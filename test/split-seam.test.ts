import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { SessionBridge, findRawSplitPoint } from "../src/acp/session.js";
import { toSlackMrkdwn } from "../src/formatters/markdown.js";
import type { Config } from "../src/config.js";
import type { ThreadClient } from "../src/slack/thread.js";

// Regression test: a text-mode agent message that outgrows
// SLACK_MESSAGE_LIMIT splits into a head plus continuations, and the seam
// used to be remembered as an offset into the RENDERED text. toSlackMrkdwn
// is not prefix-stable, so that offset drifted and the next flush sliced
// the continuation at a stale position, silently dropping characters
// mid-word at the seam.
//
// The seam now lives in raw (pre-render) coordinates and each continuation
// renders from the raw tail, so a render shift inside already-sent text
// cannot move this message's start.
//
// Triggering it needs the shifting construct to STRADDLE the seam. Emphasis
// spans can't contain a newline (see convertEmphasis), so a paragraph-break
// seam is never straddled — it takes a long unbroken line, where the split
// falls back to a sentence boundary or the hard cap and can land in the
// middle of a `**…**` whose closing marker has not arrived yet.

const SESSION_ID = "hydra_session_TEST";
const CHANNEL = "C_TEST";
const LIMIT = 3500;

class FakeAttach extends EventEmitter {
  readonly sessionId = SESSION_ID;
  readonly clientId = "cli_self";
  readonly agentInfo = { name: "test-agent" };
  readonly attachMeta = undefined;
  readonly attachModels = undefined;

  async request<R = unknown>(): Promise<R> {
    return undefined as R;
  }

  notify(): void {}
}

// Tracks the latest text per Slack message in creation order, which is what
// a reader actually sees in the thread.
function makeFakeThread(): {
  thread: ThreadClient;
  messages: () => string[];
  sawBlocks: () => boolean;
  reset: () => void;
} {
  let n = 0;
  let blocksSeen = false;
  const order: string[] = [];
  const latest = new Map<string, string>();
  const record = (ts: string, text: string, blocks?: unknown[]): void => {
    if (Array.isArray(blocks) && blocks.length > 0) {
      blocksSeen = true;
    }
    if (!latest.has(ts)) {
      order.push(ts);
    }
    latest.set(ts, text);
  };
  const thread = {
    async findSessionThread(): Promise<string | undefined> {
      return undefined;
    },
    async postMessage(opts: {
      text?: string;
      blocks?: unknown[];
    }): Promise<{ channel: string; ts: string; threadTs: string }> {
      const ts = `ts_${++n}`;
      record(ts, opts.text ?? "", opts.blocks);
      return { channel: CHANNEL, ts, threadTs: "ts_thread" };
    },
    async updateMessage(
      _channel: string,
      ts: string,
      text: string,
      blocks?: unknown[],
    ): Promise<void> {
      record(ts, text, blocks);
    },
    async deleteMessage(): Promise<void> {},
    async fetchText(): Promise<string | undefined> {
      return undefined;
    },
    async uploadFile(): Promise<void> {},
    async uploadAudio(): Promise<void> {},
  };
  return {
    thread: thread as unknown as ThreadClient,
    messages: () => order.map((ts) => latest.get(ts) ?? ""),
    sawBlocks: () => blocksSeen,
    // The thread's own header message is posted with blocks; call this after
    // the session opens so only agent-message renders are under inspection.
    reset: () => {
      blocksSeen = false;
      order.length = 0;
      latest.clear();
    },
  };
}

