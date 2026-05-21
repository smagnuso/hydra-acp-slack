import bolt from "@slack/bolt";
import type { Config } from "../config.js";
import {
  decodePermissionButtonValue,
  PERMISSION_ACTION_PREFIX,
} from "../acp/session.js";
import { logger } from "../util/log.js";
import {
  listAgents,
  matchKnownCommand,
  parseBangCommand,
  parseSessionArgs,
  createSession,
} from "./commands.js";
import { reactionAction } from "./reaction-map.js";
import { threadRegistry } from "./registry.js";
import {
  attemptResurrect,
  bufferPendingMessage,
  findSessionIdForThread,
} from "./resurrect.js";

const log = logger("slack");

// Optional per-command override for the visual ack we drop on a
// forwarded bang. Keyed by the matched slash-form name (longest-prefix
// match from the discovered command set). Unmapped commands get the
// generic :gear: — new commands work in Slack with no entry here.
const BANG_VERB_REACTIONS: Record<string, string> = {
  "/hydra title": "label",
  "/hydra agent": "twisted_rightwards_arrows",
};

export interface SlackApp {
  app: bolt.App;
  client: bolt.App["client"];
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createSlackApp(config: Config): SlackApp {
  // Construct the receiver explicitly so the staleness watchdog below
  // can access its underlying SocketModeClient. Passing socketMode:true
  // to bolt.App also creates one, but stores it as a private field.
  const receiver = new bolt.SocketModeReceiver({
    appToken: config.slackAppToken,
    logLevel: config.debug ? bolt.LogLevel.DEBUG : bolt.LogLevel.INFO,
  });
  const app = new bolt.App({
    token: config.slackBotToken,
    receiver,
    logLevel: config.debug ? bolt.LogLevel.DEBUG : bolt.LogLevel.INFO,
  });

  app.error(async (err) => {
    log.error("bolt error", err);
  });

  // Inbound message → ACP session/prompt.
  app.message(async ({ message }) => {
    const m = message as Partial<{
      subtype?: string;
      bot_id?: string;
      user?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
      channel?: string;
      files?: Array<{
        id: string;
        mimetype?: string;
        url_private?: string;
        url_private_download?: string;
      }>;
      // For subtype === "message_changed" / "message_deleted", Slack
      // wraps the new/old content in these envelopes. `message` is the
      // post-edit version (only on message_changed); `previous_message`
      // is the pre-edit / deleted message and carries the original ts
      // and user we need for authorization + queue lookup.
      message?: {
        ts?: string;
        text?: string;
        user?: string;
        thread_ts?: string;
        bot_id?: string;
      };
      previous_message?: {
        ts?: string;
        text?: string;
        user?: string;
        thread_ts?: string;
        bot_id?: string;
      };
    }>;
    const preview = (m.text ?? "").slice(0, 60);
    log.info(
      `inbound msg user=${m.user ?? "?"} channel=${m.channel ?? "?"} thread=${m.thread_ts ?? "(none)"} subtype=${m.subtype ?? "(none)"} bot=${m.bot_id ?? "(none)"} ts=${m.ts ?? "?"} text="${preview}"`,
    );
    if (m.bot_id) {
      log.info(`drop: bot=${m.bot_id}`);
      return;
    }
    // Slack delivers edits as subtype="message_changed" and deletions as
    // subtype="message_deleted". Both target a previously-queued prompt
    // by its source `ts`; route to dedicated handlers and skip the
    // normal enqueue path. Any other subtype (file_share is the one
    // we *do* accept on the main path; everything else — channel_join,
    // bot_message, thread_broadcast, etc. — is dropped).
    if (m.subtype === "message_changed") {
      await handleMessageChanged(app, config, m);
      return;
    }
    if (m.subtype === "message_deleted") {
      await handleMessageDeleted(app, config, m);
      return;
    }
    if (m.subtype && m.subtype !== "file_share") {
      log.info(`drop: subtype=${m.subtype}`);
      return;
    }
    if (!m.channel || !m.user || !m.ts) {
      log.info(
        `drop: missing fields channel=${m.channel ?? "(none)"} user=${m.user ?? "(none)"} ts=${m.ts ?? "(none)"}`,
      );
      return;
    }
    if (config.authorizedUsers.size > 0 && !config.authorizedUsers.has(m.user)) {
      log.info(`drop: unauthorized user ${m.user}`);
      return;
    }
    const rawText = (m.text ?? "").trim();
    if (rawText.startsWith("!session")) {
      await handleSessionCommand(app, config, rawText, m.channel, m.ts);
      return;
    }
    if (rawText === "!agents") {
      await handleAgents(app, config, m.channel, m.ts);
      return;
    }
    if (!m.thread_ts) {
      log.info(`drop: top-level message without bang-command`);
      return;
    }
    const candidates = threadRegistry.lookupAll(m.channel, m.thread_ts);
    const text = (m.text ?? "").trim();
    if (!text && !(m.files && m.files.length > 0)) {
      return;
    }
    // Download any attached images and forward as multimodal content.
    const imageBlocks: Array<{ type: "image"; mimeType: string; data: string }> =
      [];
    for (const f of m.files ?? []) {
      if (!f.mimetype || !f.mimetype.startsWith("image/")) {
        continue;
      }
      const url = f.url_private_download ?? f.url_private;
      if (!url) {
        continue;
      }
      try {
        const data = await downloadAsBase64(url, config.slackBotToken);
        imageBlocks.push({ type: "image", mimeType: f.mimetype, data });
      } catch (err) {
        log.warn(`image download failed: ${(err as Error).message}`);
      }
    }
    if (candidates.length === 0) {
      // Thread has no live bridge — likely a cold session whose disk
      // record outlived its agent process. Try to resurrect via a
      // transient session/attach (hydra revives from loadFromDisk),
      // and buffer the user's message so the new bridge picks it up
      // when discovery's next poll catches the now-live session.
      const sessionId = await findSessionIdForThread(
        app,
        m.channel,
        m.thread_ts,
      );
      if (!sessionId) {
        log.info(
          `drop: no bridge or session marker for thread channel=${m.channel} thread_ts=${m.thread_ts}`,
        );
        return;
      }
      bufferPendingMessage(sessionId, { text, images: imageBlocks });
      log.info(
        `cold thread ${m.thread_ts} → buffer + resurrect ${sessionId.slice(0, 8)}`,
      );
      attemptResurrect(config, sessionId).catch((err: unknown) => {
        log.warn(
          `resurrect ${sessionId.slice(0, 8)} failed: ${(err as Error).message}`,
        );
      });
      return;
    }
    // First candidate is the preferred one (most recent live activity);
    // fall back to others if the prompt fails (e.g. when multiple
    // proxies share the Claude Code session DB but only one has the
    // session in memory). The succeeding candidate gets promoted in
    // the registry below so future routes prefer it.
    const entry = candidates[0]!;
    if (text.startsWith("!debug")) {
      const info = entry.bridge.debugInfo(entry.sessionId);
      await app.client.chat.postMessage({
        channel: m.channel,
        thread_ts: m.thread_ts,
        text: "```\n" + info + "\n```",
      });
      return;
    }
    // Strict-mirror bang routing: `!foo bar` → `/foo bar`. We look up
    // the candidate against the daemon-advertised command set
    // (available_commands_update) and only forward when it matches a
    // known command. Locally owned bangs (!debug, !session, !agents)
    // are filtered out by parseBangCommand.
    const bang = parseBangCommand(text);
    let forwardedText = text;
    if (bang) {
      const known = entry.bridge.availableCommands(entry.sessionId);
      const matched = matchKnownCommand(bang.slash, known.keys());
      if (!matched) {
        await postUnknownCommandReply(
          app,
          m.channel,
          m.ts,
          m.thread_ts,
          bang.slash,
          known,
        );
        return;
      }
      forwardedText = bang.slash;
      const emoji = BANG_VERB_REACTIONS[matched] ?? "gear";
      await app.client.reactions
        .add({ channel: m.channel, timestamp: m.ts, name: emoji })
        .catch(() => undefined);
    }
    let routed = false;
    let lastError: string | undefined;
    for (const candidate of candidates) {
      try {
        await candidate.bridge.sendUserPrompt(
          candidate.sessionId,
          forwardedText,
          imageBlocks,
          m.ts,
        );
        threadRegistry.promote(candidate.bridge, m.channel, m.thread_ts);
        routed = true;
        break;
      } catch (err) {
        lastError = (err as Error).message;
        if (candidates.length > 1) {
          log.info(
            `route attempt failed (${lastError}); trying next of ${candidates.length} candidate(s)`,
          );
        }
      }
    }
    if (!routed) {
      log.warn(
        `session/prompt failed across ${candidates.length} bridge(s): ${lastError ?? "?"}`,
      );
      await app.client.reactions
        .add({ channel: m.channel, timestamp: m.ts ?? "", name: "warning" })
        .catch(() => undefined);
    }
  });

  // Reaction added → permission, hide, expand, etc.
  app.event("reaction_added", async ({ event }) => {
    const e = event as {
      user: string;
      reaction: string;
      item: { channel?: string; ts?: string };
    };
    if (config.authorizedUsers.size > 0 && !config.authorizedUsers.has(e.user)) {
      log.info(`reaction drop: unauthorized user ${e.user} :${e.reaction}:`);
      return;
    }
    const channel = e.item.channel;
    const ts = e.item.ts;
    if (!channel || !ts) {
      log.info(
        `reaction drop: missing channel/ts :${e.reaction}: channel=${channel ?? "(none)"} ts=${ts ?? "(none)"}`,
      );
      return;
    }
    const action = reactionAction(e.reaction);
    if (!action) {
      // Only log when the reaction landed on a thread we own — avoids
      // logging every random reaction on unrelated channel messages.
      const entry =
        threadRegistry.lookup(channel, ts) ??
        (await tryLookupByMessage(app, channel, ts));
      if (entry) {
        log.info(`unmapped reaction :${e.reaction}: on ${channel}/${ts}`);
      }
      return;
    }
    // Reactions can target either the thread parent (root ts) or any
    // message inside the thread. Look up by both forms.
    const directEntry = threadRegistry.lookup(channel, ts);
    const entry = directEntry ?? (await tryLookupByMessage(app, channel, ts));
    if (!entry) {
      log.info(
        `reaction drop: no bridge for ${channel}/${ts} (direct=${!!directEntry}) :${e.reaction}:→${action}`,
      );
      return;
    }
    log.info(
      `reaction route: :${e.reaction}:→${action} ${channel}/${ts} session=${entry.sessionId.slice(0, 8)} (direct=${!!directEntry})`,
    );
    try {
      await entry.bridge.handleReaction(entry.sessionId, channel, ts, action, true);
    } catch (err) {
      log.warn(`reaction(${e.reaction}) failed: ${(err as Error).message}`);
    }
  });

  app.event("reaction_removed", async ({ event }) => {
    const e = event as {
      user: string;
      reaction: string;
      item: { channel?: string; ts?: string };
    };
    if (config.authorizedUsers.size > 0 && !config.authorizedUsers.has(e.user)) {
      return;
    }
    const channel = e.item.channel;
    const ts = e.item.ts;
    if (!channel || !ts) {
      return;
    }
    const action = reactionAction(e.reaction);
    if (!action) {
      return;
    }
    const entry =
      threadRegistry.lookup(channel, ts) ??
      (await tryLookupByMessage(app, channel, ts));
    if (!entry) {
      return;
    }
    try {
      await entry.bridge.handleReaction(entry.sessionId, channel, ts, action, false);
    } catch (err) {
      log.warn(`reaction(${e.reaction}) remove failed: ${(err as Error).message}`);
    }
  });

  // Block Kit button click on a permission prompt. action_id starts
  // with PERMISSION_ACTION_PREFIX; the button value carries the
  // sessionId + toolCallId + optionId triple (encoded in
  // encodePermissionButtonValue) so we can route without a global
  // bridge index.
  app.action(
    { type: "block_actions", action_id: new RegExp(`^${PERMISSION_ACTION_PREFIX}`) },
    async ({ ack, body, action }) => {
      await ack();
      const ba = action as { value?: string; action_id?: string };
      const userId = (body as { user?: { id?: string } }).user?.id;
      if (config.authorizedUsers.size > 0 && (!userId || !config.authorizedUsers.has(userId))) {
        log.info(`permission button drop: unauthorized user ${userId ?? "(none)"}`);
        return;
      }
      const decoded = decodePermissionButtonValue(ba.value);
      if (!decoded) {
        log.warn(
          `permission button drop: undecodable value action_id=${ba.action_id ?? "?"}`,
        );
        return;
      }
      const entry = threadRegistry.findBySession(decoded.s);
      if (!entry) {
        log.info(
          `permission button drop: no bridge for session=${decoded.s.slice(0, 8)} toolCallId=${decoded.t}`,
        );
        return;
      }
      log.info(
        `permission button click user=${userId ?? "?"} session=${decoded.s.slice(0, 8)} toolCallId=${decoded.t} optionId=${decoded.o}`,
      );
      try {
        const ok = await entry.bridge.respondToPermissionByToolCallId(
          decoded.t,
          decoded.o,
          userId,
        );
        if (!ok) {
          log.info(
            `permission button: no pending resolver for toolCallId=${decoded.t} (already resolved?)`,
          );
        }
      } catch (err) {
        log.warn(`permission button failed: ${(err as Error).message}`);
      }
    },
  );

  let watchdogTimer: NodeJS.Timeout | undefined;
  let lastConnectedAt = 0;
  let smConnected = false;
  let stopping = false;

  return {
    app,
    client: app.client,
    async start() {
      // Initial connect with internal retry. Bolt's SocketModeClient
      // throws if apps.connections.open fails on the first try, so a
      // network-down spawn would otherwise crash the process and leave
      // hydra to backoff-respawn us indefinitely. Stay in-process and
      // retry every 10s — recovers as soon as the network is back
      // without churning through hydra's process spawns.
      while (!stopping) {
        try {
          await app.start();
          break;
        } catch (err) {
          log.warn(
            `slack start failed: ${(err as Error).message}; retrying in 10s`,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
        }
      }
      if (stopping) {
        return;
      }
      log.info("Slack Socket Mode connected");
      lastConnectedAt = Date.now();
      smConnected = true;
      // Bolt holds the SocketModeClient on its receiver; tap into its
      // connect/disconnect events so we can detect a wedged reconnect
      // loop. When bolt's WebClient gets stuck (e.g. node's DNS or
      // keep-alive pool turned bad mid-VPN-flap), bolt fires
      // 'disconnected' and never recovers; we exit so hydra restarts
      // us with a fresh process.
      receiver.client.on("connected", () => {
        smConnected = true;
        lastConnectedAt = Date.now();
        log.info("slack socket-mode reconnected");
      });
      receiver.client.on("disconnected", () => {
        smConnected = false;
        log.warn("slack socket-mode disconnected");
      });
      const thresholdMs = config.websocketStaleThreshold * 1_000;
      watchdogTimer = setInterval(() => {
        if (smConnected) {
          return;
        }
        const downMs = Date.now() - lastConnectedAt;
        if (downMs > thresholdMs) {
          log.error(
            `slack ws disconnected for ${Math.floor(downMs / 1_000)}s (threshold ${config.websocketStaleThreshold}s); exiting for hydra restart`,
          );
          process.exit(1);
        }
      }, 5_000);
      if (typeof watchdogTimer.unref === "function") {
        watchdogTimer.unref();
      }
    },
    async stop() {
      stopping = true;
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = undefined;
      }
      await app.stop();
      log.info("Slack stopped");
    },
  };
}


async function downloadAsBase64(url: string, botToken: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

// Reply when a user typed a `!<verb>` that doesn't match anything the
// daemon has advertised (typo, command not yet wired, agent that
// doesn't advertise its commands, etc.). Drops a :grey_question:
// reaction and lists the known commands in the thread.
async function postUnknownCommandReply(
  app: bolt.App,
  channel: string,
  ts: string,
  threadTs: string | undefined,
  slash: string,
  known: ReadonlyMap<string, string | undefined>,
): Promise<void> {
  await app.client.reactions
    .add({ channel, timestamp: ts, name: "grey_question" })
    .catch(() => undefined);
  const names = [...known.keys()].sort();
  const list =
    names.length === 0
      ? "_(no commands advertised yet — try again after the agent emits its command list)_"
      : names
          .map((n) => {
            const desc = known.get(n);
            // The args-hint (e.g. "<agent>") is folded into the
            // description by applyAvailableCommandsUpdate; surface the
            // first `<…>` token in the bang line so users know to
            // supply an argument.
            const hintMatch = desc?.match(/^(<[^>]*>(?:\s+<[^>]*>)*)/);
            const hint = hintMatch ? ` ${hintMatch[1]}` : "";
            return `• \`!${n.slice(1)}${hint}\``;
          })
          .join("\n");
  await app.client.chat
    .postMessage({
      channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: `:grey_question: unknown command \`!${slash.slice(1)}\`\nKnown:\n${list}`,
    })
    .catch(() => undefined);
}

// When the reaction's target is a message inside a thread (not the parent),
// we need the parent's ts to look up the bridge. Fetch the message and use
// its thread_ts.
async function tryLookupByMessage(
  app: bolt.App,
  channel: string,
  ts: string,
): Promise<ReturnType<typeof threadRegistry.lookup>> {
  try {
    const res = await app.client.conversations.replies({
      channel,
      ts,
      limit: 1,
      inclusive: true,
    });
    const msg = res.messages?.[0];
    const threadTs = msg?.thread_ts ?? msg?.ts;
    if (!threadTs) {
      return undefined;
    }
    return threadRegistry.lookup(channel, threadTs);
  } catch {
    return undefined;
  }
}

async function handleSessionCommand(
  app: bolt.App,
  config: Config,
  rawText: string,
  channel: string,
  ts: string,
): Promise<void> {
  const body = rawText.slice("!session".length);
  const args = parseSessionArgs(body);
  let result;
  try {
    result = await createSession(config, args);
  } catch (err) {
    log.warn(`session creation failed: ${(err as Error).message}`);
    await app.client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: `:warning: session creation failed: ${(err as Error).message}`,
    });
    return;
  }
  if (args.prompt) {
    bufferPendingMessage(result.sessionId, {
      text: args.prompt,
      images: [],
    });
  }
  await app.client.reactions
    .add({ channel, timestamp: ts, name: "white_check_mark" })
    .catch(() => undefined);
  const head = `:rocket: starting \`${result.agentId}\` in \`${result.cwd}\` (session \`${result.sessionId}\`)`;
  const queuedSuffix = args.prompt ? "; first prompt queued" : "";
  const initial = `${head}; thread will appear once the agent is ready${queuedSuffix}`;
  const posted = await app.client.chat.postMessage({
    channel,
    thread_ts: ts,
    text: initial,
  });
  const startingTs = posted.ts;
  if (!startingTs) {
    return;
  }
  // Cap the wait so a failed/abandoned session doesn't leak a subscriber
  // entry forever. The starting message simply stays as-is on timeout.
  const timeout = setTimeout(() => {
    unsubscribe();
  }, 5 * 60 * 1000);
  const unsubscribe = threadRegistry.onceForSession(
    result.sessionId,
    (entry) => {
      clearTimeout(timeout);
      void (async () => {
        let linkText = "thread ready";
        try {
          const link = await app.client.chat.getPermalink({
            channel: entry.channel,
            message_ts: entry.threadTs,
          });
          if (link.permalink) {
            linkText = `<${link.permalink}|open thread>`;
          }
        } catch (err) {
          log.warn(
            `chat.getPermalink failed for ${entry.sessionId}: ${(err as Error).message}`,
          );
        }
        try {
          await app.client.chat.update({
            channel,
            ts: startingTs,
            text: `${head} → ${linkText}${queuedSuffix}`,
          });
        } catch (err) {
          log.warn(
            `chat.update of starting msg failed for ${entry.sessionId}: ${(err as Error).message}`,
          );
        }
      })();
    },
  );
}

