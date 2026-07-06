import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildHighlightBlocks,
  fitsBlockLimits,
  toSlackMrkdwn,
} from "../src/formatters/markdown.js";

test("converts **bold** and __bold__ to *bold*", () => {
  assert.equal(toSlackMrkdwn("**hi** there"), "*hi* there");
  assert.equal(toSlackMrkdwn("__yo__"), "*yo*");
});

test("converts links", () => {
  assert.equal(toSlackMrkdwn("[ex](https://e.com)"), "<https://e.com|ex>");
});

test("hydra:// links fall back to code span when session unknown / no team domain cached", () => {
  const result = toSlackMrkdwn("[Review session](hydra://sessions/abc123)");
  assert.equal(result, "Review session (`hydra://sessions/abc123`)");
});

test("hydra:// with turn fragment and host prefix also fall back to code span", () => {
  const result = toSlackMrkdwn("[Open](hydra://host:5514/sessions/xyz#turn-3)");
  assert.equal(result, "Open (`hydra://sessions/xyz`)");
});

test("hydra:// links rewrite to Slack permalink when session + team known", async () => {
  const { threadRegistry, setTeamDomain } = await import("../src/slack/registry.js");
  setTeamDomain("myteam");
  // Stub bridge — findBySession only inspects sessionId; other fields
  // aren't touched by the formatter path.
  threadRegistry.register({
    bridge: {} as never,
    sessionId: "hydra_session_perm42",
    channel: "C123",
    threadTs: "1700000000.123456",
  });

  const result = toSlackMrkdwn("[Review](hydra://sessions/hydra_session_perm42)");
  assert.equal(
    result,
    "<https://myteam.slack.com/archives/C123/p1700000000123456?thread_ts=1700000000.123456&cid=C123|Review>",
  );

  // Reset for other tests.
  setTeamDomain("");
  threadRegistry.unregisterBridge({} as never);
});

test("converts headings", () => {
  assert.equal(toSlackMrkdwn("# Title\nbody"), "*Title*\nbody");
  assert.equal(toSlackMrkdwn("### sub"), "*sub*");
});

test("preserves fenced code untouched", () => {
  const src = "before\n```\n**not bold** [link](u)\n```\nafter";
  const out = toSlackMrkdwn(src);
  assert.match(out, /```\n\*\*not bold\*\* \[link\]\(u\)\n```/);
});

test("wraps ascii-art tables (─ separator) in a code fence", () => {
  const src = [
    "leading prose",
    "",
    "  #   File           Currently   Should be",
    "  ─   ────────────   ─────────   ─────────",
    "  1   GPUTexture.h   send        sendNoncancelable",
    "  2   GibbonPlat.cpp send        sendCancelable",
    "",
    "trailing prose",
  ].join("\n");
  const out = toSlackMrkdwn(src);
  // The block containing the ─ separator should now be wrapped in a fence.
  assert.match(out, /```\n  #   File/);
  assert.match(out, /sendCancelable\n```/);
  // Surrounding prose stays outside fences.
  assert.match(out, /leading prose/);
  assert.match(out, /trailing prose/);
});

test("does not touch ascii-art tables already inside a fence", () => {
  const src = "```\n  ─   ────\n  1   x\n```";
  // Already fenced — wrapAsciiTables runs only outside existing fences,
  // so we shouldn't see double-wrapping.
  const out = toSlackMrkdwn(src);
  // No double opening fence on its own line.
  assert.equal(out.match(/^```$/gm)?.length, 2);
});

test("buildHighlightBlocks returns null when no trigger feature present", () => {
  assert.equal(buildHighlightBlocks("just prose"), null);
  // Unlabeled fence alone — mrkdwn already renders monospace correctly.
  assert.equal(buildHighlightBlocks("prose\n```\nplain code\n```\n"), null);
});

test("buildHighlightBlocks emits a single markdown block when a language-hinted fence is present", () => {
  const src = "Here is some code:\n```cpp\nint main() { return 0; }\n```\nAnd more prose.";
  const blocks = buildHighlightBlocks(src);
  assert.ok(blocks);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "markdown");
  // Raw text passes through — fence with language hint intact so Slack
  // can syntax-highlight it inside the markdown block.
  assert.match((blocks[0] as { text: string }).text, /```cpp\nint main/);
});

test("buildHighlightBlocks keeps prose unmodified (standard markdown, not mrkdwn)", () => {
  const src = "**bold** and [link](https://e.com)\n```diff\n-a\n+b\n```\n";
  const blocks = buildHighlightBlocks(src);
  assert.ok(blocks);
  const md = blocks[0] as { text: string };
  assert.match(md.text, /\*\*bold\*\*/);
  assert.match(md.text, /\[link\]\(https:\/\/e\.com\)/);
});

test("buildHighlightBlocks triggers on a GFM table with no fences", () => {
  const src = [
    "Some prose",
    "",
    "| h1 | h2 |",
    "| -- | -- |",
    "| a  | b  |",
    "",
    "trailing.",
  ].join("\n");
  const blocks = buildHighlightBlocks(src);
  assert.ok(blocks);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "markdown");
  assert.match((blocks[0] as { text: string }).text, /\| h1 \| h2 \|/);
  assert.match((blocks[0] as { text: string }).text, /\| -- \| -- \|/);
});

test("buildHighlightBlocks wraps ASCII-art tables in unlabeled fences before sending", () => {
  const src = [
    "Top:",
    "",
    "  #   File   Status",
    "  ─   ────   ──────",
    "  1   a.c    ok",
    "",
    "GFM:",
    "",
    "| col | val |",
    "| --- | --- |",
    "| 1   | x   |",
  ].join("\n");
  const blocks = buildHighlightBlocks(src);
  assert.ok(blocks);
  assert.equal(blocks.length, 1);
  const text = (blocks[0] as { text: string }).text;
  // ASCII table got wrapped in an unlabeled fence so its alignment
  // survives the markdown block's variable-width rendering.
  assert.match(text, /```\n  #   File   Status/);
  // GFM table stays as raw markdown table syntax.
  assert.match(text, /\| col \| val \|/);
});

test("fitsBlockLimits rejects oversize markdown payloads", () => {
  const small = buildHighlightBlocks("a\n```py\nprint(1)\n```\n");
  assert.ok(small);
  assert.equal(fitsBlockLimits(small), true);

  const oversize: { type: "markdown"; text: string }[] = [
    { type: "markdown", text: "x".repeat(12001) },
  ];
  assert.equal(fitsBlockLimits(oversize), false);
});
