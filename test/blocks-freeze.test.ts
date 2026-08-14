import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { SessionBridge } from "../src/acp/session.js";
import type { Config } from "../src/config.js";
import type { ThreadClient } from "../src/slack/thread.js";

// Regression test: a blocks-mode agent message (one carrying a
// language-hinted fence or a GFM table) stopped updating once it grew
// past SLACK_MESSAGE_LIMIT, and the remainder of the turn was lost.
//
// Cause: the no-op check compared the mrkdwn *fallback* against
// agentLastSent. findSplitPoint only searches text.slice(0, limit), so
// past the limit the fallback is a fixed string no matter how much more
// text streams in — every later flush compared equal and returned before
// postOrUpdate, freezing the message at whatever the agent had emitted
// when it crossed the line. closeAgentMessage then dropped the tail.
//
// Observed in session UFpjRvlYLyWWzuvh: the last flush logged 3291ch
// (the clamped fallback), turn_complete logged no flush at all, and the
// Slack message ended mid-sentence.

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
  blockText: string;
}

function blockTextOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) {
    return "";
  }
  return blocks
    .map((b) => {
      const rec = b as { type?: string; text?: unknown };
      return rec.type === "markdown" && typeof rec.text === "string" ? rec.text : "";
    })
    .join("");
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
        blockText: blockTextOf(opts.blocks),
      });
      return { channel: CHANNEL, ts: `ts_${++n}`, threadTs: "ts_thread" };
    },
    async updateMessage(
      _channel: string,
      _ts: string,
      text: string,
      blocks?: unknown[],
    ): Promise<void> {
      renders.push({ kind: "update", text, blockText: blockTextOf(blocks) });
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

function paragraphs(tag: string, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      `${tag} paragraph ${i}: the classifier tried a dbgid that is neither the ESN on line 2 nor the SDK sha, so the upload key would not have matched.`,
    );
  }
  return out.join("\n\n");
}

async function openSession(bridge: SessionBridge, attach: FakeAttach) {
  attach.emit("open");
  await flush();
  const session = bridge.getSession(SESSION_ID);
  assert.ok(session);
  return session;
}

test("blocks-mode message keeps updating after outgrowing the message limit", async () => {
  const attach = new FakeAttach();
  const { thread, renders } = makeFakeThread();
  const bridge = makeBridge(attach, thread);
  const session = await openSession(bridge, attach);

  // A language-hinted fence puts this on the blocks-mode path.
  session.agentChunks.push("```cpp\nint main() { return 0; }\n```\n\n");
  session.agentChunks.push(paragraphs("early", 20));
  await bridge.flushAgentMessage(session);

  const beforeLimit = renders.length;
  assert.ok(beforeLimit > 0, "expected an initial render");

  // Push well past SLACK_MESSAGE_LIMIT (3500) so the mrkdwn fallback
  // gets clamped, then keep streaming.
  session.agentChunks.push("\n\n" + paragraphs("middle", 20));
  await bridge.flushAgentMessage(session);
  session.agentChunks.push("\n\nBefore I write it, one thing I don't want to lose.");
  await bridge.flushAgentMessage(session);

  const last = renders.at(-1);
  assert.ok(last, "expected a render");
  assert.ok(
    last.text.length > 0 && last.text.length <= 3500,
    `fallback should stay within the limit, got ${last.text.length}`,
  );
  assert.ok(
    last.blockText.includes("one thing I don't want to lose"),
    "final render lost the tail of the message",
  );
  assert.ok(
    last.blockText.includes("early paragraph 0"),
    "final render lost the head of the message",
  );
});

test("blocks-mode flush with no new chunks is still a no-op", async () => {
  const attach = new FakeAttach();
  const { thread, renders } = makeFakeThread();
  const bridge = makeBridge(attach, thread);
  const session = await openSession(bridge, attach);

  session.agentChunks.push("```cpp\nint main() { return 0; }\n```\n\n");
  session.agentChunks.push(paragraphs("early", 40));
  await bridge.flushAgentMessage(session);

  const afterFirst = renders.length;
  await bridge.flushAgentMessage(session);
  await bridge.flushAgentMessage(session);

  assert.equal(renders.length, afterFirst, "repeat flushes should not re-render");
});

test("a message that flips from text mode to blocks mode renders the blocks", async () => {
  const attach = new FakeAttach();
  const { thread, renders } = makeFakeThread();
  const bridge = makeBridge(attach, thread);
  const session = await openSession(bridge, attach);

  // Prose first: text mode, no blocks.
  session.agentChunks.push("Here is what I found so far.\n\n");
  await bridge.flushAgentMessage(session);
  assert.equal(renders.at(-1)?.blockText, "", "expected text mode initially");

  // The fence arrives late and flips the same message into blocks mode.
  session.agentChunks.push("```cpp\nint main() { return 0; }\n```\n");
  await bridge.flushAgentMessage(session);

  assert.ok(
    renders.at(-1)?.blockText.includes("int main()"),
    "flip into blocks mode was suppressed",
  );
});
