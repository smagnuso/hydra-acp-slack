import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const PRIMARY_CONF_PATH = resolve(homedir(), ".hydra-acp", "slack.conf");

export interface ConfUpdate {
  [key: string]: string | undefined;
}

interface ParsedLine {
  raw: string;
  key?: string;
  value?: string;
}

function parseLines(text: string): ParsedLine[] {
  return text.split(/\r?\n/).map((raw) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#"))
      return { raw };
    const eq = raw.indexOf("=");
    if (eq === -1)
      return { raw };
    const key = raw.slice(0, eq).trim();
    let value = raw.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return { raw, key, value };
  });
}

export function readExisting(path: string): { text: string; map: Map<string, string> } {
  if (!existsSync(path))
    return { text: "", map: new Map() };
  const text = readFileSync(path, "utf8");
  const map = new Map<string, string>();
  for (const line of parseLines(text)) {
    if (line.key !== undefined && line.value !== undefined)
      map.set(line.key, line.value);
  }
  return { text, map };
}

const HEADER = `# hydra-acp-slack config — written by 'hydra-acp-slack setup'.
# Lock this file: chmod 600.
`;

const HYDRA_TOKEN_PLACEHOLDER = `# When run standalone, set HYDRA_TOKEN to the token your hydra daemon prints
# on startup. When run as a hydra extension, hydra injects HYDRA_ACP_TOKEN
# at spawn time and this can stay commented out.
# HYDRA_TOKEN=
`;

function quoteIfNeeded(value: string): string {
  if (/[\s#'"]/.test(value))
    return `"${value.replace(/"/g, '\\"')}"`;
  return value;
}

export function mergeConf(existing: string, updates: ConfUpdate): string {
  const lines = parseLines(existing);
  const remaining = new Map<string, string>();
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined)
      remaining.set(k, v);
  }

  const out: string[] = [];
  for (const line of lines) {
    if (line.key && remaining.has(line.key)) {
      const newVal = remaining.get(line.key)!;
      out.push(`${line.key}=${quoteIfNeeded(newVal)}`);
      remaining.delete(line.key);
    } else {
      out.push(line.raw);
    }
  }

  if (!existing) {
    out.length = 0;
    out.push(HEADER.trimEnd());
    out.push("");
  }

  while (out.length > 0 && out[out.length - 1] === "")
    out.pop();

  if (remaining.size > 0) {
    if (out.length > 0)
      out.push("");
    for (const [k, v] of remaining)
      out.push(`${k}=${quoteIfNeeded(v)}`);
  }

  const hadHydraToken = lines.some((l) => l.key === "HYDRA_TOKEN");
  const hasHydraTokenComment = /^\s*#\s*HYDRA_TOKEN\b/m.test(out.join("\n"));
  if (!existing && !hadHydraToken && !hasHydraTokenComment) {
    out.push("");
    out.push(HYDRA_TOKEN_PLACEHOLDER.trimEnd());
  }

  return out.join("\n") + "\n";
}

export function writeConf(path: string, updates: ConfUpdate): void {
  const { text } = readExisting(path);
  const merged = mergeConf(text, updates);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, merged, { encoding: "utf8" });
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod isn't meaningful on Windows; ignore.
  }
}
