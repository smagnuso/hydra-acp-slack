import { hostname } from "node:os";
import { basename } from "node:path";
import type { Config } from "../config.js";
import {
  buildHighlightBlocks,
  fitsBlockLimits,
  toSlackMrkdwn,
  type SlackBlock,
} from "../formatters/markdown.js";
import {
  type ToolCallStatus,
  renderToolCallHeader,
  statusIcon,
} from "../formatters/tool-call.js";
import type { ReactionAction } from "../slack/reaction-map.js";
import { threadRegistry } from "../slack/registry.js";
import type { PendingMessage } from "../slack/resurrect.js";
import { ChannelMap } from "../storage/channels.js";
import { HiddenStore } from "../storage/hidden.js";
import { TruncatedStore, fullExpand, truncate } from "../storage/truncated.js";
import { sessionMarker, type ThreadClient } from "../slack/thread.js";
import { logger } from "../util/log.js";
import type { AcpAttach } from "./attach.js";
import { fetchHydraBundleText } from "./hydra-bundle.js";
import type { JsonRpcNotification, JsonRpcRequest } from "./protocol.js";

const log = logger("session");

// Cap each streamed agent Slack message at this many rendered chars.
// Slack's documented chat.postMessage text limit is 40k, but the server
// renders text into rich_text blocks and a single rich_text_section text
// element is capped at ~4000 chars — long agent responses would fail
// chat.update with msg_too_long once they crossed that line. We split at
// a comfortable margin below it and roll over into continuation messages
// in the same thread.
const SLACK_MESSAGE_LIMIT = 3500;

// Pick a split offset within `text` no greater than `limit`. Prefers the
// last paragraph break (\n\n), then the last newline, then a sentence
// boundary, then the hard cap. The aim is to break between paragraphs or
// list items where possible, so each Slack message reads naturally on
// its own and broken formatting (half-open code fences, dangling list
// markers) is rare. A `limit/2` floor on the resulting head length keeps
// us from producing absurdly tiny messages when only an early break is
// available.
export function findSplitPoint(text: string, limit: number): number {
  const window = text.slice(0, limit);
  const floor = limit / 2;

  const paraIdx = window.lastIndexOf("\n\n");
  if (paraIdx !== -1 && paraIdx + 2 >= floor) {
    return paraIdx + 2;
  }
  const nlIdx = window.lastIndexOf("\n");
  if (nlIdx !== -1 && nlIdx + 1 >= floor) {
    return nlIdx + 1;
  }
  const sentIdx = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
  );
  if (sentIdx !== -1 && sentIdx + 2 >= floor) {
    return sentIdx + 2;
  }
  return limit;
}

interface QueuedPromptEntry {
  text: string;
  promptTs: string | undefined;
  cancelled: boolean;
  started: boolean;
  // Server-assigned id from hydra-acp/prompt_queue_added. Undefined
  // between the local enqueue and the daemon's accept; once bound,
  // used as the target for hydra-acp/cancel_prompt (instead of local
  // chain splicing) so peers see the cancellation too, and as the key
  // for prompt_queue_updated to refresh the Slack indicator text when
  // another client edits this queued prompt.
  messageId?: string;
  // ts of the user's original Slack message (the one they typed).
  // Distinct from promptTs (which is the bot's `_queued_` indicator).
  // Populated when the message handler passes it through; lets edits
  // and deletes of the source message reach this entry.
  sourceSlackTs?: string;
  // Captured at enqueue time. We need these to rebuild the prompt
  // blocks on update_prompt — Slack edits only update text, so any
  // images attached to the original message must be re-sent unchanged.
  imageBlocks: ReadonlyArray<{ type: "image"; mimeType: string; data: string }>;
  // Captured at enqueue time so handlePromptQueueUpdated can re-render
  // the indicator with the same "· N ahead" suffix the original post
  // showed. Without this, edits silently drop the suffix and the user
  // loses queue-position context after editing a queued prompt.
  initialAheadCount: number;
  // Pending text edit that arrived before messageId was bound. Applied
  // in handlePromptQueueAdded after FIFO binding completes.
  pendingEditText?: string;
  // True if a message_deleted arrived before binding. Applied in
  // handlePromptQueueAdded by firing cancel_prompt immediately after
  // binding.
  pendingCancel?: boolean;
  // Barrier the prompt_queue_removed{started} handler awaits before
  // posting the Processing indicator for this entry. Captures the
  // session-level pendingOwnTurnEnd as it was *at the moment this
  // entry was enqueued* — i.e. the Ready-barrier of whichever own
  // turn was already running (or none, in which case undefined).
  // Stashed per-entry instead of read from session at handler time
  // because by then session.pendingOwnTurnEnd has been chained past
  // (each sendUserPrompt installs its own barrier synchronously) and
  // would point to *this* entry's barrier — a self-wait deadlock.
  waitForPriorReady?: Promise<void>;
}

// Tracks a Slack indicator we posted for a PEER-originated queued
// prompt (one another client like the TUI or browser queued, surfaced
// in this thread for cross-client visibility). Separate from
// QueuedPromptEntry because peer prompts have no in-flight session/
// prompt request on this side — they're pure display state driven
// entirely by hydra-acp/prompt_queue_* notifications.
interface PeerQueueIndicator {
  messageId: string;
  promptTs: string;
  text: string;
  // Name from sentBy / originator.name on the wire ("hydra-acp-tui",
  // "hydra-acp-browser", etc.). Used to attribute the indicator with
  // "(from <name>)" so Slack viewers know who queued it.
  originatorName: string | undefined;
}

interface ToolCallState {
  toolCallId: string;
  threadMessageTs: string | undefined;
  status: ToolCallStatus | string | undefined;
  title: string | undefined;
  kind: string | undefined;
  bodyChunks: string[];
}

interface SessionState {
  sessionId: string;
  threadTs: string | undefined;
  channel: string;
  // Pending tool calls in flight, keyed by toolCallId.
  toolCalls: Map<string, ToolCallState>;
  // Streaming agent message. Chunks accumulate for the lifetime of one
  // agent message; flushAgentMessage posts on the first flush and updates
  // the same Slack message on subsequent flushes, so one agent burst
  // shows up as one live-streaming Slack message rather than fragmenting
  // each time the periodic flush fires. closeAgentMessage clears these
  // (called on turn_complete, before tool cards, before sibling user
  // messages, etc.) so the next stream begins a fresh Slack message.
  agentChunks: string[];
  agentMessageTs: string | undefined;
  // Last text written to Slack for the currently-open agent message; used
  // to skip no-op updates when a flush fires with no new chunks.
  agentLastSent: string | undefined;
  // Offset into the rendered text (toSlackMrkdwn(agentChunks.join(""))) at
  // which the currently-open Slack message begins. Advances when a flush
  // rolls over into a continuation message after hitting Slack's
  // per-message size limit; reset to 0 in closeAgentMessage.
  agentRenderedBase: number;
  // Per-session flush serializer. Concurrent calls (periodic timer +
  // turn_complete arm + user_message_chunk arm + own-turn end after
  // session/prompt) would otherwise race on agentMessageTs — both seeing
  // it undefined, both calling postMessage, producing two Slack messages
  // for one agent burst. Each flush queues onto this chain so the
  // post-and-set-ts step is effectively atomic.
  agentFlushChain: Promise<void> | undefined;
  // Per-prompt entries for own (slack-originated) queued prompts.
  // Pushed when sendUserPrompt fires session/prompt to hydra; bound
  // to a server messageId when prompt_queue_added with our originator
  // arrives; removed when the corresponding session/prompt response
  // resolves. Carries the Slack indicator's ts so :stop_sign:
  // reactions can target the right entry.
  queuedPrompts: QueuedPromptEntry[];
  // messageId → queued entry for hydra-acp/prompt_queue_updated and
  // prompt_queue_removed notifications. Populated when a
  // prompt_queue_added with our originator binds to a FIFO-head
  // unbound entry in queuedPrompts. Lets cross-client edits / cancels
  // reach our locally-tracked entry (and its Slack indicator message).
  queueByMessageId: Map<string, QueuedPromptEntry>;
  // messageId → peer queue indicator. Tracked separately from
  // queueByMessageId (own entries) so the peer-rendering code paths
  // can iterate without colliding with the local-chain types. Reused
  // both for live prompt_queue_added events from peers and for
  // attach-snapshot hydration on first connection.
  peerQueueByMessageId: Map<string, PeerQueueIndicator>;
  // sourceSlackTs → own queued entry. Populated when sendUserPrompt
  // is called with a sourceSlackTs; cleaned on entry removal. Used by
  // the Slack message_changed / message_deleted handlers to find the
  // entry corresponding to an edited or deleted source message.
  sourceTsToEntry: Map<string, QueuedPromptEntry>;
  // ts of the bot's `_processing …_` indicator for the currently-
  // running own prompt (the message posted by
  // markQueueIndicatorProcessing). Tracked so `:stop_sign:` reactions
  // on it can fire session/cancel, matching the gesture available on
  // the spinner. Singleton per session — one prompt runs at a time.
  // Cleared in finalizeSpinnerWork at turn end.
  processingTs: string | undefined;
  // Streaming user message from another frontend attached to the same
  // session (e.g. the editor's stdio shim). Same flush model as agent.
  userChunks: string[];
  // Last known title for chat.update of the thread header.
  title: string | undefined;
  // CWD of the session (used for per-project channel mapping).
  cwd: string | undefined;
  // Per-session agent state observed from streaming notifications.
  // modeId tracks current_mode_update; modelId tracks
  // current_model_update (hydra synthesizes both on the corresponding
  // session/set_* responses). Usage fields track usage_update
  // notifications: contextUsed/Size are token counts for the active
  // context window; cost is the running cost the agent reports for the
  // session.
  modeId: string | undefined;
  modelId: string | undefined;
  contextUsed: number | undefined;
  contextSize: number | undefined;
  costAmount: number | undefined;
  costCurrency: string | undefined;
  // Per-turn collapsed spinner state. While the agent is running tools,
  // a single Slack message replaces the per-tool-call cards: collapsed
  // to ":hourglass_flowing_sand: _working..._" by default, expanded to
  // a header list of tool calls when the user reacts :eyes: on it.
  // Deleted entirely at turn end so the thread doesn't accumulate
  // mechanical tool-call clutter.
  spinnerTs: string | undefined;
  spinnerExpanded: boolean;
  // Tool-call ids that have appeared in this turn, in order, so the
  // expanded view can list them. The full state for each is in
  // session.toolCalls (keyed by id). Cleared on turn end.
  turnToolCallIds: string[];
  // Per-session spinner serializer. Without this, two tool-call
  // notifications arriving close together both see spinnerTs ===
  // undefined, both call postMessage, and produce two Slack spinner
  // messages — only the second's ts gets stored, so the first is
  // orphaned and never updated/finalized. Same race shape as
  // agentFlushChain.
  spinnerChain: Promise<void> | undefined;
  // Wall-clock time (ms since epoch) when the current spinner was
  // posted. Used to render an elapsed-time indicator on the spinner
  // head so the user can see the agent is still alive on long turns.
  // Cleared at finalize.
  spinnerStartedAt: number | undefined;
  // Slack ts of the current turn's plan message. Each plan
  // notification redelivers the full updated plan, so we chat.update
  // in place rather than posting a fresh message per delta. Cleared
  // at turn end alongside the spinner.
  planTs: string | undefined;
  // Barrier resolved once the current own-turn's Ready marker has
  // posted. Set synchronously in sendUserPrompt before we await
  // session/prompt — so it exists before the daemon's
  // prompt_queue_removed{started} for the *next* turn can possibly
  // be observed by handlePromptQueueRemoved. That handler awaits
  // this barrier before posting the Processing indicator, which is
  // what keeps Ready (previous turn) → Processing (next turn) in
  // visual order. Without it the chain ordering between the
  // session/prompt response continuation and the notification arm
  // is undefined — the daemon emits prompt_queue_removed{started}
  // as soon as it dequeues the next prompt, which can happen in the
  // same tick as the response. Cleared in the tail after Ready posts.
  pendingOwnTurnEnd: Promise<void> | undefined;
  // True once this daemon run has seen any session/update notification
  // for this session. Eager-attached sessions (materialized from a
  // marker scan at startup) start false and stay false until a real
  // notification comes in — used to scope bundle-on-exit uploads
  // to sessions that actually did something this run, not every old
  // thread we know how to route to.
  hadActivity: boolean;
  // 30-second timer that re-renders the spinner so its elapsed-time
  // suffix advances during long turns. Cleared at finalize and on
  // bridge cleanup.
  spinnerTicker: NodeJS.Timeout | undefined;
  // Slash command names (with leading "/") advertised by the daemon for
  // this session: the union of /hydra verbs and the backing agent's
  // commands. Refreshed on every available_commands_update. Used to
  // route `!<verb>` bangs and produce a useful error for typos.
  availableCommands: Map<string, string | undefined>;
  // Identifier of the backing agent process for this session
  // (e.g. "claude-acp", "codex-acp"). Seeded from sessionMeta.agentId at
  // attach time and rotated on session_info_update when /hydra agent
  // emits a new agentId in _meta["hydra-acp"]. Used for the thread
  // parent header so the agent label tracks the live backing agent
  // instead of staying frozen at whatever was attached first.
  agentId: string | undefined;
}

export interface SessionBridgeOptions {
  attach: AcpAttach;
  config: Config;
  thread: ThreadClient;
  channels: ChannelMap;
  truncatedStore: TruncatedStore;
  hiddenStore: HiddenStore;
  // Session-level metadata sourced from hydra's HydraSessionInfo.
  // Provides the cwd / title / agentId we'd previously bootstrap by
  // calling `session/list` over the WS attach. With one bridge per
  // hydra session, these are known up front.
  sessionMeta: {
    sessionId: string;
    cwd: string | undefined;
    title: string | undefined;
    agentId: string | undefined;
    // Set when the session was imported from another machine. A
    // session is treated as foreign — and thus skipped by slack —
    // only when this is set AND upstreamSessionId is empty (passive
    // mirror). Once a local agent binds upstreamSessionId, the
    // session graduates to local and slack reflects it normally.
    importedFromMachine?: string;
    // Local ACP agent's session id once one has bound this session
    // here. Empty for passive mirrors.
    upstreamSessionId?: string;
  };
  // Messages buffered while the bridge wasn't yet up — typed in slack
  // against a cold thread (resurrection path) or queued by !session for
  // a session whose bridge hadn't booted yet. Forwarded to the agent
  // in order via sendUserPrompt as soon as the bridge attach opens
  // and the slack thread is ready.
  initialMessages?: ReadonlyArray<PendingMessage>;
}

