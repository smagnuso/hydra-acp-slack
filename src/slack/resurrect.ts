import bolt from "@slack/bolt";
import { AcpAttach } from "../acp/attach.js";
import type { Config } from "../config.js";
import { logger } from "../util/log.js";
import { SESSION_MARKER_RE, canonicalSessionId } from "./thread.js";

const log = logger("resurrect");

export interface PendingMessage {
  text: string;
  images: ReadonlyArray<{ type: "image" | "audio"; mimeType: string; data: string }>;
  // Parsed-bang slash form (e.g. `/hydra compact`) when the buffered
  // text was a `!foo bar` bang. Resolved against the bridge's
  // available_commands_update at replay time so cold-session
  // resurrection still routes slash commands instead of forwarding
  // them as plain user prompts. Undefined for non-bang text.
  slashCandidate?: string;
}

// Messages waiting for their session's bridge to come up. Filled by
// `!session` (with the optional initial prompt) and by the resurrection
// path in app.message. Drained by index.ts in onAdd, where each entry
// is forwarded to the freshly-attached bridge once it has opened the
// thread.
const pendingMessages = new Map<string, PendingMessage[]>();

// Resurrect attempts in flight. Acts as a coalescing guard so a burst
// of typed Slack messages on a cold thread doesn't fan out into a burst
// of WS connects.
const resurrectInFlight = new Set<string>();

export function bufferPendingMessage(
  sessionId: string,
  msg: PendingMessage,
): void {
  const list = pendingMessages.get(sessionId) ?? [];
  list.push(msg);
  pendingMessages.set(sessionId, list);
}

export function consumePendingMessages(sessionId: string): PendingMessage[] {
  const list = pendingMessages.get(sessionId) ?? [];
  pendingMessages.delete(sessionId);
  return list;
}

// Fetch a thread's parent message and pull the session id out of its
// `_session <id>_` marker. Returns undefined if the thread isn't ours
// or Slack doesn't return a parent.
export async function findSessionIdForThread(
  app: bolt.App,
  channel: string,
  threadTs: string,
): Promise<string | undefined> {
  try {
    const res = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 1,
      inclusive: true,
    });
    const msg = res.messages?.[0];
    if (!msg || typeof msg.text !== "string") {
      return undefined;
    }
    const match = SESSION_MARKER_RE.exec(msg.text);
    const id = match?.[1];
    if (!id) {
      return undefined;
    }
    // New threads omit the "hydra_session_" prefix in the marker; old
    // threads include it. Normalise both back to the full session id.
    return canonicalSessionId(id);
  } catch (err) {
    log.warn(`thread parent fetch failed: ${(err as Error).message}`);
    return undefined;
  }
}

// Look up a specific session in the daemon's /v1/sessions view. Passes
// includeNonInteractive=true so we find rows that haven't seen a
// user prompt yet — orphan-thread recovery typically lands here, since
// such sessions are filtered out of the default view.
export async function fetchSessionInfo(
  config: Config,
  sessionId: string,
): Promise<
  | {
      sessionId: string;
      cwd: string;
      title?: string;
      agentId?: string;
      importedFromMachine?: string;
      upstreamSessionId?: string;
    }
  | undefined
> {
  try {
    const r = await fetch(
      `${config.hydraDaemonUrl}/v1/sessions?includeNonInteractive=true`,
      {
        headers: { Authorization: `Bearer ${config.hydraToken}` },
      },
    );
    if (!r.ok) {
      log.warn(`fetchSessionInfo: GET /v1/sessions returned ${r.status}`);
      return undefined;
    }
    const body = (await r.json()) as {
      sessions: Array<{
        sessionId: string;
        cwd: string;
        title?: string;
        agentId?: string;
        importedFromMachine?: string;
        upstreamSessionId?: string;
      }>;
    };
    return body.sessions.find((s) => s.sessionId === sessionId);
  } catch (err) {
    log.warn(`fetchSessionInfo failed: ${(err as Error).message}`);
    return undefined;
  }
}

// Open a transient WS to hydra, run initialize + session/attach, close.
// If the session is cold on disk, hydra runs loadFromDisk + resurrect to
// bring it back live before responding to attach. Once the daemon's
// next /v1/sessions poll fires, HydraDiscovery sees it as live and
// onAdd creates a real SessionBridge that drains the pending messages.
export async function attemptResurrect(
  config: Config,
  sessionId: string,
): Promise<void> {
  if (resurrectInFlight.has(sessionId)) {
    return;
  }
  resurrectInFlight.add(sessionId);
  try {
    const attach = new AcpAttach({
      sessionId,
      daemonWsUrl: config.hydraWsUrl,
      token: config.hydraToken,
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        fn();
      };
      attach.once("open", () => finish(resolve));
      attach.once("error", (err) => finish(() => reject(err)));
      attach.once("close", ({ hadError }) =>
        finish(() =>
          reject(new Error(`ws closed${hadError ? " with error" : ""}`)),
        ),
      );
      attach.start();
    });
    log.info(`resurrected ${sessionId.slice(0, 8)}`);
    attach.stop();
  } finally {
    resurrectInFlight.delete(sessionId);
  }
}
