import bolt from "@slack/bolt";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../config.js";
import {
  AMEND_QUEUED_ACTION_ID,
  CAT_SHOW_ALL_ACTION_ID,
  CAT_SHOW_MORE_ACTION_ID,
  CANCEL_QUEUED_ACTION_ID,
  CANCEL_TURN_ACTION_ID,
  decodeCancelQueuedValue,
  decodeCancelTurnValue,
  decodePermissionButtonValue,
  PERMISSION_ACTION_PREFIX,
  SPINNER_DETAILS_ACTION_ID,
} from "../acp/session.js";
import { logger } from "../util/log.js";
import { languageForPath } from "./cat-lang.js";
import {
  listAgents,
  canonicalizeSlash,
  matchKnownCommand,
  parseBangCommand,
  parseSessionArgs,
  createSession,
} from "./commands.js";
import { reactionAction } from "./reaction-map.js";
import { transcribeAudio } from "../transcribe.js";
import { setTeamDomain, threadRegistry } from "./registry.js";
import type { AdopterRef } from "./adopter.js";
import {
  bufferPendingMessage,
  findSessionIdForThread,
  fetchSessionInfo,
} from "./resurrect.js";

const log = logger("slack");

const CAT_MAX_FILE_BYTES = 512 * 1024;
const CAT_CHUNK_BODY_CHARS = 11500;
const CAT_BINARY_SCAN_BYTES = 8192;

interface CatButtonState {
  s: string;   // sessionId
  c: string;   // channel
  t: string;   // threadTs
  p: string;   // absolute path (already realpath-resolved)
  i: number;   // next chunk index to render
  n: number;   // total chunks
}

function encodeCatState(state: CatButtonState): string {
  const json = JSON.stringify(state);
  return Buffer.from(json, "utf8").toString("base64");
}