// One SessionBridge per hydra session. The discovery layer
// (HydraDiscovery) creates a bridge for each live session it sees;
// each bridge owns one WS attach to /acp on hydra and renders that
// session's traffic into a Slack thread.
//
// Replay handling: hydra replays cached history on attach. We don't
// want each replayed event posting to Slack (rate limits, noise). The
// bridge starts in `replay` mode where every frame resets a quiet
// timer; once the timer fires (~2s of inbound silence) we flip to
// `live` and start posting. Replayed events still build internal
// state so we know about in-flight tool calls, we just don't surface
// them.
export class SessionBridge {
  private sessions = new Map<string, SessionState>();
  // While a session's thread is being opened, concurrent notifications
  // arriving on the same sessionId all await this single promise so we
  // never open two threads or post into the channel before the parent ts
  // is known.
  private creating = new Map<string, Promise<SessionState | undefined>>();
  // available_commands_update payloads that arrive before a SessionState
  // exists (typically during the attach replay window, when the bridge
  // hasn't yet flipped to `live` and createSession hasn't run). Latest
  // wins, keyed by sessionId. Drained into SessionState.availableCommands
  // at createSession time so the routing map is non-empty by the time
  // the first live `!<verb>` arrives.
  private pendingCommands = new Map<
    string,
    Map<string, string | undefined>
  >();
  // String(requestId) -> resolver for any in-flight permission request
  // awaiting a Slack reaction. Keyed by toolCallId (per RFD #533) — that's
  // the wire-stable correlator the daemon broadcasts on permission_resolved
  // events. An agent can have multiple permission requests pending on the
  // same session simultaneously (parallel tool invocations); each carries
  // its own toolCallId so collisions are not a concern.
  permissionResolvers = new Map<
    string,
    {
      requestId: string | number;
      sessionId: string;
      toolCallId: string;
      options: Array<{ optionId: string; name: string; kind?: string }>;
      // Slack ts of the posted ":lock: Permission requested" message.
      // Reactions on this ts route to *this* entry; resolution
      // notifications match by requestId; the chat.delete cleanup uses
      // the same ts. promptChannel pairs with promptTs for delete.
      promptTs: string | undefined;
      promptChannel: string | undefined;
      // Pending setTimeout that will release handlePermissionRequest
      // after config.permissionDisplayDelayMs. Both the timer firing
      // and a sibling-driven resolvePermissionEntry call wake the
      // waiter via wakeDelay() — wakeDelay clears the timer and
      // resolves the await so the handler doesn't leak. Undefined
      // once the delay window has ended (one way or the other).
      displayTimer: NodeJS.Timeout | undefined;
      // Resolver for the delay-window await. Set when
      // handlePermissionRequest starts the timer; called by
      // wakeDelay() either from the timer callback (display the
      // prompt) or from resolvePermissionEntry (sibling resolved
      // first, suppress the prompt). Undefined after wake.
      wakeDelay: (() => void) | undefined;
      // True once the resolver has been torn down via
      // resolvePermissionEntry. handlePermissionRequest checks this
      // after the delay-await returns and skips posting if a sibling
      // resolved during the delay window.
      resolved: boolean;
      // When the user resolved via a Block Kit button, the click
      // handler already overwrote the prompt with a "decided by @user"
      // line via chat.update. Setting this flag tells
      // resolvePermissionEntry to leave the message alone instead of
      // deleting it. Sibling-resolved and ensureSession-failed paths
      // leave this false so the prompt still gets cleaned up.
      suppressDelete?: boolean;
    }
  >();
  // When backfillHistory is true, we surface every replayed event. When
  // false (the default), we discard the proxy's history replay and only
  // post Slack messages once the inbound stream has been quiet for
  // `liveQuietMs`. See SessionBridge class doc.
  private live: boolean;
  private liveTimer: NodeJS.Timeout | undefined;

  // Texts of session/prompt requests we sent ourselves, kept around so
  // we can suppress the user_message_chunk that hydra fans back out to
  // all attached frontends (us included). FIFO per session; entries
  // time out so we don't leak if the proxy doesn't echo.
  private recentOwnPrompts = new Map<
    string,
    Array<{ text: string; at: number }>
  >();
  private static readonly OWN_PROMPT_TTL_MS = 60_000;

