import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ask, askSecret, confirm, maskToken, openBrowser, pause, pickFromList } from "./prompts.js";
import { callSlack, callSlackForm, exchangeOAuthCode, SlackApiError } from "./slack-api.js";
import { startOAuthServer } from "./oauth-server.js";
import { PRIMARY_CONF_PATH, readExisting, writeConf } from "./conf-writer.js";

const OAUTH_PORT = 4817;

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function header(num: number, total: number, title: string): void {
  process.stdout.write(`\n  ${BOLD}[${num}/${total}] ${title}${RESET}\n\n`);
}

function ok(msg: string): void {
  process.stdout.write(`      ${GREEN}✓${RESET} ${msg}\n`);
}

function warn(msg: string): void {
  process.stdout.write(`      ${YELLOW}⚠${RESET} ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`      ${RED}✗ ${msg}${RESET}\n`);
  process.exit(1);
}

function info(msg: string): void {
  process.stdout.write(`      ${msg}\n`);
}

function blank(): void {
  process.stdout.write("\n");
}

const TOTAL_STEPS = 7;

interface SlackManifest {
  display_information: { name: string; description?: string; background_color?: string };
  features: { bot_user: { display_name: string; always_online?: boolean } };
  oauth_config: { scopes: { bot: string[]; user?: string[] }; pkce_enabled?: boolean; redirect_urls?: string[] };
  settings: {
    event_subscriptions?: { bot_events?: string[]; user_events?: string[] };
    interactivity?: { is_enabled?: boolean };
    org_deploy_enabled?: boolean;
    socket_mode_enabled?: boolean;
    token_rotation_enabled?: boolean;
  };
}

function manifestPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../assets/slack-manifest.json");
}

function hasBin(name: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    if (!dir)
      continue;
    for (const ext of exts) {
      const full = join(dir, name + ext);
      try {
        if (statSync(full).isFile())
          return true;
      } catch {
        // not present in this dir; keep looking
      }
    }
  }
  return false;
}

function defaultBotName(): string {
  let u = "user";
  try {
    const name = userInfo().username;
    if (name)
      u = name;
  } catch {
    // userInfo can throw if the system has no user info; fall through.
  }
  const cleaned = u.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  return `${cleaned}-hydra-acp`;
}

function loadManifest(): SlackManifest {
  return JSON.parse(readFileSync(manifestPath(), "utf8")) as SlackManifest;
}

function sortedManifest(m: SlackManifest): SlackManifest {
  const c = JSON.parse(JSON.stringify(m)) as SlackManifest;
  c.oauth_config.scopes.bot = [...c.oauth_config.scopes.bot].sort();
  if (c.oauth_config.scopes.user)
    c.oauth_config.scopes.user = [...c.oauth_config.scopes.user].sort();
  if (c.oauth_config.redirect_urls)
    c.oauth_config.redirect_urls = [...c.oauth_config.redirect_urls].sort();
  if (c.settings.event_subscriptions?.bot_events)
    c.settings.event_subscriptions.bot_events = [...c.settings.event_subscriptions.bot_events].sort();
  if (c.settings.event_subscriptions?.user_events)
    c.settings.event_subscriptions.user_events = [...c.settings.event_subscriptions.user_events].sort();
  return c;
}

function diffStringArrays(label: string, current: string[] = [], desired: string[] = []): string[] {
  const cur = new Set(current);
  const des = new Set(desired);
  const removed = [...cur].filter((x) => !des.has(x)).sort();
  const added = [...des].filter((x) => !cur.has(x)).sort();
  if (removed.length === 0 && added.length === 0)
    return [];
  const out = [`${label}:`];
  for (const r of removed)
    out.push(`    ${RED}- ${r}${RESET}`);
  for (const a of added)
    out.push(`    ${GREEN}+ ${a}${RESET}`);
  return out;
}

interface Step1Result {
  keepExisting: boolean;
  existingBotToken?: string;
  existingAppId?: string;
}

async function step1Prereqs(): Promise<Step1Result> {
  header(1, TOTAL_STEPS, "Checking existing setup");

  info("This wizard creates a Slack app for hydra-acp, runs OAuth, and");
  info(`writes ${PRIMARY_CONF_PATH}. About 3–5 minutes.`);
  blank();

  const { map } = readExisting(PRIMARY_CONF_PATH);
  const existingBot = map.get("SLACK_BOT_TOKEN");
  const existingAppId = map.get("SLACK_APP_ID");

  if (!existingBot) {
    ok("No existing Slack config found");
    return { keepExisting: false };
  }

  info(`Existing config at ${PRIMARY_CONF_PATH}. Validating...`);
  try {
    const auth = await callSlack("auth.test", existingBot);
    const user = typeof auth.user === "string" ? auth.user : "?";
    const team = typeof auth.team === "string" ? auth.team : "?";
    ok(`Tokens valid: ${user} on ${team}`);
    blank();
    if (await confirm("Keep existing tokens and just sync the manifest?", true))
      return { keepExisting: true, existingBotToken: existingBot, existingAppId };
    return { keepExisting: false, existingBotToken: existingBot, existingAppId };
  } catch (err) {
    const msg = err instanceof SlackApiError ? err.slackError : (err as Error).message;
    warn(`Existing tokens failed validation (${msg}) — running full setup.`);
    return { keepExisting: false };
  }
}

interface Step2Result {
  appId: string;
  clientId: string;
  clientSecret: string;
  configToken: string;
  manifest: SlackManifest;
}

async function step2CreateApp(): Promise<Step2Result> {
  header(2, TOTAL_STEPS, "Create the Slack app");

  const baseName = defaultBotName();
  info("Pick a name unique to your Slack workspace — Slack rejects duplicates.");
  info(`Defaults are based on your system username so they don't collide with`);
  info(`other people running hydra-acp on the same workspace.`);
  blank();
  let name = await ask("App name (used for @mentions)", baseName);
  let display = await ask("Bot display name (shown in chat)", name);

  blank();
  info("To create the app programmatically, Slack needs a one-time App");
  info("Configuration Token. The token isn't stored — used once and discarded.");
  blank();
  info("  1. Click 'Generate Token' next to 'Your App Configuration Tokens'");
  info("  2. Pick the workspace you want the bot to live in, click 'Generate'");
  info("  3. Copy the Access Token and paste it below");
  blank();
  await pause("Press Enter to open the Slack page...");
  openBrowser("https://api.slack.com/apps?new_app_token=1");
  blank();
  const configToken = await askSecret("App Configuration Access Token");
  if (!configToken)
    fail("No token provided");

  for (;;) {
    const manifest = loadManifest();
    manifest.display_information.name = name;
    manifest.features.bot_user.display_name = display;
    manifest.oauth_config.redirect_urls = [`http://localhost:${OAUTH_PORT}/callback`];

    try {
      const res = await callSlack("apps.manifest.create", configToken, { manifest });
      const appId = res.app_id as string;
      const creds = res.credentials as { client_id: string; client_secret: string };
      ok(`App created (id: ${appId})`);
      return { appId, clientId: creds.client_id, clientSecret: creds.client_secret, configToken, manifest };
    } catch (err) {
      blank();
      if (err instanceof SlackApiError) {
        warn(`apps.manifest.create failed: ${err.slackError}`);
        const errs = (err.details as { errors?: unknown[] }).errors;
        if (Array.isArray(errs)) {
          for (const e of errs)
            warn(`  ${typeof e === "object" ? JSON.stringify(e) : String(e)}`);
        }
        blank();
        if (!(await confirm("Try a different name?", true)))
          fail("Aborted at app creation.");
        name = await ask("App name", name);
        display = await ask("Bot display name", name);
      } else {
        // Network / transport error (e.g. "fetch failed"), not a Slack rejection.
        // The name is fine; the request never reached Slack, so offer a retry.
        warn(`apps.manifest.create failed: ${(err as Error).message}`);
        warn("This looks like a network error — the request didn't reach Slack.");
        warn("Check your connection and that the App Configuration Token is valid.");
        blank();
        if (!(await confirm("Retry?", true)))
          fail("Aborted at app creation.");
      }
    }
  }
}

interface Step3Result {
  botToken: string;
  installingUserId: string | undefined;
}

async function step3OAuth(args: { clientId: string; clientSecret: string; manifest: SlackManifest }): Promise<Step3Result> {
  header(3, TOTAL_STEPS, "Authorize app (OAuth)");

  const server = await startOAuthServer(OAUTH_PORT);
  info("On the page that opens, click 'Allow' to install the app to your");
  info("workspace. The page will redirect back here automatically.");
  blank();

  const scopes = args.manifest.oauth_config.scopes.bot.join(",");
  const url =
    "https://slack.com/oauth/v2/authorize?" +
    new URLSearchParams({
      client_id: args.clientId,
      scope: scopes,
      redirect_uri: server.redirectUri,
    }).toString();

  await pause("Press Enter to open the Slack authorization page...");
  openBrowser(url);
  info("Waiting for authorization...");

  let code: string;
  try {
    const cb = await server.awaitCallback();
    code = cb.code;
  } catch (err) {
    server.close();
    fail(`OAuth failed: ${(err as Error).message}`);
  }
  server.close();

  let oauth: Record<string, unknown>;
  try {
    oauth = await exchangeOAuthCode({
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      code,
      redirectUri: server.redirectUri,
    });
  } catch (err) {
    fail(`Token exchange failed: ${(err as Error).message}`);
  }

  const botToken = typeof oauth.access_token === "string" ? oauth.access_token : "";
  if (!botToken.startsWith("xoxb-"))
    fail(`Expected bot token (xoxb-...), got '${botToken.slice(0, 8)}...'`);
  const authedUser = oauth.authed_user as { id?: string } | undefined;
  ok(`Bot token received (${maskToken(botToken)})`);
  return { botToken, installingUserId: authedUser?.id };
}

async function step4AppLevelToken(appId: string): Promise<string> {
  header(4, TOTAL_STEPS, "App-level token (Socket Mode)");

  info("Slack doesn't expose an API to generate this — you create it in the");
  info("UI, then paste it here (3 clicks).");
  blank();
  info("  1. Scroll to 'App-Level Tokens' on the page that opens");
  info("  2. Click 'Generate Token and Scopes'");
  info("  3. Name it 'socket', add scope: connections:write, click Generate");
  info("  4. Copy the xapp- token");
  blank();
  info("  Optional: while you're in the app config, click 'App Home' in the");
  info("  sidebar and enable 'Allow users to send Slash commands and messages");
  info("  from the messages tab' if you want to DM the bot directly.");
  blank();
  await pause("Press Enter to open the app page...");
  openBrowser(`https://api.slack.com/apps/${appId}/general`);
  blank();
  const token = await askSecret("App-level token (xapp-...)");
  if (!token)
    fail("App-level token is required for Socket Mode");
  if (!token.startsWith("xapp-"))
    fail(`Expected xapp- token, got '${token.slice(0, 8)}...'`);
  ok(`App-level token received (${maskToken(token)})`);
  return token;
}

interface Channel {
  id: string;
  name: string;
  isPrivate: boolean;
}

interface Step5Result {
  channelId: string | undefined;
  additionalUserIds: string[];
}

async function offerSeedAuthorizedUsers(args: {
  botToken: string;
  channelId: string;
  channelLabel: string;
  installingUserId: string | undefined;
}): Promise<string[]> {
  let memberIds: string[];
  try {
    const res = await callSlackForm("conversations.members", args.botToken, {
      channel: args.channelId,
      limit: "200",
    });
    const raw = (res.members as string[] | undefined) ?? [];
    memberIds = raw.filter((id) => id !== args.installingUserId);
  } catch (err) {
    const msg = err instanceof SlackApiError ? err.slackError : (err as Error).message;
    warn(`Could not list channel members (${msg}); skipping member seeding.`);
    return [];
  }

  if (memberIds.length === 0)
    return [];

  blank();
  info(`${args.channelLabel} has ${memberIds.length} other member(s).`);
  info(`AUTHORIZED_USERS controls who can prompt the bot and approve tool calls`);
  info(`— i.e. act under your credentials. Add only people you trust.`);
  blank();
  if (!(await confirm("Pick channel members to add to AUTHORIZED_USERS?", false)))
    return [];

  const cap = 50;
  const ids = memberIds.slice(0, cap);
  if (memberIds.length > cap)
    warn(`Showing first ${cap} of ${memberIds.length} members. Add the rest manually later.`);
  info(`Looking up names for ${ids.length} member(s)...`);

  const results = await Promise.allSettled(
    ids.map((id) => callSlackForm("users.info", args.botToken, { user: id })),
  );
  const people: { id: string; label: string }[] = [];
  for (let i = 0; i < ids.length; i++) {
    const r = results[i]!;
    if (r.status !== "fulfilled") {
      people.push({ id: ids[i]!, label: ids[i]! });
      continue;
    }
    const u =
      (r.value.user as { name?: string; real_name?: string; is_bot?: boolean; deleted?: boolean }) ?? {};
    if (u.is_bot || u.deleted)
      continue;
    const label = u.real_name ? `${u.real_name} (@${u.name ?? "?"})` : `@${u.name ?? ids[i]!}`;
    people.push({ id: ids[i]!, label });
  }

  if (people.length === 0) {
    info("No human members to add.");
    return [];
  }

  blank();
  info("Members in this channel:");
  people.forEach((p, i) => process.stdout.write(`        ${i + 1}. ${p.label}  (${p.id})\n`));
  blank();
  info("Comma-separated numbers to add (e.g. '1,3,4'), 'a' for all, blank to skip.");
  const reply = (await ask("Selection")).trim().toLowerCase();
  if (!reply)
    return [];
  if (reply === "a") {
    ok(`Adding ${people.length} member(s) to AUTHORIZED_USERS.`);
    return people.map((p) => p.id);
  }

  const picked: string[] = [];
  for (const tok of reply.split(",").map((s) => s.trim())) {
    const n = Number.parseInt(tok, 10);
    if (Number.isInteger(n) && n >= 1 && n <= people.length)
      picked.push(people[n - 1]!.id);
  }
  if (picked.length > 0)
    ok(`Adding ${picked.length} member(s) to AUTHORIZED_USERS.`);
  return picked;
}

async function step5PickChannel(args: {
  botToken: string;
  installingUserId: string | undefined;
}): Promise<Step5Result> {
  header(5, TOTAL_STEPS, "Pick a default channel (optional)");

  info("Invite the bot to the channel you want hydra to post in. In Slack,");
  info("type:  /invite @<your-bot-display-name>");
  info("then come back here. Skip this if you'd rather configure it later.");
  blank();
  if (!(await confirm("Have you invited the bot to a channel?", true))) {
    info("Skipping channel pick — add SLACK_CHANNEL_ID to slack.conf later.");
    return { channelId: undefined, additionalUserIds: [] };
  }

  let channels: Channel[] = [];
  try {
    const res = await callSlackForm("conversations.list", args.botToken, {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });
    const raw = (res.channels as Array<Record<string, unknown>> | undefined) ?? [];
    channels = raw
      .filter((c) => c.is_member === true)
      .map((c) => ({
        id: String(c.id),
        name: String(c.name ?? "?"),
        isPrivate: c.is_private === true,
      }));
  } catch (err) {
    const msg = err instanceof SlackApiError ? err.slackError : (err as Error).message;
    warn(`Could not list channels (${msg}). Enter a channel ID manually.`);
  }

  let chosenId: string | undefined;
  let chosenLabel = "";
  if (channels.length === 0) {
    info("Bot isn't a member of any channels yet, or listing failed.");
    const manual = await ask("Channel ID (C... or G..., blank to skip)");
    if (!manual)
      return { channelId: undefined, additionalUserIds: [] };
    chosenId = manual;
    chosenLabel = manual;
  } else {
    const picked = await pickFromList(
      "Channels the bot can post in:",
      channels,
      (c) => `${c.isPrivate ? "🔒" : "#"} ${c.name}  (${c.id})`,
    );
    if (!picked)
      return { channelId: undefined, additionalUserIds: [] };
    ok(`Channel: ${picked.isPrivate ? "🔒" : "#"}${picked.name} (${picked.id})`);
    chosenId = picked.id;
    chosenLabel = `${picked.isPrivate ? "🔒" : "#"}${picked.name}`;
  }

  const additionalUserIds = await offerSeedAuthorizedUsers({
    botToken: args.botToken,
    channelId: chosenId,
    channelLabel: chosenLabel,
    installingUserId: args.installingUserId,
  });
  return { channelId: chosenId, additionalUserIds };
}

async function step6WriteConfig(args: {
  botToken: string;
  appToken: string;
  appId: string;
  channelId: string | undefined;
  installingUserId: string | undefined;
  additionalUserIds: string[];
}): Promise<void> {
  header(6, TOTAL_STEPS, "Writing config");

  const { map } = readExisting(PRIMARY_CONF_PATH);
  const updates: Record<string, string | undefined> = {
    SLACK_BOT_TOKEN: args.botToken,
    SLACK_APP_TOKEN: args.appToken,
    SLACK_APP_ID: args.appId,
    SLACK_CHANNEL_ID: args.channelId,
  };

  const existingAuth = (map.get("AUTHORIZED_USERS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const explicitlyWidening = args.additionalUserIds.length > 0;
  if (explicitlyWidening || existingAuth.length === 0) {
    const union = new Set<string>(existingAuth);
    if (args.installingUserId)
      union.add(args.installingUserId);
    for (const id of args.additionalUserIds)
      union.add(id);
    if (union.size > 0)
      updates.AUTHORIZED_USERS = Array.from(union).join(",");
  }

  writeConf(PRIMARY_CONF_PATH, updates);
  ok(`Wrote ${PRIMARY_CONF_PATH} (chmod 600)`);
  if (updates.AUTHORIZED_USERS)
    ok(`AUTHORIZED_USERS: ${updates.AUTHORIZED_USERS}`);
  if (!map.get("HYDRA_TOKEN") && !process.env.HYDRA_ACP_TOKEN) {
    blank();
    warn("HYDRA_TOKEN isn't set. When run as a hydra extension, hydra injects");
    warn("HYDRA_ACP_TOKEN automatically. Standalone use needs HYDRA_TOKEN in");
    warn("slack.conf — see the placeholder comment in the file.");
  }
}

async function manifestSync(args: { existingBotToken: string; existingAppId: string | undefined }): Promise<void> {
  header(7, TOTAL_STEPS, "Sync manifest");

  let appId = args.existingAppId;
  if (!appId) {
    info("Your slack.conf doesn't record SLACK_APP_ID. Enter it manually so we");
    info("can sync the deployed manifest.");
    appId = (await ask("App ID (A...)")) || undefined;
    if (!appId) {
      warn("Skipping manifest sync.");
      return;
    }
  }

  info("Generate a one-time App Configuration Token to apply manifest changes.");
  await pause("Press Enter to open the Slack page...");
  openBrowser("https://api.slack.com/apps?new_app_token=1");
  blank();
  const configToken = await askSecret("App Configuration Access Token");
  if (!configToken) {
    warn("Skipping manifest sync.");
    return;
  }

  let exported: Record<string, unknown>;
  try {
    exported = await callSlack("apps.manifest.export", configToken, { app_id: appId });
  } catch (err) {
    const msg = err instanceof SlackApiError ? err.slackError : (err as Error).message;
    warn(`Manifest export failed: ${msg}`);
    return;
  }

  const current = exported.manifest as SlackManifest;
  const desired = loadManifest();
  desired.display_information.name = current.display_information.name;
  desired.features.bot_user.display_name = current.features.bot_user.display_name;
  desired.oauth_config.redirect_urls = [`http://localhost:${OAUTH_PORT}/callback`];

  const curS = sortedManifest(current);
  const desS = sortedManifest(desired);
  if (JSON.stringify(curS) === JSON.stringify(desS)) {
    ok("Manifest already in sync");
    return;
  }

  blank();
  info("Manifest changes:");
  const diffs: string[] = [];
  diffs.push(...diffStringArrays("  bot scopes", curS.oauth_config.scopes.bot, desS.oauth_config.scopes.bot));
  diffs.push(
    ...diffStringArrays(
      "  bot events",
      curS.settings.event_subscriptions?.bot_events ?? [],
      desS.settings.event_subscriptions?.bot_events ?? [],
    ),
  );
  diffs.push(
    ...diffStringArrays(
      "  redirect urls",
      curS.oauth_config.redirect_urls ?? [],
      desS.oauth_config.redirect_urls ?? [],
    ),
  );
  if (diffs.length === 0)
    info("  (changes in fields not summarized — apply to see full update)");
  else
    for (const line of diffs)
      info(line);
  blank();

  if (!(await confirm("Apply these changes?", true))) {
    warn("Skipped manifest update.");
    return;
  }
  try {
    await callSlack("apps.manifest.update", configToken, { app_id: appId, manifest: desired });
    ok("Manifest synced");
  } catch (err) {
    const msg = err instanceof SlackApiError ? err.slackError : (err as Error).message;
    warn(`Manifest update failed: ${msg}`);
  }
}

async function step7RegisterExtension(): Promise<void> {
  header(7, TOTAL_STEPS, "Register with hydra (optional)");

  if (!hasBin("hydra-acp")) {
    info("hydra-acp not found on PATH. Register manually later with:");
    info("  hydra-acp extensions add hydra-acp-slack");
    return;
  }

  const hydraConfigPath = resolve(homedir(), ".hydra-acp", "config.json");
  let alreadyRegistered = false;
  try {
    const cfg = JSON.parse(readFileSync(hydraConfigPath, "utf8")) as {
      extensions?: Record<string, unknown>;
    };
    if (cfg.extensions && "hydra-acp-slack" in cfg.extensions)
      alreadyRegistered = true;
  } catch {
    // No config or invalid JSON — treat as not registered.
  }

  if (alreadyRegistered) {
    ok("Already registered as a hydra extension.");
    info("Restart the daemon to pick up the new tokens: hydra-acp daemon restart");
    return;
  }

  info("hydra can manage hydra-acp-slack as a subprocess that auto-starts with");
  info("the daemon. This adds an entry to ~/.hydra-acp/config.json.");
  blank();
  if (!(await confirm("Register hydra-acp-slack as a hydra extension?", true))) {
    info("Skipping. Register later with:");
    info("  hydra-acp extensions add hydra-acp-slack");
    return;
  }

  const cmdArgs = ["extensions", "add", "hydra-acp-slack"];
  if (!hasBin("hydra-acp-slack")) {
    const scriptPath = process.argv[1] ?? "";
    if (!scriptPath) {
      warn("Couldn't determine script path; falling back to bare command.");
    } else if (scriptPath.includes("/.npm/_npx/")) {
      warn("Looks like you're running via npx — registering this transient path");
      warn("would break on the next npx cache cleanup. Install globally first:");
      info("  npm install -g @hydra-acp/slack");
      info("Then register with: hydra-acp extensions add hydra-acp-slack");
      return;
    } else {
      cmdArgs.push("--command", "node", "--args", scriptPath);
    }
  }

  info(`Running: hydra-acp ${cmdArgs.join(" ")}`);
  const result = spawnSync("hydra-acp", cmdArgs, { stdio: "inherit" });
  if (result.status === 0) {
    ok("Registered.");
    info("Start the daemon (or restart if already running): hydra-acp daemon restart");
  } else {
    blank();
    warn(`hydra-acp exited with code ${result.status ?? "?"}.`);
    info("Register manually later with:");
    info(`  hydra-acp ${cmdArgs.join(" ")}`);
  }
}

export async function runSetup(): Promise<void> {
  process.stdout.write(`\n  ${BOLD}hydra-acp-slack setup${RESET}\n`);

  const step1 = await step1Prereqs();

  if (step1.keepExisting && step1.existingBotToken) {
    await manifestSync({ existingBotToken: step1.existingBotToken, existingAppId: step1.existingAppId });
    blank();
    ok("Done. Start the bridge with: hydra-acp-slack");
    return;
  }

  const step2 = await step2CreateApp();
  const step3 = await step3OAuth({ clientId: step2.clientId, clientSecret: step2.clientSecret, manifest: step2.manifest });
  const appToken = await step4AppLevelToken(step2.appId);
  const step5 = await step5PickChannel({ botToken: step3.botToken, installingUserId: step3.installingUserId });
  await step6WriteConfig({
    botToken: step3.botToken,
    appToken,
    appId: step2.appId,
    channelId: step5.channelId,
    installingUserId: step3.installingUserId,
    additionalUserIds: step5.additionalUserIds,
  });
  await step7RegisterExtension();

  blank();
  ok("Setup complete.");
  if (!step5.channelId)
    info("Invite the bot to a channel and add SLACK_CHANNEL_ID to slack.conf.");
}
