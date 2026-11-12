// Client for the daemon's session stream (GET /v1/sessions/stream, see the
// daemon's PROTOCOL.md). Frames are deltas: rows that changed, plus ids that
// left. Copied between the extensions that discover sessions; keep them in
// step.

export interface SessionFrame<Row> {
  sessions: Row[];
  removed: string[];
  cursor?: number;
}

// Pulls SSE `data:` payloads out of a growing text buffer; what is left may
// be the front of a frame still arriving.
export function drainSseData(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf("\n\n");
    if (end === -1) {
      return { payloads, rest };
    }
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.length > 0) {
      payloads.push(data);
    }
  }
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000];

export interface SessionStreamOptions<Row> {
  open: (since: number | undefined, signal: AbortSignal) => Promise<Response>;
  signal: AbortSignal;
  onFrame: (frame: SessionFrame<Row>) => void;
  // The connection dropped; the caller can go back to polling for the gap.
  onDisconnect?: () => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    timer.unref();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function toFrame<Row>(raw: unknown): SessionFrame<Row> {
  const body = raw as { sessions?: Row[]; removed?: string[]; cursor?: number };
  return {
    sessions: Array.isArray(body.sessions) ? body.sessions : [],
    removed: Array.isArray(body.removed) ? body.removed : [],
    ...(typeof body.cursor === "number" ? { cursor: body.cursor } : {}),
  };
}

// Holds the stream open, resuming from the last cursor after a drop.
// Resolves "unsupported" when the daemon has no such route (an older one), so
// the caller keeps polling, and "aborted" once the signal fires. Never rejects.
export async function runSessionStream<Row>(
  opts: SessionStreamOptions<Row>,
): Promise<"unsupported" | "aborted"> {
  const sleep = opts.sleep ?? sleepUnlessAborted;
  let cursor: number | undefined;
  let failures = 0;
  while (!opts.signal.aborted) {
    try {
      const response = await opts.open(cursor, opts.signal);
      if (response.status === 404 || response.status === 405) {
        return "unsupported";
      }
      if (!response.ok || !response.body) {
        throw new Error(`stream returned ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        const drained = drainSseData(buffer);
        buffer = drained.rest;
        for (const payload of drained.payloads) {
          let frame: SessionFrame<Row>;
          try {
            frame = toFrame<Row>(JSON.parse(payload));
          } catch {
            continue;
          }
          if (typeof frame.cursor === "number") {
            cursor = frame.cursor;
          }
          failures = 0;
          opts.onFrame(frame);
        }
      }
    } catch {
      // Fall through to the reconnect wait; an abort is caught by the loop.
    }
    if (opts.signal.aborted) {
      break;
    }
    opts.onDisconnect?.();
    const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!;
    failures++;
    await sleep(wait, opts.signal);
  }
  return "aborted";
}