  // Serializes notification handling. Without this, two notifications
  // arriving back-to-back (e.g. prompt_received then agent_message_chunk)
  // run concurrently and race on Slack postMessage ordering — the spinner
  // can post before the prompt mirror, leaving the prompt visually
  // "below" its own done-marker in the Slack thread.
  private notificationChain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: SessionBridgeOptions) {
    this.live = opts.config.backfillHistory;
    opts.attach.on("open", () => {
      // Open the Slack thread eagerly as soon as we attach to the hydra
      // session — before any agent activity — so Slack-side users can
      // post into the thread immediately.
      const sessionId = this.opts.sessionMeta.sessionId;
      void this.ensureSession(sessionId, {})
        .then(async () => {
          // Hydrate from the attach-response queue snapshot before
          // replaying buffered prompts. Entries hydra already had
          // queued for this session (e.g. queued by browser/TUI
          // before slack attached, or replayed from disk after a
          // daemon restart) get rendered as peer indicators so the
          // Slack thread reflects daemon state from the get-go.
          await this.hydrateQueueFromAttach(sessionId);
          for (const msg of this.opts.initialMessages ?? []) {
            try {
              await this.sendUserPrompt(sessionId, msg.text, msg.images);
            } catch (err) {
              log.warn(
                `buffered prompt failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`,
              );
            }
          }
        })
        .catch((err: unknown) => {
          log.warn(
            `eager session-open failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`,
          );
        });
    });
    opts.attach.on("notification", (n) => {
      this.bumpLiveTimer();
      this.notificationChain = this.notificationChain.then(() =>
        this.onNotification(n).catch((err: unknown) => {
          log.warn(`onNotification error: ${(err as Error).message}`);
        }),
      );
    });
    opts.attach.on("request", (r) => {
      this.bumpLiveTimer();
      void this.onRequest(r);
    });
    if (!this.live) {
      this.bumpLiveTimer();
    }
  }

  private bumpLiveTimer(): void {
    if (this.live) {
      return;
    }
    if (this.liveTimer) {
      clearTimeout(this.liveTimer);
    }
    this.liveTimer = setTimeout(() => {
      this.live = true;
      log.info(`live: ${this.opts.attach.sessionId}`);
    }, this.opts.config.liveQuietMs);
  }

  // Public so the inbound handlers can route by sessionId.
  getSessionByThread(threadTs: string): SessionState | undefined {
    for (const s of this.sessions.values()) {
      if (s.threadTs === threadTs) {
        return s;
      }
    }
    return undefined;
  }

  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  private async onNotification(n: JsonRpcNotification): Promise<void> {
    const params = (n.params ?? {}) as Record<string, unknown>;
    // A sibling frontend answered a permission request before us. Tear
    // down our (now-stale) Slack prompt. Lives outside the live-gate
    // because it's a transient signal, not session activity. Idempotent:
    // if we don't have an entry for the toolCallId, no-op.
    if (n.method === "session/update") {
      const update = (params.update ?? {}) as Record<string, unknown>;
      if (update.sessionUpdate === "permission_resolved") {
        const toolCallId =
          typeof update.toolCallId === "string" ? update.toolCallId : undefined;
        if (!toolCallId) {
          return;
        }
        const entry = this.permissionResolvers.get(toolCallId);
        if (entry) {
          log.info(
            `permission_resolved match toolCallId=${toolCallId} session=${entry.sessionId.slice(0, 8)} promptTs=${entry.promptTs ?? "(none)"}`,
          );
          await this.resolvePermissionEntry(entry).catch(() => undefined);
        } else {
          const known = Array.from(this.permissionResolvers.keys());
          log.info(
            `permission_resolved miss toolCallId=${toolCallId} known=[${known.join(",")}]`,
          );
        }
        return;
      }
    }

    // available_commands_update is the one session/update kind we want
    // to process during the replay window — it's a state snapshot that
    // populates the routing map for `!<verb>` bangs, not an event that
    // would re-render old transcript content. Handled out-of-band here
    // before the live gate so a session whose commands update only ever
    // arrives in replay (the common case for short-lived sessions)
    // still gets a populated availableCommands map.
    const earlySessionId = (params.sessionId ?? params.session_id) as
      | string
      | undefined;
    if (
      n.method === "session/update" &&
      earlySessionId &&
      isAvailableCommandsUpdate(params)
    ) {
      this.applyAvailableCommandsUpdate(earlySessionId, params);
    }

    if (!this.live) {
      return; // drop replayed history; only act on live events
    }
    const sessionId = (params.sessionId ?? params.session_id) as
      | string
      | undefined;
    log.debug(`notification ${n.method} sessionId=${sessionId ?? "(none)"}`);

    if (n.method === "session/update" && sessionId) {
      await this.handleSessionUpdate(sessionId, params);
      return;
    }

    // Server-driven queue notifications. Hydra emits these for any
    // session/prompt arrival; we use them to bind a server messageId
    // to a locally-tracked QueuedPromptEntry (so reactions on our
    // queue indicator can fire hydra-acp/cancel_prompt for cross-
    // client cancellation), and to mirror cross-client edits /
    // cancels back into the Slack indicator.
    if (n.method === "hydra-acp/prompt_queue_added" && sessionId) {
      await this.handlePromptQueueAdded(sessionId, params);
      return;
    }
    if (n.method === "hydra-acp/prompt_queue_updated" && sessionId) {
      await this.handlePromptQueueUpdated(sessionId, params);
      return;
    }
    if (n.method === "hydra-acp/prompt_queue_removed" && sessionId) {
      await this.handlePromptQueueRemoved(sessionId, params);
      return;
    }

    if (n.method === "session/title-changed" && sessionId) {
      const title = params.title as string | undefined;
      if (title) {
        await this.applyTitle(sessionId, title);
      }
      return;
    }
  }

  // Re-render the thread parent with the current state. Used when
  // heading inputs change (mode/model/usage updates, etc.) outside of
  // session/title-changed.
  private async refreshParent(session: SessionState): Promise<void> {
    if (!session.threadTs) {
      return;
    }
    await this.opts.thread.updateMessage(
      session.channel,
      session.threadTs,
      renderParent({
        title: session.title,
        cwd: session.cwd,
        sessionId: session.sessionId,
        agentName: session.agentId ?? this.opts.attach.agentInfo?.name,
        modelId: session.modelId,
        modeId: session.modeId,
        contextUsed: session.contextUsed,
        contextSize: session.contextSize,
        costAmount: session.costAmount,
        costCurrency: session.costCurrency,
      }),
    );
  }

  private async onRequest(r: JsonRpcRequest): Promise<void> {
    const params = (r.params ?? {}) as Record<string, unknown>;
    const sessionId = params.sessionId as string | undefined;
    log.debug(`request ${r.method} sessionId=${sessionId ?? "(none)"}`);

    if (!this.live) {
      // Replayed permission requests are stale (already resolved by the
      // primary). Drop without responding — the proxy will route any
      // live response through the request's original recipient.
      return;
    }

    if (r.method === "session/request_permission" && sessionId) {
      await this.handlePermissionRequest(r, sessionId, params);
      return;
    }

    // hydra-acp broadcasts agent→client requests to every attached
    // client and resolves on the first response. Anything else (fs/*,
    // terminal/*, ...) belongs to a primary frontend — we stay silent
    // so we don't race it with an error.
  }

  private async handleSessionUpdate(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const update = (params.update ?? {}) as Record<string, unknown>;
    const kind = update.sessionUpdate as string | undefined;
    const session = await this.ensureSession(sessionId, params);
    if (!session) {
      return;
    }
    // A session/update arriving here means our agent process is the
    // live owner of this session — even if multiple bridges registered
    // the same thread on attach. Promote so subsequent inbound Slack
    // messages route to us first.
    if (session.threadTs) {
      threadRegistry.promote(this, session.channel, session.threadTs);
    }
    // Mark live activity for the bundle-on-exit upload. Without
    // this, eager-attached sessions (no live notifications this run)
    // would still get re-archived on bridge close, spamming threads
    // with redundant bundles of conversations that didn't change.
    session.hadActivity = true;

    switch (kind) {
      case "agent_thought_chunk": {
        // We don't surface thought content in Slack (it's noisy), but
        // its existence is the earliest signal that a turn is actually
        // running. Post the spinner now so the user has proof of life
        // before any agent text or tool call materializes.
        await this.ensureSpinner(session);
        break;
      }
      case "agent_message_chunk": {
        const content = (update.content ?? {}) as Record<string, unknown>;
        const text = (content.text ?? "") as string;
        if (text.length > 0) {
          await this.flushUserMessage(session);
          await this.ensureSpinner(session);
          session.agentChunks.push(text);
          log.debug(
            `agent_chunk ${sessionId.slice(0, 8)} +${text.length}ch (buf=${session.agentChunks.length})`,
          );
        }
        break;
      }
      case "user_message_chunk": {
        // Hydra emits a marked user_message_chunk alongside prompt_received
        // for clients that don't implement RFD #533. We render via the
        // prompt_received arm below, so drop the compat copy to avoid
        // double-rendering.
        const meta = (update._meta ?? {}) as Record<string, unknown>;
        const hydraMeta = (meta["hydra-acp"] ?? {}) as Record<string, unknown>;
        if (hydraMeta.compatFor === "prompt_received") {
          break;
        }
        const content = (update.content ?? {}) as Record<string, unknown>;
        const text = (content.text ?? "") as string;
        if (text.length > 0) {
          await this.flushAgentMessage(session);
          this.closeAgentMessage(session);
          session.userChunks.push(text);
        }
        break;
      }
      case "prompt_received": {
        // Synthesized by hydra (per RFD #533) when ANOTHER client sends
        // session/prompt to this session. Spec excludes the originator,
        // so receiving this means a sibling frontend (e.g. agent-shell)
        // typed the prompt and we should mirror it into Slack as a user
        // message. Unlike user_message_chunk (which streams), the entire
        // prompt arrives in one event, so flush immediately — otherwise
        // the spinner posted by the agent's first agent_message_chunk
        // would land in Slack before the prompt mirror.
        //
        // Be defensive about content shape: extract text from anything
        // with a string `text` field, regardless of how the content block
        // tags itself (`type`, `kind`, or no discriminator at all).
        const promptField = update.prompt;
        const blocks = Array.isArray(promptField)
          ? (promptField as Array<Record<string, unknown>>)
          : [];
        const text =
          typeof promptField === "string"
            ? promptField
            : blocks
                .filter((b) => typeof b.text === "string")
                .map((b) => b.text as string)
                .join("");
        log.info(
          `prompt_received ${sessionId.slice(0, 8)} text=${text.slice(0, 80)} blocks=${blocks.length}`,
        );
        if (text.length > 0) {
          await this.flushAgentMessage(session);
          this.closeAgentMessage(session);
          session.userChunks.push(text);
          await this.flushUserMessage(session);
        }
        break;
      }
      case "turn_complete": {
        // Synthesized by hydra when the agent's session/prompt response
        // arrives. Finalize any open streaming agent message so the
        // next turn's chunks start a fresh Slack message, and transform
        // the per-turn spinner into a static marker. The stopReason
        // carries through to the marker so a user-cancelled turn reads
        // as "cancelled" rather than the success default.
        const stopReason = update.stopReason as string | undefined;
        log.info(
          `turn_complete ${sessionId.slice(0, 8)}${stopReason ? ` (${stopReason})` : ""}`,
        );
        await this.flushAgentMessage(session);
        this.closeAgentMessage(session);
        await this.finalizeSpinner(session, stopReason);
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        await this.handleToolCallUpdate(session, update);
        break;
      }
      case "plan": {
        // Each plan notification re-emits the full plan with updated
        // per-step statuses. Post the first one as a fresh message,
        // then chat.update in place on subsequent deltas so the
        // single plan message evolves rather than the thread filling
        // with restated copies.
        const planText = renderPlan(update);
        if (planText) {
          await this.upsertPlan(session, planText);
        }
        break;
      }
      case "current_mode_update": {
        const newMode = update.currentModeId as string | undefined;
        if (newMode && session.modeId !== newMode) {
          session.modeId = newMode;
          await this.refreshParent(session).catch(() => undefined);
        }
        break;
      }
      case "current_model_update": {
        const newModel = update.currentModelId as string | undefined;
        if (newModel && session.modelId !== newModel) {
          session.modelId = newModel;
          await this.refreshParent(session).catch(() => undefined);
        }
        break;
      }
      case "usage_update": {
        // Shape: {used, size, cost: {amount, currency}}. Track diffs
        // so unchanged updates don't churn chat.update calls on the
        // parent — usage_update can fire multiple times within a turn.
        const used = update.used as number | undefined;
        const size = update.size as number | undefined;
        const cost = (update.cost ?? {}) as Record<string, unknown>;
        const amount = cost.amount as number | undefined;
        const currency = cost.currency as string | undefined;
        let changed = false;
        if (typeof used === "number" && session.contextUsed !== used) {
          session.contextUsed = used;
          changed = true;
        }
        if (typeof size === "number" && session.contextSize !== size) {
          session.contextSize = size;
          changed = true;
        }
        if (typeof amount === "number" && session.costAmount !== amount) {
          session.costAmount = amount;
          changed = true;
        }
        if (typeof currency === "string" && session.costCurrency !== currency) {
          session.costCurrency = currency;
          changed = true;
        }
        if (changed) {
          await this.refreshParent(session).catch(() => undefined);
        }
        break;
      }
      case "session_info_update": {
        // Hydra synthesizes this on the first prompt of a session and
        // forwards any agent-emitted session_info_update authoritatively.
        // Apply the new title (top-level field, per ACP) and/or the new
        // backing agentId (hydra extension under _meta["hydra-acp"],
        // emitted on /hydra agent).
        const title = update.title as string | undefined;
        if (typeof title === "string" && title.length > 0) {
          await this.applyTitle(sessionId, title);
        }
        const agentId = readHydraAgentId(update._meta);
        if (agentId !== undefined) {
          await this.applyAgentId(sessionId, agentId);
        }
        break;
      }
      case "available_commands_update":
        // Refresh the per-session command set so `!<verb>` routing knows
        // what's valid. Live and replay paths both end up here, but the
        // replay path runs out-of-band above the `!this.live` gate, so
        // this case only fires for live events.
        this.applyAvailableCommandsUpdate(sessionId, params);
        break;
      case "config_option_update":
        // Ignored — no slack-relevant signal.
        break;
      default:
        log.debug(`unhandled session/update kind=${kind ?? "?"}`);
    }
  }

  private async handlePermissionRequest(
    r: JsonRpcRequest,
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    // Pre-register the resolver synchronously, before any await. A
    // permission_resolved notification can fire any time after the
    // proxy broadcasts the original session/request_permission — even
    // before our ensureSession resolves — and the handler needs an
    // entry to find. promptTs and promptChannel get filled in once we
    // know them.
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
    const toolCallId = (toolCall.toolCallId ?? "") as string;
    if (!toolCallId) {
      // No toolCallId means we can't correlate sibling-resolution; refuse
      // rather than silently drop into an un-clearable state.
      this.opts.attach.replyError(r.id, -32602, "missing toolCall.toolCallId");
      return;
    }
    const options = (params.options ?? []) as Array<{
      optionId: string;
      name: string;
      kind?: string;
    }>;
    const key = toolCallId;
    const entry: NonNullable<ReturnType<typeof this.permissionResolvers.get>> = {
      requestId: r.id,
      sessionId,
      toolCallId,
      options,
      promptTs: undefined,
      promptChannel: undefined,
      displayTimer: undefined,
      wakeDelay: undefined,
      resolved: false,
    };
    this.permissionResolvers.set(key, entry);
    log.info(
      `permission requested session=${sessionId.slice(0, 8)} toolCallId=${key} requestId=${typeof r.id}:${String(r.id)}`,
    );

    const delayMs = this.opts.config.permissionDisplayDelayMs;
    if (delayMs > 0) {
      // Defer the actual post so a fast auto-approve resolution can
      // suppress it entirely (no transient :lock: message flashing in
      // the Slack thread).
      await new Promise<void>((resolveTimer) => {
        entry.wakeDelay = () => {
          if (entry.displayTimer) {
            clearTimeout(entry.displayTimer);
            entry.displayTimer = undefined;
          }
          entry.wakeDelay = undefined;
          resolveTimer();
        };
        entry.displayTimer = setTimeout(() => {
          entry.wakeDelay?.();
        }, delayMs);
      });
      if (entry.resolved) {
        log.info(
          `permission suppressed-by-delay toolCallId=${key} session=${sessionId.slice(0, 8)} delayMs=${delayMs}`,
        );
        return;
      }
    }

    const session = await this.ensureSession(sessionId, params);
    if (!session) {
      // No bridge to surface this on; clean up our stub if it's still
      // ours and reject so the agent doesn't hang.
      if (this.permissionResolvers.get(key) === entry) {
        this.permissionResolvers.delete(key);
      }
      this.opts.attach.replyError(r.id, -32000, "no session bridge");
      return;
    }

    // Resolved during ensureSession? Don't post a stale prompt.
    if (this.permissionResolvers.get(key) !== entry) {
      return;
    }
    entry.promptChannel = session.channel;

    const title = (toolCall.title as string | undefined) ?? "Permission requested";
    const { text, blocks } = buildPermissionMessage(
      sessionId,
      toolCallId,
      title,
      options,
    );

    const promptTs = await this.postOrAccumulate(session, text, blocks);

    if (this.permissionResolvers.get(key) === entry) {
      // Still pending — fill in the ts so reactions and resolution
      // notifications can tear down the message later.
      entry.promptTs = promptTs;
      log.info(
        `permission posted toolCallId=${key} session=${sessionId.slice(0, 8)} promptTs=${promptTs ?? "(none)"} promptChannel=${session.channel}`,
      );
    } else if (promptTs) {
      // Resolved while we were posting. The notification handler
      // couldn't delete because we hadn't told it the ts yet — clean
      // up the now-orphaned message ourselves.
      log.info(
        `permission posted-but-already-resolved toolCallId=${key}; deleting orphan ${session.channel}/${promptTs}`,
      );
      await this.opts.thread
        .deleteMessage(session.channel, promptTs)
        .catch(() => undefined);
    }
  }

  // Resolve a permission entry: clear from the resolver map and, if the
  // prompt was actually posted to Slack, delete it. Used both when a
  // sibling frontend answered first (session/update permission_resolved
  // notification, RFD #533) and when this client itself answered (so we
  // can drop the now-irrelevant prompt — the user already gave their
  // reaction).
  private async resolvePermissionEntry(
    entry: NonNullable<ReturnType<typeof this.permissionResolvers.get>>,
  ): Promise<void> {
    this.permissionResolvers.delete(entry.toolCallId);
    entry.resolved = true;
    if (entry.wakeDelay) {
      // Resolution arrived during the display-delay window. Wake the
      // awaiter so handlePermissionRequest can see entry.resolved and
      // return without posting; the wake fn also clears the timer.
      entry.wakeDelay();
    }
    if (entry.promptTs && entry.promptChannel && !entry.suppressDelete) {
      await this.opts.thread.deleteMessage(
        entry.promptChannel,
        entry.promptTs,
      );
    }
  }

  // Fallback for the case where session/update permission_resolved didn't
  // arrive: if the agent emits a tool_call_update for our pending
  // permission's toolCallId in any non-pending state, the decision was
  // clearly made elsewhere — clear our prompt the same way.
  // resolvePermissionEntry is idempotent.
  private async maybeResolvePermissionByToolCall(
    toolCallId: string,
    status: string | undefined,
  ): Promise<void> {
    if (!toolCallId || !status || status === "pending") {
      return;
    }
    const entry = this.permissionResolvers.get(toolCallId);
    if (!entry) {
      return;
    }
    log.info(
      `permission resolved-by-tool-call toolCallId=${toolCallId} status=${status}`,
    );
    await this.resolvePermissionEntry(entry).catch(() => undefined);
  }

  private async handleToolCallUpdate(
    session: SessionState,
    update: Record<string, unknown>,
  ): Promise<void> {
    const toolCallId = (update.toolCallId ?? "") as string;
    if (!toolCallId) {
      return;
    }
    let state = session.toolCalls.get(toolCallId);
    const isNewTool = !state;
    if (!state) {
      state = {
        toolCallId,
        threadMessageTs: undefined,
        status: undefined,
        title: undefined,
        kind: undefined,
        bodyChunks: [],
      };
      session.toolCalls.set(toolCallId, state);
      session.turnToolCallIds.push(toolCallId);
    }
    if (typeof update.status === "string") {
      state.status = update.status;
      await this.maybeResolvePermissionByToolCall(toolCallId, update.status);
    }
    if (typeof update.title === "string") {
      state.title = update.title;
    }
    if (typeof update.kind === "string") {
      state.kind = update.kind;
    }
    const content = update.content as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(content)) {
      for (const c of content) {
        const t = c.type as string | undefined;
        if (t === "content" || t === "diff" || t === undefined) {
          const inner = (c.content ?? c) as Record<string, unknown>;
          const text = inner.text as string | undefined;
          if (text) {
            state.bodyChunks.push(text);
          }
        }
      }
    }

    // Flush and close any pending agent message before the spinner so
    // thread ordering mirrors event order. Each NEW tool call is a
    // semantic boundary — the agent has stopped narrating and is doing
    // a thing — so the next prose chunk should land in a fresh Slack
    // message. tool_call_updates for an already-known tool (status
    // change, body grow) have isNewTool=false and don't close, so a
    // long-running tool's incremental updates don't fragment the
    // surrounding agent text.
    await this.flushAgentMessage(session);
    if (isNewTool) {
      this.closeAgentMessage(session);
    }

    await this.refreshSpinner(session);
  }

  // Post or update the per-turn collapsed-spinner message. Replaces the
  // previous one-Slack-message-per-tool-call rendering: every tool call
  // in a turn merges into a single message that the user can either
  // ignore (default) or expand inline by reacting :eyes:. At turn end
  // finalizeSpinner transforms it into a small static marker between
  // prompts and answers, so the thread keeps visible structure without
  // accumulating tool-call clutter.
  //
  // Calls are serialized per session via spinnerChain. Without
  // serialization, rapid tool_call notifications race on spinnerTs:
  // two refreshes observe it undefined, both POST, the second's ts
  // overwrites the first in state, and the first message is orphaned
  // as a permanent "working..." in Slack.
  private async refreshSpinner(session: SessionState): Promise<void> {
    const previous = session.spinnerChain ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.refreshSpinnerWork(session));
    session.spinnerChain = next;
    return next;
  }

  private async refreshSpinnerWork(session: SessionState): Promise<void> {
    if (!session.threadTs) {
      log.warn(
        `refreshSpinner with no threadTs for ${session.sessionId}; dropping`,
      );
      return;
    }
    const text = renderSpinner(session);
    // Spinner gets a Cancel button always; details-toggle button
    // appears once at least one tool call has shown up (or if the
    // user already expanded it via :eyes:, so they can still
    // collapse). Same boolean controls the rendered tool-list body
    // in renderSpinner.
    const blocks = buildSpinnerBlocks(session.sessionId, text, {
      expanded: session.spinnerExpanded,
      toolCallCount: session.turnToolCallIds.length,
    });
    if (session.spinnerTs) {
      await this.opts.thread.updateMessage(
        session.channel,
        session.spinnerTs,
        text,
        blocks,
      );
    } else {
      const r = await this.opts.thread.postMessage({
        channel: session.channel,
        threadTs: session.threadTs,
        text,
        blocks,
      });
      session.spinnerTs = r.ts;
      session.spinnerStartedAt = Date.now();
      this.startSpinnerTicker(session);
    }
  }

  // Post the per-turn spinner if it isn't up yet. Called from the
  // earliest indicators of agent activity (agent_thought_chunk,
  // agent_message_chunk) so the spinner appears as soon as the turn
  // is moving — not just when the first tool_call fires. After the
  // spinner exists, agent text and tool updates use refreshSpinner
  // directly; no need to call ensureSpinner repeatedly.
  private async ensureSpinner(session: SessionState): Promise<void> {
    if (session.spinnerTs) {
      return;
    }
    await this.refreshSpinner(session);
  }

  // 30-second ticker that re-renders the spinner so its elapsed-time
  // suffix advances on long turns. Provides proof of life — if the
  // suffix keeps advancing the agent is still doing something. Each
  // tick goes through refreshSpinner, so it queues on spinnerChain
  // alongside tool-call updates and never races on spinnerTs.
  private startSpinnerTicker(session: SessionState): void {
    if (session.spinnerTicker) {
      return;
    }
    session.spinnerTicker = setInterval(() => {
      if (!session.spinnerTs) {
        return;
      }
      void this.refreshSpinner(session).catch(() => undefined);
    }, 30_000);
  }

  private stopSpinnerTicker(session: SessionState): void {
    if (session.spinnerTicker) {
      clearInterval(session.spinnerTicker);
      session.spinnerTicker = undefined;
    }
  }

  // Transform the per-turn spinner into a quiet, static "turn ran"
  // marker. Called at turn end from both the turn_complete arm
  // (sibling-driven turns) and the sendUserPrompt tail (own turns).
  //
  // We deliberately do NOT chat.delete the message — keeping a one-line
  // marker between turns gives the thread visible structure. If the
  // user reacted :eyes: during the turn the expanded form (tool list)
  // is preserved in the finalized text so they don't lose what they
  // were watching when the turn ended. Idempotent — no-op if the
  // spinner was never created.
  // Called by the entry point on bridge close (attach.on("close")).
  // Stops anything timer-based we own per session so the bridge object
  // can be garbage-collected and we don't keep firing intervals against
  // a torn-down attach.
  cleanup(): void {
    for (const session of this.sessions.values()) {
      this.stopSpinnerTicker(session);
    }
  }

  // Upload the daemon-built *.hydra bundle for every thread we own as
  // a file attachment. Called from the entry point's bridge-close path
  // before cleanup, gated on config.uploadBundleOnEnd. Recipients can
  // re-import the bundle into any hydra (via `hydra-acp sessions import`
  // or the browser's Import button) to continue the conversation.
  async uploadBundlesOnExit(): Promise<void> {
    if (!this.opts.config.uploadBundleOnEnd) {
      return;
    }
    for (const session of this.sessions.values()) {
      if (!session.threadTs) {
        continue;
      }
      // Skip sessions we eager-attached for routing but never saw a
      // notification for this run. Re-uploading an unchanged old thread
      // on every daemon stop would spam Slack with duplicate bundles.
      if (!session.hadActivity) {
        continue;
      }
      try {
        const bundleText = await fetchHydraBundleText({
          daemonUrl: this.opts.config.hydraDaemonUrl,
          token: this.opts.config.hydraToken,
          sessionId: session.sessionId,
        });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await this.opts.thread.uploadFile({
          channel: session.channel,
          threadTs: session.threadTs,
          filename: `hydra-${session.sessionId.slice(0, 8)}-${stamp}.hydra`,
          title: session.title
            ? `Bundle: ${session.title}`
            : `Bundle: ${session.sessionId.slice(0, 8)}`,
          content: bundleText,
        });
        log.info(
          `bundle uploaded for ${session.sessionId.slice(0, 8)} (${bundleText.length} bytes)`,
        );
      } catch (err) {
        log.warn(
          `bundle upload failed for ${session.sessionId.slice(0, 8)}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async finalizeSpinner(
    session: SessionState,
    stopReason?: string,
  ): Promise<void> {
    // Stop the ticker synchronously so it can't fire a refresh after
    // we've cleared spinnerTs (which would post a fresh spinner).
    this.stopSpinnerTicker(session);
    // Queue behind any in-flight refresh so we can't observe spinnerTs
    // before a pending postMessage has set it (which would skip the
    // update and leave a zombie "working..." spinner in the thread).
    const previous = session.spinnerChain ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.finalizeSpinnerWork(session, stopReason));
    session.spinnerChain = next;
    return next;
  }

  private async finalizeSpinnerWork(
    session: SessionState,
    stopReason?: string,
  ): Promise<void> {
    const ts = session.spinnerTs;
    const processingTs = session.processingTs;
    const expanded = session.spinnerExpanded;
    const count = session.turnToolCallIds.length;
    const elapsed = session.spinnerStartedAt
      ? Date.now() - session.spinnerStartedAt
      : 0;
    const head = renderReadyMarker(count, elapsed, stopReason);
    const text = expanded ? renderSpinnerExpanded(session, head) : head;
    session.spinnerTs = undefined;
    session.spinnerExpanded = false;
    session.turnToolCallIds = [];
    session.spinnerStartedAt = undefined;
    session.planTs = undefined;
    session.processingTs = undefined;
    // Delete the in-progress spinner (where it originally posted, mid-turn)
    // and post a fresh "Ready" marker at the bottom of the thread. One
    // turn-boundary message instead of two — and the bottom marker is the
    // unambiguous "your turn" signal regardless of whether the turn
    // produced agent prose, tools, or both.
    if (ts) {
      await this.opts.thread
        .deleteMessage(session.channel, ts)
        .catch(() => undefined);
    }
    if (!session.threadTs) {
      return;
    }
    await this.opts.thread
      .postMessage({
        channel: session.channel,
        threadTs: session.threadTs,
        text,
      })
      .catch((err: unknown) => {
        log.warn(`ready marker post failed: ${(err as Error).message}`);
      });
    // Strip the Cancel button off the processing indicator after the
    // Ready marker has posted. The processing message stays in the
    // thread as scrollback context (it shows which prompt this turn
    // ran), but its button no longer means anything once the turn is
    // over — a stale click would fire session/cancel against the
    // *next* turn. updateMessage without a blocks arg clears the
    // blocks field via thread.ts's empty-array fallback. Done last so
    // an extra fetchText round-trip doesn't delay Ready landing.
    if (processingTs) {
      const existing = await this.opts.thread
        .fetchText(session.channel, processingTs)
        .catch(() => undefined);
      if (existing) {
        await this.opts.thread
          .updateMessage(session.channel, processingTs, existing)
          .catch(() => undefined);
      }
    }
  }

  private async ensureSession(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<SessionState | undefined> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const inFlight = this.creating.get(sessionId);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.createSession(sessionId, params);
    this.creating.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(sessionId);
    }
  }

  private async createSession(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<SessionState | undefined> {
    // Passive mirrors — imported from another machine and not yet
    // touched on this one (no local ACP agent has bound them) — are
    // skipped entirely: no thread, no event forwarding. Once the user
    // attaches locally and upstreamSessionId is populated, the session
    // graduates to local and slack treats it like any other. Downstream
    // code reads `undefined` here as "skip".
    if (
      this.opts.sessionMeta.importedFromMachine &&
      !this.opts.sessionMeta.upstreamSessionId
    ) {
      log.info(
        `skipping Slack thread for foreign sessionId=${sessionId} ` +
          `(passive mirror from ${this.opts.sessionMeta.importedFromMachine})`,
      );
      return undefined;
    }
    // Prefer cwd from the live notification, fall back to the
    // sessionMeta hydra discovery handed us at construction time.
    const known = this.opts.sessionMeta;
    const cwd = this.cwdFromParams(params) ?? known.cwd;
    const channel = this.resolveChannel(cwd);
    if (!channel) {
      log.warn(
        `no Slack channel resolved for sessionId=${sessionId} cwd=${cwd ?? "?"}; ` +
          `set SLACK_CHANNEL_ID or add a cwd → channelId entry to ~/.hydra-acp-slack/channels.json`,
      );
      return undefined;
    }
    // Reattach to the thread we already opened for this session, if any.
    // The marker `_session <id>_` written into every parent-message render
    // makes this fully Slack-resident — daemon restarts (or a fresh
    // machine) rebuild the mapping on demand without any local state.
    let threadTs: string | undefined;
    const existing = await this.opts.thread.findSessionThread(
      channel,
      sessionId,
    );
    if (existing) {
      threadTs = existing;
      log.info(
        `reattached to thread ${existing} in ${channel} for sessionId=${sessionId}`,
      );
    } else {
      // Open the thread first so threadTs is known before the SessionState
      // is published into the sessions map. Otherwise concurrent
      // notifications would race in, see a session-with-no-threadTs, and
      // post unthreaded.
      const initial = renderParent({
        title: known.title,
        cwd,
        sessionId,
        agentName: known.agentId ?? this.opts.attach.agentInfo?.name,
        modelId: undefined,
        modeId: undefined,
        contextUsed: undefined,
        contextSize: undefined,
        costAmount: undefined,
        costCurrency: undefined,
      });
      const r = await this.opts.thread.postMessage({
        channel,
        text: initial,
      });
      threadTs = r.threadTs;
      log.info(
        `opened thread ${r.threadTs} in ${channel} for sessionId=${sessionId}`,
      );
    }
    const session: SessionState = {
      sessionId,
      threadTs,
      channel,
      toolCalls: new Map(),
      agentChunks: [],
      agentMessageTs: undefined,
      agentLastSent: undefined,
      agentRenderedBase: 0,
      agentFlushChain: undefined,
      queuedPrompts: [],
      queueByMessageId: new Map(),
      peerQueueByMessageId: new Map(),
      sourceTsToEntry: new Map(),
      processingTs: undefined,
      userChunks: [],
      title: undefined,
      cwd,
      modeId: undefined,
      modelId: undefined,
      contextUsed: undefined,
      contextSize: undefined,
      costAmount: undefined,
      costCurrency: undefined,
      spinnerTs: undefined,
      spinnerExpanded: false,
      turnToolCallIds: [],
      spinnerChain: undefined,
      spinnerStartedAt: undefined,
      spinnerTicker: undefined,
      planTs: undefined,
      pendingOwnTurnEnd: undefined,
      hadActivity: false,
      availableCommands: this.pendingCommands.get(sessionId) ?? new Map(),
      agentId: this.opts.sessionMeta.agentId,
    };
    this.pendingCommands.delete(sessionId);
    this.sessions.set(sessionId, session);
    threadRegistry.register({
      bridge: this,
      sessionId,
      channel: session.channel,
      threadTs,
    });
    // If discovery already gave us a title, apply it so the header
    // reflects the topic immediately rather than waiting for a
    // title-changed event.
    if (known.title) {
      await this.applyTitle(sessionId, known.title).catch(() => undefined);
    }
    return session;
  }

  private cwdFromParams(params: Record<string, unknown>): string | undefined {
    if (typeof params.cwd === "string") {
      return params.cwd;
    }
    return undefined;
  }

  private resolveChannel(cwd: string | undefined): string | undefined {
    // Prefer a per-cwd mapping from ~/.hydra-acp-slack/channels.json so
    // different projects can post to different Slack channels. Falls
    // back to the global SLACK_CHANNEL_ID when no mapping matches (or
    // the session has no cwd to look up).
    if (cwd) {
      const mapped = this.opts.channels.get(cwd);
      if (mapped) {
        return mapped;
      }
    }
    return this.opts.config.slackChannelId ?? undefined;
  }

  // hydra-acp/prompt_queue_added: hydra accepted a session/prompt and
  // pushed it onto its per-session FIFO.
  //
  // Own-originator: bind the server's messageId to the FIFO head
  // locally-tracked QueuedPromptEntry so peer-originated edits/cancels
  // can target it.
  //
  // Peer-originator: post a queue indicator to the Slack thread with
  // "from <name>" attribution so viewers see what's coming up before
  // it actually starts processing.
  private async handlePromptQueueAdded(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const messageId =
      typeof params.messageId === "string" ? params.messageId : undefined;
    if (!messageId) return;
    const ownClientId = this.opts.attach.clientId;
    const originator = (params.originator ?? {}) as Record<string, unknown>;
    if (ownClientId && originator.clientId === ownClientId) {
      const unbound = session.queuedPrompts.find(
        (q) => q.messageId === undefined && !q.cancelled,
      );
      if (!unbound) return;
      unbound.messageId = messageId;
      session.queueByMessageId.set(messageId, unbound);
      // Drain any pending edit/delete that arrived from a Slack
      // message_changed / message_deleted before binding completed.
      // Cancel wins over edit — deleting after editing should not
      // leave a queued prompt running.
      if (unbound.pendingCancel) {
        unbound.pendingCancel = false;
        log.info(
          `queue-cancel pending->fire ${sessionId.slice(0, 8)} mid=${messageId.slice(0, 8)}`,
        );
        void this.opts.attach
          .request("hydra-acp/cancel_prompt", {
            sessionId,
            messageId,
          })
          .catch((err: unknown) => {
            log.warn(
              `cancel_prompt (pending) failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`,
            );
          });
        session.queueByMessageId.delete(messageId);
        return;
      }
      if (unbound.pendingEditText !== undefined) {
        const newText = unbound.pendingEditText;
        unbound.pendingEditText = undefined;
        unbound.text = newText;
        log.info(
          `queue-edit pending->fire ${sessionId.slice(0, 8)} mid=${messageId.slice(0, 8)}: ${newText.slice(0, 80)}`,
        );
        const prompt: Array<Record<string, unknown>> = [];
        if (newText) {
          prompt.push({ type: "text", text: newText });
        }
        for (const img of unbound.imageBlocks) {
          prompt.push({
            type: "image",
            mimeType: img.mimeType,
            data: img.data,
          });
        }
        void this.opts.attach
          .request("hydra-acp/update_prompt", {
            sessionId,
            messageId,
            prompt,
          })
          .catch((err: unknown) => {
            log.warn(
              `update_prompt (pending) failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`,
            );
          });
      }
      return;
    }
    await this.postPeerQueueIndicator(session, {
      messageId,
      prompt: params.prompt,
      originatorName:
        typeof originator.name === "string" ? originator.name : undefined,
    });
  }

  // Shared post-and-track for peer-originated queue indicators. Used
  // by both the live prompt_queue_added handler and by the attach-time
  // queue snapshot hydration. Idempotent on messageId so the snapshot
  // path doesn't double-post if a live event already raced ahead.
  private async postPeerQueueIndicator(
    session: SessionState,
    args: {
      messageId: string;
      prompt: unknown;
      originatorName: string | undefined;
    },
  ): Promise<void> {
    if (session.peerQueueByMessageId.has(args.messageId)) {
      return;
    }
    const promptBlocks = Array.isArray(args.prompt) ? args.prompt : [];
    let text = "";
    for (const block of promptBlocks) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          text += b.text;
        }
      }
    }
    if (!text) return;
    if (!session.threadTs) return;
    const indicatorText = formatQueuedIndicator(text, 0);
    let promptTs: string | undefined;
    try {
      const r = await this.opts.thread.postMessage({
        channel: session.channel,
        threadTs: session.threadTs,
        text: indicatorText,
      });
      promptTs = r.ts;
    } catch (err) {
      log.warn(`peer queue indicator post failed: ${(err as Error).message}`);
      return;
    }
    if (!promptTs) return;
    // Re-check map after the await — another path (live event arriving
    // during the snapshot post) might have populated it; if so, delete
    // the duplicate Slack message we just posted.
    if (session.peerQueueByMessageId.has(args.messageId)) {
      await this.opts.thread
        .deleteMessage(session.channel, promptTs)
        .catch(() => undefined);
      return;
    }
    // Attach the Block Kit Cancel button now that we know the ts.
    // Mirrors postQueueIndicator's two-step pattern.
    const indicatorBlocks = buildQueuedBlocks(session.sessionId, promptTs, indicatorText);
    await this.opts.thread
      .updateMessage(session.channel, promptTs, indicatorText, indicatorBlocks)
      .catch(() => undefined);
    session.peerQueueByMessageId.set(args.messageId, {
      messageId: args.messageId,
      promptTs,
      text,
      originatorName: args.originatorName,
    });
  }

  // hydra-acp/prompt_queue_updated: another client (or us) called
  // hydra-acp/update_prompt to rewrite a queued prompt's content.
  // Refresh the Slack indicator text to reflect the new prompt — both
  // for our own queued entries (cross-client edits reach us) and as a
  // general consistency check when peers edit prompts that happen to
  // be visible in our thread.
  private async handlePromptQueueUpdated(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const messageId =
      typeof params.messageId === "string" ? params.messageId : undefined;
    if (!messageId) return;
    const blocks = Array.isArray(params.prompt) ? params.prompt : [];
    let text = "";
    for (const block of blocks) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          text += b.text;
        }
      }
    }
    if (!text) return;
    // Try own entries first (the originator's queue indicator), then
    // peer indicators (cross-client edits to a prompt we're showing
    // for visibility). Either way, refresh the Slack indicator text.
    const ownEntry = session.queueByMessageId.get(messageId);
    if (ownEntry) {
      ownEntry.text = text;
      if (ownEntry.promptTs) {
        // Reuse the original "· N ahead" suffix so editing doesn't
        // silently drop queue-position context. Re-emit blocks so the
        // Cancel button stays attached after the edit — without blocks
        // chat.update wipes them (per thread.updateMessage's empty-
        // array fallback) and the indicator silently loses its button.
        const indicatorText = formatQueuedIndicator(text, ownEntry.initialAheadCount);
        const blocks = buildQueuedBlocks(sessionId, ownEntry.promptTs, indicatorText);
        await this.opts.thread
          .updateMessage(
            session.channel,
            ownEntry.promptTs,
            indicatorText,
            blocks,
          )
          .catch(() => undefined);
      }
      return;
    }
    const peer = session.peerQueueByMessageId.get(messageId);
    if (peer) {
      peer.text = text;
      // Peer indicators never had an "ahead" suffix in postPeerQueueIndicator,
      // so re-render without one to stay visually consistent. Re-emit
      // blocks so the Cancel button survives the edit.
      const indicatorText = formatQueuedIndicator(text, 0);
      const blocks = buildQueuedBlocks(sessionId, peer.promptTs, indicatorText);
      await this.opts.thread
        .updateMessage(
          session.channel,
          peer.promptTs,
          indicatorText,
          blocks,
        )
        .catch(() => undefined);
    }
  }

  // hydra-acp/prompt_queue_removed: a queued entry left the queue.
  // reason = "started" lines up with the local chain's
  // markQueueIndicatorProcessing path (no extra work needed — the
  // local chain owns that transition for own-prompts). reason =
  // "cancelled" or "abandoned" indicate the entry got dropped server-
  // side; mirror that into the Slack indicator so cross-client cancels
  // (e.g. someone clicked × on the browser bubble) reflect here too.
  private async handlePromptQueueRemoved(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const messageId =
      typeof params.messageId === "string" ? params.messageId : undefined;
    if (!messageId) return;
    const reason = typeof params.reason === "string" ? params.reason : "";
    const ownEntry = session.queueByMessageId.get(messageId);
    if (ownEntry) {
      if (reason === "cancelled" || reason === "abandoned") {
        // The session/prompt awaiter in sendUserPrompt is still alive
        // here — it'll resolve shortly with stopReason:"cancelled" and
        // remove the entry from queuedPrompts in its finally block.
        // Mark cancelled defensively so :stop_sign:'s own-queue check
        // skips this entry.
        ownEntry.cancelled = true;
        session.queueByMessageId.delete(messageId);
        if (ownEntry.promptTs) {
          await this.opts.thread
            .updateMessage(
              session.channel,
              ownEntry.promptTs,
              formatCancelledQueuedIndicator(ownEntry.text),
            )
            .catch(() => undefined);
        }
      } else if (reason === "started") {
        // The local chain used to call markQueueIndicatorProcessing
        // when its turn came up; now that the daemon owns
        // serialization, drive that transition off the queue event.
        // Only fires if a queued indicator was actually posted (i.e.
        // the prompt waited for at least one other turn).
        ownEntry.started = true;
        if (ownEntry.promptTs) {
          // Wait for the previous own turn's Ready marker to post
          // before posting Processing for this one. The daemon
          // dequeues the next prompt as soon as the previous turn
          // resolves, so prompt_queue_removed{started} can arrive on
          // notificationChain at the same tick as (or before) the
          // session/prompt response continuation that schedules the
          // previous turn's finalize tail. Without this barrier
          // Processing visually precedes Ready in the thread.
          //
          // We wait on the *previous* turn's barrier (captured at
          // enqueue time onto waitForPriorReady), not the current
          // session.pendingOwnTurnEnd — that already points to our
          // own turn's barrier (installed by our sendUserPrompt) and
          // awaiting it would deadlock the next-turn handler against
          // its own finish.
          if (ownEntry.waitForPriorReady) {
            await ownEntry.waitForPriorReady.catch(() => undefined);
          }
          // Stash the new processing-indicator ts on the session so
          // `:stop_sign:` reactions and the Block Kit Cancel button
          // on it can route to session/cancel.
          const processingTs = await this.markQueueIndicatorProcessing(
            session,
            ownEntry.promptTs,
            ownEntry.text,
          ).catch(() => undefined);
          if (processingTs) {
            session.processingTs = processingTs;
          }
        }
        session.queueByMessageId.delete(messageId);
      }
      return;
    }
    const peer = session.peerQueueByMessageId.get(messageId);
    if (!peer) return;
    session.peerQueueByMessageId.delete(messageId);
    if (reason === "started") {
      // Peer's prompt is now running. The existing prompt_received
      // handler will post the actual user message into the thread
      // moments later, so delete our queue indicator to avoid
      // showing both. (Race window between delete + the new post is
      // brief and visually fine — Slack just replaces one message
      // with another.)
      await this.opts.thread
        .deleteMessage(session.channel, peer.promptTs)
        .catch(() => undefined);
    } else if (reason === "cancelled" || reason === "abandoned") {
      await this.opts.thread
        .updateMessage(
          session.channel,
          peer.promptTs,
          formatCancelledQueuedIndicator(peer.text),
        )
        .catch(() => undefined);
    }
  }

  // Walk the queue snapshot the daemon delivered on session/attach
  // (_meta["hydra-acp"].queue) and post peer indicators for entries
  // that aren't ours. Skips position 0 — that prompt's user-text
  // landed (or will land) in scrollback via prompt_received during
  // history replay, so an extra queue indicator would just be noise.
  private async hydrateQueueFromAttach(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const meta = this.opts.attach.attachMeta;
    if (!meta) return;
    const hydra = meta["hydra-acp"];
    if (!hydra || typeof hydra !== "object" || Array.isArray(hydra)) return;
    const queue = (hydra as Record<string, unknown>).queue;
    if (!Array.isArray(queue)) return;
    const ownClientId = this.opts.attach.clientId;
    for (const raw of queue) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const messageId =
        typeof e.messageId === "string" ? e.messageId : undefined;
      if (!messageId) continue;
      const position = typeof e.position === "number" ? e.position : 0;
      if (position === 0) continue;
      const originator = (e.originator ?? {}) as Record<string, unknown>;
      // If somehow it's our own entry (shouldn't happen on a fresh
      // attach — our prior clientId is gone), skip; the local-chain
      // path doesn't have local state to bind it to.
      if (ownClientId && originator.clientId === ownClientId) continue;
      await this.postPeerQueueIndicator(session, {
        messageId,
        prompt: e.prompt,
        originatorName:
          typeof originator.name === "string" ? originator.name : undefined,
      });
    }
  }

  private async applyTitle(sessionId: string, title: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.title === title) {
      return;
    }
    session.title = title;
    if (!session.threadTs) {
      return;
    }
    await this.opts.thread.updateMessage(
      session.channel,
      session.threadTs,
      renderParent({
        title,
        cwd: session.cwd,
        sessionId,
        agentName: session.agentId ?? this.opts.attach.agentInfo?.name,
        modelId: session.modelId,
        modeId: session.modeId,
        contextUsed: session.contextUsed,
        contextSize: session.contextSize,
        costAmount: session.costAmount,
        costCurrency: session.costCurrency,
      }),
    );
  }

  private async applyAgentId(sessionId: string, agentId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.agentId === agentId) {
      return;
    }
    session.agentId = agentId;
    await this.refreshParent(session).catch(() => undefined);
  }

  // Push the agent's accumulated text to Slack. First flush of a new
  // agent message posts; subsequent flushes update the same message in
  // place, so a single agent burst stays as one live Slack message even
  // if streaming has internal pauses that fire the periodic flush.
  // Chunks are NOT cleared here — closeAgentMessage finalizes and resets
  // state when something else needs to post (tool card, sibling user
  // message, turn end).
  //
  // Calls are serialized per session via agentFlushChain. Without
  // serialization, a periodic-timer flush and a turn_complete-arm flush
  // can both observe agentMessageTs === undefined, both call postMessage,
  // and produce two Slack messages for one agent burst (the second
  // replacing the first as the live message but the first lingering as
  // an orphan).
  async flushAgentMessage(session: SessionState): Promise<void> {
    const previous = session.agentFlushChain ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.flushAgentMessageWork(session));
    session.agentFlushChain = next;
    return next;
  }

  private async flushAgentMessageWork(session: SessionState): Promise<void> {
    if (session.agentChunks.length === 0) {
      return;
    }
    if (!session.threadTs) {
      log.warn(
        `flushAgentMessage with no threadTs for ${session.sessionId}; dropping`,
      );
      session.agentChunks = [];
      session.agentRenderedBase = 0;
      return;
    }
    const rawText = session.agentChunks.join("");

    // Blocks-mode path: when this message has a language-hinted fence
    // (```cpp, ```diff, …) we send it as Block Kit so Slack renders the
    // code with syntax highlighting. Only used while we're still on the
    // initial Slack message — once we've rolled over a continuation, we
    // stay in text mode (blocks-mode doesn't split). If the blocks
    // wouldn't fit within Slack's per-block limits, fall through too.
    if (session.agentRenderedBase === 0) {
      const blocks = buildHighlightBlocks(rawText);
      if (blocks && fitsBlockLimits(blocks)) {
        const fallback = toSlackMrkdwn(rawText);
        if (fallback.length <= SLACK_MESSAGE_LIMIT) {
          if (fallback === session.agentLastSent) {
            return;
          }
          await this.postOrUpdate(session, fallback, blocks);
          session.agentLastSent = fallback;
          return;
        }
      }
    }

    const fullText = toSlackMrkdwn(rawText);

    // Walk forward through fullText one Slack message at a time. Each
    // iteration handles the slice that belongs to the currently-open
    // (or about-to-be-opened) Slack message; once that slice fits
    // within SLACK_MESSAGE_LIMIT, the loop is done. If it doesn't,
    // finalize the current message at a safe split point, advance
    // agentRenderedBase, and let the next iteration post the remainder
    // as a fresh continuation message.
    while (true) {
      const current = fullText.slice(session.agentRenderedBase);
      if (!current.trim()) {
        return;
      }

      if (current.length <= SLACK_MESSAGE_LIMIT) {
        if (current === session.agentLastSent) {
          return;
        }
        await this.postOrUpdate(session, current);
        session.agentLastSent = current;
        return;
      }

      // Overflow: split current at a safe boundary, finalize the head
      // in this Slack message, and roll over to a new one for the tail.
      const splitAt = findSplitPoint(current, SLACK_MESSAGE_LIMIT);
      const head = current.slice(0, splitAt);
      await this.postOrUpdate(session, head);
      session.agentRenderedBase += splitAt;
      session.agentMessageTs = undefined;
      session.agentLastSent = undefined;
    }
  }

  private async postOrUpdate(
    session: SessionState,
    text: string,
    blocks?: SlackBlock[],
  ): Promise<void> {
    if (session.agentMessageTs) {
      log.info(
        `flush update ${session.sessionId.slice(0, 8)} ts=${session.agentMessageTs} ${text.length}ch${blocks ? ` blocks=${blocks.length}` : ""}`,
      );
      await this.opts.thread.updateMessage(
        session.channel,
        session.agentMessageTs,
        text,
        blocks,
      );
      return;
    }
    log.info(
      `flush post ${session.sessionId.slice(0, 8)} ${text.length}ch${blocks ? ` blocks=${blocks.length}` : ""}`,
    );
    const r = await this.opts.thread.postMessage({
      channel: session.channel,
      threadTs: session.threadTs,
      text,
      ...(blocks ? { blocks } : {}),
    });
    session.agentMessageTs = r.ts;
  }

  // Finalize the current agent Slack message; the next agent stream will
  // start a fresh message rather than appending into this one. Call after
  // flushing whenever something else is about to post into the thread.
  private closeAgentMessage(session: SessionState): void {
    session.agentChunks = [];
    session.agentMessageTs = undefined;
    session.agentLastSent = undefined;
    session.agentRenderedBase = 0;
  }

  // Flush accumulated user-message chunks (input from another frontend
  // attached to the same session — typically the editor's stdio shim
  // typing). Drops the message if it matches a prompt we just sent
  // ourselves, since hydra fans the synthesized user_message_chunk back
  // to every attached frontend.
  async flushUserMessage(session: SessionState): Promise<void> {
    if (session.userChunks.length === 0) {
      return;
    }
    const text = session.userChunks.join("");
    session.userChunks = [];
    if (!text.trim()) {
      return;
    }
    if (this.consumeOwnPrompt(session.sessionId, text)) {
      return;
    }
    if (!session.threadTs) {
      log.warn(
        `flushUserMessage with no threadTs for ${session.sessionId}; dropping`,
      );
      return;
    }
    await this.opts.thread.postMessage({
      channel: session.channel,
      threadTs: session.threadTs,
      text: `:speech_balloon: ${toSlackMrkdwn(text)}`,
    });
  }

  // Convenience: post text right now, flushing any pending agent or user
  // message first to preserve ordering. Closes the agent message so any
  // subsequent agent chunks start a fresh Slack message below this one.
  // Post or update the per-turn plan message. First call posts; later
  // calls chat.update the same ts so a single plan evolves in place.
  // Cleared at turn end (finalizeSpinnerWork) so the next turn starts
  // a fresh plan message.
  private async upsertPlan(
    session: SessionState,
    planText: string,
  ): Promise<void> {
    const text = `*Plan*\n${planText}`;
    if (session.planTs) {
      await this.opts.thread.updateMessage(
        session.channel,
        session.planTs,
        text,
      );
      return;
    }
    // Flush any in-flight agent stream so the plan message lands at
    // the right point in thread order, then post.
    await this.flushUserMessage(session);
    await this.flushAgentMessage(session);
    this.closeAgentMessage(session);
    if (!session.threadTs) {
      log.warn(
        `upsertPlan with no threadTs for ${session.sessionId}; dropping`,
      );
      return;
    }
    const r = await this.opts.thread.postMessage({
      channel: session.channel,
      threadTs: session.threadTs,
      text,
    });
    session.planTs = r.ts;
  }

  private async postOrAccumulate(
    session: SessionState,
    text: string,
    blocks?: SlackBlock[],
  ): Promise<string | undefined> {
    await this.flushUserMessage(session);
    await this.flushAgentMessage(session);
    this.closeAgentMessage(session);
    if (!session.threadTs) {
      log.warn(
        `postOrAccumulate with no threadTs for ${session.sessionId}; dropping`,
      );
      return undefined;
    }
    const r = await this.opts.thread.postMessage({
      channel: session.channel,
      threadTs: session.threadTs,
      text,
      ...(blocks ? { blocks } : {}),
    });
    return r.ts;
  }

  // Called by the entry point on a periodic timer to flush idle text.
  async flushAll(): Promise<void> {
    for (const s of this.sessions.values()) {
      await this.flushUserMessage(s);
      await this.flushAgentMessage(s);
    }
  }

  private rememberOwnPrompt(sessionId: string, text: string): void {
    if (!text) {
      return;
    }
    const list = this.recentOwnPrompts.get(sessionId) ?? [];
    list.push({ text, at: Date.now() });
    this.recentOwnPrompts.set(sessionId, list);
  }

  private consumeOwnPrompt(sessionId: string, text: string): boolean {
    const list = this.recentOwnPrompts.get(sessionId);
    if (!list || list.length === 0) {
      return false;
    }
    const cutoff = Date.now() - SessionBridge.OWN_PROMPT_TTL_MS;
    while (list.length > 0) {
      const head = list[0];
      if (!head || head.at < cutoff) {
        list.shift();
        continue;
      }
      break;
    }
    const idx = list.findIndex((e) => e.text === text);
    if (idx === -1) {
      return false;
    }
    list.splice(idx, 1);
    return true;
  }

  // ---- Inbound (Slack -> agent) ----

  async sendUserPrompt(
    sessionId: string,
    text: string,
    images: ReadonlyArray<{ type: "image"; mimeType: string; data: string }> = [],
    sourceSlackTs?: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.warn(`sendUserPrompt for unknown session ${sessionId}`);
      return;
    }
    // Estimate "ahead of us" optimistically from local state for the
    // initial queued indicator. Hydra's authoritative count arrives via
    // prompt_queue_added shortly after, but we want feedback in the
    // thread the moment the user hits send. Counts both own entries
    // we've already submitted (still in queuedPrompts) and peer
    // entries we know about; falls back to "1 ahead" if the agent's
    // spinner is up but we don't have queue knowledge (peer turn
    // started before we attached, or running from a non-queue-aware
    // path).
    const ownAhead = session.queuedPrompts.length;
    const peerAhead = session.peerQueueByMessageId.size;
    const aheadCount =
      ownAhead + peerAhead > 0
        ? ownAhead + peerAhead
        : session.spinnerTs
          ? 1
          : 0;
    // Whether to post a queued indicator at all. If nothing's ahead of
    // us we skip the queued → processing dance and let the spinner
    // appear when the agent starts emitting. Matches the original
    // wasQueued check.
    const willWait = aheadCount > 0;

    // Track this entry locally for the lifetime of the round-trip.
    // promptTs gets stashed when the queued indicator post resolves.
    // messageId gets bound when hydra-acp/prompt_queue_added arrives.
    // started flips true when prompt_queue_removed{started} fires —
    // used by :stop_sign: handler to know whether the cancel still has
    // a queue slot to drop or needs a session/cancel.
    const queuedEntry: QueuedPromptEntry = {
      text,
      promptTs: undefined,
      cancelled: false,
      started: false,
      sourceSlackTs,
      imageBlocks: images,
      initialAheadCount: aheadCount,
    };
    session.queuedPrompts.push(queuedEntry);
    if (sourceSlackTs) {
      session.sourceTsToEntry.set(sourceSlackTs, queuedEntry);
    }

    // Post the queued indicator (fire-and-forget; the ts lands on
    // queuedEntry when the API call resolves). Skipped when nothing's
    // ahead so an immediate-turn prompt doesn't flicker queued before
    // processing.
    if (willWait) {
      void this.postQueueIndicator(session, text, aheadCount)
        .then((ts) => {
          if (ts && !queuedEntry.cancelled) {
            queuedEntry.promptTs = ts;
          }
        })
        .catch(() => undefined);
    }

    // Suppress own-prompt echo from the user_message_chunk hydra will
    // re-broadcast back to us. Same intent as before — the slack
    // thread already shows the user's typed message natively, no need
    // to re-render it.
    if (text) {
      this.rememberOwnPrompt(sessionId, text);
    }

    log.info(
      `prompt -> ${sessionId.slice(0, 8)}: ${text.slice(0, 80)}${images.length > 0 ? ` [+${images.length} image(s)]` : ""}`,
    );

    // Build the prompt content blocks and fire session/prompt EAGERLY.
    // The daemon-side queue (hydra-acp's prompt_queue_*) is now the
    // authoritative serializer — every attached client (TUI, browser,
    // peers) sees this prompt's queue position via prompt_queue_added
    // as soon as hydra accepts it, instead of after slack's local
    // chain drained.
    const prompt: Array<Record<string, unknown>> = [];
    if (text) {
      prompt.push({ type: "text", text });
    }
    for (const img of images) {
      prompt.push({ type: "image", mimeType: img.mimeType, data: img.data });
    }

    // Turn-end barrier — must exist before we send session/prompt so
    // the daemon's prompt_queue_removed{started} for the next turn
    // (which can arrive on notificationChain as soon as our turn's
    // session/prompt resolves, including in the same tick) finds it
    // and waits for our Ready post. Without this, a peer-or-self
    // queued prompt's Processing indicator can land in the thread
    // before our Ready marker — see SessionState.pendingOwnTurnEnd.
    //
    // Capture the *previous* turn's barrier on the queue entry so the
    // started-handler waits on the prior Ready, not our own. Then
    // install our own barrier on the session so the turn-after-us
    // can find it.
    const priorBarrier = session.pendingOwnTurnEnd;
    queuedEntry.waitForPriorReady = priorBarrier;
    let resolveTurnEnd!: () => void;
    const ownBarrier = new Promise<void>((resolve) => {
      resolveTurnEnd = resolve;
    });
    const myBarrier: Promise<void> = priorBarrier
      ? priorBarrier.then(() => ownBarrier)
      : ownBarrier;
    session.pendingOwnTurnEnd = myBarrier;

    let stopReason: string | undefined;
    try {
      const response = await this.opts.attach.request<{
        stopReason?: string;
      }>("session/prompt", {
        sessionId,
        prompt,
      });
      stopReason = response?.stopReason;
    } catch (err) {
      log.warn(
        `prompt request failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`,
      );
    } finally {
      // Drop the local entry. queueByMessageId was already cleared by
      // the prompt_queue_removed handler that fired when this turn
      // started.
      const idx = session.queuedPrompts.indexOf(queuedEntry);
      if (idx >= 0) {
        session.queuedPrompts.splice(idx, 1);
      }
      if (
        queuedEntry.sourceSlackTs &&
        session.sourceTsToEntry.get(queuedEntry.sourceSlackTs) === queuedEntry
      ) {
        session.sourceTsToEntry.delete(queuedEntry.sourceSlackTs);
      }
    }

    // When we are the originator, hydra excludes us from the
    // synthesized turn_complete broadcast. The session/prompt response
    // is the turn-end signal for this side. Run the cleanup tail on
    // notificationChain so any subsequent session/update events for
    // the *next* turn (which hydra dequeues immediately after our
    // response) wait behind our finalizeSpinner — without this, the
    // next turn's first agent_message_chunk hits ensureSpinner with
    // spinnerTs still set to our spinner and silently no-ops.
    log.info(
      `own-turn end ${sessionId.slice(0, 8)}${stopReason ? ` (${stopReason})` : ""}`,
    );
    // Skip the finalize tail entirely when this entry was cancelled
    // before it ever ran. The daemon resolves its session/prompt
    // awaiter with stopReason:"cancelled" as soon as cancelQueuedPrompt
    // splices the queue entry — but the spinner / agent state belongs
    // to whichever turn is *actually* running (a sibling we don't own).
    // Finalizing here would steal that sibling's spinner ts and post a
    // bogus ":no_entry: cancelled · N tool · Ts" Ready marker
    // attributing the running turn's tool count and elapsed time to
    // our cancellation. Fires for both delete-via-Slack and
    // :stop_sign:-on-queued-indicator gestures.
    if (!queuedEntry.started && queuedEntry.cancelled) {
      // No Ready will post — release the barrier so waiters don't hang.
      resolveTurnEnd();
      if (session.pendingOwnTurnEnd === myBarrier) {
        session.pendingOwnTurnEnd = undefined;
      }
      return;
    }
    const finalizeTail = (async () => {
      await this.flushAgentMessage(session);
      this.closeAgentMessage(session);
      await this.finalizeSpinner(session, stopReason);
    })();
    try {
      await finalizeTail;
    } finally {
      // Resolve our barrier so any waiter (e.g. the next-turn's
      // prompt_queue_removed{started} handler) can proceed. Done in
      // finally so even an error in finalize doesn't leave the chain
      // stuck. Clear the session field only if it still points at us
      // — a later sendUserPrompt may have already chained past.
      resolveTurnEnd();
      if (session.pendingOwnTurnEnd === myBarrier) {
        session.pendingOwnTurnEnd = undefined;
      }
    }
  }

  // Slack message_changed of a previously-queued prompt: route the new
  // text through hydra-acp/update_prompt so the queued entry's prompt
  // gets rewritten before it runs. Lookup is keyed by the user's
  // original Slack `ts` (the message they edited), stamped onto the
  // entry at enqueue time. Mirrors the daemon-side updateQueuedPrompt
  // primitive — already exercised by TUI/browser edits that round-trip
  // through prompt_queue_updated.
  async editQueuedPromptBySourceTs(
    sessionId: string,
    sourceSlackTs: string,
    newText: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const entry = session.sourceTsToEntry.get(sourceSlackTs);
    if (!entry) return;
    if (entry.cancelled) return;
    if (entry.started) {
      // Already running. Daemon would return `already_running`; the
      // user has the `:stop_sign:` gesture (on either the
      // `_processing …_` indicator or the spinner) for that case.
      log.info(
        `queue-edit skip (started) <- slack ${sessionId.slice(0, 8)}: ${newText.slice(0, 80)}`,
      );
      return;
    }
    if (!entry.messageId) {
      // Not yet bound to a server messageId. Stash; reconciled in
      // handlePromptQueueAdded once binding completes.
      entry.pendingEditText = newText;
      log.info(
        `queue-edit pending (unbound) <- slack ${sessionId.slice(0, 8)}: ${newText.slice(0, 80)}`,
      );
      return;
    }
    log.info(
      `queue-edit <- slack ${sessionId.slice(0, 8)} mid=${entry.messageId.slice(0, 8)}: ${newText.slice(0, 80)}`,
    );
    // Update the local text immediately so the FIFO-binding race for
    // a follow-up edit (or a subsequent suppress-own-prompt check) sees
    // the latest copy.
    entry.text = newText;
    const prompt: Array<Record<string, unknown>> = [];
    if (newText) {
      prompt.push({ type: "text", text: newText });
    }
    for (const img of entry.imageBlocks) {
      prompt.push({ type: "image", mimeType: img.mimeType, data: img.data });
    }
    void this.opts.attach
      .request("hydra-acp/update_prompt", {
        sessionId,
        messageId: entry.messageId,
        prompt,
      })
      .catch((err: unknown) => {
        log.warn(
          `update_prompt failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`,
        );
      });
  }

  // Slack message_deleted of a previously-queued prompt: route to
  // hydra-acp/cancel_prompt so the entry is dropped from the daemon's
  // queue before it runs. Symmetric with the `:stop_sign:`-reaction
  // cancel path at handleReaction's queued branch — same wire call,
  // just a different Slack-side trigger.
  async cancelQueuedPromptBySourceTs(
    sessionId: string,
    sourceSlackTs: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const entry = session.sourceTsToEntry.get(sourceSlackTs);
    if (!entry) return;
    if (entry.cancelled) return;
    if (entry.started) {
      // Already running — deletion-as-interrupt would be a surprising
      // side effect of an accidental delete. The user has explicit
      // gestures (`:stop_sign:` on the `_processing …_` indicator or
      // the spinner) for stopping a running turn.
      log.info(
        `queue-cancel skip (started) <- slack-delete ${sessionId.slice(0, 8)}`,
      );
      return;
    }
    // Optimistic local mark, matching the reaction path. Even if we
    // raced past binding, the in-flight session/prompt response will
    // just resolve and the entry will be cleaned up by the finally.
    entry.cancelled = true;
    if (!entry.messageId) {
      entry.pendingCancel = true;
      log.info(
        `queue-cancel pending (unbound) <- slack-delete ${sessionId.slice(0, 8)}`,
      );
      return;
    }
    log.info(
      `queue-cancel <- slack-delete ${sessionId.slice(0, 8)} mid=${entry.messageId.slice(0, 8)}: ${entry.text.slice(0, 80)}`,
    );
    void this.opts.attach
      .request("hydra-acp/cancel_prompt", {
        sessionId,
        messageId: entry.messageId,
      })
      .catch((err: unknown) => {
        log.warn(
          `cancel_prompt failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`,
        );
      });
    // Pull the messageId mapping eagerly so the daemon's
    // prompt_queue_removed broadcast (arriving ~1ms later) sees the
    // entry as already-handled and skips its indicator-update branch.
    // We then drive the indicator update inline here. Mirrors the
    // `:stop_sign:`-reaction path at handleReaction's queued branch —
    // pre-delete + explicit chat.update — so both gestures produce
    // identical visual results.
    const promptTs = entry.promptTs;
    const cancelledText = entry.text;
    session.queueByMessageId.delete(entry.messageId);
    if (promptTs) {
      await this.opts.thread
        .updateMessage(
          session.channel,
          promptTs,
          formatCancelledQueuedIndicator(cancelledText),
        )
        .catch(() => undefined);
    }
  }

  // Cancel an own queued entry identified by its indicator's Slack ts.
  // Returns true if it matched and the cancel was issued; false if no
  // such entry exists (so a caller can try the next indicator kind).
  // Mirrors the previous reaction-cancel branch verbatim — same wire
  // call (`hydra-acp/cancel_prompt`), same indicator update, same
  // optimistic local mark. Shared between the reaction path and the
  // Block Kit Cancel button handler.
  private async cancelOwnQueuedByPromptTs(
    session: SessionState,
    promptTs: string,
  ): Promise<boolean> {
    const queued = session.queuedPrompts.find(
      (q) => q.promptTs === promptTs && !q.started && !q.cancelled,
    );
    if (!queued) {
      return false;
    }
    queued.cancelled = true;
    log.info(
      `queue-cancel <- slack ${session.sessionId.slice(0, 8)}: ${queued.text.slice(0, 80)}`,
    );
    // cancel_prompt is a request per the wire spec (the daemon's
    // onRequest handler returns { cancelled, reason }) so it must go
    // via attach.request — notify would be a no-op and the entry
    // would keep running. We don't need the response: the daemon's
    // prompt_queue_removed{cancelled} broadcast updates every attached
    // client (including us) to tear down their indicators.
    if (queued.messageId) {
      void this.opts.attach
        .request("hydra-acp/cancel_prompt", {
          sessionId: session.sessionId,
          messageId: queued.messageId,
        })
        .catch(() => undefined);
      session.queueByMessageId.delete(queued.messageId);
    }
    await this.opts.thread
      .updateMessage(
        session.channel,
        promptTs,
        formatCancelledQueuedIndicator(queued.text),
      )
      .catch(() => undefined);
    return true;
  }

  // Cancel a peer's queued entry identified by its indicator's Slack
  // ts. Same wire call as cancelOwnQueuedByPromptTs; the daemon's
  // prompt_queue_removed{cancelled} echo drives the indicator update
  // for everyone (including us via handlePromptQueueRemoved). Returns
  // true if matched.
  private async cancelPeerQueuedByPromptTs(
    session: SessionState,
    promptTs: string,
  ): Promise<boolean> {
    for (const [, peer] of session.peerQueueByMessageId) {
      if (peer.promptTs === promptTs) {
        log.info(
          `peer queue-cancel <- slack ${session.sessionId.slice(0, 8)}: ${peer.text.slice(0, 80)}`,
        );
        void this.opts.attach
          .request("hydra-acp/cancel_prompt", {
            sessionId: session.sessionId,
            messageId: peer.messageId,
          })
          .catch(() => undefined);
        return true;
      }
    }
    return false;
  }

  // Turn-scoped cancel: fire session/cancel for the currently running
  // turn. Same effect as a :stop_sign: reaction on the spinner or the
  // _processing …_ indicator. The agent's response (stopReason
  // "cancelled") flows through turn_complete (or our await on
  // session/prompt for own turns) and finalizes the spinner with a
  // "cancelled" marker.
  private cancelRunningTurn(session: SessionState): void {
    this.opts.attach.notify("session/cancel", { sessionId: session.sessionId });
  }

  // Public entry point for the Block Kit "Cancel" button on a queued
  // indicator (own or peer). The slack/app.ts action handler decodes
  // {sessionId, promptTs} from the button value and calls this. Tries
  // own entries first, then peer entries — matches the reaction-cancel
  // priority order. Returns true when an entry matched.
  async cancelQueuedByPromptTs(
    sessionId: string,
    promptTs: string,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    if (await this.cancelOwnQueuedByPromptTs(session, promptTs)) {
      return true;
    }
    return this.cancelPeerQueuedByPromptTs(session, promptTs);
  }

  // Public entry point for the Block Kit "Cancel" button on the
  // processing indicator or the spinner. Same wire call as the
  // :stop_sign: reaction path on those messages.
  cancelTurn(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    log.info(`cancel <- slack (button) ${sessionId.slice(0, 8)}`);
    this.cancelRunningTurn(session);
    return true;
  }

  // Public entry point for the spinner's "Show details / Hide details"
  // toggle button. Flips session.spinnerExpanded and refreshes the
  // spinner so its block re-renders with the inverted label and the
  // expanded/collapsed body. Same boolean the :eyes: reaction toggles
  // (handleReaction's expand_truncated branch), so either gesture
  // converges on the same state.
  async toggleSpinnerDetails(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.spinnerTs) {
      return false;
    }
    session.spinnerExpanded = !session.spinnerExpanded;
    await this.refreshSpinner(session).catch(() => undefined);
    return true;
  }

  // True if this bridge has a queued (or about-to-be-queued) own entry
  // for the given source Slack ts. Used by the Slack message handler
  // to pick the right candidate bridge for an edit/delete across a
  // multi-bridge thread.
  hasQueueEntryBySourceTs(sessionId: string, sourceSlackTs: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.sourceTsToEntry.has(sourceSlackTs);
  }

  // Slack-side feedback for a Slack-originated prompt that has to wait
  // behind another in-flight prompt. Posts immediately so the user sees
  // their second/third-in-a-row Slack message land in the thread; the
  // returned ts is later used by markQueueIndicatorProcessing to flip
  // it to "processing" when its turn comes.
  //
  // Two-step post: chat.postMessage to learn the ts, then chat.update
  // with the Block Kit Cancel button keyed by that ts. We can't put
  // the button on the initial post because the button value needs to
  // carry the indicator's own ts as the cancel correlator, and Slack
  // only hands us the ts on the response. Same Slack RTT shape as the
  // permission prompt — one extra update call per queued indicator.
  private async postQueueIndicator(
    session: SessionState,
    text: string,
    aheadCount: number,
  ): Promise<string | undefined> {
    if (!session.threadTs) {
      return undefined;
    }
    const indicatorText = formatQueuedIndicator(text, aheadCount);
    let ts: string | undefined;
    try {
      const r = await this.opts.thread.postMessage({
        channel: session.channel,
        threadTs: session.threadTs,
        text: indicatorText,
      });
      ts = r.ts;
    } catch (err) {
      log.warn(`queue indicator post failed: ${(err as Error).message}`);
      return undefined;
    }
    if (!ts) {
      return undefined;
    }
    const blocks = buildQueuedBlocks(session.sessionId, ts, indicatorText);
    await this.opts.thread
      .updateMessage(session.channel, ts, indicatorText, blocks)
      .catch(() => undefined);
    return ts;
  }

  // Transition a queued indicator into "processing". Rather than
  // chat.update'ing the queued message in place — which leaves the
  // transition stuck at its original (now scrolled-up) position in
  // the thread — delete the queued message and post a fresh
  // "processing" line at the bottom. The user can scan to the
  // latest message and immediately see which prompt the agent is
  // working on next.
  private async markQueueIndicatorProcessing(
    session: SessionState,
    ts: string,
    text: string,
  ): Promise<string | undefined> {
    await this.opts.thread
      .deleteMessage(session.channel, ts)
      .catch(() => undefined);
    if (!session.threadTs) {
      return undefined;
    }
    // Number of own prompts still queued behind this one. queuedPrompts
    // includes the currently-running entry (us) until our finally
    // removes it, so subtract 1. Hidden parenthetical when nothing's
    // queued behind us — keeps the common case clean.
    const waiting = Math.max(0, session.queuedPrompts.length - 1);
    const indicatorText = formatProcessingIndicator(text, waiting);
    try {
      // Processing cancel is turn-scoped (session/cancel), so the
      // button doesn't need the indicator's own ts — sessionId is
      // enough. That lets us post text + blocks in one shot.
      const blocks = buildProcessingBlocks(session.sessionId, indicatorText);
      const r = await this.opts.thread.postMessage({
        channel: session.channel,
        threadTs: session.threadTs,
        text: indicatorText,
        blocks,
      });
      return r.ts;
    } catch (err) {
      log.warn(
        `processing indicator post failed: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  // Permission reaction → session/request_permission response. Takes
  // the resolver entry directly so the caller can target a specific
  // permission (sessionId alone is ambiguous when several permissions
  // for the same session are pending).
  async respondToPermission(
    entry: NonNullable<ReturnType<typeof this.permissionResolvers.get>>,
    optionId: string | "cancel",
  ): Promise<void> {
    if (optionId === "cancel") {
      this.opts.attach.reply(entry.requestId, {
        outcome: { outcome: "cancelled" },
      });
    } else {
      this.opts.attach.reply(entry.requestId, {
        outcome: { outcome: "selected", optionId },
      });
    }
    // Clear the entry and remove the now-resolved Slack prompt. The user
    // reacted, the agent has its answer; leaving the lock prompt around
    // would clutter the thread and tempt accidental re-reactions.
    await this.resolvePermissionEntry(entry);
  }

  // Block-action handler entry point. The action handler in slack/app.ts
  // looks up the bridge by sessionId (encoded in the button value) and
  // calls this with the toolCallId + selected optionId. resolution is
  // the same as the reaction path — we just bypass the (channel, ts)
  // lookup since the button carried the correlator directly.
  //
  // `decoratedBy` is the Slack user id of the clicker, used to annotate
  // the resolved prompt ("Allowed by <@U…>") via chat.update before the
  // entry is cleaned up.
  async respondToPermissionByToolCallId(
    toolCallId: string,
    optionId: string | "cancel",
    decoratedBy: string | undefined,
  ): Promise<boolean> {
    const entry = this.permissionResolvers.get(toolCallId);
    if (!entry) {
      return false;
    }
    if (decoratedBy && entry.promptTs && entry.promptChannel) {
      // Replace the buttons with a static "resolved" line so the thread
      // keeps an audit trail of who decided. Done before resolvePermissionEntry
      // (which would otherwise delete the message) — we want this update to
      // win.
      entry.suppressDelete = true;
      const verb =
        optionId === "cancel"
          ? "cancelled"
          : pickResolvedVerb(entry.options, optionId);
      const newText = `:lock: _${verb} by <@${decoratedBy}>_`;
      await this.opts.thread
        .updateMessage(entry.promptChannel, entry.promptTs, newText, [])
        .catch(() => undefined);
    }
    await this.respondToPermission(entry, optionId);
    return true;
  }

  async handleReaction(
    sessionId: string,
    channel: string,
    ts: string,
    action: ReactionAction,
    added: boolean,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.info(
        `handleReaction drop: no SessionState for ${sessionId.slice(0, 8)} action=${action}; have=${[...this.sessions.keys()].map((k) => k.slice(0, 8)).join(",") || "(none)"}`,
      );
      return;
    }
    switch (action) {
      case "allow":
      case "allow_always":
      case "deny":
        if (!added) {
          return;
        }
        await this.handleAllowDeny(channel, ts, action);
        return;
      case "cancel": {
        if (!added) {
          return;
        }
        // Try the three indicator kinds in order. Each helper returns
        // true if it owned the ts and handled the cancel; the chain
        // short-circuits so the spinner branch only runs when nothing
        // upstream matched. Shared with the Block Kit Cancel button
        // handlers in slack/app.ts so reaction-cancel and button-cancel
        // behave identically.
        if (await this.cancelOwnQueuedByPromptTs(session, ts)) {
          return;
        }
        if (await this.cancelPeerQueuedByPromptTs(session, ts)) {
          return;
        }
        if (session.processingTs === ts) {
          log.info(`cancel <- slack (processing) ${sessionId.slice(0, 8)}`);
          this.cancelRunningTurn(session);
          return;
        }
        if (session.spinnerTs !== ts) {
          return;
        }
        log.info(`cancel <- slack ${sessionId.slice(0, 8)}`);
        this.cancelRunningTurn(session);
        return;
      }
      case "hide":
        if (added) {
          await this.hideMessage(channel, ts);
        } else {
          await this.unhideMessage(channel, ts);
        }
        return;
      case "expand_truncated":
        // :eyes: on the per-turn spinner toggles whether the spinner
        // shows just "working..." or expands to the running list of
        // tool calls. Falls through to the normal truncated-content
        // expand for any other message.
        if (session.spinnerTs === ts) {
          session.spinnerExpanded = added;
          await this.refreshSpinner(session).catch(() => undefined);
          return;
        }
        if (added) {
          await this.expandTruncated(channel, ts);
        } else {
          await this.collapseExpanded(channel, ts);
        }
        return;
      case "expand_full":
        if (added) {
          await this.expandFull(channel, ts);
        } else {
          await this.collapseExpanded(channel, ts);
        }
        return;
      case "heart":
        if (added) {
          await this.handleHeart(channel, ts);
        }
        return;
    }
  }

  private async handleAllowDeny(
    channel: string,
    ts: string,
    action: "allow" | "allow_always" | "deny",
  ): Promise<void> {
    // Look up the resolver entry by the Slack ts the user reacted on
    // — the only reliable way to disambiguate multiple permission
    // prompts on the same session. sessionId-keyed lookup picks
    // whichever entry was set last and resolves the wrong request.
    let pending: ReturnType<typeof this.permissionResolvers.get> | undefined;
    for (const e of this.permissionResolvers.values()) {
      if (e.promptTs === ts && e.promptChannel === channel) {
        pending = e;
        break;
      }
    }
    if (!pending) {
      const open = Array.from(this.permissionResolvers.values()).map(
        (e) =>
          `toolCallId=${e.toolCallId} session=${e.sessionId.slice(0, 8)} promptTs=${e.promptTs ?? "(none)"} promptChannel=${e.promptChannel ?? "(none)"}`,
      );
      log.info(
        `permission ${action} miss: no resolver matches ${channel}/${ts}; open=[${open.join(" | ") || "(none)"}]`,
      );
      return;
    }
    log.info(
      `permission ${action} match: toolCallId=${pending.toolCallId} session=${pending.sessionId.slice(0, 8)} ts=${ts}`,
    );
    // Map the reaction to a kind ordering. The first option whose kind
    // matches in priority order wins; if nothing matches we fall back to
    // the agent's first option (some agents don't tag option kinds).
    const priority: ReadonlyArray<string> =
      action === "allow_always"
        ? ["allow_always", "allow_once"]
        : action === "allow"
        ? ["allow_once", "allow_always"]
        : ["reject_once", "reject_always"];
    let opt: typeof pending.options[number] | undefined;
    for (const want of priority) {
      opt = pending.options.find((o) => o.kind === want);
      if (opt) {
        break;
      }
    }
    opt = opt ?? pending.options[0];
    const optionId = opt?.optionId;
    if (!optionId) {
      await this.respondToPermission(pending, "cancel");
      return;
    }
    await this.respondToPermission(pending, optionId);
  }

  private async hideMessage(channel: string, ts: string): Promise<void> {
    // Fetch current text, store it, replace with placeholder.
    const text = await this.fetchMessageText(channel, ts);
    if (text === undefined) {
      return;
    }
    this.opts.hiddenStore.save(channel, ts, text);
    await this.opts.thread.updateMessage(
      channel,
      ts,
      ":see_no_evil: _message hidden_",
    );
  }

  private async unhideMessage(channel: string, ts: string): Promise<void> {
    const original = this.opts.hiddenStore.load(channel, ts);
    if (original === undefined) {
      return;
    }
    await this.opts.thread.updateMessage(channel, ts, original);
    this.opts.hiddenStore.remove(channel, ts);
  }

  private async expandTruncated(channel: string, ts: string): Promise<void> {
    const full = this.opts.truncatedStore.loadFull(channel, ts);
    const collapsed = this.opts.truncatedStore.loadCollapsed(channel, ts);
    if (!full || !collapsed) {
      return;
    }
    const text = `${collapsed}\n\`\`\`\n${truncate(full)}\n\`\`\``;
    await this.opts.thread.updateMessage(channel, ts, text);
  }

  private async expandFull(channel: string, ts: string): Promise<void> {
    const full = this.opts.truncatedStore.loadFull(channel, ts);
    const collapsed = this.opts.truncatedStore.loadCollapsed(channel, ts);
    if (!full || !collapsed) {
      return;
    }
    const text = `${collapsed}\n\`\`\`\n${fullExpand(full)}\n\`\`\``;
    await this.opts.thread.updateMessage(channel, ts, text);
  }

  private async collapseExpanded(channel: string, ts: string): Promise<void> {
    const collapsed = this.opts.truncatedStore.loadCollapsed(channel, ts);
    if (!collapsed) {
      return;
    }
    await this.opts.thread.updateMessage(channel, ts, collapsed);
  }

  private async handleHeart(channel: string, ts: string): Promise<void> {
    // Forward as a user prompt so the agent sees positive feedback.
    const text = await this.fetchMessageText(channel, ts);
    if (text === undefined) {
      return;
    }
    // Pick any active session; for a multi-session bridge this is "the
    // current one" — we don't have a more specific signal here.
    const first = this.sessions.values().next().value;
    if (!first) {
      return;
    }
    await this.sendUserPrompt(
      first.sessionId,
      `The user heart-reacted to: ${text}`,
    );
  }

  private async fetchMessageText(
    channel: string,
    ts: string,
  ): Promise<string | undefined> {
    return this.opts.thread.fetchText(channel, ts);
  }

  // Returns the live slash-command map for the session, name → description
  // (description optional). The set is reset on every
  // available_commands_update from the daemon; an empty map means the
  // bridge hasn't yet seen one (slack should treat unknown bangs as a
  // soft error in that case).
  availableCommands(sessionId: string): ReadonlyMap<string, string | undefined> {
    const s = this.sessions.get(sessionId);
    if (s) {
      return s.availableCommands;
    }
    return this.pendingCommands.get(sessionId) ?? new Map();
  }

  // Decode an available_commands_update params payload and apply it to
  // whichever map currently represents the session: the live
  // SessionState if one exists, otherwise the pendingCommands stash so
  // createSession can adopt it once the bridge opens a thread.
  private applyAvailableCommandsUpdate(
    sessionId: string,
    params: Record<string, unknown>,
  ): void {
    const update = (params.update ?? {}) as Record<string, unknown>;
    const raw = update.availableCommands ?? update.commands;
    const list = Array.isArray(raw) ? raw : [];
    const next = new Map<string, string | undefined>();
    for (const c of list) {
      if (!c || typeof c !== "object") {
        continue;
      }
      const entry = c as { name?: unknown; description?: unknown };
      if (typeof entry.name !== "string" || entry.name.length === 0) {
        continue;
      }
      // Normalize: protocol may advertise either bare ("create_plan")
      // or slash-prefixed ("/hydra title") names. Store slash-prefixed
      // so the bang→slash mapping is a direct lookup.
      //
      // Some agents (hydra's own /hydra commands; see
      // cli/src/core/hydra-commands.ts:hydraCommandsAsAdvertised)
      // concatenate the args-hint into the name field — the wire-level
      // string is literally `hydra agent <agent>`. Strip the trailing
      // `<…>` tokens so the map key is the bare verb (`/hydra agent`),
      // which is what matchKnownCommand needs to compare against the
      // user's actual input. The original argsHint is preserved in the
      // description prefix so the unknown-command listing still shows
      // it.
      const rawName = entry.name.startsWith("/")
        ? entry.name
        : `/${entry.name}`;
      const { name, argsHint } = stripCommandArgsHint(rawName);
      const baseDesc =
        typeof entry.description === "string"
          ? entry.description
          : undefined;
      const desc = argsHint
        ? baseDesc
          ? `${argsHint} — ${baseDesc}`
          : argsHint
        : baseDesc;
      next.set(name, desc);
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      session.availableCommands.clear();
      for (const [k, v] of next) {
        session.availableCommands.set(k, v);
      }
    } else {
      this.pendingCommands.set(sessionId, next);
    }
  }

  debugInfo(sessionId: string): string {
    const s = this.sessions.get(sessionId);
    return JSON.stringify(
      {
        sessionId,
        threadTs: s?.threadTs,
        channel: s?.channel,
        cwd: s?.cwd,
        title: s?.title,
        connected: this.opts.attach.isConnected,
        lastFrameAt: new Date(this.opts.attach.lastFrameTime).toISOString(),
      },
      null,
      2,
    );
  }
}

// Quick predicate so the early-out path that peels off
// available_commands_update from the live gate doesn't need to repeat
// the type narrowing inline.
function isAvailableCommandsUpdate(params: Record<string, unknown>): boolean {
  const update = (params.update ?? {}) as { sessionUpdate?: unknown };
  return update.sessionUpdate === "available_commands_update";
}

// Split an advertised command name into the verb portion and any
// trailing args-hint tokens. `<…>` placeholders get peeled off; the
// remaining tail (after the last hint) is treated as still part of the
// verb so descriptive suffixes survive. E.g.:
//   "/hydra agent <agent>"      → { name: "/hydra agent", argsHint: "<agent>" }
//   "/hydra title"              → { name: "/hydra title", argsHint: undefined }
//   "/foo <a> <b>"              → { name: "/foo",          argsHint: "<a> <b>" }
export function stripCommandArgsHint(raw: string): {
  name: string;
  argsHint: string | undefined;
} {
  const tokens = raw.split(/\s+/);
  let i = tokens.length;
  while (i > 0 && /^<[^>]*>$/.test(tokens[i - 1] ?? "")) {
    i--;
  }
  if (i === tokens.length) {
    return { name: raw, argsHint: undefined };
  }
  return {
    name: tokens.slice(0, i).join(" "),
    argsHint: tokens.slice(i).join(" "),
  };
}

// Render the thread's parent-message text. Always includes
// sessionMarker(sessionId) so a daemon restart can locate this thread by
// scanning channel history (ThreadClient.findSessionThread).
//
// Heading priority:
//   title       — agent-supplied per-session, e.g. via session/title-changed
//   basename(cwd) — derived per-session
//   none        — fall back to just the marker line, since the only thing
//                 left would be the sessionId, which already appears in
//                 the marker
//
// Layout below the title (each line omitted when the inputs aren't known):
//   1. cwd path with the daemon's hostname appended ("_/path_ on `host`")
//      — disambiguates threads when running multiple hydra-acp-slack daemons
//      against the same Slack workspace.
//   2. Agent / model / mode / usage stats on one packed line, with
//      identifiers wrapped in backticks for monospace contrast (Slack
//      mrkdwn doesn't support color).
//   3. Session marker (italic, contains the full sessionId for the
//      grep-based reattach path).
function renderParent(opts: {
  title: string | undefined;
  cwd: string | undefined;
  sessionId: string;
  agentName: string | undefined;
  modelId: string | undefined;
  modeId: string | undefined;
  contextUsed: number | undefined;
  contextSize: number | undefined;
  costAmount: number | undefined;
  costCurrency: string | undefined;
}): string {
  const heading =
    opts.title ?? (opts.cwd ? basename(opts.cwd) : undefined);
  const lines: string[] = [];
  if (heading) {
    lines.push(`:robot_face: *${heading}*`);
  }
  const tailParts: string[] = [];
  if (opts.cwd) {
    tailParts.push(`_${opts.cwd}_ on \`${daemonHost}\``);
  } else {
    tailParts.push(`on \`${daemonHost}\``);
  }
  const agent = friendlyAgent(opts.agentName);
  // Collapse "agent · model" into "agent(model)" so the line reads like
  // "opencode(gpt-5-codex) · mode build · …" rather than three separate
  // backticked pills competing for the same row.
  const agentCell = agentWithModel(agent, opts.modelId);
  if (agentCell) {
    tailParts.push(`\`${agentCell}\``);
  }
  if (opts.modeId) {
    tailParts.push(`mode \`${opts.modeId}\``);
  }
  if (typeof opts.contextUsed === "number" || typeof opts.contextSize === "number") {
    const used = formatTokens(opts.contextUsed);
    const size = formatTokens(opts.contextSize);
    tailParts.push(`\`${used}\`/\`${size}\``);
  }
  if (typeof opts.costAmount === "number") {
    const cur = opts.costCurrency ?? "USD";
    tailParts.push(`\`${formatCost(opts.costAmount, cur)}\``);
  }
  tailParts.push(sessionMarker(opts.sessionId));
  lines.push(tailParts.join(" "));
  return lines.join("\n");
}

const daemonHost = hostname().split(".")[0] ?? hostname();

// Strip the npm-style scope prefix from agentInfo.name so a name like
// "@agentclientprotocol/claude-agent-acp" displays as the bare package
// name "claude-agent-acp". Most ACP agents publish under a scope; for
// presentation the scope is uninformative noise.
function friendlyAgent(name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  const m = name.match(/^@[^/]+\/(.+)$/);
  return m?.[1] ?? name;
}

// Drop the provider prefix from a model id ("openai/gpt-4o-mini" →
// "gpt-4o-mini") to keep the thread header line readable.
function shortenModel(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  const idx = model.lastIndexOf("/");
  return idx === -1 ? model : model.slice(idx + 1);
}

function agentWithModel(
  agent: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!agent) {
    return undefined;
  }
  const short = shortenModel(model);
  return short ? `${agent}(${short})` : agent;
}

// Pull the hydra agentId from an update's _meta extension namespace.
// session_info_update's ACP-standard payload is just title/updatedAt;
// /hydra agent carries the new agentId under _meta["hydra-acp"] so
// strict ACP clients ignore the extension and hydra-aware clients
// (this one) read it.
function readHydraAgentId(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const ns = (meta as Record<string, unknown>)["hydra-acp"];
  if (!ns || typeof ns !== "object" || Array.isArray(ns)) {
    return undefined;
  }
  const v = (ns as Record<string, unknown>).agentId;
  return typeof v === "string" ? v : undefined;
}

function formatTokens(n: number | undefined): string {
  if (typeof n !== "number") {
    return "?";
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)}k`;
  }
  return `${n}`;
}

function formatCost(amount: number, currency: string): string {
  const sym = currency === "USD" ? "$" : `${currency} `;
  return `${sym}${amount.toFixed(2)}`;
}

// Render the per-turn spinner message. Collapsed by default — just an
// hourglass and "working..." — so a turn that does ten tool calls
// occupies one line in the thread instead of ten cards. When the user
// reacts :eyes: on the spinner, spinnerExpanded flips to true and the
// list of tool calls in this turn appears inline below the spinner
// header. Removing the reaction collapses again.
//
// After 30s of elapsed time the head grows an "(elapsed)" suffix that
// updates every 30s via the spinner ticker (see startSpinnerTicker).
// This serves as proof of life on long-running turns.
function renderSpinner(session: SessionState): string {
  const elapsed = session.spinnerStartedAt
    ? Date.now() - session.spinnerStartedAt
    : 0;
  // Elapsed-time meta only appears after 30s — keeps the head clean
  // on short turns, surfaces proof-of-life on long ones. Italic so it
  // visually matches the _N ahead_ / _N waiting_ meta on the queued
  // and processing indicators.
  const meta = elapsed >= 30_000 ? ` · _${formatElapsed(elapsed)}_` : "";
  const head = `:robot_face: *Working*${meta}`;
  if (!session.spinnerExpanded) {
    return head;
  }
  return renderSpinnerExpanded(session, head);
}

// Compose the static turn-end marker. Picks an icon and label based on
// the stopReason carried on turn_complete (or session/prompt response
// for own turns). end_turn / no reason → success; cancelled → an
// explicit "cancelled" indicator so a user-interrupted turn doesn't
// look like a normal completion; other non-success reasons (refusal,
// max_tokens, etc.) use a warning icon and include the reason text.
// Final per-turn marker, posted at the bottom of the thread once the
// agent goes idle. Replaces both the in-place "✓ done" spinner finalize
// and the separate Ready post — see finalizeSpinnerWork. Combines the
// stop-reason icon with the turn's stats into one line.
function renderReadyMarker(
  count: number,
  elapsedMs: number,
  stopReason: string | undefined,
): string {
  let icon: string;
  let label: string;
  if (stopReason === "cancelled") {
    icon = ":no_entry:";
    label = "cancelled";
  } else if (stopReason && stopReason !== "end_turn") {
    icon = ":warning:";
    label = stopReason;
  } else {
    icon = ":white_check_mark:";
    label = "Ready";
  }
  const stats: string[] = [];
  if (count > 0) {
    stats.push(`${count} tool${count === 1 ? "" : "s"}`);
  }
  if (elapsedMs > 0) {
    stats.push(formatElapsed(elapsedMs));
  }
  if (stats.length === 0) {
    return `${icon} *${label}*`;
  }
  return `${icon} *${label}* _· ${stats.join(" · ")}_`;
}

// Trim a prompt for inline display in a queue/processing indicator so
// the marker stays a single line even for paragraph-length prompts.
function formatPromptPreview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 200) {
    return trimmed;
  }
  return `${trimmed.slice(0, 200)}…`;
}

// Centralized renderers for the per-turn indicator family. Keep the
// vocabulary consistent across the queued → processing → working →
// ready lifecycle so the thread reads as one continuous progression:
//
//   :hourglass_flowing_sand: *Queued*    — <preview> · _N ahead_
//   :zap:                    *Processing* — <preview> · _N waiting_
//   :robot_face:             *Working*   · _elapsed_
//   :x:                      _Cancelled_  — <preview>
//   :white_check_mark:       *Ready*      · _N tools · elapsed_
//
// Bold for active states, italic for terminal/de-emphasized states.
// Em-dash separates the label from the prompt preview; middle-dot
// separates meta segments. Meta segments stay italic so they don't
// compete with the preview text for scanning.
function formatQueuedIndicator(text: string, aheadCount: number): string {
  const meta = aheadCount > 0
    ? ` · _${aheadCount === 1 ? "1 ahead" : `${aheadCount} ahead`}_`
    : "";
  return `:hourglass_flowing_sand: *Queued* — ${formatPromptPreview(text)}${meta}`;
}

function formatProcessingIndicator(text: string, waitingCount: number): string {
  const meta = waitingCount > 0
    ? ` · _${waitingCount === 1 ? "1 waiting" : `${waitingCount} waiting`}_`
    : "";
  return `:zap: *Processing* — ${formatPromptPreview(text)}${meta}`;
}

function formatCancelledQueuedIndicator(text: string): string {
  return `:x: _Cancelled_ — ${formatPromptPreview(text)}`;
}

// Compact human-readable elapsed-time formatter.
//   0s..59s    → "Xs"
//   1m..59m    → "Xm" or "Xm Ys" if Y > 0
//   1h+        → "Xh" or "Xh Ym" if Y > 0
function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const totalMin = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (totalMin < 60) {
    return remSec > 0 ? `${totalMin}m ${remSec}s` : `${totalMin}m`;
  }
  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  return remMin > 0 ? `${totalHr}h ${remMin}m` : `${totalHr}h`;
}

// Tool-list rendering shared between the active spinner (when :eyes:
// is reacted) and finalizeSpinner's preservation of the expanded view
// when a turn ends with the user still watching. `head` is the line
// shown above the list — the active "working..." or the finalized
// ":white_check_mark: _N tools_".
function renderSpinnerExpanded(session: SessionState, head: string): string {
  const lines = [head];
  for (const id of session.turnToolCallIds) {
    const tc = session.toolCalls.get(id);
    if (!tc) {
      continue;
    }
    lines.push(
      renderToolCallHeader({
        status: tc.status,
        title: tc.title,
        kind: tc.kind,
      }),
    );
  }
  return lines.join("\n");
}

function renderPlan(update: Record<string, unknown>): string | undefined {
  const entries = update.entries as
    | Array<{ content?: string; status?: string }>
    | undefined;
  if (!Array.isArray(entries)) {
    return undefined;
  }
  return entries
    .map((e) => {
      const icon = statusIcon(e.status as ToolCallStatus | undefined);
      return `${icon} ${e.content ?? ""}`;
    })
    .join("\n");
}

function statusIconShim(s: string | undefined): string {
  return statusIcon(s as ToolCallStatus | undefined);
}
// Keep the unused-import linter quiet but available for future use.
void statusIconShim;

// Action-id prefix for permission buttons. The slack/app.ts action
// listener matches on this exact prefix; the rest of the action_id is
// the optionId (which can be opaque per ACP — we surface it back to
// the agent verbatim, but never embed the sessionId / toolCallId in
// it because Slack caps action_id at 255 chars).
export const PERMISSION_ACTION_PREFIX = "hydra-perm:";

// `value` is the only place we get to stash extra state on a Slack
// button (max 2000 chars). We pack sessionId + toolCallId + optionId
// as JSON so the action handler can route without a global lookup
// table.
interface PermissionButtonValue {
  s: string; // sessionId
  t: string; // toolCallId
  o: string; // optionId (or "cancel")
}

export function encodePermissionButtonValue(v: PermissionButtonValue): string {
  return JSON.stringify(v);
}

export function decodePermissionButtonValue(
  raw: string | undefined,
): PermissionButtonValue | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const v = JSON.parse(raw) as Partial<PermissionButtonValue>;
    if (typeof v.s !== "string" || typeof v.t !== "string" || typeof v.o !== "string") {
      return undefined;
    }
    return { s: v.s, t: v.t, o: v.o };
  } catch {
    return undefined;
  }
}

// Construct the text fallback + Block Kit payload for a permission
// prompt. `text` is what notifications and accessibility readers see;
// the visible UI is the section header + actions row of buttons.
// Slack's actions block holds at most 5 elements — if the agent
// surfaces more options than that we fall through to a sixth
// "overflow" disclosure inline in the section. In practice agents
// emit ≤4 options (allow_once / allow_always / reject_once /
// reject_always).
export function buildPermissionMessage(
  sessionId: string,
  toolCallId: string,
  title: string,
  options: ReadonlyArray<{ optionId: string; name: string; kind?: string }>,
): { text: string; blocks: SlackBlock[] } {
  const text = `:lock: Permission requested — ${title}`;
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:lock: *Permission requested*\n${title}` },
    },
  ];

  const buttonOptions = options.slice(0, 5);
  const overflow = options.slice(5);

  if (overflow.length > 0) {
    // Surface the names of the cut-off options in a context block so
    // the user at least knows they exist — but they won't be clickable
    // without a redesign (e.g. an overflow menu). Worth revisiting if
    // any agent actually starts emitting >5 options.
    const overflowLine =
      "_additional options not shown:_ " +
      overflow.map((o) => `\`${o.name}\``).join(", ");
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: overflowLine }],
    });
  }

  const elements = buttonOptions.map((o) => {
    const label = truncateButtonLabel(o.name);
    const style = buttonStyleForKind(o.kind);
    const value = encodePermissionButtonValue({
      s: sessionId,
      t: toolCallId,
      o: o.optionId,
    });
    const btn: import("../formatters/markdown.js").ButtonElement = {
      type: "button",
      text: { type: "plain_text", text: label, emoji: true },
      action_id: `${PERMISSION_ACTION_PREFIX}${o.optionId}`,
      value,
    };
    if (style) {
      btn.style = style;
    }
    return btn;
  });

  if (elements.length > 0) {
    blocks.push({ type: "actions", elements });
  }

  return { text, blocks };
}

