import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { SessionBridge } from "../src/acp/session.js";
import type { Config } from "../src/config.js";
import type { ThreadClient } from "../src/slack/thread.js";

// Regression tests for hydra's agent-initiated turns (PROTOCOL.md
// "Agent-initiated turns").
//
// When Claude Code restarts itself after a background task finishes, the
// turn has no session/prompt behind it. Hydra brackets it with
// turn_started / turn_ended carrying _meta["hydra-acp"].unsolicited, and
// deliberately does NOT emit turn_complete: clients pair turn_complete
// against a prompt they saw start.
//
// Before these were handled, both events fell through to the default
// no-op arm and nothing ever ended the turn on the Slack side: the
// spinner was orphaned (with its 30s ticker chat.updating forever and a
// live Cancel button), the open agent message was never closed so the
// next turn's prose appended into it, and turnToolCallIds /
// spinnerStartedAt leaked into the next turn's Ready marker.

const TOKEN = "tok";
const CLIENT_ID = "cli_self";
const SESSION_ID = "hydra_session_TEST";
const CHANNEL = "C_TEST";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class FakeAttach extends EventEmitter {
  readonly sessionId = SESSION_ID;
  readonly clientId = CLIENT_ID;
  readonly agentInfo = { name: "test-agent" };
  readonly attachMeta = undefined;
  readonly attachModels = undefined;
  promptResponses: Array<{ resolve: (v: unknown) => void }> = [];

  async request<R = unknown>(method: string): Promise<R> {
    if (method === "session/prompt") {
      const d = deferred<unknown>();
      this.promptResponses.push({ resolve: d.resolve });
      return d.promise as Promise<R>;
    }
    return undefined as R;
  }

  notify(): void {}
}

interface Posted {
  ts: string;
  text: string;
}

function makeFakeThread(): {
  thread: ThreadClient;
  posts: Posted[];
  deleted: string[];
  updates: Array<{ ts: string; text: string }>;
} {
  let n = 0;
  const posts: Posted[] = [];
  const deleted: string[] = [];
  const updates: Array<{ ts: string; text: string }> = [];
  const thread = {
    async findSessionThread(): Promise<string | undefined> {
      return undefined;
    },
    async postMessage(opts: { text?: string }): Promise<{
      channel: string;
      ts: string;
      threadTs: string;
    }> {
      const ts = `ts_${++n}`;
      posts.push({ ts, text: opts.text ?? "" });
      return { channel: CHANNEL, ts, threadTs: "ts_thread" };
    },
    async updateMessage(
      _channel: string,
      ts: string,
      text: string,
    ): Promise<void> {
      updates.push({ ts, text });
    },
    async deleteMessage(_channel: string, ts: string): Promise<void> {
      deleted.push(ts);
    },
    async fetchText(): Promise<string | undefined> {
      return undefined;
    },
    async uploadFile(): Promise<void> {},
    async uploadAudio(): Promise<void> {},
    async permalink(): Promise<string | undefined> {
      return undefined;
    },
    async directMessage(): Promise<void> {},
  };
  return { thread: thread as unknown as ThreadClient, posts, deleted, updates };
}

function makeBridge(attach: FakeAttach, thread: ThreadClient): SessionBridge {
  const config = {
    slackChannelId: CHANNEL,
    uploadBundleOnEnd: false,
    hydraDaemonUrl: "http://127.0.0.1:0",
    hydraToken: TOKEN,
    permissionDisplayDelayMs: 0,
  } as unknown as Config;

  return new SessionBridge({
    attach: attach as never,
    config,
    thread,
    channels: { get: () => undefined } as never,
    truncatedStore: {} as never,
    hiddenStore: {} as never,
    sessionMeta: {
      sessionId: SESSION_ID,
      cwd: "/work",
      title: "test",
      agentId: "test-agent",
    },
  });
}

function flush(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function update(attach: FakeAttach, u: Record<string, unknown>): void {
  attach.emit("notification", {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: SESSION_ID, update: u },
  });
}