function decodeCatState(value: string | undefined): CatButtonState | null {
  if (!value) {
    return null;
  }
  try {
    const json = Buffer.from(value, "base64").toString("utf8");
    const parsed = JSON.parse(json) as CatButtonState;
    if (
      typeof parsed.s !== "string" ||
      typeof parsed.c !== "string" ||
      typeof parsed.t !== "string" ||
      typeof parsed.p !== "string" ||
      typeof parsed.i !== "number" ||
      typeof parsed.n !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function splitIntoChunks(body: string): string[] {
  if (body.length <= CAT_CHUNK_BODY_CHARS) {
    return [body];
  }
  const chunks: string[] = [];
  let i = 0;
  while (i < body.length) {
    let end = Math.min(i + CAT_CHUNK_BODY_CHARS, body.length);
    if (end < body.length) {
      const lastNl = body.lastIndexOf("\n", end);
      if (lastNl > i + CAT_CHUNK_BODY_CHARS / 2) {
        end = lastNl + 1;
      }
    }
    chunks.push(body.slice(i, end));
    i = end;
  }
  return chunks;
}

function containsBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, CAT_BINARY_SCAN_BYTES);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

async function resolveCatPath(
  raw: string,
  cwd: string,
): Promise<{ ok: true; abs: string; display: string } | { ok: false; reason: string }> {
  let input = raw.trim();
  if (
    (input.startsWith('"') && input.endsWith('"')) ||
    (input.startsWith("'") && input.endsWith("'"))
  ) {
    input = input.slice(1, -1);
  }
  if (input.length === 0) {
    return { ok: false, reason: "usage: !cat <path>" };
  }
  const wasAbsolute = isAbsolute(input) || input.startsWith("~");
  let expanded = input;
  if (expanded.startsWith("~")) {
    expanded = join(homedir(), expanded.slice(1));
  }
  const joined = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  let abs: string;
  let cwdReal: string;
  try {
    abs = await realpath(joined);
  } catch (err) {
    return { ok: false, reason: `cannot resolve path: ${(err as Error).message}` };
  }
  try {
    cwdReal = await realpath(cwd);
  } catch {
    cwdReal = cwd;
  }
  if (!wasAbsolute && !abs.startsWith(cwdReal + "/") && abs !== cwdReal) {
    return { ok: false, reason: "path escapes session cwd" };
  }
  return { ok: true, abs, display: input };
}

async function loadCatFile(
  abs: string,
): Promise<{ ok: true; chunks: string[]; totalBytes: number; language: string | undefined } | { ok: false; reason: string }> {
  let st;
  try {
    st = await stat(abs);
  } catch (err) {
    return { ok: false, reason: `stat failed: ${(err as Error).message}` };
  }
  if (!st.isFile()) {
    return { ok: false, reason: "not a regular file" };
  }
  if (st.size > CAT_MAX_FILE_BYTES) {
    return { ok: false, reason: `file too large (${st.size} B > ${CAT_MAX_FILE_BYTES} B cap)` };
  }
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch (err) {
    return { ok: false, reason: `read failed: ${(err as Error).message}` };
  }
  if (containsBinary(buf)) {
    return { ok: false, reason: "looks like a binary file, refusing to cat" };
  }
  const text = buf.toString("utf8");
  const chunks = splitIntoChunks(text);
  return { ok: true, chunks, totalBytes: buf.length, language: languageForPath(abs) };
}

function buildCatBlocks(
  chunks: string[],
  chunkIndex: number,
  displayPath: string,
  totalBytes: number,
  language: string | undefined,
  state: CatButtonState,
): unknown[] {
  const lang = language ?? "";
  const chunk = chunks[chunkIndex] ?? "";
  const total = chunks.length;
  const header =
    total === 1
      ? `:page_facing_up: \`${displayPath}\` (${totalBytes} B)`
      : `:page_facing_up: \`${displayPath}\` — chunk ${chunkIndex + 1}/${total} (${totalBytes} B total)`;
  const blocks: unknown[] = [
    { type: "context", elements: [{ type: "mrkdwn", text: header }] },
    { type: "markdown", text: "```" + lang + "\n" + chunk + "\n```" },
  ];
  const hasMore = chunkIndex + 1 < total;
  if (hasMore) {
    const nextState: CatButtonState = { ...state, i: chunkIndex + 1 };
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Show more" },
          action_id: CAT_SHOW_MORE_ACTION_ID,
          value: encodeCatState(nextState),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Show all" },
          action_id: CAT_SHOW_ALL_ACTION_ID,
          value: encodeCatState(nextState),
          style: "primary",
        },
      ],
    });
  }
  return blocks;
}

async function pathIsInsideCwd(abs: string, cwd: string): Promise<boolean> {
  try {
    const absReal = await realpath(abs);
    const cwdReal = await realpath(cwd);
    return absReal === cwdReal || absReal.startsWith(cwdReal + "/");
  } catch {
    return false;
  }
}

async function handleCat(
  app: bolt.App,
  entry: { bridge: { sessionCwd(id: string): string | undefined }; sessionId: string },
  channel: string,
  threadTs: string,
  sourceTs: string,
  argsText: string,
): Promise<void> {
  const cwd = entry.bridge.sessionCwd(entry.sessionId);
  if (!cwd) {
    await app.client.reactions
      .add({ channel, timestamp: sourceTs, name: "warning" })
      .catch(() => undefined);
    await app.client.chat
      .postMessage({ channel, thread_ts: threadTs, text: "no cwd known for this session" })
      .catch(() => undefined);
    return;
  }
  const resolved = await resolveCatPath(argsText, cwd);
  if (!resolved.ok) {
    await app.client.reactions
      .add({ channel, timestamp: sourceTs, name: "no_entry" })
      .catch(() => undefined);
    await app.client.chat
      .postMessage({ channel, thread_ts: threadTs, text: `:no_entry: ${resolved.reason}` })
      .catch(() => undefined);
    return;
  }
  const loaded = await loadCatFile(resolved.abs);
  if (!loaded.ok) {
    await app.client.reactions
      .add({ channel, timestamp: sourceTs, name: "warning" })
      .catch(() => undefined);
    await app.client.chat
      .postMessage({ channel, thread_ts: threadTs, text: `:warning: ${loaded.reason}` })
      .catch(() => undefined);
    return;
  }
  const state: CatButtonState = {
    s: entry.sessionId,
    c: channel,
    t: threadTs,
    p: resolved.abs,
    i: 0,
    n: loaded.chunks.length,
  };
  const blocks = buildCatBlocks(
    loaded.chunks,
    0,
    resolved.display,
    loaded.totalBytes,
    loaded.language,
    state,
  );
  try {
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `!cat ${resolved.display}`,
      blocks: blocks as never,
    });
  } catch (err) {
    log.warn(`!cat post failed: ${(err as Error).message}`);
  }
}

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

