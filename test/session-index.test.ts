import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";
import type { SessionBridge } from "../src/acp/session.js";
import type { HydraSessionInfo } from "../src/hydra-discovery.js";
import { setTeamDomain, threadRegistry } from "../src/slack/registry.js";
import { INDEX_MARKER, SessionIndex } from "../src/slack/session-index.js";
import type { ThreadClient } from "../src/slack/thread.js";

interface Posted {
  channel: string;
  text: string;
}

class FakeThread {
  posts: Posted[] = [];
  updates: Posted[] = [];
  pins: string[] = [];
  existing = new Map<string, string>();
  pinOk = true;
  private seq = 0;

  async postMessage(opts: { channel: string; text: string }) {
    this.posts.push({ channel: opts.channel, text: opts.text });
    const ts = `100.${++this.seq}`;
    return { channel: opts.channel, ts, threadTs: ts };
  }

  async updateMessage(channel: string, _ts: string, text: string) {
    this.updates.push({ channel, text });
  }

  async findMarkedMessage(channel: string, _marker: string) {
    return this.existing.get(channel);
  }

  async pinMessage(channel: string, ts: string) {
    if (!this.pinOk) {
      return false;
    }
    this.pins.push(`${channel}/${ts}`);
    return true;
  }
}

function warm(
  sessionId: string,
  cwd: string,
  title?: string,
  agentId?: string,
): HydraSessionInfo {
  return {
    sessionId,
    cwd,
    agentId,
    title,
    attachedClients: 1,
    updatedAt: "now",
    status: "warm",
  };
}

function registerThread(sessionId: string, channel: string, threadTs: string) {
  const bridge = { id: sessionId } as unknown as SessionBridge;
  threadRegistry.register({ bridge, sessionId, channel, threadTs });
  return bridge;
}

function make(thread: FakeThread, sessions: HydraSessionInfo[]) {
  return new SessionIndex({
    thread: thread as unknown as ThreadClient,
    currentSessions: () => sessions,
    intervalMs: 60_000,
  });
}

beforeEach(() => {
  for (const e of threadRegistry.entries()) {
    threadRegistry.unregisterBridge(e.bridge);
  }
  setTeamDomain("acme");
});

test("posts and pins an index listing warm sessions with thread links", async () => {
  const thread = new FakeThread();
  registerThread("s1", "C1", "111.1");
  const idx = make(thread, [warm("s1", "/tmp/proj", "Fix the parser", "claude")]);

  await idx.refreshNow();

  assert.equal(thread.posts.length, 1);
  const text = thread.posts[0]!.text;
  assert.match(text, /Warm hydra sessions\* \(1\)/);
  assert.match(text, /Fix the parser/);
  assert.match(text, /archives\/C1\/p1111\?thread_ts=111\.1/);
  assert.ok(text.includes(INDEX_MARKER));
  assert.deepEqual(thread.pins, ["C1/100.1"]);
});

test("does not re-post or re-update when nothing changed", async () => {
  const thread = new FakeThread();
  registerThread("s1", "C1", "111.1");
  const idx = make(thread, [warm("s1", "/tmp/proj")]);

  await idx.refreshNow();
  await idx.refreshNow();
  await idx.refreshNow();

  assert.equal(thread.posts.length, 1);
  assert.equal(thread.updates.length, 0);
});

test("updates in place when a session goes cold, leaving an empty index", async () => {
  const thread = new FakeThread();
  registerThread("s1", "C1", "111.1");
  const sessions = [warm("s1", "/tmp/proj")];
  const idx = make(thread, sessions);

  await idx.refreshNow();
  sessions.length = 0;
  await idx.refreshNow();

  assert.equal(thread.posts.length, 1);
  assert.equal(thread.updates.length, 1);
  assert.match(thread.updates[0]!.text, /\(0\)/);
  assert.match(thread.updates[0]!.text, /none right now/);
});

test("skips warm sessions that have no thread yet", async () => {
  const thread = new FakeThread();
  const idx = make(thread, [warm("s1", "/tmp/proj")]);

  await idx.refreshNow();

  assert.equal(thread.posts.length, 0);
});

test("lists a session once when several bridges share its thread", async () => {
  const thread = new FakeThread();
  registerThread("s1", "C1", "111.1");
  registerThread("s1", "C1", "111.1");
  const idx = make(thread, [warm("s1", "/tmp/proj", "Only once")]);

  await idx.refreshNow();

  const hits = thread.posts[0]!.text.match(/Only once/g) ?? [];
  assert.equal(hits.length, 1);
});

test("groups sessions into their own channels", async () => {
  const thread = new FakeThread();
  registerThread("s1", "C1", "111.1");
  registerThread("s2", "C2", "222.2");
  const idx = make(thread, [
    warm("s1", "/tmp/a", "Alpha"),
    warm("s2", "/tmp/b", "Beta"),
  ]);

  await idx.refreshNow();

  assert.equal(thread.posts.length, 2);
  const c1 = thread.posts.find((p) => p.channel === "C1")!;
  const c2 = thread.posts.find((p) => p.channel === "C2")!;
  assert.match(c1.text, /Alpha/);
  assert.ok(!c1.text.includes("Beta"));
  assert.match(c2.text, /Beta/);
});

test("reuses an existing index message found by marker after a restart", async () => {
  const thread = new FakeThread();
  thread.existing.set("C1", "999.9");
  registerThread("s1", "C1", "111.1");
  const idx = make(thread, [warm("s1", "/tmp/proj")]);

  await idx.refreshNow();

  assert.equal(thread.posts.length, 0);
  assert.equal(thread.updates.length, 1);
  assert.equal(thread.updates[0]!.channel, "C1");
});

test("still publishes the index when pinning is unavailable", async () => {
  const thread = new FakeThread();
  thread.pinOk = false;
  registerThread("s1", "C1", "111.1");
  const idx = make(thread, [warm("s1", "/tmp/proj")]);

  await idx.refreshNow();

  assert.equal(thread.posts.length, 1);
  assert.deepEqual(thread.pins, []);
});

test("renders nothing until the team domain is known", async () => {
  const thread = new FakeThread();
  setTeamDomain(undefined as unknown as string);
  registerThread("s1", "C1", "111.1");
  const idx = make(thread, [warm("s1", "/tmp/proj")]);

  await idx.refreshNow();

  assert.equal(thread.posts.length, 0);
});
