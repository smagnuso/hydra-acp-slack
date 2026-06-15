// Convert markdown tables in a string into aligned, code-fenced tables.
// Slack's mrkdwn doesn't render markdown tables; we render them as
// fixed-width plain text inside a ```sh block so they at least line up
// in monospace.

const TABLE_LINE = /^\s*\|.*\|\s*$/;
const SEPARATOR_LINE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const FENCE_LINE = /^\s*```/;

export function convertMarkdownTables(text: string): string {
  if (!text.includes("|")) {
    return text;
  }
  text = unwrapFencedTables(text);
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (
      !inFence &&
      TABLE_LINE.test(line) &&
      i + 1 < lines.length &&
      SEPARATOR_LINE.test(lines[i + 1] ?? "")
    ) {
      // Collect contiguous table rows.
      const rows: string[] = [];
      while (i < lines.length && TABLE_LINE.test(lines[i] ?? "")) {
        rows.push(lines[i] ?? "");
        i++;
      }
      out.push(formatTable(rows));
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

// True iff `text` contains at least one GFM table outside fenced code.
// Mirrors the detection logic in convertMarkdownTables but doesn't
// transform anything — used as a trigger for the blocks-mode path,
// which leaves GFM tables intact so the `markdown` block can render
// them as actual columns rather than monospace text.
export function hasGfmTable(text: string): boolean {
  if (!text.includes("|")) {
    return false;
  }
  text = unwrapFencedTables(text);
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i + 1 < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (
      TABLE_LINE.test(line) &&
      SEPARATOR_LINE.test(lines[i + 1] ?? "")
    ) {
      return true;
    }
  }
  return false;
}

// Models sometimes emit a GFM table wrapped in a code fence, and
// sometimes glue the fence opener to the first table row on a single
// line (```| col | col |). Either case kills GFM table rendering
// everywhere — fenced content is literal, and the glued form doesn't
// even parse as a fence cleanly. Strip the fences when the fenced
// payload is *only* a GFM table (header + separator + rows, optionally
// surrounded by blank lines). Leave all other fenced blocks alone so
// real code samples that happen to contain pipes survive.
export function unwrapFencedTables(text: string): string {
  if (!text.includes("```")) {
    return text;
  }
  // Split a fence opener that has table content glued to the same line.
  //   ```| Concern | …  →  ```␤| Concern | …
  const split: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\s*```[^\s`|]*)[ \t]*(\|.*)$/.exec(line);
    if (m) {
      split.push(m[1] ?? "");
      split.push(m[2] ?? "");
    } else {
      split.push(line);
    }
  }
  const out: string[] = [];
  let i = 0;
  while (i < split.length) {
    const line = split[i] ?? "";
    if (/^\s*```[^\s`]*\s*$/.test(line)) {
      let j = i + 1;
      while (j < split.length && !/^\s*```\s*$/.test(split[j] ?? "")) {
        j++;
      }
      if (j < split.length) {
        const body = split.slice(i + 1, j);
        let s = 0;
        let e = body.length;
        while (s < e && (body[s] ?? "").trim() === "") {
          s++;
        }
        while (e > s && (body[e - 1] ?? "").trim() === "") {
          e--;
        }
        const trimmed = body.slice(s, e);
        if (
          trimmed.length >= 2 &&
          TABLE_LINE.test(trimmed[0] ?? "") &&
          SEPARATOR_LINE.test(trimmed[1] ?? "") &&
          trimmed.every((l) => TABLE_LINE.test(l))
        ) {
          for (const l of trimmed) {
            out.push(l);
          }
          i = j + 1;
          continue;
        }
      }
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

function parseRow(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith("|")) {
    inner = inner.slice(1);
  }
  if (inner.endsWith("|")) {
    inner = inner.slice(0, -1);
  }
  return inner.split("|").map((c) => c.trim());
}

function formatTable(rawRows: string[]): string {
  // First row = header, second = separator (skip), rest = data. Preserve
  // GFM `|` syntax, just pad each cell to the column max so the table
  // lines up in monospace inside the fence. Keeping `|` reads more like
  // a familiar markdown table than the previous ─-only style and is
  // easier to copy back out as raw markdown.
  const header = parseRow(rawRows[0] ?? "");
  const data = rawRows.slice(2).map(parseRow);
  const all: string[][] = [header, ...data];
  const cols = Math.max(...all.map((r) => r.length));
  const widths = new Array<number>(cols).fill(0);
  for (const row of all) {
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? "";
      if (cell.length > (widths[c] ?? 0)) {
        widths[c] = cell.length;
      }
    }
  }
  const padCell = (cell: string, w: number): string =>
    cell + " ".repeat(Math.max(0, w - cell.length));
  const renderRow = (row: string[]): string =>
    "| " +
    row.map((cell, c) => padCell(cell ?? "", widths[c] ?? 0)).join(" | ") +
    " |";
  // Separator: |---|---|… with each segment matching column width + the
  // surrounding " ... " padding.
  const sep =
    "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  const lines: string[] = ["```", renderRow(header), sep];
  for (const row of data) {
    lines.push(renderRow(row));
  }
  lines.push("```");
  return lines.join("\n");
}
