#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpAttach } from "./acp/attach.js";
import { SessionBridge } from "./acp/session.js";
import {
  channelsFile,
  configPath,
  hiddenMessagesDir,
  loadConfig,
  truncatedMessagesDir,
} from "./config.js";
import { HydraDiscovery } from "./hydra-discovery.js";
import { createSlackApp } from "./slack/app.js";
import { consumePendingMessages } from "./slack/resurrect.js";
import { ThreadClient } from "./slack/thread.js";
import { ThreadJanitor } from "./slack/thread-janitor.js";
import { ChannelMap } from "./storage/channels.js";
import { HiddenStore } from "./storage/hidden.js";
import { TruncatedStore } from "./storage/truncated.js";
import { threadRegistry } from "./slack/registry.js";
import { logger, setDebug } from "./util/log.js";

const log = logger("main");

interface AttachContext {
  attach: AcpAttach;
  bridge: SessionBridge;
}

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function printUsage(): void {
  process.stdout.write(
    `hydra-acp-slack ${readVersion()}\n\n` +
      `Usage:\n` +
      `  hydra-acp-slack           Start the bridge daemon (default)\n` +
      `  hydra-acp-slack setup     Interactive Slack-app setup wizard\n` +
      `  hydra-acp-slack --version Print version\n` +
      `  hydra-acp-slack --help    Show this message\n`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`hydra-acp-slack ${readVersion()}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  if (argv[0] === "setup") {
    const { runSetup } = await import("./setup/wizard.js");
    await runSetup();
    return;
  }

  const path = configPath();
  const config = loadConfig(path);
  setDebug(config.debug);

  log.info(`config loaded from ${path}`);
  log.info(`hydra daemon: ${config.hydraDaemonUrl}`);
  log.info(
    `authorized users: ${config.authorizedUsers.size > 0 ? Array.from(config.authorizedUsers).join(",") + " (whitelist)" : "(empty — all Slack users allowed)"}`,
  );

  const slack = createSlackApp(config);
  await slack.start();
  const thread = new ThreadClient(slack.app);
  const channels = new ChannelMap(channelsFile());
  channels.startWatching();
  const truncatedStore = new TruncatedStore(truncatedMessagesDir());
  const hiddenStore = new HiddenStore(hiddenMessagesDir());

  const bridges = new Map<string, AttachContext>();

  // Periodic flusher: agent-message chunks accumulate until we observe a
  // pause (~750 ms) or a tool call begins, so we don't post one Slack
  // message per token. flushAll() is idempotent.
  const FLUSH_INTERVAL_MS = 750;
  const flushTimer = setInterval(() => {
    for (const ctx of bridges.values()) {
      void ctx.bridge.flushAll().catch((err: unknown) => {
        log.warn(`flush error: ${(err as Error).message}`);
      });
    }
  }, FLUSH_INTERVAL_MS);

  const discovery = new HydraDiscovery({
    daemonUrl: config.hydraDaemonUrl,
    token: config.hydraToken,
    pollIntervalMs: config.hydraPollIntervalMs,
    onAdd(session) {
      const sessionId = session.sessionId;
      log.info(
        `session added: ${sessionId} agent=${session.agentId ?? "?"} cwd=${session.cwd}`,
      );
      const attach = new AcpAttach({
        sessionId,
        daemonWsUrl: config.hydraWsUrl,
        token: config.hydraToken,
      });
      const initialMessages = consumePendingMessages(sessionId);
      const bridge = new SessionBridge({
        attach,
        config,
        thread,
        channels,
        truncatedStore,
        hiddenStore,
        sessionMeta: {
          sessionId,
          cwd: session.cwd,
          title: session.title,
          agentId: session.agentId,
          importedFromMachine: session.importedFromMachine,
          upstreamSessionId: session.upstreamSessionId,
        },
        initialMessages,
      });
      attach.on("close", () => {
        // Run the bundle dump (if enabled) before tearing down so
        // session state — channel, threadTs, sessionId — is still
        // populated for the upload. cleanup() and unregister run in
        // the .finally so they always happen even if upload errors.
        void bridge
          .uploadBundlesOnExit()
          .catch((err: unknown) => {
            log.warn(`bundle upload error: ${(err as Error).message}`);
          })
          .finally(() => {
            bridge.cleanup();
            threadRegistry.unregisterBridge(bridge);
            bridges.delete(sessionId);
          });
      });
      attach.on("error", (err) => {
        log.warn(`attach error: ${err.message}`);
      });
      attach.start();
      bridges.set(sessionId, { attach, bridge });
    },
    onRemove(sessionId) {
      log.info(`session removed: ${sessionId}`);
      const ctx = bridges.get(sessionId);
      if (ctx) {
        ctx.attach.stop();
        bridges.delete(sessionId);
      }
    },
  });
  discovery.start();

  const janitor = new ThreadJanitor({
    thread,
    channels,
    slackChannelId: config.slackChannelId,
    daemonUrl: config.hydraDaemonUrl,
    token: config.hydraToken,
    deleteEnabled: config.deleteAbandonedThreads,
    isLiveBridge: (id) => bridges.has(id),
    intervalMs: config.threadJanitorIntervalMs,
    settleMs: config.threadJanitorSettleMs,
  });
  janitor.start();

  const shutdown = async (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    clearInterval(flushTimer);
    try {
      discovery.stop();
      janitor.stop();
      // Flush any pending text before tearing down.
      for (const ctx of bridges.values()) {
        await ctx.bridge.flushAll().catch(() => undefined);
        ctx.attach.stop();
      }
      bridges.clear();
      await slack.stop();
    } catch (err) {
      log.error("stop error", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
