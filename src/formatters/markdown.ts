import { convertMarkdownTables, hasGfmTable } from "./tables.js";

// Best-effort markdown → Slack mrkdwn. Slack's flavor:
//   *bold*, _italic_, ~strike~, `code`, ```fence```, > quote, * bullets.
// Standard markdown uses **bold** and __bold__, *italic* / _italic_, etc.
// This is intentionally light — agents emit GFM-ish text and the goal is
// "looks reasonable in Slack", not full fidelity.
//
// We deliberately avoid touching content inside fenced code blocks.
export function toSlackMrkdwn(text: string): string {
  const withGfmTables = convertMarkdownTables(text);
  const withAsciiTables = transformOutsideFences(withGfmTables, wrapAsciiTables);
  return transformOutsideFences(withAsciiTables, transform);
}

// Slack `markdown` block. See:
//   https://docs.slack.dev/reference/block-kit/blocks/markdown-block/
// Renders standard markdown — including ```lang fenced code blocks
// (syntax-highlighted by Slack since March 2026), GFM tables, **bold**,
// [text](url), headings, etc. We send the whole message as one markdown
// block when any of those features would otherwise be lost by the
// mrkdwn / text-field path.
export interface MarkdownBlock {
  type: "markdown";
  text: string;
}

// Subset of Block Kit blocks we emit beyond `markdown`. Only the fields
// we actually set are modeled; Slack ignores unknown fields and Bolt's
// full type tree is too noisy to mirror here. See:
//   https://docs.slack.dev/reference/block-kit/blocks/section-block
//   https://docs.slack.dev/reference/block-kit/blocks/actions-block
//   https://docs.slack.dev/reference/block-kit/block-elements/button-element
export interface SectionBlock {
  type: "section";
  text: { type: "mrkdwn" | "plain_text"; text: string };
  block_id?: string;
}
export interface ButtonElement {
  type: "button";
  text: { type: "plain_text"; text: string; emoji?: boolean };
  action_id: string;
  value?: string;
  style?: "primary" | "danger";
}
export interface ActionsBlock {
  type: "actions";
  elements: ButtonElement[];
  block_id?: string;
}
export interface ContextBlock {
  type: "context";
  elements: Array<{ type: "mrkdwn" | "plain_text"; text: string }>;
  block_id?: string;
}

export type SlackBlock =
  | MarkdownBlock
  | SectionBlock
  | ActionsBlock
  | ContextBlock;

const FENCE_INFO_RE = /```([^\s`]+)[ \t]*\n/;

// Build a single Slack `markdown` block from raw agent text when the
// message has a feature the mrkdwn path can't render:
//   - language-hinted fenced code (```cpp, ```diff, …) → syntax
//     highlighting in the markdown block.
//   - GFM tables (`| h | h |` + `| - | - |`) → native column rendering.
// ASCII-art tables (─ bars) are wrapped in unlabeled fences first so
// they stay monospace inside the markdown block.
//
// Returns null when no trigger fires — caller stays on the text /
// mrkdwn path.
export function buildHighlightBlocks(raw: string): SlackBlock[] | null {
  const pre = transformOutsideFences(raw, wrapAsciiTables);
  if (!FENCE_INFO_RE.test(pre) && !hasGfmTable(pre)) {
    return null;
  }
  return [{ type: "markdown", text: pre }];
}

// `markdown` blocks share a cumulative 12000-char budget per payload.
// Returns false when the block array would exceed it — caller should
// fall back to the text-field / mrkdwn split path. Only markdown
// blocks count against the budget; other block types (sections,
// actions, etc.) have their own per-block limits and aren't part of
// this aggregate.
export function fitsBlockLimits(blocks: SlackBlock[]): boolean {
  let total = 0;
  for (const b of blocks) {
    if (b.type !== "markdown") {
      continue;
    }
    total += b.text.length;
    if (total > 12000) {
      return false;
    }
  }
  return true;
}

function transform(s: string): string {
  // **bold** -> *bold*  (and __bold__ -> *bold*)
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");
  s = s.replace(/__([^_\n]+?)__/g, "*$1*");
  // [text](url) -> <url|text>
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  // # heading -> *heading*
  s = s.replace(/^(#{1,6})\s+(.+)$/gm, (_m, _hashes: string, body: string) => `*${body.trim()}*`);
  return s;
}

// Detect ASCII-art tables that the agent rendered with box-drawing chars
// (─ runs as a separator, no `|` columns) and wrap them in a code fence
// so Slack renders them monospace and column-aligned. Without this,
// Slack's variable-width rendering shreds the alignment.
//
// A "separator line" is one whose non-whitespace content is entirely ─
// characters. We expand outward from each separator to the nearest
// blank lines on either side and wrap that block in ```. Slightly
// over-aggressive — a paragraph ending right above a divider would get
// wrapped too — but rare in practice and the alignment win on real
// tables is worth the occasional overshoot.
function wrapAsciiTables(text: string): string {
  const lines = text.split("\n");
  if (!lines.some(isHorizontalBarLine)) {
    return text;
  }
  const wrap = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!isHorizontalBarLine(lines[i] ?? "")) {
      continue;
    }
    let start = i;
    while (start > 0 && (lines[start - 1] ?? "").trim() !== "") {
      start--;
    }
    let end = i;
    while (end < lines.length - 1 && (lines[end + 1] ?? "").trim() !== "") {
      end++;
    }
    for (let j = start; j <= end; j++) {
      wrap[j] = true;
    }
  }
  const out: string[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (wrap[i] && !fenced) {
      out.push("```");
      fenced = true;
    } else if (!wrap[i] && fenced) {
      out.push("```");
      fenced = false;
    }
    out.push(lines[i] ?? "");
  }
  if (fenced) {
    out.push("```");
  }
  return out.join("\n");
}

function isHorizontalBarLine(line: string): boolean {
  if (!line.includes("─")) {
    return false;
  }
  // Line consists only of ─ characters and whitespace, with at least
  // one run of 3+ ─ — filters out incidental single bars in prose.
  return /^[\s─]+$/.test(line) && /─{3,}/.test(line);
}

function transformOutsideFences(text: string, fn: (s: string) => string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((p) => (p.startsWith("```") ? p : fn(p)))
    .join("");
}