function turnStarted(cause?: string): Record<string, unknown> {
  const meta: Record<string, unknown> = { unsolicited: true };
  if (cause) {
    meta.cause = { toolCallId: "toolu_1", label: cause };
  }
  return {
    sessionUpdate: "turn_started",
    messageId: "m_unsol",
    _meta: { "hydra-acp": meta },
  };
}

function turnEnded(reason: string): Record<string, unknown> {
  return {
    sessionUpdate: "turn_ended",
    messageId: "m_unsol_end",
    startedMessageId: "m_unsol",
    durationMs: 2100,
    _meta: { "hydra-acp": { unsolicited: true, reason } },
  };
}

async function openBridge(): Promise<{
  attach: FakeAttach;
  bridge: SessionBridge;
  thread: ReturnType<typeof makeFakeThread>;
}> {
  const attach = new FakeAttach();
  const thread = makeFakeThread();
  const bridge = makeBridge(attach, thread.thread);
  attach.emit("open");
  await flush();
  return { attach, bridge, thread };
}

test("unsolicited turn_ended finalizes the turn instead of orphaning the spinner", async () => {
  const { attach, bridge, thread } = await openBridge();
  const session = bridge.getSession(SESSION_ID);
  assert.ok(session);

  update(attach, turnStarted("gibbon rebuild"));
  await flush();
  assert.ok(
    thread.posts.some((p) => p.text.includes("agent resumed on its own")),
    "turn_started should announce the resumption in the thread",
  );
  assert.ok(
    thread.posts.some((p) => p.text.includes("gibbon rebuild")),
    "the cause label should name what woke the agent",
  );

  update(attach, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "build is green" },
  });
  await flush();
  assert.ok(session.spinnerTs, "agent content should post a spinner");
  const spinnerTs = session.spinnerTs;

  update(attach, turnEnded("completed"));
  await flush();

  assert.equal(session.spinnerTs, undefined, "spinner must be finalized");
  assert.ok(
    thread.deleted.includes(spinnerTs!),
    "the in-progress spinner must be deleted, not left with a live Cancel button",
  );
  assert.ok(
    thread.posts.some((p) => p.text.includes("Ready")),
    "turn end must post the Ready marker",
  );
  assert.equal(
    session.agentMessageTs,
    undefined,
    "agent message must be closed so the next turn starts a fresh one",
  );
  assert.deepEqual(
    session.turnToolCallIds,
    [],
    "per-turn tool ids must not leak into the next turn's Ready marker",
  );
  assert.equal(session.spinnerStartedAt, undefined);
  bridge.cleanup();
});

test("a second turn_started while one is open does not double-open", async () => {
  const { attach, bridge, thread } = await openBridge();
  const session = bridge.getSession(SESSION_ID);
  assert.ok(session);

  update(attach, turnStarted());
  await flush();
  const headers = thread.posts.filter((p) =>
    p.text.includes("agent resumed on its own"),
  ).length;

  update(attach, turnStarted());
  await flush();
  assert.equal(
    thread.posts.filter((p) => p.text.includes("agent resumed on its own"))
      .length,
    headers,
    "duplicate turn_started must be ignored",
  );

  // And a single turn_ended still closes it.
  update(attach, turnEnded("completed"));
  await flush();
  assert.equal(session.unsolicitedTurnOpen, false);
  bridge.cleanup();
});

test("turn_ended with no turn_started we saw does not steal a running turn", async () => {
  const { attach, bridge, thread } = await openBridge();
  const session = bridge.getSession(SESSION_ID);
  assert.ok(session);

  // A real turn is running (spinner up), and an unbalanced turn_ended
  // arrives (a daemon restart mid-turn, or history replay).
  update(attach, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "working on it" },
  });
  await flush();
  const spinnerTs = session.spinnerTs;
  assert.ok(spinnerTs);

  update(attach, turnEnded("completed"));
  await flush();

  assert.equal(
    session.spinnerTs,
    spinnerTs,
    "unmatched turn_ended must not finalize somebody else's turn",
  );
  assert.equal(
    thread.deleted.includes(spinnerTs!),
    false,
    "unmatched turn_ended must not delete the running spinner",
  );
  bridge.cleanup();
});

