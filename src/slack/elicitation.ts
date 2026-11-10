import type { ButtonElement, SlackBlock } from "../formatters/markdown.js";

export const ELICITATION_ACTION_PREFIX = "hydra-elic:";
export const ELICITATION_SUBMIT_ACTION_ID = `${ELICITATION_ACTION_PREFIX}submit`;
export const ELICITATION_SKIP_ACTION_ID = `${ELICITATION_ACTION_PREFIX}skip`;
const FIELD_ACTION_ID = "hydra-elic-field";
const MAX_FIELDS = 40;
const MAX_SELECT_OPTIONS = 100;

export interface ElicitationValue {
  s: string;
  e: string;
}

export function encodeElicitationValue(v: ElicitationValue): string {
  return JSON.stringify(v);
}

export function decodeElicitationValue(
  raw: string | undefined,
): ElicitationValue | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const v = JSON.parse(raw) as Partial<ElicitationValue>;
    if (typeof v.s === "string" && typeof v.e === "string") {
      return { s: v.s, e: v.e };
    }
  } catch {
    // fall through
  }
  return undefined;
}

interface Choice {
  value: string;
  title: string;
}

type Field =
  | { kind: "select"; choices: Choice[] }
  | { kind: "multi"; choices: Choice[] }
  | { kind: "text" }
  | { kind: "number"; integer: boolean }
  | { kind: "boolean" };

export interface ElicitationField {
  key: string;
  label: string;
  hint?: string;
  required: boolean;
  field: Field;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readChoices(list: unknown): Choice[] | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  const out: Choice[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      out.push({ value: item, title: item });
    } else if (isObj(item) && typeof item.const === "string") {
      out.push({
        value: item.const,
        title: typeof item.title === "string" ? item.title : item.const,
      });
    } else {
      return undefined;
    }
  }
  return out;
}

function choicesOf(schema: Json): Choice[] | undefined {
  return (
    readChoices(schema.oneOf) ??
    readChoices(schema.anyOf) ??
    readChoices(schema.enum)
  );
}

function parseField(schema: Json): Field | undefined {
  if (schema.type === "string") {
    const choices = choicesOf(schema);
    if (!choices) {
      return { kind: "text" };
    }
    if (choices.length === 0 || choices.length > MAX_SELECT_OPTIONS) {
      return undefined;
    }
    return { kind: "select", choices };
  }
  if (schema.type === "number" || schema.type === "integer") {
    return { kind: "number", integer: schema.type === "integer" };
  }
  if (schema.type === "boolean") {
    return { kind: "boolean" };
  }
  if (schema.type === "array" && isObj(schema.items)) {
    const choices = choicesOf(schema.items);
    if (!choices || choices.length === 0 || choices.length > MAX_SELECT_OPTIONS) {
      return undefined;
    }
    return { kind: "multi", choices };
  }
  return undefined;
}

// Returns undefined when any field cannot be rendered, so the caller abstains.
export function parseElicitationSchema(
  schema: unknown,
): ElicitationField[] | undefined {
  if (!isObj(schema) || !isObj(schema.properties)) {
    return undefined;
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === "string")
      : [],
  );
  const entries = Object.entries(schema.properties);
  if (entries.length === 0 || entries.length > MAX_FIELDS) {
    return undefined;
  }
  const out: ElicitationField[] = [];
  for (const [key, prop] of entries) {
    if (!isObj(prop)) {
      return undefined;
    }
    const field = parseField(prop);
    if (!field) {
      return undefined;
    }
    out.push({
      key,
      label: typeof prop.title === "string" ? prop.title : key,
      ...(typeof prop.description === "string" ? { hint: prop.description } : {}),
      required: required.has(key),
      field,
    });
  }
  return out;
}

function plain(text: string, max: number): { type: "plain_text"; text: string } {
  const t = text.length > max ? text.slice(0, max - 1) + "…" : text;
  return { type: "plain_text", text: t || " " };
}

function option(c: Choice, index: number): Json {
  return { text: plain(c.title, 75), value: String(index) };
}

