import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { SessionBridge } from "../src/acp/session.js";
import type { Config } from "../src/config.js";
import type { ThreadClient } from "../src/slack/thread.js";

// Regression test for the queue/finalize deadlock.
//
// Symptom (observed in production, hydra-acp-slack 0.1.20/0.1.21): when a
// second prompt is queued behind an in-flight own turn, the
// prompt_queue_removed{started} handler for the second prompt awaited the
// FIRST turn's "Ready" barrier *while occupying the serialized
// notificationChain*. But the first turn's finalize tail — which resolves
// that barrier — is itself scheduled on the same notificationChain, behind
// the blocked handler. Result: a cycle where the started-handler waits for
// the barrier and the tail that resolves the barrier waits for the
// started-handler to release the chain. The first turn's sendUserPrompt
// promise never resolves: no "Ready" marker posts, no finalize runs, and
// the queued prompt stays stuck "queued" forever.
//
// The fix runs the "wait for prior Ready -> post Processing" work in a
// detached continuation off the chain, so the chain can drain and the
// prior tail can run.

const TOKEN = "tok";
const CLIENT_ID = "cli_self";
const SESSION_ID = "hydra_session_TEST";
const CHANNEL = "C_TEST";

// Minimal manually-resolvable deferred.
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Fake AcpAttach: an EventEmitter exposing the surface SessionBridge uses
// (request/clientId/agentInfo/attachMeta/attachModels/sessionId). Each
// session/prompt request returns a deferred we resolve from the test so we
// control exactly when a turn "ends" relative to the next turn's started
// notification.
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

  notify(): void {
    // no-op; the daemon side is not exercised here
  }
}

// Minimal ThreadClient fake. Every post returns a unique ts so the bridge
// can track spinner / queue-indicator message ids.
function makeFakeThread(): {
  thread: ThreadClient;
  posts: string[];
} {
  let n = 0;
  const posts: string[] = [];
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
      posts.push(opts.text ?? "");
      return { channel: CHANNEL, ts, threadTs: "ts_thread" };
    },
    async updateMessage(): Promise<void> {},
    async deleteMessage(): Promise<void> {},
    async fetchText(): Promise<string | undefined> {
      return undefined;
    },
    async uploadFile(): Promise<void> {},
    async uploadAudio(): Promise<void> {},
  };
  return { thread: thread as unknown as ThreadClient, posts };
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

// Drive the exact interleaving that wedged the chain and assert that the
// first own turn actually finalizes (its sendUserPrompt resolves) within a
// generous timeout. Under the bug this hangs forever.
test("queued second prompt does not deadlock the first turn's finalize", async () => {
  const attach = new FakeAttach();
  const { thread } = makeFakeThread();
  const bridge = makeBridge(attach, thread);

  // Open the attach: creates the SessionState + opens the thread.
  attach.emit("open");
  await flush();
  const session = bridge.getSession(SESSION_ID);
  assert.ok(session, "session should be created on attach open");

  // Turn 1: nothing ahead -> starts immediately (no queued indicator).
  const p1 = bridge.sendUserPrompt(SESSION_ID, "first prompt");
  await flush();
  assert.equal(attach.promptResponses.length, 1, "p1 session/prompt sent");

  // Daemon dequeues p1 immediately: prompt_queue_added + removed{started}.
  const p1mid = "m_p1";
  attach.emit("notification", {
    jsonrpc: "2.0",
    method: "hydra-acp/prompt_queue/added",
    params: {
      sessionId: SESSION_ID,
      messageId: p1mid,
      originator: { clientId: CLIENT_ID },
      prompt: [{ type: "text", text: "first prompt" }],
    },
  });
  attach.emit("notification", {
    jsonrpc: "2.0",
    method: "hydra-acp/prompt_queue/removed",
    params: { sessionId: SESSION_ID, messageId: p1mid, reason: "started" },
  });
  await flush();

  // Turn 2: sent while turn 1 is in flight -> queued behind p1, so it
  // posts a queued indicator and captures p1's barrier as waitForPriorReady.
  const p2 = bridge.sendUserPrompt(SESSION_ID, "second prompt");
  await flush();
  assert.equal(attach.promptResponses.length, 2, "p2 session/prompt sent");

  const p2mid = "m_p2";
  attach.emit("notification", {
    jsonrpc: "2.0",
    method: "hydra-acp/prompt_queue/added",
    params: {
      sessionId: SESSION_ID,
      messageId: p2mid,
      originator: { clientId: CLIENT_ID },
      prompt: [{ type: "text", text: "second prompt" }],
    },
  });
  await flush();

  // CRITICAL ORDERING: deliver p2's started BEFORE p1's session/prompt
  // resolves. This puts p2's started-handler on the notificationChain
  // first; under the bug it blocks the chain awaiting p1's barrier.
  attach.emit("notification", {
    jsonrpc: "2.0",
    method: "hydra-acp/prompt_queue/removed",
    params: { sessionId: SESSION_ID, messageId: p2mid, reason: "started" },
  });
  await flush();

  // Now end turn 1. Its finalize tail chains behind p2's (possibly
  // blocked) started-handler. With the bug this never runs.
  attach.promptResponses[0]!.resolve({ stopReason: "end_turn" });

  // p1 must resolve. Race it against a timeout so the test fails fast
  // (rather than hanging) if the deadlock is reintroduced.
  const timedOut = Symbol("timeout");
  const result = await Promise.race([
    p1.then(() => "p1-resolved" as const),
    flush(2000).then(() => timedOut),
  ]);
  assert.equal(
    result,
    "p1-resolved",
    "turn 1 finalize deadlocked: sendUserPrompt never resolved",
  );

  // Clean up p2 so the test process can exit.
  attach.promptResponses[1]!.resolve({ stopReason: "end_turn" });
  await p2.catch(() => undefined);
});
