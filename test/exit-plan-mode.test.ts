import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isExitPlanModeTool,
  renderExitPlanMessage,
  type ExitPlanMessageState,
} from "../src/acp/session.js";

test("isExitPlanModeTool matches casing variants", () => {
  assert.equal(isExitPlanModeTool("ExitPlanMode"), true);
  assert.equal(isExitPlanModeTool("exit_plan_mode"), true);
  assert.equal(isExitPlanModeTool("EXITPLANMODE"), true);
  assert.equal(isExitPlanModeTool("Exit Plan Mode"), true);
  assert.equal(isExitPlanModeTool("exit-plan-mode"), true);
});

test("isExitPlanModeTool rejects unrelated names", () => {
  assert.equal(isExitPlanModeTool(undefined), false);
  assert.equal(isExitPlanModeTool(""), false);
  assert.equal(isExitPlanModeTool("Read file"), false);
  assert.equal(isExitPlanModeTool("ExitPlanModeX"), false);
});

function stateOf(
  overrides: Partial<ExitPlanMessageState> = {},
): ExitPlanMessageState {
  return {
    toolCallId: "tc-1",
    messageTs: undefined,
    plan: "## Step 1\n- do thing",
    status: undefined,
    ...overrides,
  };
}

test("renderExitPlanMessage includes the Plan header and converts markdown", () => {
  const { text } = renderExitPlanMessage(stateOf());
  assert.match(text, /:clipboard: \*Plan\*/);
  // toSlackMrkdwn turns "## " heading into *…*.
  assert.match(text, /\*Step 1\*/);
});

test("renderExitPlanMessage appends an approval footer per status", () => {
  assert.match(
    renderExitPlanMessage(stateOf({ status: "pending" })).text,
    /awaiting approval/,
  );
  assert.match(
    renderExitPlanMessage(stateOf({ status: "completed" })).text,
    /:white_check_mark: Approved/,
  );
  assert.match(
    renderExitPlanMessage(stateOf({ status: "rejected" })).text,
    /:x: Rejected/,
  );
  assert.match(
    renderExitPlanMessage(stateOf({ status: "cancelled" })).text,
    /:no_entry_sign: Cancelled/,
  );
});

test("renderExitPlanMessage omits the footer when status is unset", () => {
  const { text } = renderExitPlanMessage(stateOf());
  assert.equal(/awaiting approval/.test(text), false);
  assert.equal(/Approved/.test(text), false);
  assert.equal(/Rejected/.test(text), false);
});

test("renderExitPlanMessage promotes table-bearing plans to markdown blocks", () => {
  const plan = [
    "Some intro",
    "",
    "| Col A | Col B |",
    "| --- | --- |",
    "| a | b |",
  ].join("\n");
  const { blocks } = renderExitPlanMessage(stateOf({ plan }));
  assert.ok(blocks);
  // First block is the section header, then at least one markdown block.
  assert.equal(blocks?.[0]?.type, "section");
  assert.equal(
    blocks?.some((b) => b.type === "markdown"),
    true,
  );
});
