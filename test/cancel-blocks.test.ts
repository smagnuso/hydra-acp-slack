import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  AMEND_QUEUED_ACTION_ID,
  buildProcessingBlocks,
  buildQueuedBlocks,
  buildSpinnerBlocks,
  CANCEL_QUEUED_ACTION_ID,
  CANCEL_TURN_ACTION_ID,
  decodeCancelQueuedValue,
  decodeCancelTurnValue,
  encodeCancelQueuedValue,
  encodeCancelTurnValue,
  SPINNER_DETAILS_ACTION_ID,
} from "../src/acp/session.js";

const SESSION = "session-abc";
const PROMPT_TS = "1700000000.000100";

test("buildQueuedBlocks emits a section + actions row with Amend + Cancel buttons keyed by promptTs", () => {
  const blocks = buildQueuedBlocks(
    SESSION,
    PROMPT_TS,
    ":hourglass: _queued:_ hello world",
  );
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.type, "section");
  assert.equal(blocks[1]?.type, "actions");
  const actions = blocks[1] as { elements: Array<Record<string, unknown>> };
  assert.equal(actions.elements.length, 2);
  const amend = actions.elements[0]!;
  assert.equal(amend.type, "button");
  assert.equal(amend.action_id, AMEND_QUEUED_ACTION_ID);
  assert.equal(amend.style, undefined);
  const amendVal = decodeCancelQueuedValue(amend.value as string);
  assert.ok(amendVal);
  assert.equal(amendVal?.s, SESSION);
  assert.equal(amendVal?.p, PROMPT_TS);
  const cancel = actions.elements[1]!;
  assert.equal(cancel.type, "button");
  assert.equal(cancel.action_id, CANCEL_QUEUED_ACTION_ID);
  assert.equal(cancel.style, "danger");
  const cancelVal = decodeCancelQueuedValue(cancel.value as string);
  assert.ok(cancelVal);
  assert.equal(cancelVal?.s, SESSION);
  assert.equal(cancelVal?.p, PROMPT_TS);
});

test("buildProcessingBlocks emits a single turn-scoped Cancel button", () => {
  const blocks = buildProcessingBlocks(
    SESSION,
    ":arrow_forward: _processing:_ hi",
  );
  assert.equal(blocks.length, 2);
  const actions = blocks[1] as { elements: Array<Record<string, unknown>> };
  assert.equal(actions.elements.length, 1);
  const btn = actions.elements[0]!;
  assert.equal(btn.action_id, CANCEL_TURN_ACTION_ID);
  assert.equal(btn.style, "danger");
  const v = decodeCancelTurnValue(btn.value as string);
  assert.equal(v?.s, SESSION);
});

test("buildSpinnerBlocks omits the details toggle when there are no tool calls and not expanded", () => {
  const blocks = buildSpinnerBlocks(SESSION, ":hourglass_flowing_sand: _working..._", {
    expanded: false,
    toolCallCount: 0,
  });
  const actions = blocks[1] as { elements: Array<Record<string, unknown>> };
  assert.equal(actions.elements.length, 1);
  assert.equal(actions.elements[0]?.action_id, CANCEL_TURN_ACTION_ID);
});

test("buildSpinnerBlocks shows a 'Show details' toggle once a tool call appears", () => {
  const blocks = buildSpinnerBlocks(SESSION, "head", {
    expanded: false,
    toolCallCount: 1,
  });
  const actions = blocks[1] as { elements: Array<Record<string, unknown>> };
  assert.equal(actions.elements.length, 2);
  const toggle = actions.elements[0] as {
    action_id: string;
    text: { text: string };
    style?: string;
  };
  const cancel = actions.elements[1] as { action_id: string; style?: string };
  assert.equal(toggle.action_id, SPINNER_DETAILS_ACTION_ID);
  assert.equal(toggle.text.text, "Show details");
  assert.equal(toggle.style, undefined);
  assert.equal(cancel.action_id, CANCEL_TURN_ACTION_ID);
  assert.equal(cancel.style, "danger");
});

test("buildSpinnerBlocks flips the toggle label to 'Hide details' when expanded", () => {
  const blocks = buildSpinnerBlocks(SESSION, "head", {
    expanded: true,
    toolCallCount: 3,
  });
  const actions = blocks[1] as { elements: Array<{ text?: { text: string }; action_id: string }> };
  const toggle = actions.elements.find((e) => e.action_id === SPINNER_DETAILS_ACTION_ID);
  assert.ok(toggle);
  assert.equal(toggle?.text?.text, "Hide details");
});

test("buildSpinnerBlocks keeps the toggle when expanded even with zero tool calls (so user can collapse)", () => {
  const blocks = buildSpinnerBlocks(SESSION, "head", {
    expanded: true,
    toolCallCount: 0,
  });
  const actions = blocks[1] as { elements: Array<{ action_id: string }> };
  assert.ok(actions.elements.some((e) => e.action_id === SPINNER_DETAILS_ACTION_ID));
});

test("decodeCancelQueuedValue rejects junk", () => {
  assert.equal(decodeCancelQueuedValue(undefined), undefined);
  assert.equal(decodeCancelQueuedValue(""), undefined);
  assert.equal(decodeCancelQueuedValue("not-json"), undefined);
  assert.equal(decodeCancelQueuedValue("{}"), undefined);
  assert.equal(decodeCancelQueuedValue(JSON.stringify({ s: "a" })), undefined);
});

test("decodeCancelTurnValue rejects junk", () => {
  assert.equal(decodeCancelTurnValue(undefined), undefined);
  assert.equal(decodeCancelTurnValue(""), undefined);
  assert.equal(decodeCancelTurnValue("not-json"), undefined);
  assert.equal(decodeCancelTurnValue("{}"), undefined);
});

test("cancel-queued encode / decode roundtrips", () => {
  const original = { s: "sess", p: "1700.000200" };
  const v = decodeCancelQueuedValue(encodeCancelQueuedValue(original));
  assert.deepEqual(v, original);
});

test("cancel-turn encode / decode roundtrips", () => {
  const original = { s: "sess" };
  const v = decodeCancelTurnValue(encodeCancelTurnValue(original));
  assert.deepEqual(v, original);
});