function elementFor(f: Field): Json {
  switch (f.kind) {
    case "select":
      return {
        type: "static_select",
        action_id: FIELD_ACTION_ID,
        placeholder: plain("Select", 150),
        options: f.choices.map(option),
      };
    case "multi":
      return {
        type: "multi_static_select",
        action_id: FIELD_ACTION_ID,
        placeholder: plain("Select", 150),
        options: f.choices.map(option),
      };
    case "boolean":
      return {
        type: "radio_buttons",
        action_id: FIELD_ACTION_ID,
        options: [
          { text: plain("Yes", 75), value: "true" },
          { text: plain("No", 75), value: "false" },
        ],
      };
    default:
      return { type: "plain_text_input", action_id: FIELD_ACTION_ID };
  }
}

function blockId(index: number): string {
  return `hydra-elic-f${index}`;
}

export function buildElicitationMessage(
  sessionId: string,
  elicitationId: string,
  message: string,
  fields: ElicitationField[],
): { text: string; blocks: SlackBlock[] } {
  const header = message.trim() || "The agent has a question";
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:question: *Question*\n${header}`.slice(0, 3000),
      },
    },
  ];
  fields.forEach((f, i) => {
    blocks.push({
      type: "input",
      block_id: blockId(i),
      label: plain(f.label, 2000),
      element: elementFor(f.field),
      optional: !f.required,
      ...(f.hint ? { hint: plain(f.hint, 2000) } : {}),
    });
  });
  const value = encodeElicitationValue({ s: sessionId, e: elicitationId });
  const submit: ButtonElement = {
    type: "button",
    text: { type: "plain_text", text: "Submit" },
    action_id: ELICITATION_SUBMIT_ACTION_ID,
    value,
    style: "primary",
  };
  const skip: ButtonElement = {
    type: "button",
    text: { type: "plain_text", text: "Skip" },
    action_id: ELICITATION_SKIP_ACTION_ID,
    value,
  };
  blocks.push({ type: "actions", elements: [submit, skip] });
  return { text: `:question: ${header}`, blocks };
}

export type ElicitationContent = Record<
  string,
  string | number | boolean | string[]
>;

type StateValues = Record<string, Record<string, Json> | undefined>;

function optionIndex(o: unknown): number | undefined {
  if (!isObj(o) || typeof o.value !== "string") {
    return undefined;
  }
  const n = Number(o.value);
  return Number.isInteger(n) ? n : undefined;
}

// Turns Slack's block state into an ACP form answer, or an error to show the user.
export function parseElicitationState(
  fields: ElicitationField[],
  state: StateValues | undefined,
): { ok: true; content: ElicitationContent } | { ok: false; error: string } {
  const content: ElicitationContent = {};
  for (const [i, f] of fields.entries()) {
    const el = state?.[blockId(i)]?.[FIELD_ACTION_ID];
    const spec = f.field;
    let answer: string | number | boolean | string[] | undefined;
    if (spec.kind === "select") {
      const idx = optionIndex(el?.selected_option);
      answer = idx === undefined ? undefined : spec.choices[idx]?.value;
    } else if (spec.kind === "multi") {
      const sel = Array.isArray(el?.selected_options) ? el.selected_options : [];
      const picked: string[] = [];
      for (const o of sel) {
        const idx = optionIndex(o);
        const c = idx === undefined ? undefined : spec.choices[idx];
        if (c) {
          picked.push(c.value);
        }
      }
      if (picked.length > 0) {
        answer = picked;
      }
    } else if (spec.kind === "boolean") {
      const sel = el?.selected_option;
      const v = isObj(sel) ? sel.value : undefined;
      if (v === "true") {
        answer = true;
      } else if (v === "false") {
        answer = false;
      }
    } else if (spec.kind === "number") {
      const raw = typeof el?.value === "string" ? el.value.trim() : "";
      if (raw !== "") {
        const n = Number(raw);
        if (!Number.isFinite(n) || (spec.integer && !Number.isInteger(n))) {
          return {
            ok: false,
            error: `"${f.label}" must be ${spec.integer ? "a whole number" : "a number"}.`,
          };
        }
        answer = n;
      }
    } else {
      const raw = typeof el?.value === "string" ? el.value : "";
      if (raw.trim() !== "") {
        answer = raw;
      }
    }
    if (answer === undefined) {
      if (f.required) {
        return { ok: false, error: `"${f.label}" is required.` };
      }
      continue;
    }
    content[f.key] = answer;
  }
  return { ok: true, content };
}