// Slack caps button text at 75 chars. Trim with an ellipsis so long
// option names don't get a hard reject from the chat.postMessage
// validator.
function truncateButtonLabel(name: string): string {
  const MAX = 75;
  if (name.length <= MAX) {
    return name;
  }
  return name.slice(0, MAX - 1) + "…";
}

function buttonStyleForKind(kind: string | undefined): "primary" | "danger" | undefined {
  if (kind === "allow_once" || kind === "allow_always") {
    return "primary";
  }
  if (kind === "reject_once" || kind === "reject_always") {
    return "danger";
  }
  return undefined;
}

// Human-readable verb for the "decided by @user" line shown after a
// button click. Derived from the resolved option's kind when available,
// falling back to the option name; "cancel" is its own case (no option
// in `options`).
function pickResolvedVerb(
  options: ReadonlyArray<{ optionId: string; name: string; kind?: string }>,
  optionId: string,
): string {
  const opt = options.find((o) => o.optionId === optionId);
  if (!opt) {
    return "decided";
  }
  switch (opt.kind) {
    case "allow_once":
      return "allowed once";
    case "allow_always":
      return "allowed always";
    case "reject_once":
      return "rejected";
    case "reject_always":
      return "rejected always";
    default:
      return `chose ${opt.name}`;
  }
}

