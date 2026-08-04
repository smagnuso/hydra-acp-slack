import { strict as assert } from "node:assert";
import { test } from "node:test";
import { convertMarkdownTables, splitRowCells } from "../src/formatters/tables.js";

test("converts a simple GFM table to a code-fenced aligned block", () => {
  const input = [
    "| name | role |",
    "|------|------|",
    "| ada  | engineer |",
    "| bob  | pm |",
  ].join("\n");
  const out = convertMarkdownTables(input);
  assert.match(out, /^```\n/);
  assert.match(out, /\n```$/);
  // Pipe syntax preserved, columns padded to the widest cell.
  assert.match(out, /\| name \| role {5}\|/); // role padded to "engineer" (8 chars)
  assert.match(out, /\| ada {2}\| engineer \|/);
  assert.match(out, /\| bob {2}\| pm {7}\|/);
  // Separator dashes match column width + surrounding spaces.
  assert.match(out, /\|------\|----------\|/);
});

test("leaves text without tables unchanged", () => {
  const input = "hello world\n\nanother line\n";
  assert.equal(convertMarkdownTables(input), input);
});

test("unwraps a GFM table that was wrapped in a code fence", () => {
  const input = [
    "outside",
    "```",
    "| name | role |",
    "|------|------|",
    "| ada  | eng |",
    "```",
    "after",
  ].join("\n");
  const out = convertMarkdownTables(input);
  // Fences around the table are stripped and replaced with the
  // formatted code-fenced aligned block.
  assert.match(out, /outside\n```\n\| name \| role \|/);
  assert.match(out, /\| ada {2}\| eng {2}\|\n```\nafter/);
});

test("unwraps a fence opener glued to the first table row", () => {
  const input = [
    "intro",
    "```| name | role |",
    "|------|------|",
    "| ada  | eng |",
    "```",
    "tail",
  ].join("\n");
  const out = convertMarkdownTables(input);
  assert.match(out, /\| name \| role \|/);
  assert.match(out, /\| ada {2}\| eng {2}\|/);
  // No glued fence-and-pipe artifact survives.
  assert.ok(!out.includes("```|"));
});

test("leaves non-table fenced blocks alone even when they contain pipes", () => {
  const input = [
    "```sh",
    "echo a | wc -l",
    "```",
  ].join("\n");
  assert.equal(convertMarkdownTables(input), input);
});

test("escaped pipes inside cells do not create phantom columns", () => {
  const input = [
    "| Gate | Code | Verdict |",
    "|---|---|---|",
    "| pane? | `a.is_some() \\| b.is_some()` (state.rs:1951) | ok |",
    "| render | `.or_else(\\| \\| label())` (nav.rs:475) | ok |",
  ].join("\n");
  const out = convertMarkdownTables(input);
  const rows = out.split("\n").filter((l) => l.startsWith("|"));
  for (const row of rows) {
    // 3 columns → exactly 4 unescaped delimiters per row.
    const delims = row.replace(/\\\|/g, "").match(/\|/g)?.length ?? 0;
    assert.equal(delims, 4, `row has wrong column count: ${row}`);
  }
  assert.match(out, /`a\.is_some\(\) \\\| b\.is_some\(\)` \(state\.rs:1951\)/);
});

test("pipes inside code spans are not cell delimiters", () => {
  const input = [
    "| expr | note |",
    "|---|---|",
    "| `a | b` | bitwise or |",
  ].join("\n");
  assert.deepEqual(splitRowCells("| `a | b` | bitwise or |"), [
    "`a | b`",
    "bitwise or",
  ]);
  const out = convertMarkdownTables(input);
  // Two columns → separator has exactly two dash segments.
  assert.equal(out.split("\n")[2]?.match(/-+/g)?.length, 2);
  assert.match(out, /\| `a \| b` +\| bitwise or \|/);
});
