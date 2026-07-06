import type { SessionBridge } from "../acp/session.js";

// Team-workspace domain (e.g. "netflix" from "netflix.slack.com"), cached
// once at startup via auth.test. Consumed by permalinkForSession() to
// build clickable https://<team>.slack.com/archives/<channel>/p<ts>
// URLs synchronously in the markdown formatter. Undefined until the
// startup handshake completes; callers must fall back gracefully.
let teamDomain: string | undefined;

export function setTeamDomain(domain: string): void {
  teamDomain = domain;
}

export function getTeamDomain(): string | undefined {
  return teamDomain;
}

// Slack handlers receive (channel, threadTs) but need a SessionBridge +
// sessionId to act. SessionBridges register threads here when they open
// them; handlers look them up.
//
// Multi-entry: hydra normally produces one bridge per session, but we
// keep the registry tolerant of multiple bridges claiming the same
// (channel, threadTs) — e.g. across a daemon-restart overlap window —
// and prefer the one that has shown agent-side activity (promoted via
// promote()), with app.ts's message handler falling back to others if
// the first fails.
export interface ThreadEntry {
  bridge: SessionBridge;
  sessionId: string;
  channel: string;
  threadTs: string;
}

class ThreadRegistry {
  private byThread = new Map<string, ThreadEntry[]>(); // key: channel|threadTs
  private sessionSubscribers = new Map<
    string,
    ((entry: ThreadEntry) => void)[]
  >();

  register(entry: ThreadEntry): void {
    const k = this.key(entry.channel, entry.threadTs);
    const list = this.byThread.get(k) ?? [];
    if (list.some((e) => e.bridge === entry.bridge)) {
      return; // already registered for this bridge
    }
    list.push(entry);
    this.byThread.set(k, list);
    const subs = this.sessionSubscribers.get(entry.sessionId);
    if (subs && subs.length > 0) {
      this.sessionSubscribers.delete(entry.sessionId);
      for (const cb of subs) {
        try {
          cb(entry);
        } catch {
          // Subscriber failure must not break registration.
        }
      }
    }
  }

  // Fire `cb` once when a thread is registered for `sessionId`. If the
  // session is already registered, fires on a microtask so callers can
  // always treat it as async. Returns an unsubscribe fn.
  onceForSession(
    sessionId: string,
    cb: (entry: ThreadEntry) => void,
  ): () => void {
    for (const list of this.byThread.values()) {
      const found = list.find((e) => e.sessionId === sessionId);
      if (found) {
        queueMicrotask(() => cb(found));
        return () => {};
      }
    }
    const arr = this.sessionSubscribers.get(sessionId) ?? [];
    arr.push(cb);
    this.sessionSubscribers.set(sessionId, arr);
    return () => {
      const cur = this.sessionSubscribers.get(sessionId);
      if (!cur) {
        return;
      }
      const idx = cur.indexOf(cb);
      if (idx >= 0) {
        cur.splice(idx, 1);
      }
      if (cur.length === 0) {
        this.sessionSubscribers.delete(sessionId);
      }
    };
  }

  unregisterBridge(bridge: SessionBridge): void {
    for (const [k, list] of this.byThread) {
      const filtered = list.filter((e) => e.bridge !== bridge);
      if (filtered.length === 0) {
        this.byThread.delete(k);
      } else if (filtered.length !== list.length) {
        this.byThread.set(k, filtered);
      }
    }
  }

  // Backwards-compatible single-entry lookup. Returns the highest-
  // priority candidate (front of the list). Reaction handlers and
  // callers that only need *some* bridge for a thread (e.g. fetching
  // text) use this.
  lookup(channel: string, threadTs: string): ThreadEntry | undefined {
    return this.byThread.get(this.key(channel, threadTs))?.[0];
  }

  // Locate the entry for `sessionId` across all threads. Used by the
  // block-action handler, which only has a sessionId encoded in the
  // button value and needs the owning bridge.
  findBySession(sessionId: string): ThreadEntry | undefined {
    for (const list of this.byThread.values()) {
      const found = list.find((e) => e.sessionId === sessionId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  // All candidate bridges for a thread, in priority order. Inbound
  // message routing iterates this and falls back on send error.
  lookupAll(channel: string, threadTs: string): ThreadEntry[] {
    return [...(this.byThread.get(this.key(channel, threadTs)) ?? [])];
  }

  // Move the entry for `bridge` on this thread to the front of the
  // candidate list. Called when a bridge proves it owns the session
  // (either by emitting a session/update notification for it, or by
  // successfully servicing an inbound prompt). No-op if `bridge` isn't
  // a candidate, already at the front, or the thread has only one
  // candidate.
  promote(bridge: SessionBridge, channel: string, threadTs: string): void {
    const k = this.key(channel, threadTs);
    const list = this.byThread.get(k);
    if (!list || list.length < 2) {
      return;
    }
    const idx = list.findIndex((e) => e.bridge === bridge);
    if (idx <= 0) {
      return;
    }
    const moved = list.splice(idx, 1);
    if (moved[0]) {
      list.unshift(moved[0]);
    }
  }

  private key(channel: string, threadTs: string): string {
    return `${channel}|${threadTs}`;
  }
}

export const threadRegistry = new ThreadRegistry();

// Build a Slack permalink URL for a session, if we have both the thread
// mapping and the team domain cached. Format matches the shape Slack's
// own `chat.getPermalink` API returns, so links look identical to those
// copied from the Slack UI. Returns undefined when either piece is
// missing — the caller should fall back to a non-clickable rendering.
export function permalinkForSession(sessionId: string): string | undefined {
  const entry = threadRegistry.findBySession(sessionId);
  const domain = getTeamDomain();
  if (!entry || !domain) return undefined;
  const tsNoDot = entry.threadTs.replace(".", "");
  return `https://${domain}.slack.com/archives/${entry.channel}/p${tsNoDot}?thread_ts=${entry.threadTs}&cid=${entry.channel}`;
}
