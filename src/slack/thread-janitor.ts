import type { ChannelMap } from "../storage/channels.js";
import { logger } from "../util/log.js";
import type { ThreadClient } from "./thread.js";

const log = logger("janitor");

export interface ThreadJanitorOptions {
  thread: ThreadClient;
  channels: ChannelMap;
  slackChannelId: string | undefined;
  daemonUrl: string;
  token: string;
  deleteEnabled: boolean;
  isLiveBridge: (sessionId: string) => boolean;
  intervalMs: number;
  settleMs: number;
}

// Cap acted-on entries per sweep so a misconfiguration cannot flood
// Slack. Each delete walks conversations.replies and issues one
// chat.delete per message (replies + parent), so even a modest cap can
// translate to dozens of API calls. Spillover stays in pendingDelete
// and is picked up on the next sweep.
const PER_SWEEP_CAP = 3;

interface DaemonSessionListResponse {
  sessions?: Array<{ sessionId?: string }>;
}

// Periodic janitor: scans known Slack channels for `_session <id>_`
// thread-parent markers whose sessionId is missing from the daemon's
// full session list (live + cold).
//
// Delete mode: a candidate must miss two consecutive sweeps before
// chat.delete fires, so a transient daemon read failure cannot
// orphan-delete a live thread.
//
// Dry-run mode (deleteEnabled === false): logs "would delete …" on
// first detection so users see results promptly. Each (channel, ts)
// is logged at most once per process lifetime to keep the log quiet;
// if the session reappears in the daemon list the entry is forgotten
// so it can re-log later if it disappears again.
export class ThreadJanitor {
  private timer: NodeJS.Timeout | undefined;
  private firstTimer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private stopped = false;
  private pendingDelete = new Set<string>();
  private dryRunLogged = new Set<string>();

  constructor(private readonly opts: ThreadJanitorOptions) {}

  start(): void {
    log.info(
      `starting (mode=${this.opts.deleteEnabled ? "delete" : "dry-run"} ` +
        `interval=${this.opts.intervalMs}ms settle=${this.opts.settleMs}ms)`,
    );
    this.firstTimer = setTimeout(() => {
      this.firstTimer = undefined;
      void this.sweep();
      this.timer = setInterval(() => {
        void this.sweep();
      }, this.opts.intervalMs);
      if (typeof this.timer.unref === "function") {
        this.timer.unref();
      }
    }, this.opts.settleMs);
    if (typeof this.firstTimer.unref === "function") {
      this.firstTimer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.firstTimer) {
      clearTimeout(this.firstTimer);
      this.firstTimer = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private channelSet(): string[] {
    const out = new Set<string>();
    for (const c of this.opts.channels.values()) {
      if (c) {
        out.add(c);
      }
    }
    if (this.opts.slackChannelId) {
      out.add(this.opts.slackChannelId);
    }
    return [...out];
  }

  private async fetchDaemonSessionIds(): Promise<Set<string> | undefined> {
    try {
      const r = await fetch(`${this.opts.daemonUrl}/v1/sessions`, {
        headers: { Authorization: `Bearer ${this.opts.token}` },
      });
      if (!r.ok) {
        log.warn(`daemon /v1/sessions returned ${r.status}; aborting sweep`);
        return undefined;
      }
      const body = (await r.json()) as DaemonSessionListResponse;
      const ids = new Set<string>();
      for (const s of body.sessions ?? []) {
        if (typeof s.sessionId === "string" && s.sessionId.length > 0) {
          ids.add(s.sessionId);
        }
      }
      return ids;
    } catch (err) {
      log.warn(
        `daemon /v1/sessions fetch failed: ${(err as Error).message}; aborting sweep`,
      );
      return undefined;
    }
  }

  private async sweep(): Promise<void> {
    if (this.stopped || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      const daemonIds = await this.fetchDaemonSessionIds();
      if (!daemonIds) {
        this.pendingDelete.clear();
        return;
      }
      const channels = this.channelSet();
      if (channels.length === 0) {
        this.pendingDelete.clear();
        return;
      }

      // Collect this sweep's candidates first (full pass), then act on
      // the intersection with last sweep's pendingDelete. Acting only
      // after the full pass keeps the cap meaningful even when scanning
      // multiple channels.
      const candidates: Array<{
        sessionId: string;
        channel: string;
        threadTs: string;
        key: string;
      }> = [];
      const seenSessionIds = new Set<string>();
      for (const channel of channels) {
        const threads = await this.opts.thread.listSessionThreads(channel);
        for (const { sessionId, threadTs } of threads) {
          seenSessionIds.add(sessionId);
          if (this.opts.isLiveBridge(sessionId)) {
            continue;
          }
          if (daemonIds.has(sessionId)) {
            continue;
          }
          candidates.push({
            sessionId,
            channel,
            threadTs,
            key: `${channel}|${threadTs}`,
          });
        }
      }

      // Forget dry-run log entries for sessions that no longer appear
      // in any scanned thread (or that reappeared in the daemon list),
      // so a future disappearance re-logs.
      for (const key of [...this.dryRunLogged]) {
        const sessionPart = key.split("§")[0] ?? "";
        if (!sessionPart || daemonIds.has(sessionPart)) {
          this.dryRunLogged.delete(key);
        }
      }

      const nextPending = new Set<string>();
      let acted = 0;
      for (const c of candidates) {
        if (this.opts.deleteEnabled) {
          // Delete mode: two-sweep gate so a transient daemon read
          // failure can't orphan-delete a live thread.
          if (!this.pendingDelete.has(c.key)) {
            log.info(
              `abandoned thread detected session=${c.sessionId} channel=${c.channel} ts=${c.threadTs} (will delete on next sweep)`,
            );
            nextPending.add(c.key);
            continue;
          }
          if (acted >= PER_SWEEP_CAP) {
            nextPending.add(c.key);
            continue;
          }
          acted += 1;
          log.info(
            `deleting abandoned thread session=${c.sessionId} channel=${c.channel} ts=${c.threadTs}`,
          );
          const n = await this.opts.thread.deleteThread(
            c.channel,
            c.threadTs,
          );
          log.info(
            `deleted ${n} message(s) from thread session=${c.sessionId} channel=${c.channel} ts=${c.threadTs}`,
          );
        } else {
          // Dry-run: log on first detection, dedupe per process lifetime.
          // No per-sweep cap: only local log.info, no Slack API calls.
          const dedupeKey = `${c.sessionId}§${c.channel}|${c.threadTs}`;
          if (this.dryRunLogged.has(dedupeKey)) {
            continue;
          }
          this.dryRunLogged.add(dedupeKey);
          log.info(
            `would delete abandoned thread session=${c.sessionId} channel=${c.channel} ts=${c.threadTs} (set DELETE_ABANDONED_THREADS=true to enable)`,
          );
        }
      }
      this.pendingDelete = nextPending;
    } finally {
      this.inFlight = false;
    }
  }
}