// Block Kit cancel buttons attached to the queued / processing / spinner
// indicators. Two action ids — queued cancels target a specific entry
// (correlated by the indicator's own Slack ts, which lives on the
// QueuedPromptEntry / peer entry); turn cancels are session-scoped and
// fire session/cancel for the running turn. The spinner-details button
// shares the turn-scoped value shape since it also only needs sessionId.
export const CANCEL_QUEUED_ACTION_ID = "hydra-cancel-queued";
export const CANCEL_TURN_ACTION_ID = "hydra-cancel-turn";
export const SPINNER_DETAILS_ACTION_ID = "hydra-spinner-details";

interface CancelQueuedButtonValue {
  s: string; // sessionId
  p: string; // promptTs of the indicator message (used as the correlator)
}

interface CancelTurnButtonValue {
  s: string; // sessionId
}

export function encodeCancelQueuedValue(v: CancelQueuedButtonValue): string {
  return JSON.stringify(v);
}

export function decodeCancelQueuedValue(
  raw: string | undefined,
): CancelQueuedButtonValue | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const v = JSON.parse(raw) as Partial<CancelQueuedButtonValue>;
    if (typeof v.s !== "string" || typeof v.p !== "string") {
      return undefined;
    }
    return { s: v.s, p: v.p };
  } catch {
    return undefined;
  }
}

