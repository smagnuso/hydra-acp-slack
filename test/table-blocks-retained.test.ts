import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { SessionBridge } from "../src/acp/session.js";
import type { Config } from "../src/config.js";
import type { ThreadClient } from "../src/slack/thread.js";

// Regression test: a long agent message containing a GFM table used to
// render as a native Slack table for a moment and then visibly flip to
// the monospace mrkdwn fallback. Cause: the blocks-mode path bailed when
// the mrkdwn *fallback* (only a notification fallback, since the markdown
// block is what users see) grew past SLACK_MESSAGE_LIMIT, and the
// following text-mode update sends `blocks: []`, wiping the good render.
// The fallback is now truncated instead, so every render of a
// table-bearing message keeps its markdown block.

const SESSION_ID = "hydra_session_TEST";
const CHANNEL = "C_TEST";

class FakeAttach extends EventEmitter {
  readonly sessionId = SESSION_ID;
  readonly clientId = "cli_self";
  readonly agentInfo = { name: "test-agent" };
  readonly attachMeta = undefined;
  readonly attachModels = undefined;

  async request<R = unknown>(): Promise<R> {
    return undefined as R;
  }

  notify(): void {}
}

interface Render {
  kind: "post" | "update";
  text: string;
  hasBlocks: boolean;
}

function makeFakeThread(): { thread: ThreadClient; renders: Render[] } {
  let n = 0;
  const renders: Render[] = [];
  const thread = {
    async findSessionThread(): Promise<string | undefined> {
      return undefined;
    },
    async postMessage(opts: {
      text?: string;
      blocks?: unknown[];
    }): Promise<{ channel: string; ts: string; threadTs: string }> {
      renders.push({
        kind: "post",
        text: opts.text ?? "",
        hasBlocks: Array.isArray(opts.blocks) && opts.blocks.length > 0,
      });
      return { channel: CHANNEL, ts: `ts_${++n}`, threadTs: "ts_thread" };
    },
    async updateMessage(
      _channel: string,
      _ts: string,
      text: string,
      blocks?: unknown[],
    ): Promise<void> {
      renders.push({
        kind: "update",
        text,
        hasBlocks: Array.isArray(blocks) && blocks.length > 0,
      });
    },
    async deleteMessage(): Promise<void> {},
    async fetchText(): Promise<string | undefined> {
      return undefined;
    },
    async uploadFile(): Promise<void> {},
    async uploadAudio(): Promise<void> {},
  };
  return { thread: thread as unknown as ThreadClient, renders };
}

function makeBridge(attach: FakeAttach, thread: ThreadClient): SessionBridge {
  const config = {
    slackChannelId: CHANNEL,
    uploadBundleOnEnd: false,
    hydraDaemonUrl: "http://127.0.0.1:0",
    hydraToken: "tok",
    permissionDisplayDelayMs: 0,
  } as unknown as Config;
  return new SessionBridge({
    attach: attach as never,
    config,
    thread,
    channels: { get: () => undefined } as never,
    truncatedStore: {} as never,
    hiddenStore: {} as never,
    sessionMeta: {
      sessionId: SESSION_ID,
      cwd: "/work",
      title: "test",
      agentId: "test-agent",
    },
  });
}

function flush(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function bigTable(rows: number): string {
  const cell = (i: number): string =>
    `\`fn_${i}()\` gated on \`is_agent_terminal()\` = \`a.is_some() \\| b.is_some()\` (state.rs:${1900 + i})`;
  const out = ["| Gate | Code | Verdict |", "|---|---|---|"];
  for (let i = 0; i < rows; i++) {
    out.push(`| gate ${i} | ${cell(i)} | ✓ |`);
  }
  return out.join("\n");
}

test("long GFM-table message keeps its markdown block across flushes", async () => {
  const attach = new FakeAttach();
  const { thread, renders } = makeFakeThread();
  const bridge = makeBridge(attach, thread);

  attach.emit("open");
  await flush();
  const session = bridge.getSession(SESSION_ID);
  assert.ok(session);

  // First flush: short prose + table, comfortably under the limit.
  session.agentChunks.push("Here is the gate table:\n\n" + bigTable(4) + "\n");
  await bridge.flushAgentMessage(session);

  // Second flush: same message grows well past SLACK_MESSAGE_LIMIT once
  // the mrkdwn fallback pads the table out.
  session.agentChunks.push("\nMore detail:\n\n" + bigTable(60) + "\n");
  await bridge.flushAgentMessage(session);

  const agentRenders = renders.filter((r) => r.text.includes("gate 0"));
  assert.ok(agentRenders.length >= 2, "expected at least two renders");
  for (const r of agentRenders) {
    assert.equal(r.hasBlocks, true, `render lost its blocks: ${r.kind}`);
  }
});
