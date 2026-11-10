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