async function handleAgents(
  app: bolt.App,
  config: Config,
  channel: string,
  ts: string,
): Promise<void> {
  let agents;
  try {
    agents = await listAgents(config);
  } catch (err) {
    log.warn(`!agents failed: ${(err as Error).message}`);
    await app.client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: `:warning: agents lookup failed: ${(err as Error).message}`,
    });
    return;
  }
  if (agents.length === 0) {
    await app.client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: ":information_source: no agents installed in hydra registry",
    });
    return;
  }
  const lines = agents.map((a) => {
    const ver = a.version ? ` v${a.version}` : "";
    const desc = a.description ? ` — ${a.description}` : "";
    return `• \`${a.id}\`${ver}${desc}`;
  });
  await app.client.chat.postMessage({
    channel,
    thread_ts: ts,
    text: ["*Available agents:*", ...lines].join("\n"),
  });
}

// Shared shape for the inbound Slack `message` event with the subtype
// envelopes we care about (message_changed wraps the new/old version;
// message_deleted only carries previous_message).
type SlackMessageEnvelope = Partial<{
  subtype?: string;
  channel?: string;
  ts?: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  message?: {
    ts?: string;
    text?: string;
    user?: string;
    thread_ts?: string;
    bot_id?: string;
  };
  previous_message?: {
    ts?: string;
    text?: string;
    user?: string;
    thread_ts?: string;
    bot_id?: string;
  };
}>;

