import { strict as assert } from "node:assert";
import { test } from "node:test";
import { stripCommandArgsHint } from "../src/acp/session.js";

test("stripCommandArgsHint: bare verb is unchanged", () => {
  assert.deepEqual(stripCommandArgsHint("/hydra title"), {
    name: "/hydra title",
    argsHint: undefined,
  });
});

test("stripCommandArgsHint: peels trailing <agent> placeholder", () => {
  assert.deepEqual(stripCommandArgsHint("/hydra agent <agent>"), {
    name: "/hydra agent",
    argsHint: "<agent>",
  });
});

test("stripCommandArgsHint: peels multiple placeholders", () => {
  assert.deepEqual(stripCommandArgsHint("/foo <a> <b>"), {
    name: "/foo",
    argsHint: "<a> <b>",
  });
});

test("stripCommandArgsHint: only trailing tokens are peeled (interior <…> survives)", () => {
  assert.deepEqual(stripCommandArgsHint("/cmd <a> middle <b>"), {
    name: "/cmd <a> middle",
    argsHint: "<b>",
  });
});

test("stripCommandArgsHint: empty placeholder content still matches", () => {
  assert.deepEqual(stripCommandArgsHint("/foo <>"), {
    name: "/foo",
    argsHint: "<>",
  });
});
