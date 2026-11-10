import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildElicitationMessage,
  parseElicitationSchema,
  parseElicitationState,
} from "../src/slack/elicitation.js";

const schema = {
  type: "object",
  properties: {
    question_0: {
      type: "string",
      title: "Pick one",
      oneOf: [
        { const: "a", title: "Alpha" },
        { const: "b", title: "Beta" },
      ],
    },
    question_1: {
      type: "array",
      title: "Pick many",
      items: { anyOf: [{ const: "x", title: "X" }, { const: "y", title: "Y" }] },
    },
    question_0_custom: { type: "string", title: "Other" },
    n: { type: "integer", title: "Count" },
    ok: { type: "boolean", title: "OK?" },
  },
  required: ["question_0"],
};

test("parseElicitationSchema maps AskUserQuestion shapes", () => {
  const fields = parseElicitationSchema(schema);
  assert.equal(fields?.length, 5);
  assert.equal(fields?.[0]?.required, true);
  assert.equal(fields?.[2]?.required, false);
});

test("parseElicitationSchema rejects unsupported properties", () => {
  assert.equal(
    parseElicitationSchema({ type: "object", properties: { a: { type: "object" } } }),
    undefined,
  );
  assert.equal(parseElicitationSchema({ type: "object", properties: {} }), undefined);
});

test("buildElicitationMessage emits inputs plus Submit and Skip", () => {
  const fields = parseElicitationSchema(schema)!;
  const { blocks } = buildElicitationMessage("s", "e", "Which?", fields);
  assert.equal(blocks.length, 7);
  assert.equal(blocks[0]?.type, "section");
  assert.equal(blocks[1]?.type, "input");
  assert.equal(blocks[6]?.type, "actions");
});

test("parseElicitationState builds accept content", () => {
  const fields = parseElicitationSchema(schema)!;
  const f = "hydra-elic-field";
  const r = parseElicitationState(fields, {
    "hydra-elic-f0": { [f]: { selected_option: { value: "1" } } },
    "hydra-elic-f1": { [f]: { selected_options: [{ value: "0" }, { value: "1" }] } },
    "hydra-elic-f2": { [f]: { value: "  " } },
    "hydra-elic-f3": { [f]: { value: "3" } },
    "hydra-elic-f4": { [f]: { selected_option: { value: "false" } } },
  });
  assert.deepEqual(r, {
    ok: true,
    content: { question_0: "b", question_1: ["x", "y"], n: 3, ok: false },
  });
});

test("parseElicitationState flags missing required and bad numbers", () => {
  const fields = parseElicitationSchema(schema)!;
  const f = "hydra-elic-field";
  assert.equal(parseElicitationState(fields, {}).ok, false);
  const bad = parseElicitationState(fields, {
    "hydra-elic-f0": { [f]: { selected_option: { value: "0" } } },
    "hydra-elic-f3": { [f]: { value: "1.5" } },
  });
  assert.equal(bad.ok, false);
});

const F = "hydra-elic-field";

function one(prop: Record<string, unknown>, value: unknown) {
  const fields = parseElicitationSchema({
    type: "object",
    properties: { k: prop },
  })!;
  return parseElicitationState(fields, { "hydra-elic-f0": { [F]: value as Record<string, unknown> } });
}

test("defaults pre-populate Block Kit elements", () => {
  const fields = parseElicitationSchema({
    type: "object",
    properties: {
      a: { type: "string", enum: ["p", "q"], default: "q" },
      b: { type: "array", items: { enum: ["x", "y"] }, default: ["y"] },
      c: { type: "string", default: "hi" },
      d: { type: "boolean", default: false },
      e: { type: "integer", default: 4 },
    },
  })!;
  const els = buildElicitationMessage("s", "e", "m", fields)
    .blocks.filter((b) => b.type === "input")
    .map((b) => (b as { element: Record<string, any> }).element);
  assert.equal(els[0]?.initial_option.value, "1");
  assert.equal(els[1]?.initial_options[0].value, "1");
  assert.equal(els[2]?.initial_value, "hi");
  assert.equal(els[3]?.initial_option.value, "false");
  assert.equal(els[4]?.initial_value, "4");
});

test("string constraints are validated", () => {
  assert.equal(one({ type: "string", minLength: 3 }, { value: "ab" }).ok, false);
  assert.equal(one({ type: "string", maxLength: 2 }, { value: "abc" }).ok, false);
  assert.equal(one({ type: "string", pattern: "^a+$" }, { value: "ab" }).ok, false);
  assert.equal(one({ type: "string", pattern: "^a+$" }, { value: "aa" }).ok, true);
  assert.equal(one({ type: "string", pattern: "(" }, { value: "z" }).ok, true);
  assert.equal(one({ type: "string", pattern: "^a$".padEnd(300, "b") }, { value: "z" }).ok, true);
});

test("string formats are validated", () => {
  assert.equal(one({ type: "string", format: "email" }, { value: "a@b.co" }).ok, true);
  assert.equal(one({ type: "string", format: "email" }, { value: "nope" }).ok, false);
  assert.equal(one({ type: "string", format: "uri" }, { value: "https://x.y" }).ok, true);
  assert.equal(one({ type: "string", format: "uri" }, { value: "x y" }).ok, false);
  assert.equal(one({ type: "string", format: "date" }, { value: "2024-02-30" }).ok, false);
  assert.equal(one({ type: "string", format: "date" }, { value: "2024-02-29" }).ok, true);
  assert.equal(one({ type: "string", format: "date-time" }, { value: "2024-01-01T10:00:00Z" }).ok, true);
  assert.equal(one({ type: "string", format: "date-time" }, { value: "2024-01-01" }).ok, false);
  assert.equal(one({ type: "string", format: "weird" }, { value: "anything" }).ok, true);
});

test("number and multi-select bounds are validated", () => {
  assert.equal(one({ type: "number", minimum: 1 }, { value: "0" }).ok, false);
  assert.equal(one({ type: "number", maximum: 1 }, { value: "2" }).ok, false);
  assert.equal(one({ type: "number", minimum: 1, maximum: 3 }, { value: "2" }).ok, true);
  const multi = { type: "array", items: { enum: ["a", "b", "c"] }, minItems: 2, maxItems: 2 };
  assert.equal(one(multi, { selected_options: [{ value: "0" }] }).ok, false);
  assert.equal(one(multi, { selected_options: [{ value: "0" }, { value: "1" }, { value: "2" }] }).ok, false);
  assert.equal(one(multi, { selected_options: [{ value: "0" }, { value: "1" }] }).ok, true);
});
