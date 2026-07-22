import { permalinkForSession } from "../slack/registry.js";
import { convertMarkdownTables, hasGfmTable, unwrapFencedTables } from "./tables.js";

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
  const pre = transformOutsideFences(unwrapFencedTables(raw), wrapAsciiTables);
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

function convertEmphasis(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < n) {
      const nxt = text[i + 1]!;
      if (nxt === "*" || nxt === "_" || nxt === "`" || nxt === "[" || nxt === "]" || nxt === "\\") {
        out += nxt;
        i += 2;
        continue;
      }
    }
    if (c === "`") {
      const close = text.indexOf("`", i + 1);
      if (close !== -1) {
        out += text.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    if (c === "*" && text[i + 1] === "*") {
      const close = text.indexOf("**", i + 2);
      if (close !== -1 && close > i + 2) {
        const inner = convertEmphasis(text.slice(i + 2, close));
        out += `*${inner}*`;
        i = close + 2;
        continue;
      }
    }
    if (c === "_" && text[i + 1] === "_") {
      const close = text.indexOf("__", i + 2);
      if (close !== -1 && close > i + 2 && !text.slice(i + 2, close).includes("\n")) {
        const inner = convertEmphasis(text.slice(i + 2, close));
        out += `*${inner}*`;
        i = close + 2;
        continue;
      }
    }
    if (c === "*" && text[i + 1] !== "*") {
      const prev = i > 0 ? text[i - 1]! : "";
      const nextCh = text[i + 1] ?? "";
      const openable =
        nextCh !== "" &&
        nextCh !== " " &&
        nextCh !== "\t" &&
        nextCh !== "\n" &&
        nextCh !== "*" &&
        !/[A-Za-z0-9]/.test(prev);
      if (openable) {
        let close = -1;
        for (let j = i + 1; j < n; j++) {
          const cj = text[j]!;
          if (cj === "\n") {
            break;
          }
          if (cj !== "*") {
            continue;
          }
          if (text[j + 1] === "*") {
            continue;
          }
          const before = text[j - 1]!;
          const after = text[j + 1] ?? "";
          if (before === " " || before === "\t" || before === "*") {
            continue;
          }
          if (/[A-Za-z0-9]/.test(after)) {
            continue;
          }
          close = j;
          break;
        }
        if (close !== -1 && close > i + 1) {
          const inner = convertEmphasis(text.slice(i + 1, close));
          out += `_${inner}_`;
          i = close + 1;
          continue;
        }
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

function transform(s: string): string {
  // Emphasis conversion in a single pass. Slack mrkdwn uses `*bold*`
  // and `_italic_`, so standard markdown maps as:
  //   **foo** / __foo__ → *foo*
  //   *foo*             → _foo_    (with flanking guards)
  //   _foo_             → _foo_    (unchanged; word-boundary flank)
  // We can't do these as sequential regex passes: a `**foo**` → `*foo*`
  // rewrite would then be re-matched by the `*italic*` pass and turned
  // into `_foo_`. The walker below emits both in one pass so the bold
  // output is not visible to the italic rule. Inline `` `code` `` spans
  // are copied verbatim so their contents aren't mangled.
  s = convertEmphasis(s);
  // [text](url) -> <url|text>. For hydra://sessions/<id>, look up the
  // session in threadRegistry and rewrite to a Slack permalink URL when
  // both the thread mapping and the team domain are known. Falls back
  // to a code-span rendering when either piece is missing (unknown
  // session, or startup handshake hasn't cached the team domain yet).
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
    const hydraMatch = url.match(/^hydra:\/\/(?:[^/\s]+\/)?sessions\/([A-Za-z0-9_-]+)(?:#turn-\d+)?$/);
    if (hydraMatch) {
      const sid = hydraMatch[1]!;
      const permalink = permalinkForSession(sid);
      if (permalink) {
        return `<${permalink}|${text}>`;
      }
      return `${text} (\`hydra://sessions/${sid}\`)`;
    }
    return `<${url}|${text}>`;
  });
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