test("superseded turn_ended leaves the finalize to the prompt that took over", async () => {
  const { attach, bridge, thread } = await openBridge();
  const session = bridge.getSession(SESSION_ID);
  assert.ok(session);

  update(attach, turnStarted());
  update(attach, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "still going" },
  });
  await flush();
  const spinnerTs = session.spinnerTs;
  assert.ok(spinnerTs);

  update(attach, turnEnded("superseded"));
  await flush();

  assert.equal(
    session.unsolicitedTurnOpen,
    false,
    "the flag must clear so a later resumption opens cleanly",
  );
  assert.equal(
    session.spinnerTs,
    spinnerTs,
    "the agent keeps working under the superseding prompt; its spinner stays",
  );
  assert.equal(thread.deleted.includes(spinnerTs!), false);
  bridge.cleanup();
});

test("a held prompt gets a queue indicator even when none was posted", async () => {
  const { attach, bridge, thread } = await openBridge();

  // Prompt sent while Slack believed the session idle, so willWait was
  // false and no indicator posted. Hydra then holds it at the head
  // because an agent-initiated turn is running.
  const p = bridge.sendUserPrompt(SESSION_ID, "what broke?");
  await flush();
  assert.equal(
    thread.posts.some((x) => x.text.includes("Queued")),
    false,
    "precondition: nothing looked ahead, so no indicator was posted",
  );

  const mid = "m_held";
  attach.emit("notification", {
    jsonrpc: "2.0",
    method: "hydra-acp/prompt_queue/added",
    params: {
      sessionId: SESSION_ID,
      messageId: mid,
      originator: { clientId: CLIENT_ID },
      prompt: [{ type: "text", text: "what broke?" }],
    },
  });
  attach.emit("notification", {
    jsonrpc: "2.0",
    method: "hydra-acp/prompt_queue/held",
    params: {
      sessionId: SESSION_ID,
      messageId: mid,
      reason: "agent_resumed",
      cause: { toolCallId: "toolu_1", label: "gibbon rebuild" },
    },
  });
  await flush();

  const heldPost = thread.posts.find((x) => x.text.includes("Queued"));
  assert.ok(heldPost, "the hold must be rendered; it has no upper bound");
  assert.ok(
    heldPost.text.includes("held"),
    "the indicator must say it's held, not read as an ordinary queue wait",
  );

  attach.emit("notification", {
    jsonrpc: "2.0",
    method: "hydra-acp/prompt_queue/released",
    params: {
      sessionId: SESSION_ID,
      messageId: mid,
      reason: "turn_ended",
      heldMs: 3200,
    },
  });
  await flush();
  const cleared = thread.updates.filter(
    (u) => u.text.includes("Queued") && !u.text.includes("held"),
  );
  assert.ok(
    cleared.length > 0,
    "release must drop the held marker from the indicator",
  );

  attach.promptResponses[0]!.resolve({ stopReason: "end_turn" });
  await p.catch(() => undefined);
  bridge.cleanup();
});

test("a prompt sent during an open unsolicited turn is shown as waiting", async () => {
  const { attach, bridge, thread } = await openBridge();

  // turn_started arrives before the agent has emitted anything, so there
  // is no spinner for the old aheadCount heuristic to notice.
  update(attach, turnStarted("vitest run"));
  await flush();

  const p = bridge.sendUserPrompt(SESSION_ID, "status?");
  await flush();
  assert.ok(
    thread.posts.some((x) => x.text.includes("Queued")),
    "an agent-initiated turn is exactly when hydra holds the prompt; show it",
  );

  attach.promptResponses[0]!.resolve({ stopReason: "end_turn" });
  await p.catch(() => undefined);
  bridge.cleanup();
});
