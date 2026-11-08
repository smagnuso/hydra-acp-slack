import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  quoteForCmd,
  resolveSpawnTarget,
  resolveWindowsCommand,
} from "../src/util/windows-command.js";

// Windows filesystems are case-insensitive, so compare paths that way.
const eqPath = (actual: string, expected: string): void => {
  assert.equal(actual.toLowerCase(), expected.toLowerCase());
};

let dir: string;
let spacedDir: string;
let env: NodeJS.ProcessEnv;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "slack-wincmd-"));
  writeFileSync(join(dir, "hydra-acp"), "#!/bin/sh\n");
  writeFileSync(join(dir, "hydra-acp.cmd"), "@echo off\n");
  writeFileSync(join(dir, "real-tool.exe"), "MZ");
  spacedDir = join(dir, "First Last");
  mkdirSync(spacedDir, { recursive: true });
  writeFileSync(join(spacedDir, "hydra-acp.cmd"), "@echo off\n");
  env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveWindowsCommand", () => {
  test("is identity off Windows even when a .cmd sibling exists", () => {
    assert.equal(resolveWindowsCommand("hydra-acp", { env, platform: "linux" }), "hydra-acp");
  });

  test("prefers the .cmd sibling over an extensionless sh shim", () => {
    eqPath(
      resolveWindowsCommand("hydra-acp", { env, platform: "win32" }),
      join(dir, "hydra-acp.cmd"),
    );
  });

  test("finds .exe via PATHEXT", () => {
    eqPath(
      resolveWindowsCommand("real-tool", { env, platform: "win32" }),
      join(dir, "real-tool.exe"),
    );
  });

  test("returns a missing command unchanged", () => {
    assert.equal(resolveWindowsCommand("nope", { env, platform: "win32" }), "nope");
  });

  test("leaves a command that already has a known extension alone", () => {
    assert.equal(
      resolveWindowsCommand("hydra-acp.cmd", { env, platform: "win32" }),
      "hydra-acp.cmd",
    );
  });
});

describe("quoteForCmd", () => {
  test("leaves plain tokens bare", () => {
    assert.equal(quoteForCmd("extensions"), "extensions");
  });

  test("quotes whitespace and cmd metacharacters", () => {
    assert.equal(quoteForCmd("C:\\Program Files\\x.js"), '"C:\\Program Files\\x.js"');
    assert.equal(quoteForCmd("a&b"), '"a&b"');
  });

  test("refuses quote, percent, CR and LF", () => {
    for (const bad of ['a"b', "50%", "a\rb", "a\nb"]) {
      assert.throws(() => quoteForCmd(bad), /cannot pass/);
    }
  });
});

describe("resolveSpawnTarget", () => {
  test("is a plain passthrough on POSIX", () => {
    assert.deepEqual(
      resolveSpawnTarget("hydra-acp", ["extensions", "add", "x y"], { env, platform: "linux" }),
      { command: "hydra-acp", args: ["extensions", "add", "x y"], shell: false },
    );
  });

  test("routes a .cmd shim through the shell with quoted tokens", () => {
    const t = resolveSpawnTarget("hydra-acp", ["--args", "C:\\My Dir\\slack.js"], {
      env: { PATH: spacedDir, PATHEXT: env["PATHEXT"] },
      platform: "win32",
    });
    assert.equal(t.shell, true);
    assert.ok(t.command.startsWith('"'));
    assert.ok(t.command.toLowerCase().endsWith('hydra-acp.cmd"'));
    assert.deepEqual(t.args, ["--args", '"C:\\My Dir\\slack.js"']);
  });

  test("does not use the shell for an .exe", () => {
    const t = resolveSpawnTarget("real-tool", ["a"], { env, platform: "win32" });
    assert.equal(t.shell, false);
    eqPath(t.command, join(dir, "real-tool.exe"));
  });

  test("throws when a shell-bound arg is unquotable", () => {
    assert.throws(
      () => resolveSpawnTarget("hydra-acp", ["C:\\100%\\x.js"], { env, platform: "win32" }),
      /cannot pass/,
    );
  });

  test("does not throw for the same arg on POSIX", () => {
    assert.doesNotThrow(() =>
      resolveSpawnTarget("hydra-acp", ["/tmp/100%/x.js"], { env, platform: "linux" }),
    );
  });
});
