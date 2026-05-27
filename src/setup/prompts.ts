import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { platform } from "node:os";

function isTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function ask(label: string, fallback = ""): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise((resolve) => {
      rl.question(`      ${label}${suffix}: `, resolve);
    });
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

export async function confirm(label: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  for (;;) {
    const reply = (await ask(`${label} ${hint}`)).toLowerCase();
    if (!reply)
      return defaultYes;
    if (reply.startsWith("y"))
      return true;
    if (reply.startsWith("n"))
      return false;
    process.stdout.write("      Please answer y or n.\n");
  }
}

export async function pickFromList<T>(
  label: string,
  items: T[],
  render: (item: T) => string,
): Promise<T | undefined> {
  if (items.length === 0)
    return undefined;
  process.stdout.write(`\n      ${label}\n\n`);
  items.forEach((item, idx) => {
    process.stdout.write(`        ${idx + 1}. ${render(item)}\n`);
  });
  process.stdout.write("        s. Skip\n\n");
  for (;;) {
    const reply = (await ask("Choice")).toLowerCase();
    if (reply === "s" || reply === "")
      return undefined;
    const n = Number.parseInt(reply, 10);
    if (Number.isInteger(n) && n >= 1 && n <= items.length)
      return items[n - 1];
    process.stdout.write("      Enter a number from the list, or 's' to skip.\n");
  }
}

export async function askSecret(label: string): Promise<string> {
  process.stdout.write(`      ${label}: `);
  if (!isTTY()) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    try {
      const line: string = await new Promise((resolve) => {
        rl.question("", resolve);
      });
      return line.trim();
    } finally {
      rl.close();
    }
  }
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let buf = "";
  try {
    for await (const chunk of stdin as AsyncIterable<string>) {
      let done = false;
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          done = true;
          break;
        }
        if (code === 3) {
          process.stdout.write("\n");
          process.exit(1);
        }
        if (code === 127 || code === 8) {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
      if (done)
        break;
    }
  } finally {
    stdin.setRawMode(wasRaw);
    stdin.pause();
    process.stdout.write("\n");
  }
  return buf.trim();
}

export function maskToken(t: string): string {
  if (t.length > 16)
    return `${t.slice(0, 8)}...${t.slice(-4)}`;
  return `${t.slice(0, 4)}...`;
}

export function openBrowser(url: string): void {
  const p = platform();
  const cmd = p === "darwin" ? "open" : p === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {
      process.stdout.write(`      Open this URL: ${url}\n`);
    });
    child.unref();
  } catch {
    process.stdout.write(`      Open this URL: ${url}\n`);
  }
}

export async function pause(label = "Press Enter to continue..."): Promise<void> {
  await ask(label);
}
