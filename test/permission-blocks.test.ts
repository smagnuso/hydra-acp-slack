import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildPermissionMessage,
  decodePermissionButtonValue,
  encodePermissionButtonValue,
  PERMISSION_ACTION_PREFIX,
} from "../src/acp/session.js";

const SESSION = "session-abc";
const TOOL = "tool-xyz";

test("buildPermissionMessage emits a section header + actions row", () => {
  const { text, blocks } = buildPermissionMessage(SESSION, TOOL, "Read /etc/passwd", [
    { optionId: "opt-1", name: "Allow once", kind: "allow_once" },
    { optionId: "opt-2", name: "Allow always", kind: "allow_always" },
    { optionId: "opt-3", name: "Reject", kind: "reject_once" },
  ]);
  assert.match(text, /Read \/etc\/passwd/);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.type, "section");
  assert.equal(blocks[1]?.type, "actions");
  const actions = blocks[1] as { type: "actions"; elements: Array<Record<string, unknown>> };
  assert.equal(actions.elements.length, 3);
  for (const el of actions.elements) {
    assert.equal(el.type, "button");
    assert.match(String(el.action_id), new RegExp(`^${PERMISSION_ACTION_PREFIX}opt-`));
  }
});

test("buildPermissionMessage maps allow kinds to primary, reject kinds to danger", () => {
  const { blocks } = buildPermissionMessage(SESSION, TOOL, "t", [
    { optionId: "a1", name: "Allow once", kind: "allow_once" },
    { optionId: "a2", name: "Allow always", kind: "allow_always" },
    { optionId: "r1", name: "Reject", kind: "reject_once" },
    { optionId: "r2", name: "Reject always", kind: "reject_always" },
    { optionId: "u", name: "Untagged" },
  ]);
  const actions = blocks[1] as { elements: Array<{ style?: string; action_id: string }> };
  const byAction = new Map(actions.elements.map((e) => [e.action_id, e.style]));
  assert.equal(byAction.get(`${PERMISSION_ACTION_PREFIX}a1`), "primary");
  assert.equal(byAction.get(`${PERMISSION_ACTION_PREFIX}a2`), "primary");
  assert.equal(byAction.get(`${PERMISSION_ACTION_PREFIX}r1`), "danger");
  assert.equal(byAction.get(`${PERMISSION_ACTION_PREFIX}r2`), "danger");
  assert.equal(byAction.get(`${PERMISSION_ACTION_PREFIX}u`), undefined);
});

test("buildPermissionMessage encodes session + toolCallId + optionId in the button value", () => {
  const { blocks } = buildPermissionMessage(SESSION, TOOL, "t", [
    { optionId: "opt-1", name: "Allow", kind: "allow_once" },
  ]);
  const actions = blocks[1] as { elements: Array<{ value?: string }> };
  const v = decodePermissionButtonValue(actions.elements[0]?.value);
  assert.ok(v);
  assert.equal(v?.s, SESSION);
  assert.equal(v?.t, TOOL);
  assert.equal(v?.o, "opt-1");
});

test("buildPermissionMessage truncates button labels over 75 chars", () => {
  const longName = "x".repeat(200);
  const { blocks } = buildPermissionMessage(SESSION, TOOL, "t", [
    { optionId: "o", name: longName, kind: "allow_once" },
  ]);
  const actions = blocks[1] as { elements: Array<{ text: { text: string } }> };
  const labelLen = actions.elements[0]?.text.text.length ?? 0;
  assert.ok(labelLen <= 75, `label length ${labelLen} should be <= 75`);
});

test("buildPermissionMessage caps the actions block at 5 buttons and surfaces overflow", () => {
  const options = Array.from({ length: 7 }, (_, i) => ({
    optionId: `o-${i}`,
    name: `Option ${i}`,
    kind: i % 2 === 0 ? "allow_once" : "reject_once",
  }));
  const { blocks } = buildPermissionMessage(SESSION, TOOL, "t", options);
  const actions = blocks.find((b) => b.type === "actions") as
    | { elements: unknown[] }
    | undefined;
  const context = blocks.find((b) => b.type === "context") as
    | { elements: Array<{ text: string }> }
    | undefined;
  assert.equal(actions?.elements.length, 5);
  assert.ok(context, "overflow context block should be present");
  assert.match(context!.elements[0]!.text, /Option 5/);
  assert.match(context!.elements[0]!.text, /Option 6/);
});

test("decodePermissionButtonValue rejects junk", () => {
  assert.equal(decodePermissionButtonValue(undefined), undefined);
  assert.equal(decodePermissionButtonValue(""), undefined);
  assert.equal(decodePermissionButtonValue("not-json"), undefined);
  assert.equal(decodePermissionButtonValue("{}"), undefined);
  assert.equal(decodePermissionButtonValue(JSON.stringify({ s: "a", t: "b" })), undefined);
});

test("encode / decode roundtrips", () => {
  const original = { s: "sess", t: "tool", o: "opt" };
  const v = decodePermissionButtonValue(encodePermissionButtonValue(original));
  assert.deepEqual(v, original);
});