// Slack edit of a previously-queued prompt → hydra-acp/update_prompt.
// Only fires when:
//   * the edited message lives in a bridged thread
//   * there's an own queued entry stamped with this source ts
//   * the entry hasn't started yet
// Anything else is silently ignored: messages we never queued
// (e.g. bang-routed `!agents`, drops, peer-originated prompts) won't
// have an entry; messages that already ran will have been spliced
// out of `sourceTsToEntry` by sendUserPrompt's finally.
async function handleMessageChanged(
  app: bolt.App,
  config: Config,
  m: SlackMessageEnvelope,
): Promise<void> {
  const prev = m.previous_message;
  const next = m.message;
  // Bot-authored messages are dropped — `bot_id` lives inside the
  // nested envelopes for these subtypes, not on the outer event.
  // Without this filter we'd process every spinner / queue indicator
  // edit the bridge itself performs (chat.update fires message_changed
  // back to us; spinner deletion fires message_deleted back).
  if (next?.bot_id || prev?.bot_id) {
    return;
  }
  // Slack delivers message_changed with both envelopes; we need the
  // original ts (lookup key) and the post-edit text. Channel is on
  // the outer event.
  const sourceTs = prev?.ts ?? next?.ts;
  const channel = m.channel;
  const newText = (next?.text ?? "").trim();
  const editorUser = next?.user ?? prev?.user;
  if (!channel || !sourceTs) {
    return;
  }
  // Edits from unauthorized users are dropped — same gate as new
  // messages. Slack actually wraps the editor in next.user but we
  // accept either as a safety net for unusual delivery shapes.
  if (
    config.authorizedUsers.size > 0 &&
    editorUser &&
    !config.authorizedUsers.has(editorUser)
  ) {
    return;
  }
  // The edit must be inside a bridged thread. Slack puts the parent ts
  // on prev/next.thread_ts (and not on the outer event for these
  // subtypes).
  const threadTs = next?.thread_ts ?? prev?.thread_ts;
  if (!threadTs) {
    return;
  }
  const candidates = threadRegistry.lookupAll(channel, threadTs);
  if (candidates.length === 0) {
    return;
  }
  // Pick the candidate that actually has an entry for this source ts.
  // Multi-bridge threads are rare but we shouldn't fire update_prompt
  // at the wrong session.
  const candidate = candidates.find((c) =>
    c.bridge.hasQueueEntryBySourceTs(c.sessionId, sourceTs),
  );
  if (!candidate) {
    return;
  }
  log.info(
    `edit -> ${candidate.sessionId.slice(0, 8)} ts=${sourceTs}: ${newText.slice(0, 80)}`,
  );
  await candidate.bridge
    .editQueuedPromptBySourceTs(candidate.sessionId, sourceTs, newText)
    .catch((err: unknown) => {
      log.warn(
        `editQueuedPromptBySourceTs failed: ${(err as Error).message}`,
      );
    });
}

