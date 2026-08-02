import { homedir } from "node:os";
import { basename } from "node:path";
import type { HydraSessionInfo } from "../hydra-discovery.js";
import { logger } from "../util/log.js";
import { getTeamDomain, threadRegistry } from "./registry.js";
import type { ThreadClient } from "./thread.js";

const log = logger("session-index");

// Embedded in the index message text so the message can be recovered
// after a bridge restart. There is no on-disk record of its ts — the
// marker is the database, exactly as with `_session <id>_` thread
// parents. Never change this string without a migration: an old index
// message would be orphaned (pinned, stale, and never updated again).
export const INDEX_MARKER = "_hydra-session-index_";

export interface SessionIndexOptions {
  thread: ThreadClient;
  // Warm sessions, as most recently seen by discovery.
  currentSessions: () => HydraSessionInfo[];
  intervalMs: number;
}

interface IndexRow {
  sessionId: string;
  title: string;
  cwd: string;
  agentId: string | undefined;
  threadTs: string;
}

function tildify(p: string): string {
  const home = homedir();
  if (p === home) {
    return "~";
  }
  return p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

function permalink(channel: string, threadTs: string, domain: string): string {
  const tsNoDot = threadTs.replace(".", "");
  return `https://${domain}.slack.com/archives/${channel}/p${tsNoDot}?thread_ts=${threadTs}&cid=${channel}`;
}

// Slack link labels break on unescaped angle brackets and pipes.
function linkLabel(s: string): string {
  return s.replace(/[<>|]/g, " ").trim();
}

// One pinned message per channel listing the warm sessions whose thread
// lives in that channel, each linking straight to its thread. Solves
// "which thread am I on" when switching from the TUI to Slack.
//
// Refresh is a polled diff rather than an event subscription: discovery
// fires onAdd/onRemove at a 2s cadence, but a session isn't linkable
// until its thread has been registered, which happens later and
// asynchronously. Re-deriving the whole picture on a timer and only
// calling chat.update when the rendered text actually changed handles
// both without per-event coalescing logic.
export class SessionIndex {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private inFlight = false;
  // channel -> ts of that channel's index message.
  private indexTs = new Map<string, string>();
  // channel -> last text we successfully sent, for change detection.
  private lastText = new Map<string, string>();
  private pinned = new Set<string>();

  constructor(private readonly opts: SessionIndexOptions) {}

  start(): void {
    log.info(`starting (interval=${this.opts.intervalMs}ms)`);
    this.timer = setInterval(() => {
      void this.refreshNow();
    }, this.opts.intervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // Public so tests can drive a single pass deterministically.
  async refreshNow(): Promise<void> {
    if (this.stopped || this.inFlight) {
      return;
    }
    // Every row is a link, so there is nothing worth posting until the
    // startup auth.test has cached the team domain. Skipping entirely
    // avoids publishing a linkless index that we'd immediately rewrite.
    const domain = getTeamDomain();
    if (!domain) {
      return;
    }
    this.inFlight = true;
    try {
      const byChannel = this.collect();
      // Channels that had rows before must still be rendered once they
      // empty out, otherwise the index freezes showing dead sessions.
      for (const channel of this.indexTs.keys()) {
        if (!byChannel.has(channel)) {
          byChannel.set(channel, []);
        }
      }
      for (const [channel, rows] of byChannel) {
        await this.renderChannel(channel, rows, domain);
      }
    } catch (err) {
      log.debug(`refresh error: ${(err as Error).message}`);
    } finally {
      this.inFlight = false;
    }
  }

  // Join the warm set against registered threads. A warm session with
  // no thread yet is omitted rather than listed without a link — it
  // appears on a later tick, once adoption completes.
  private collect(): Map<string, IndexRow[]> {
    const warm = new Map<string, HydraSessionInfo>();
    for (const s of this.opts.currentSessions()) {
      warm.set(s.sessionId, s);
    }
    const out = new Map<string, IndexRow[]>();
    const seen = new Set<string>();
    for (const entry of threadRegistry.entries()) {
      // Multiple bridges can share a thread during a daemon-restart
      // overlap; the session should still be listed exactly once.
      if (seen.has(entry.sessionId)) {
        continue;
      }
      const info = warm.get(entry.sessionId);
      if (!info) {
        continue;
      }
      seen.add(entry.sessionId);
      const rows = out.get(entry.channel) ?? [];
      rows.push({
        sessionId: entry.sessionId,
        title: info.title?.trim() || basename(info.cwd) || info.sessionId,
        cwd: info.cwd,
        agentId: info.agentId,
        threadTs: entry.threadTs,
      });
      out.set(entry.channel, rows);
    }
    // Stable ordering: an unstable sort would churn chat.update on
    // every tick for an otherwise unchanged session set.
    for (const rows of out.values()) {
      rows.sort(
        (a, b) => a.cwd.localeCompare(b.cwd) || a.sessionId.localeCompare(b.sessionId),
      );
    }
    return out;
  }

  private render(channel: string, rows: IndexRow[], domain: string): string {
    const lines = [`:fire: *Warm hydra sessions* (${rows.length})`];
    if (rows.length === 0) {
      lines.push("_none right now_");
    }
    for (const r of rows) {
      const url = permalink(channel, r.threadTs, domain);
      const parts = [`<${url}|${linkLabel(r.title)}>`, `\`${tildify(r.cwd)}\``];
      if (r.agentId) {
        parts.push(r.agentId);
      }
      lines.push(`• ${parts.join("  ·  ")}`);
    }
    lines.push(INDEX_MARKER);
    return lines.join("\n");
  }

  private async renderChannel(
    channel: string,
    rows: IndexRow[],
    domain: string,
  ): Promise<void> {
    const text = this.render(channel, rows, domain);
    if (this.lastText.get(channel) === text) {
      return;
    }
    const ts = await this.ensureMessage(channel, rows, text);
    if (!ts) {
      return;
    }
    // ensureMessage posts with the final text when creating, so only an
    // existing message needs updating.
    if (this.lastText.get(channel) !== text) {
      await this.opts.thread.updateMessage(channel, ts, text);
      this.lastText.set(channel, text);
    }
    if (!this.pinned.has(channel)) {
      // Best-effort: without pins:write this fails every tick, so only
      // retry while the channel has content worth pinning.
      if (await this.opts.thread.pinMessage(channel, ts)) {
        this.pinned.add(channel);
      }
    }
  }

  private async ensureMessage(
    channel: string,
    rows: IndexRow[],
    text: string,
  ): Promise<string | undefined> {
    const known = this.indexTs.get(channel);
    if (known) {
      return known;
    }
    const found = await this.opts.thread.findMarkedMessage(channel, INDEX_MARKER);
    if (found) {
      this.indexTs.set(channel, found);
      return found;
    }
    // Don't create an empty index in a channel that has never hosted a
    // session — a channel only earns a pinned message once it has one.
    if (rows.length === 0) {
      return undefined;
    }
    try {
      const res = await this.opts.thread.postMessage({ channel, text });
      this.indexTs.set(channel, res.ts);
      this.lastText.set(channel, text);
      return res.ts;
    } catch (err) {
      log.warn(`could not post index in ${channel}: ${(err as Error).message}`);
      return undefined;
    }
  }
}