export function createSlackApp(
  config: Config,
  adopterRef: AdopterRef,
): SlackApp {
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
    // Our own chat.update / chat.delete calls (spinners, streamed agent
    // messages, header refreshes, etc.) come back to us as
    // message_changed / message_deleted events. For those subtypes Slack
    // puts bot_id inside the nested envelopes, not on the outer event,
    // so checking only m.bot_id misses them and the noisy inbound-msg
    // log fires for every self-edit. Detect both shapes up front and
    // bail before logging.
    const botEcho =
      m.bot_id ?? m.message?.bot_id ?? m.previous_message?.bot_id;
    if (botEcho) {
      return;
    }
    const preview = (m.text ?? "").slice(0, 60);
    log.info(
      `inbound msg user=${m.user ?? "?"} channel=${m.channel ?? "?"} thread=${m.thread_ts ?? "(none)"} subtype=${m.subtype ?? "(none)"} ts=${m.ts ?? "?"} text="${preview}"`,
    );
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
      await handleSessionCommand(app, config, adopterRef, rawText, m.channel, m.ts);
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
    let text = (m.text ?? "").trim();
    if (!text && !(m.files && m.files.length > 0)) {
      return;
    }
    // Download any attached images/audio and forward as multimodal content.
    const imageBlocks: Array<{ type: "image" | "audio"; mimeType: string; data: string }> =
      [];
    for (const f of m.files ?? []) {
      const isImage = f.mimetype?.startsWith("image/");
      const isAudio = f.mimetype?.startsWith("audio/");
      if (!isImage && !isAudio) {
        continue;
      }
      const url = f.url_private_download ?? f.url_private;
      if (!url) {
        continue;
      }
      try {
        const data = await downloadAsBase64(url, config.slackBotToken, f.mimetype ?? "");
        imageBlocks.push({ type: isImage ? "image" : "audio", mimeType: f.mimetype!, data });
      } catch (err) {
        log.warn(`file download failed (${f.mimetype}): ${(err as Error).message}`);
      }
    }
    // Transcribe any audio attachments and fold the transcript into the
    // prompt text. The agent silently strips audio content blocks it can't
    // forward (Claude doesn't support audio natively), so without a text
    // transcript the prompt would arrive empty and the API would reject it.
    for (const block of imageBlocks) {
      if (block.type !== "audio") continue;
      try {
        const transcript = await transcribeAudio(
          Buffer.from(block.data, "base64"),
          block.mimeType,
        );
        if (transcript) {
          text = text ? `${text}\n[Voice: ${transcript}]` : transcript;
          log.info(`transcribed audio: ${transcript.slice(0, 80)}`);
          if (m.thread_ts) {
            void app.client.chat.postMessage({
              channel: m.channel!,
              thread_ts: m.thread_ts,
              text: `:microphone: _"${transcript}"_`,
            }).catch(() => undefined);
          }
        }
      } catch (err) {
        log.warn(`transcription failed: ${(err as Error).message}`);
        if (!text) text = "[Voice message — transcription unavailable]";
      }
    }
    if (candidates.length === 0) {
      // Thread has no live bridge. Two reasons land here:
      //   - cold session whose disk record outlived the agent process
      //   - !session-created session whose first prompt hasn't promoted
      //     it to interactive=true yet, so HydraDiscovery's default
      //     /v1/sessions view filters it out
      // Either way the marker on the thread parent carries the
      // sessionId. Fetch the full session info from the daemon (with
      // includeNonInteractive=true so the filter doesn't hide it), then
      // adopt directly via the adopter so the bridge gets created
      // without waiting for the next discovery poll.
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
      const orphanBang = parseBangCommand(text);
      bufferPendingMessage(sessionId, {
        text,
        images: imageBlocks,
        ...(orphanBang ? { slashCandidate: orphanBang.slash } : {}),
      });
      const info = await fetchSessionInfo(config, sessionId);
      if (!info) {
        log.warn(
          `orphan thread ${m.thread_ts}: session ${sessionId.slice(0, 8)} not in daemon /v1/sessions; dropping`,
        );
        return;
      }
      log.info(
        `orphan thread ${m.thread_ts} → adopt ${sessionId.slice(0, 8)}`,
      );
      adopterRef.current?.adopt(info);
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
    if (text.startsWith("!cat")) {
      const argsText = text.slice("!cat".length).trim();
      if (argsText.length === 0) {
        await app.client.reactions
          .add({ channel: m.channel, timestamp: m.ts, name: "warning" })
          .catch(() => undefined);
        await app.client.chat
          .postMessage({ channel: m.channel, thread_ts: m.thread_ts, text: "usage: !cat <path>" })
          .catch(() => undefined);
        return;
      }
      await handleCat(app, entry, m.channel, m.thread_ts, m.ts, argsText);
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
      forwardedText = canonicalizeSlash(bang.slash, matched);
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
          !bang && imageBlocks.some((b) => b.type === "audio"),
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

  // Block Kit Cancel button on a queued indicator (own or peer). The
  // button value carries {sessionId, promptTs}; promptTs is the ts of
  // the indicator the user clicked on, which the bridge uses to find
  // the right queued entry (own vs. peer) and fire
  // hydra-acp/prompt/cancel. Equivalent to the :stop_sign: reaction
  // on the same indicator.
  app.action(
    { type: "block_actions", action_id: CANCEL_QUEUED_ACTION_ID },
    async ({ ack, body, action }) => {
      await ack();
      const ba = action as { value?: string; action_id?: string };
      const userId = (body as { user?: { id?: string } }).user?.id;
      if (config.authorizedUsers.size > 0 && (!userId || !config.authorizedUsers.has(userId))) {
        log.info(`cancel-queued button drop: unauthorized user ${userId ?? "(none)"}`);
        return;
      }
      const decoded = decodeCancelQueuedValue(ba.value);
      if (!decoded) {
        log.warn(
          `cancel-queued button drop: undecodable value action_id=${ba.action_id ?? "?"}`,
        );
        return;
      }
      const entry = threadRegistry.findBySession(decoded.s);
      if (!entry) {
        log.info(
          `cancel-queued button drop: no bridge for session=${decoded.s.slice(0, 8)}`,
        );
        return;
      }
      log.info(
        `cancel-queued button user=${userId ?? "?"} session=${decoded.s.slice(0, 8)} promptTs=${decoded.p}`,
      );
      try {
        const ok = await entry.bridge.cancelQueuedByPromptTs(
          decoded.s,
          decoded.p,
        );
        if (!ok) {
          log.info(
            `cancel-queued button: no matching entry for promptTs=${decoded.p} (already started/cancelled?)`,
          );
        }
      } catch (err) {
        log.warn(`cancel-queued button failed: ${(err as Error).message}`);
      }
    },
  );

  // Block Kit Amend button on a queued indicator. Same {sessionId,
  // promptTs} payload as Cancel; the bridge folds the queued text into
  // the in-flight head turn via hydra-acp/prompt/amend and then drops
  // the queued entry.
  app.action(
    { type: "block_actions", action_id: AMEND_QUEUED_ACTION_ID },
    async ({ ack, body, action }) => {
      await ack();
      const ba = action as { value?: string; action_id?: string };
      const userId = (body as { user?: { id?: string } }).user?.id;
      if (config.authorizedUsers.size > 0 && (!userId || !config.authorizedUsers.has(userId))) {
        log.info(`amend-queued button drop: unauthorized user ${userId ?? "(none)"}`);
        return;
      }
      const decoded = decodeCancelQueuedValue(ba.value);
      if (!decoded) {
        log.warn(
          `amend-queued button drop: undecodable value action_id=${ba.action_id ?? "?"}`,
        );
        return;
      }
      const entry = threadRegistry.findBySession(decoded.s);
      if (!entry) {
        log.info(
          `amend-queued button drop: no bridge for session=${decoded.s.slice(0, 8)}`,
        );
        return;
      }
      log.info(
        `amend-queued button user=${userId ?? "?"} session=${decoded.s.slice(0, 8)} promptTs=${decoded.p}`,
      );
      try {
        const ok = await entry.bridge.amendQueuedByPromptTs(
          decoded.s,
          decoded.p,
        );
        if (!ok) {
          log.info(
            `amend-queued button: no matching entry / no head for promptTs=${decoded.p}`,
          );
        }
      } catch (err) {
        log.warn(`amend-queued button failed: ${(err as Error).message}`);
      }
    },
  );

  // Block Kit Cancel button on the processing indicator or the spinner.
  // Turn-scoped: fires session/cancel for the running turn. Same effect
  // as the :stop_sign: reaction on either message.
  app.action(
    { type: "block_actions", action_id: CANCEL_TURN_ACTION_ID },
    async ({ ack, body, action }) => {
      await ack();
      const ba = action as { value?: string; action_id?: string };
      const userId = (body as { user?: { id?: string } }).user?.id;
      if (config.authorizedUsers.size > 0 && (!userId || !config.authorizedUsers.has(userId))) {
        log.info(`cancel-turn button drop: unauthorized user ${userId ?? "(none)"}`);
        return;
      }
      const decoded = decodeCancelTurnValue(ba.value);
      if (!decoded) {
        log.warn(
          `cancel-turn button drop: undecodable value action_id=${ba.action_id ?? "?"}`,
        );
        return;
      }
      const entry = threadRegistry.findBySession(decoded.s);
      if (!entry) {
        log.info(
          `cancel-turn button drop: no bridge for session=${decoded.s.slice(0, 8)}`,
        );
        return;
      }
      log.info(
        `cancel-turn button user=${userId ?? "?"} session=${decoded.s.slice(0, 8)}`,
      );
      try {
        entry.bridge.cancelTurn(decoded.s);
      } catch (err) {
        log.warn(`cancel-turn button failed: ${(err as Error).message}`);
      }
    },
  );

  // Spinner "Show details / Hide details" toggle. Flips
  // session.spinnerExpanded — same boolean the :eyes: reaction
  // toggles — and re-renders the spinner so the button label and
  // (optional) tool-list body invert.
  app.action(
    { type: "block_actions", action_id: SPINNER_DETAILS_ACTION_ID },
    async ({ ack, body, action }) => {
      await ack();
      const ba = action as { value?: string; action_id?: string };
      const userId = (body as { user?: { id?: string } }).user?.id;
      if (config.authorizedUsers.size > 0 && (!userId || !config.authorizedUsers.has(userId))) {
        log.info(`spinner-details button drop: unauthorized user ${userId ?? "(none)"}`);
        return;
      }
      const decoded = decodeCancelTurnValue(ba.value);
      if (!decoded) {
        log.warn(
          `spinner-details button drop: undecodable value action_id=${ba.action_id ?? "?"}`,
        );
        return;
      }
      const entry = threadRegistry.findBySession(decoded.s);
      if (!entry) {
        log.info(
          `spinner-details button drop: no bridge for session=${decoded.s.slice(0, 8)}`,
        );
        return;
      }
      try {
        await entry.bridge.toggleSpinnerDetails(decoded.s);
      } catch (err) {
        log.warn(`spinner-details button failed: ${(err as Error).message}`);
      }
    },
  );

  app.action(
    { type: "block_actions", action_id: CAT_SHOW_MORE_ACTION_ID },
    async ({ ack, body, action }) => {
      await ack();
      const ba = action as { value?: string };
      const userId = (body as { user?: { id?: string } }).user?.id;
      if (config.authorizedUsers.size > 0 && (!userId || !config.authorizedUsers.has(userId))) {
        return;
      }
      const state = decodeCatState(ba.value);
      if (!state) {
        return;
      }
      const entry = threadRegistry.findBySession(state.s);
      if (!entry) {
        return;
      }
      const cwd = entry.bridge.sessionCwd(state.s);
      if (!cwd) {
        return;
      }
      const inside = await pathIsInsideCwd(state.p, cwd);
      if (!inside) {
        await app.client.chat
          .postMessage({
            channel: state.c,
            thread_ts: state.t,
            text: ":no_entry: file no longer inside session cwd",
          })
          .catch(() => undefined);
        return;
      }
      const loaded = await loadCatFile(state.p);
      if (!loaded.ok || state.i >= loaded.chunks.length) {
        return;
      }
      const nextBlocks = buildCatBlocks(
        loaded.chunks,
        state.i,
        basename(state.p),
        loaded.totalBytes,
        loaded.language,
        state,
      );
      await app.client.chat
        .postMessage({
          channel: state.c,
          thread_ts: state.t,
          text: `!cat ${basename(state.p)} chunk ${state.i + 1}/${state.n}`,
          blocks: nextBlocks as never,
        })
        .catch((err: unknown) => {
          log.warn(`cat_show_more post failed: ${(err as Error).message}`);
        });
    },
  );

  app.action(
    { type: "block_actions", action_id: CAT_SHOW_ALL_ACTION_ID },
    async ({ ack, body, action }) => {
      await ack();
      const ba = action as { value?: string };
      const userId = (body as { user?: { id?: string } }).user?.id;
      if (config.authorizedUsers.size > 0 && (!userId || !config.authorizedUsers.has(userId))) {
        return;
      }
      const state = decodeCatState(ba.value);
      if (!state) {
        return;
      }
      const entry = threadRegistry.findBySession(state.s);
      if (!entry) {
        return;
      }
      const cwd = entry.bridge.sessionCwd(state.s);
      if (!cwd) {
        return;
      }
      const inside = await pathIsInsideCwd(state.p, cwd);
      if (!inside) {
        return;
      }
      try {
        const buf = await readFile(state.p);
        await app.client.files.uploadV2({
          channel_id: state.c,
          thread_ts: state.t,
          filename: basename(state.p),
          file: buf,
          initial_comment: `:page_facing_up: \`${basename(state.p)}\` — full file (${buf.length} B)`,
        });
      } catch (err) {
        log.warn(`cat_show_all upload failed: ${(err as Error).message}; falling back to chunk-post`);
        const loaded = await loadCatFile(state.p);
        if (!loaded.ok) {
          await app.client.chat
            .postMessage({
              channel: state.c,
              thread_ts: state.t,
              text: `:warning: show all failed: ${(err as Error).message}`,
            })
            .catch(() => undefined);
          return;
        }
        for (let i = state.i; i < loaded.chunks.length; i++) {
          const chunkBlocks = buildCatBlocks(
            loaded.chunks,
            i,
            basename(state.p),
            loaded.totalBytes,
            loaded.language,
            { ...state, i },
          );
          try {
            await app.client.chat.postMessage({
              channel: state.c,
              thread_ts: state.t,
              text: `!cat ${basename(state.p)} chunk ${i + 1}/${loaded.chunks.length}`,
              blocks: chunkBlocks as never,
            });
          } catch (postErr) {
            log.warn(`cat_show_all chunk post failed: ${(postErr as Error).message}`);
            break;
          }
        }
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
      // Cache the team domain (e.g. "netflix" from
      // https://netflix.slack.com/) so the markdown formatter can build
      // permalink URLs for hydra://sessions/<id> links synchronously.
      // Best-effort — failure just means those links render without a
      // clickable URL. Fire-and-forget: don't block startup on it.
      void app.client.auth.test().then((res) => {
        const url = typeof res.url === "string" ? res.url : "";
        const m = url.match(/^https?:\/\/([^./]+)\.slack\.com\/?/);
        if (m) {
          setTeamDomain(m[1]!);
          log.info(`team domain cached: ${m[1]}`);
        } else {
          log.warn(`auth.test returned no parseable team URL: ${JSON.stringify(url)}`);
        }
      }).catch((err) => {
        log.warn(`auth.test failed: ${(err as Error).message}`);
      });
      if (stopping) {
        return;
      }
      log.info("Slack Socket Mode connected");
      lastConnectedAt = Date.now();
      smConnected = true;
      // Bolt holds the SocketModeClient on its receiver; tap into its
      // lifecycle events so we can detect a wedged reconnect loop.
      // When bolt's WebClient gets stuck (e.g. node's DNS or keep-alive
      // pool turned bad mid-VPN-flap), bolt sits in 'reconnecting'
      // forever; we exit so hydra restarts us with a fresh process.
      //
      // The relevant events are 'reconnecting' and 'connected'.
      // 'disconnected' is NOT what fires on a network drop — bolt only
      // emits that on graceful shutdown (disconnect() call). The
      // underlying ws 'close' triggers delayReconnectAttempt which
      // emits 'reconnecting' on every retry. So we treat 'reconnecting'
      // as the down signal and 'connected' as the up signal.
      receiver.client.on("connected", () => {
        smConnected = true;
        lastConnectedAt = Date.now();
        log.info("slack socket-mode reconnected");
      });
      receiver.client.on("reconnecting", () => {
        if (smConnected) {
          log.warn("slack socket-mode reconnecting");
        }
        smConnected = false;
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


async function downloadAsBase64(url: string, botToken: string, expectedMime: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  const expectedPrefix = expectedMime.split("/")[0] + "/";
  if (!contentType.startsWith("image/") && !contentType.startsWith("audio/")) {
    throw new Error(`unexpected content-type ${contentType} (auth failure?)`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  log.info(`file downloaded mime=${contentType.split(";")[0]} expected=${expectedPrefix} sizeB=${buf.length}`);
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
  adopterRef: AdopterRef,
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
    const sessionBang = parseBangCommand(args.prompt);
    bufferPendingMessage(result.sessionId, {
      text: args.prompt,
      images: [],
      ...(sessionBang ? { slashCandidate: sessionBang.slash } : {}),
    });
  }
  // Adopt immediately rather than waiting for the next HydraDiscovery
  // poll. The daemon filters interactive=undefined sessions out of
  // /v1/sessions by default, so discovery wouldn't see this one until
  // the user's first prompt promotes it — opening the thread now keeps
  // !session responsive AND survives that filter.
  adopterRef.current?.adopt({
    sessionId: result.sessionId,
    cwd: result.cwd,
    agentId: result.agentId,
  });
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

// Slack edit of a previously-queued prompt → hydra-acp/prompt/update.
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

// Slack delete of a previously-queued prompt → hydra-acp/prompt/cancel.
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
