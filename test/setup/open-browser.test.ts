import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { openBrowser } from "../../src/setup/prompts.js";

const URL_WITH_SPECIALS = "https://slack.com/oauth?a=1&b=%2Fx%20y&c=2#frag";

function harness(throwOnSpawn = false) {
  const calls: { cmd: string; args: readonly string[]; opts: Record<string, unknown> }[] = [];
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = () => {};
  const out: string[] = [];
  const spawn = ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    if (throwOnSpawn) {
      throw new Error("boom");
    }
    calls.push({ cmd, args, opts });
    return child;
  }) as never;
  return { calls, child, out, deps: { spawn, write: (s: string) => out.push(s) } };
}

test("win32: rundll32, no shell, not detached, URL untouched as one arg", () => {
  const h = harness();
  openBrowser(URL_WITH_SPECIALS, { ...h.deps, platform: "win32" });
  assert.equal(h.calls.length, 1);
  const c = h.calls[0]!;
  assert.equal(c.cmd, "rundll32");
  assert.deepEqual(c.args, ["url.dll,FileProtocolHandler", URL_WITH_SPECIALS]);
  assert.deepEqual(c.opts, { stdio: "ignore", windowsHide: true });
  assert.equal(c.opts["shell"], undefined);
  assert.equal(c.opts["detached"], undefined);
});

test("darwin: open with URL as one arg", () => {
  const h = harness();
  openBrowser(URL_WITH_SPECIALS, { ...h.deps, platform: "darwin" });
  assert.equal(h.calls[0]!.cmd, "open");
  assert.deepEqual(h.calls[0]!.args, [URL_WITH_SPECIALS]);
  assert.deepEqual(h.calls[0]!.opts, { stdio: "ignore", detached: true });
});

test("linux: xdg-open with URL as one arg", () => {
  const h = harness();
  openBrowser(URL_WITH_SPECIALS, { ...h.deps, platform: "linux" });
  assert.equal(h.calls[0]!.cmd, "xdg-open");
  assert.deepEqual(h.calls[0]!.args, [URL_WITH_SPECIALS]);
  assert.deepEqual(h.calls[0]!.opts, { stdio: "ignore", detached: true });
});

for (const platform of ["win32", "darwin", "linux"] as const) {
  test(`${platform}: spawn error event falls back to printing the URL`, () => {
    const h = harness();
    openBrowser(URL_WITH_SPECIALS, { ...h.deps, platform });
    assert.deepEqual(h.out, []);
    h.child.emit("error", new Error("ENOENT"));
    assert.deepEqual(h.out, [`      Open this URL: ${URL_WITH_SPECIALS}\n`]);
  });

  test(`${platform}: a synchronous spawn throw falls back to printing the URL`, () => {
    const h = harness(true);
    openBrowser(URL_WITH_SPECIALS, { ...h.deps, platform });
    assert.deepEqual(h.out, [`      Open this URL: ${URL_WITH_SPECIALS}\n`]);
  });
}
