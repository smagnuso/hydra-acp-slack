import type { Config } from "../config.js";
import { AcpAttach } from "../acp/attach.js";
import { SessionBridge } from "../acp/session.js";
import { consumePendingMessages } from "./resurrect.js";
import { ThreadClient } from "./thread.js";
import { ChannelMap } from "../storage/channels.js";
import { HiddenStore } from "../storage/hidden.js";
import { TruncatedStore } from "../storage/truncated.js";
import { threadRegistry } from "./registry.js";
import { logger } from "../util/log.js";

const log = logger("adopter");

// Subset of HydraSessionInfo the adopter actually needs. Decoupled from
// the discovery type so callers without a full DiscoveryInfo (e.g. the
// !session command path with only `{sessionId, cwd, agentId}` in hand)
// don't have to fabricate a fake one.
export interface AdoptInfo {
  sessionId: string;
  cwd?: string;
  title?: string;
  agentId?: string;
  importedFromMachine?: string;
  upstreamSessionId?: string;
}

export interface AttachContext {
  attach: AcpAttach;
  bridge: SessionBridge;
}

export interface AdopterDeps {
  config: Config;
  thread: ThreadClient;
  channels: ChannelMap;
  truncatedStore: TruncatedStore;
  hiddenStore: HiddenStore;
  bridges: Map<string, AttachContext>;
}

// Creates and wires a SessionBridge for a sessionId. Single primitive
// used by both HydraDiscovery's onAdd (sessions slack didn't originate)
// and the !session / orphan-thread paths (sessions slack does own).
//
// Dedup at the top means concurrent callers (e.g. discovery polling
// after !session already adopted) are safe no-ops, not duplicate
// bridges.
export class SessionAdopter {
  constructor(private readonly deps: AdopterDeps) {}

  adopt(info: AdoptInfo): void {
    const sessionId = info.sessionId;
    if (this.deps.bridges.has(sessionId)) {
      log.debug(`adopt: ${sessionId.slice(0, 8)} already bridged; skip`);
      return;
    }
    log.info(
      `adopt: ${sessionId} agent=${info.agentId ?? "?"} cwd=${info.cwd ?? "?"}`,
    );
    const attach = new AcpAttach({
      sessionId,
      daemonWsUrl: this.deps.config.hydraWsUrl,
      token: this.deps.config.hydraToken,
      // Default attaches request snapshot-only history. Only when the
      // operator opts into backfill do we pull the full conversation
      // (and let the bridge post it into a fresh thread).
      historyPolicy: this.deps.config.backfillHistory ? "full" : "pending_only",
    });
    const initialMessages = consumePendingMessages(sessionId);
    const bridge = new SessionBridge({
      attach,
      config: this.deps.config,
      thread: this.deps.thread,
      channels: this.deps.channels,
      truncatedStore: this.deps.truncatedStore,
      hiddenStore: this.deps.hiddenStore,
      sessionMeta: {
        sessionId,
        cwd: info.cwd,
        title: info.title,
        agentId: info.agentId,
        importedFromMachine: info.importedFromMachine,
        upstreamSessionId: info.upstreamSessionId,
      },
      initialMessages,
      onSessionReferenced: (sid) => this.adoptReferenced(sid),
    });
    attach.on("close", () => {
      // Run bundle upload before teardown so the bridge's channel /
      // threadTs / sessionId are still valid for the upload. cleanup
      // and unregister always run in finally.
      void bridge
        .uploadBundlesOnExit()
        .catch((err: unknown) => {
          log.warn(`bundle upload error: ${(err as Error).message}`);
        })
        .finally(() => {
          bridge.cleanup();
          threadRegistry.unregisterBridge(bridge);
          this.deps.bridges.delete(sessionId);
        });
    });
    attach.on("error", (err) => {
      log.warn(`attach error: ${err.message}`);
    });
    attach.start();
    this.deps.bridges.set(sessionId, { attach, bridge });
  }

  // Look up a session id mentioned in agent output (e.g. hydra:// fork
  // link) and adopt it if the daemon knows about it — including cold
  // sessions, which HydraDiscovery's warm-only poll would otherwise
  // skip. Attaching warms a cold session as a side effect, so the
  // forked session gets a thread and the markdown rewriter can
  // resolve its permalink. Silent no-op on failure / already-adopted;
  // this is a best-effort UX polish, not a critical path.
  private adoptReferenced(sessionId: string): void {
    if (this.deps.bridges.has(sessionId)) {
      return;
    }
    void (async () => {
      try {
        const r = await fetch(
          `${this.deps.config.hydraDaemonUrl}/v1/sessions/${sessionId}`,
          { headers: { Authorization: `Bearer ${this.deps.config.hydraToken}` } },
        );
        if (!r.ok) {
          log.debug(
            `adoptReferenced: ${sessionId.slice(0, 8)} lookup ${r.status}; skip`,
          );
          return;
        }
        const info = (await r.json()) as {
          sessionId?: string;
          cwd?: string;
          title?: string;
          agentId?: string;
          importedFromMachine?: string;
          upstreamSessionId?: string;
        };
        // The daemon accepts either the bare short id (as it appears
        // in hydra:// URLs) or the canonical `hydra_session_...` form
        // on GET /v1/sessions/:id. The response always echoes the
        // canonical id — use it so we don't create a duplicate bridge
        // when HydraDiscovery adopts the same session under the
        // canonical id in parallel.
        const canonical = info.sessionId ?? sessionId;
        if (this.deps.bridges.has(canonical)) {
          return;
        }
        this.adopt({
          sessionId: canonical,
          cwd: info.cwd,
          title: info.title,
          agentId: info.agentId,
          importedFromMachine: info.importedFromMachine,
          upstreamSessionId: info.upstreamSessionId,
        });
      } catch (err) {
        log.debug(
          `adoptReferenced ${sessionId.slice(0, 8)} error: ${(err as Error).message}`,
        );
      }
    })();
  }
}

// Used by callers (createSlackApp) that need an adopter reference at
// handler-registration time but can only construct the real adopter
// later (after Slack's app + thread client are ready). Set `current`
// once the adopter is constructed; consumers check current != null.
export interface AdopterRef {
  current: SessionAdopter | null;
}
