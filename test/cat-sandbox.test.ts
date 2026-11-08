import { strict as assert } from "node:assert";
import nodePath from "node:path";
import { describe, test } from "node:test";
import { isHomeRef, isInsideDir } from "../src/slack/app.js";

const win = nodePath.win32;
const posix = nodePath.posix;

describe("isInsideDir (win32)", () => {
  const cwd = "C:\\proj";
  const inside = (t: string): boolean => isInsideDir(cwd, t, win);

  test("file inside", () => {
    assert.equal(inside("C:\\proj\\src\\a.ts"), true);
  });
  test("the cwd itself", () => {
    assert.equal(inside("C:\\proj"), true);
  });
  test("outside", () => {
    assert.equal(inside("C:\\other\\a.ts"), false);
  });
  test("parent traversal", () => {
    assert.equal(inside("C:\\proj\\..\\..\\x"), false);
    assert.equal(inside("C:\\x"), false);
  });
  test("sibling sharing the cwd name as a prefix", () => {
    assert.equal(inside("C:\\proj2\\a.ts"), false);
  });
  test("different drive", () => {
    assert.equal(inside("D:\\proj\\a.ts"), false);
  });
  test("case-insensitive drive and dir", () => {
    assert.equal(inside("c:\\PROJ\\a.ts"), true);
  });
  test("file literally named ..foo is inside", () => {
    assert.equal(inside("C:\\proj\\..foo"), true);
    assert.equal(inside("C:\\proj\\sub\\..foo\\x"), true);
  });
});

describe("isInsideDir (posix)", () => {
  const cwd = "/work/proj";
  const inside = (t: string): boolean => isInsideDir(cwd, t, posix);

  test("file inside", () => {
    assert.equal(inside("/work/proj/src/a.ts"), true);
  });
  test("the cwd itself", () => {
    assert.equal(inside("/work/proj"), true);
  });
  test("outside", () => {
    assert.equal(inside("/etc/passwd"), false);
  });
  test("parent traversal", () => {
    assert.equal(inside("/work/proj/../../etc/passwd"), false);
    assert.equal(inside("/work"), false);
  });
  test("sibling sharing the cwd name as a prefix", () => {
    assert.equal(inside("/work/proj2/a.ts"), false);
  });
  test("file literally named ..foo is inside", () => {
    assert.equal(inside("/work/proj/..foo"), true);
  });
  test("root as cwd contains everything", () => {
    assert.equal(isInsideDir("/", "/etc/passwd", posix), true);
  });
});

describe("isInsideDir (default path module)", () => {
  test("works with the host path module", () => {
    const cwd = nodePath.resolve("some-proj");
    assert.equal(isInsideDir(cwd, nodePath.join(cwd, "a", "b.txt")), true);
    assert.equal(isInsideDir(cwd, cwd + "2"), false);
    assert.equal(isInsideDir(cwd, nodePath.dirname(cwd)), false);
  });
});

describe("isHomeRef", () => {
  test("accepts ~, ~/x and ~\\x", () => {
    assert.equal(isHomeRef("~"), true);
    assert.equal(isHomeRef("~/notes.txt"), true);
    assert.equal(isHomeRef("~\\notes.txt"), true);
  });
  test("rejects ~foo and other names", () => {
    assert.equal(isHomeRef("~foo"), false);
    assert.equal(isHomeRef("~foo/bar"), false);
    assert.equal(isHomeRef("a~"), false);
    assert.equal(isHomeRef(""), false);
  });
});