function makeBridge(attach: FakeAttach, thread: ThreadClient): SessionBridge {
  const config = {
    slackChannelId: CHANNEL,
    uploadBundleOnEnd: false,
    hydraDaemonUrl: "http://127.0.0.1:0",
    hydraToken: "tok",
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

// Sentences on ONE line, each carrying a unique MARKnnnn token so a dropped
// seam shows up as a missing marker rather than a subtle length mismatch.
function sentence(i: number): string {
  const id = `MARK${String(i).padStart(4, "0")}`;
  return `${id} the classifier tried a dbgid that is neither the ESN nor the SDK sha`;
}

function markersIn(text: string): string[] {
  return text.match(/MARK\d{4}/g) ?? [];
}

// Build a single unbroken line whose rendered length passes `over`, with a
// `**` opener placed before the eventual seam and left unclosed. Returns the
// opener-bearing prefix plus the text that closes it.
function straddlingLine(over: number): { open: string; close: string } {
  const parts: string[] = [];
  let i = 0;
  let openedAt = -1;
  while (parts.join(". ").length < over) {
    // Open emphasis comfortably before the limit so the seam, which falls
    // back to a sentence boundary near `LIMIT`, lands inside the span.
    if (openedAt === -1 && parts.join(". ").length > LIMIT - 600) {
      openedAt = parts.length;
      parts.push(`**${sentence(i)}`);
    } else {
      parts.push(sentence(i));
    }
    i++;
  }
  assert.ok(openedAt !== -1, "test setup: emphasis opener was never placed");
  return {
    open: parts.join(". "),
    close: `** and then ${sentence(900)}. ${sentence(901)}.`,
  };
}

async function openSession(bridge: SessionBridge, attach: FakeAttach) {
  attach.emit("open");
  await flush();
  const session = bridge.getSession(SESSION_ID);
  assert.ok(session);
  return session;
}

test("split seam survives an emphasis span that closes after the seam", async () => {
  const attach = new FakeAttach();
  const { thread, messages, sawBlocks, reset } = makeFakeThread();
  const bridge = makeBridge(attach, thread);
  const session = await openSession(bridge, attach);
  reset();

  const { open, close } = straddlingLine(LIMIT + 400);

  // Flush 1: already over the limit, so this splits and records the seam
  // while the `**` span is still open.
  session.agentChunks.push(open);
  await bridge.flushAgentMessage(session);
  assert.equal(sawBlocks(), false, "expected the text-mode path, not blocks mode");
  assert.ok(
    messages().length >= 2,
    `expected a split on the first flush, got ${messages().length} message(s)`,
  );

  // Flush 2: the closing `**` shortens the render of text already sent. The
  // old rendered-offset seam slid off the boundary here.
  session.agentChunks.push(close);
  await bridge.flushAgentMessage(session);

  const sent = messages();
  const joined = sent.join("\n");
  const expected = markersIn(toSlackMrkdwn(session.agentChunks.join("")));
  const got = markersIn(joined);
  assert.deepEqual(
    got,
    expected,
    `markers lost or duplicated at the seam: expected ${expected.length}, got ${got.length}`,
  );
  for (const [i, m] of sent.entries()) {
    assert.ok(
      m.length <= LIMIT,
      `message ${i} exceeds the Slack limit at ${m.length} chars`,
    );
  }
});

test("toSlackMrkdwn is not prefix-stable, so a rendered seam offset cannot be trusted", () => {
  // Locks in the invariant that forces the seam to be a raw offset. If this
  // ever starts passing as "stable", the raw-offset machinery could be
  // simplified — but do not assume it without this test flipping.
  const emphasis = toSlackMrkdwn("Some text with **bol");
  const emphasisClosed = toSlackMrkdwn("Some text with **bold** and then more.");
  assert.equal(
    emphasisClosed.startsWith(emphasis),
    false,
    "closing an emphasis span used to be assumed prefix-stable",
  );

  const table = "| axis | hydra |\n| --- | --- |\n| clean | yes |\n";
  const narrow = toSlackMrkdwn(table);
  const widened = toSlackMrkdwn(
    `${table}| force | guard is UI-only, never in the API |\n`,
  );
  assert.equal(
    widened.startsWith(narrow),
    false,
    "a wide table row re-pads earlier rows and shifts everything after them",
  );
});

test("findRawSplitPoint returns a prefix whose render fits the limit", () => {
  const paras: string[] = [];
  for (let i = 0; i < 40; i++) {
    paras.push(sentence(i));
  }
  const raw = paras.join("\n\n");
  const at = findRawSplitPoint(raw, LIMIT, toSlackMrkdwn);
  assert.ok(at > 0, "must make progress");
  assert.ok(at < raw.length, "should not consume the whole oversized text");
  assert.ok(
    toSlackMrkdwn(raw.slice(0, at)).length <= LIMIT,
    "returned prefix renders over the limit",
  );
  assert.equal(
    raw.slice(0, at).endsWith("\n\n"),
    true,
    "should prefer a paragraph boundary",
  );
});

test("findRawSplitPoint makes progress on text with no natural boundary", () => {
  const raw = "x".repeat(10_000);
  const at = findRawSplitPoint(raw, LIMIT, toSlackMrkdwn);
  assert.ok(at >= 1, "must always advance");
  assert.ok(
    toSlackMrkdwn(raw.slice(0, at)).length <= LIMIT,
    "returned prefix renders over the limit",
  );
});