export function encodeCancelTurnValue(v: CancelTurnButtonValue): string {
  return JSON.stringify(v);
}

export function decodeCancelTurnValue(
  raw: string | undefined,
): CancelTurnButtonValue | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const v = JSON.parse(raw) as Partial<CancelTurnButtonValue>;
    if (typeof v.s !== "string") {
      return undefined;
    }
    return { s: v.s };
  } catch {
    return undefined;
  }
}

// Build a danger-styled "Cancel" button referencing a specific queued
// indicator's ts. Used as the sole element of the actions block on
// queued indicators (own + peer).
function buildCancelQueuedButton(
  sessionId: string,
  promptTs: string,
): import("../formatters/markdown.js").ButtonElement {
  return {
    type: "button",
    text: { type: "plain_text", text: "Cancel", emoji: true },
    action_id: CANCEL_QUEUED_ACTION_ID,
    value: encodeCancelQueuedValue({ s: sessionId, p: promptTs }),
    style: "danger",
  };
}

// Build a danger-styled "Cancel" button for turn-scoped cancels
// (processing indicator + spinner). Same wire effect as a :stop_sign:
// reaction on either of those messages.
function buildCancelTurnButton(
  sessionId: string,
): import("../formatters/markdown.js").ButtonElement {
  return {
    type: "button",
    text: { type: "plain_text", text: "Cancel", emoji: true },
    action_id: CANCEL_TURN_ACTION_ID,
    value: encodeCancelTurnValue({ s: sessionId }),
    style: "danger",
  };
}