// Slack delete of a previously-queued prompt → hydra-acp/cancel_prompt.
// Symmetric with handleMessageChanged: same lookup, same skip rules,
// just routed to the cancel primitive.
async function handleMessageDeleted(
  app: bolt.App,
  config: Config,
  m: SlackMessageEnvelope,
): Promise<void> {
  const prev = m.previous_message;
  // Drop the bot's own deletions (its spinner cleanup, queue indicator
  // updates, etc.) — Slack echoes those back to us as message_deleted
  // events and they shouldn't be treated as user delete gestures.
  if (prev?.bot_id) {
    return;
  }
  const sourceTs = prev?.ts;
  const channel = m.channel;
  if (!channel || !sourceTs) {
    return;
  }
  if (
    config.authorizedUsers.size > 0 &&
    prev?.user &&
    !config.authorizedUsers.has(prev.user)
  ) {
    return;
  }
  const threadTs = prev?.thread_ts;
  if (!threadTs) {
    return;
  }
  const candidates = threadRegistry.lookupAll(channel, threadTs);
  if (candidates.length === 0) {
    return;
  }
  const candidate = candidates.find((c) =>
    c.bridge.hasQueueEntryBySourceTs(c.sessionId, sourceTs),
  );
  if (!candidate) {
    return;
  }
  log.info(
    `delete -> ${candidate.sessionId.slice(0, 8)} ts=${sourceTs}`,
  );
  await candidate.bridge
    .cancelQueuedPromptBySourceTs(candidate.sessionId, sourceTs)
    .catch((err: unknown) => {
      log.warn(
        `cancelQueuedPromptBySourceTs failed: ${(err as Error).message}`,
      );
    });
}
