import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHydraAcp } from "../../src/setup/wizard.js";

let dir: string;
let env: NodeJS.ProcessEnv;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "slack-wiz-"));
  writeFileSync(join(dir, "hydra-acp.cmd"), "@echo off\n");
  env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Call = { cmd: string; args: readonly string[]; opts: Record<string, unknown> };

function fakeSpawn(calls: Call[], status: number | null): never {
  return ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    return { status };
  }) as never;
}

test("win32: runs the .cmd shim through the shell with quoted args", () => {
  const calls: Call[] = [];
  const r = runHydraAcp(
    ["extensions", "add", "hydra-acp-slack", "--command", "node", "--args", "C:\\My Dir\\i.js"],
    { platform: "win32", env, spawnSync: fakeSpawn(calls, 0) },
  );
  assert.deepEqual(r, { kind: "ran", status: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.opts["shell"], true);
  assert.ok(calls[0]!.cmd.toLowerCase().includes("hydra-acp.cmd"));
  assert.equal(calls[0]!.args[calls[0]!.args.length - 1], '"C:\\My Dir\\i.js"');
});

test("win32: an unquotable arg is reported, not thrown, and nothing is spawned", () => {
  const calls: Call[] = [];
  const r = runHydraAcp(["extensions", "add", "x", "--args", "C:\\100%\\i.js"], {
    platform: "win32",
    env,
    spawnSync: fakeSpawn(calls, 0),
  });
  assert.equal(r.kind, "unquotable");
  assert.equal(calls.length, 0);
});

test("posix: spawns bare hydra-acp without a shell and passes status through", () => {
  const calls: Call[] = [];
  const args = ["extensions", "add", "x", "--args", "/tmp/100%/i.js"];
  const r = runHydraAcp(args, { platform: "linux", env, spawnSync: fakeSpawn(calls, 3) });
  assert.deepEqual(r, { kind: "ran", status: 3 });
  assert.equal(calls[0]!.cmd, "hydra-acp");
  assert.deepEqual(calls[0]!.args, args);
  assert.equal(calls[0]!.opts["shell"], false);
});
