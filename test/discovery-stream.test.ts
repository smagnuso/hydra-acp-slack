import { test } from "node:test";
import assert from "node:assert/strict";
import { HydraDiscovery, type HydraSessionInfo } from "../src/hydra-discovery.js";

const row = (sessionId: string, status: "warm" | "cold" = "warm"): HydraSessionInfo => ({
  sessionId,
  cwd: "/w",
  agentId: "a",
  title: undefined,
  attachedClients: 0,
  updatedAt: "2026-01-01T00:00:00Z",
  status,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeDaemon {
  restore: () => void;
  polls: () => number;
  setRows: (rows: HydraSessionInfo[]) => void;
  holdNextPoll: () => () => void;
  push: (body: unknown) => void;
  endStream: () => void;
}

// Stands in for the daemon: the poll answers from `rows`, the stream is
// whatever the test pushes into it.
function fakeDaemon(opts: { stream: boolean }): FakeDaemon {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  let rows: HydraSessionInfo[] = [];
  let pollCount = 0;
  let hold: Promise<void> | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/sessions/stream")) {
      if (!opts.stream) {
        return new Response(null, { status: 404 });
      }
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      init?.signal?.addEventListener("abort", () => {
        try {
          controller?.close();
        } catch {
          // already closed
        }
      });
      return new Response(body, { status: 200 });
    }
    pollCount++;
    const snapshot = rows;
    if (hold) {
      await hold;
    }
    return new Response(JSON.stringify({ sessions: snapshot, removed: [], cursor: 1 }), { status: 200 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    polls: () => pollCount,
    setRows: (next) => {
      rows = next;
    },
    holdNextPoll: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = () => {
          hold = null;
          resolve();
        };
      });
      return release;
    },
    push: (body) => {
      controller?.enqueue(encoder.encode(`event: sessions\ndata: ${JSON.stringify(body)}\n\n`));
    },
    endStream: () => {
      controller?.close();
    },
  };
}

function discovery(events: string[]): HydraDiscovery {
  return new HydraDiscovery({
    daemonUrl: "http://daemon",
    token: "t",
    pollIntervalMs: 20,
    onAdd: (s) => events.push(`add:${s.sessionId}`),
    onRemove: (id) => events.push(`remove:${id}`),
  });
}

test("a frame adds and removes sessions without waiting for a poll", async () => {
  const daemon = fakeDaemon({ stream: true });
  const events: string[] = [];
  const d = discovery(events);
  try {
    d.start();
    await sleep(50);
    daemon.push({ sessions: [row("pushed")], removed: [], cursor: 2 });
    await sleep(30);
    assert.ok(events.includes("add:pushed"), JSON.stringify(events));
    daemon.push({ sessions: [], removed: ["pushed"], cursor: 3 });
    await sleep(30);
    assert.ok(events.includes("remove:pushed"), JSON.stringify(events));
  } finally {
    d.stop();
    daemon.restore();
  }
});

test("a frame does not remove the sessions it leaves out", async () => {
  const daemon = fakeDaemon({ stream: true });
  daemon.setRows([row("a"), row("b")]);
  const events: string[] = [];
  const d = discovery(events);
  try {
    d.start();
    await sleep(50);
    daemon.push({ sessions: [row("b")], removed: [], cursor: 2 });
    await sleep(30);
    assert.ok(!events.some((e) => e.startsWith("remove:")), JSON.stringify(events));
  } finally {
    d.stop();
    daemon.restore();
  }
});

test("a poll that was in flight when a frame landed is discarded", async () => {
  const daemon = fakeDaemon({ stream: true });
  const events: string[] = [];
  const d = discovery(events);
  try {
    d.start();
    await sleep(50);
    // The next poll will answer with an empty set, from before the frame.
    const release = daemon.holdNextPoll();
    await sleep(60);
    daemon.push({ sessions: [row("fresh")], removed: [], cursor: 2 });
    await sleep(30);
    release();
    await sleep(40);
    assert.ok(!events.includes("remove:fresh"), JSON.stringify(events));
  } finally {
    d.stop();
    daemon.restore();
  }
});

test("polling slows while the stream is up", async () => {
  const daemon = fakeDaemon({ stream: true });
  const d = discovery([]);
  try {
    d.start();
    await sleep(50);
    daemon.push({ sessions: [], removed: [], cursor: 1 });
    await sleep(30);
    const before = daemon.polls();
    await sleep(200);
    assert.ok(daemon.polls() - before <= 1, `polled ${daemon.polls() - before} times`);
  } finally {
    d.stop();
    daemon.restore();
  }
});

test("keeps polling at the normal rate against a daemon with no stream", async () => {
  const daemon = fakeDaemon({ stream: false });
  const d = discovery([]);
  try {
    d.start();
    await sleep(250);
    assert.ok(daemon.polls() >= 5, `polled ${daemon.polls()} times`);
  } finally {
    d.stop();
    daemon.restore();
  }
});