// Build the spinner's details toggle button. Label flips based on
// current expanded state — same boolean the :eyes: reaction toggles.
// Caller decides whether to include it (see buildSpinnerBlocks: only
// shown once a tool call has appeared, or while the spinner is
// already expanded so the user can collapse back).
function buildSpinnerDetailsButton(
  sessionId: string,
  expanded: boolean,
): import("../formatters/markdown.js").ButtonElement {
  return {
    type: "button",
    text: {
      type: "plain_text",
      text: expanded ? "Hide details" : "Show details",
      emoji: true,
    },
    action_id: SPINNER_DETAILS_ACTION_ID,
    value: encodeCancelTurnValue({ s: sessionId }),
  };
}

// Block payload for a queued indicator. Section block carries the
// existing mrkdwn line; actions block holds a single Cancel button
// correlated by the indicator's own Slack ts. The caller already knows
// the ts before posting (postQueueIndicator) or has it on the entry
// (handlePromptQueueUpdated re-render). Returns `undefined` blocks when
// promptTs is not yet known so the indicator posts as plain text first
// and gets blocks attached on the follow-up update.
export function buildQueuedBlocks(
  sessionId: string,
  promptTs: string,
  text: string,
): SlackBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
    {
      type: "actions",
      elements: [buildCancelQueuedButton(sessionId, promptTs)],
    },
  ];
}

// Block payload for the processing indicator. Single Cancel button
// firing session/cancel — same wire effect as the :stop_sign: reaction
// branch in handleReaction.
export function buildProcessingBlocks(
  sessionId: string,
  text: string,
): SlackBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
    {
      type: "actions",
      elements: [buildCancelTurnButton(sessionId)],
    },
  ];
}

// Block payload for the per-turn spinner. Always includes a Cancel
// button; conditionally includes a Show/Hide details toggle when there
// is something to expand (or the spinner is already expanded — so the
// user can always collapse back). The absent toggle on a tool-call-less
// turn doubles as a "no tools yet" signal.
export function buildSpinnerBlocks(
  sessionId: string,
  text: string,
  opts: { expanded: boolean; toolCallCount: number },
): SlackBlock[] {
  const showToggle = opts.expanded || opts.toolCallCount > 0;
  const elements: import("../formatters/markdown.js").ButtonElement[] = [];
  if (showToggle) {
    elements.push(buildSpinnerDetailsButton(sessionId, opts.expanded));
  }
  elements.push(buildCancelTurnButton(sessionId));
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
    {
      type: "actions",
      elements,
    },
  ];
}
