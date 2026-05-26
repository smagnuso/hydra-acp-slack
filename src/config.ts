import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  slackChannelId: string | undefined;
  authorizedUsers: Set<string>;
  // When true, attach the session's *.hydra bundle (meta + history;
  // produced by GET /v1/sessions/:id/export) to the Slack thread when
  // the session closes. Bundles can be re-imported into any hydra
  // daemon to reconstitute the conversation context.
  uploadBundleOnEnd: boolean;
  websocketStaleThreshold: number;
  imageUploadRateLimit: number;
  imageUploadRateWindow: number;
  // Hydra daemon URL/token. Sourced from HYDRA_ACP_DAEMON_URL and
  // HYDRA_ACP_TOKEN env vars (set by hydra when it spawns this extension)
  // or, as a fallback, from the config file under HYDRA_DAEMON_URL /
  // HYDRA_TOKEN.
  hydraDaemonUrl: string;
  hydraWsUrl: string;
  hydraToken: string;
  // Polling interval for /v1/sessions discovery.
  hydraPollIntervalMs: number;
  // When true, mirror the proxy's history replay to Slack on attach.
  // Default false — replaying long-running sessions floods the channel
  // and trips Slack's rate limits. Live activity from this point forward
  // works regardless.
  backfillHistory: boolean;
  // Quiet period (ms) of inbound silence before we consider the attach
  // "caught up to live." Used only when backfillHistory is false.
  liveQuietMs: number;
  // Delay (ms) between receiving a session/request_permission and posting
  // the Slack prompt. If session/update permission_resolved (RFD #533, or
  // the tool-call fallback) fires within this window — e.g. the
  // auto-approver answers — no Slack message is ever posted, avoiding a
  // transient :lock: that gets deleted moments later. 0 disables.
  permissionDisplayDelayMs: number;
  // Janitor: scan known channels for `_session <id>_` markers whose
  // sessionId is no longer in the daemon's session list (live OR cold)
  // and delete the thread parent. When false, the sweep still runs but
  // only logs "would delete …" — for validating output before flipping
  // the flag on.
  deleteAbandonedThreads: boolean;
  threadJanitorIntervalMs: number;
  threadJanitorSettleMs: number;
  debug: boolean;
}

const PRIMARY_CONF_PATH = resolve(homedir(), ".hydra-acp", "slack.conf");
const LEGACY_CONF_PATH = resolve(homedir(), ".hydra-acp-slack.conf");

// The bridge owns a single state directory at ~/.hydra-acp/slack/ for
// every persistent artifact it writes: the cwd → channel routing map,
// hidden-message originals, and truncated-output cache. We keep the
// paths fixed (rather than configurable) so users don't have to think
// about file locations and so the structure stays predictable.
const STATE_DIR = resolve(homedir(), ".hydra-acp", "slack");

export function channelsFile(): string {
  return resolve(STATE_DIR, "channels.json");
}

export function hiddenMessagesDir(): string {
  return resolve(STATE_DIR, "hidden");
}

export function truncatedMessagesDir(): string {
  return resolve(STATE_DIR, "truncated");
}

const TRUTHY = new Set(["1", "true", "yes", "on", "t"]);

function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out.set(key, val);
  }
  return out;
}

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return "wss://" + httpUrl.slice("https://".length).replace(/\/$/, "") + "/acp";
  }
  if (httpUrl.startsWith("http://")) {
    return "ws://" + httpUrl.slice("http://".length).replace(/\/$/, "") + "/acp";
  }
  throw new Error(`hydraDaemonUrl must start with http:// or https://: ${httpUrl}`);
}

function bool(map: Map<string, string>, key: string, fallback: boolean): boolean {
  const v = map.get(key);
  if (v === undefined) {
    return fallback;
  }
  return TRUTHY.has(v.toLowerCase());
}

function intVal(map: Map<string, string>, key: string, fallback: number): number {
  const v = map.get(key);
  if (v === undefined || v.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function stringSet(map: Map<string, string>, key: string): Set<string> {
  const v = map.get(key);
  if (!v) {
    return new Set();
  }
  return new Set(
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function loadConfig(path: string = configPath()): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read config at ${path}: ${(err as Error).message}. ` +
        `Set HYDRA_ACP_SLACK_CONF env var to override.`,
    );
  }
  const map = parseEnvFile(text);

  const slackBotToken = map.get("SLACK_BOT_TOKEN");
  const slackAppToken = map.get("SLACK_APP_TOKEN");
  if (!slackBotToken) {
    throw new Error(`SLACK_BOT_TOKEN missing in ${path}`);
  }
  if (!slackAppToken) {
    throw new Error(`SLACK_APP_TOKEN missing in ${path}`);
  }

  const hydraDaemonUrl =
    process.env.HYDRA_ACP_DAEMON_URL ??
    map.get("HYDRA_DAEMON_URL") ??
    "http://127.0.0.1:8765";
  const hydraToken =
    process.env.HYDRA_ACP_TOKEN ?? map.get("HYDRA_TOKEN") ?? "";
  if (!hydraToken) {
    throw new Error(
      "Missing HYDRA_ACP_TOKEN env var (or HYDRA_TOKEN config key). When run as a hydra extension, hydra injects this automatically.",
    );
  }
  const hydraWsUrl =
    process.env.HYDRA_ACP_WS_URL ??
    map.get("HYDRA_WS_URL") ??
    deriveWsUrl(hydraDaemonUrl);

  return {
    slackBotToken,
    slackAppToken,
    slackChannelId: map.get("SLACK_CHANNEL_ID") ?? undefined,
    authorizedUsers: stringSet(map, "AUTHORIZED_USERS"),
    uploadBundleOnEnd: bool(map, "UPLOAD_BUNDLE_ON_END", true),
    websocketStaleThreshold: intVal(map, "WEBSOCKET_STALE_THRESHOLD", 30),
    imageUploadRateLimit: intVal(map, "IMAGE_UPLOAD_RATE_LIMIT", 30),
    imageUploadRateWindow: intVal(map, "IMAGE_UPLOAD_RATE_WINDOW", 60),
    hydraDaemonUrl,
    hydraWsUrl,
    hydraToken,
    hydraPollIntervalMs: intVal(map, "HYDRA_POLL_INTERVAL_MS", 2000),
    backfillHistory: bool(map, "BACKFILL_HISTORY", false),
    liveQuietMs: intVal(map, "LIVE_QUIET_MS", 2000),
    permissionDisplayDelayMs: intVal(map, "PERMISSION_DELAY_MS", 500),
    deleteAbandonedThreads: bool(map, "DELETE_ABANDONED_THREADS", false),
    threadJanitorIntervalMs: intVal(
      map,
      "THREAD_JANITOR_INTERVAL_MS",
      // Sweeps scan conversations.history across every known channel,
      // which isn't free. When delete is enabled you want prompt
      // cleanup; in dry-run nothing changes between sweeps once the
      // dedupe set is populated, so we can afford a much slower cadence.
      bool(map, "DELETE_ABANDONED_THREADS", false) ? 60_000 : 300_000,
    ),
    threadJanitorSettleMs: intVal(map, "THREAD_JANITOR_SETTLE_MS", 5_000),
    debug: bool(map, "DEBUG", false),
  };
}

export function configPath(): string {
  const override = process.env.HYDRA_ACP_SLACK_CONF;
  if (override) {
    return override;
  }
  if (existsSync(PRIMARY_CONF_PATH)) {
    return PRIMARY_CONF_PATH;
  }
  if (existsSync(LEGACY_CONF_PATH)) {
    return LEGACY_CONF_PATH;
  }
  return PRIMARY_CONF_PATH;
}
