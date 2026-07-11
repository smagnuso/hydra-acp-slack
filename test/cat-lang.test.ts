import { strict as assert } from "node:assert";
import { test } from "node:test";
import { languageForPath } from "../src/slack/cat-lang.js";

test("languageForPath maps common extensions", () => {
  assert.equal(languageForPath("foo.ts"), "typescript");
  assert.equal(languageForPath("foo.tsx"), "tsx");
  assert.equal(languageForPath("foo.py"), "python");
  assert.equal(languageForPath("foo.md"), "markdown");
  assert.equal(languageForPath("foo.cpp"), "cpp");
  assert.equal(languageForPath("foo.h"), "c");
});

test("languageForPath is case-insensitive on the extension", () => {
  assert.equal(languageForPath("FOO.TS"), "typescript");
  assert.equal(languageForPath("Foo.Py"), "python");
});

test("languageForPath handles dotless well-known basenames", () => {
  assert.equal(languageForPath("Makefile"), "makefile");
  assert.equal(languageForPath("path/to/Dockerfile"), "dockerfile");
  assert.equal(languageForPath("CMakeLists.txt"), "cmake");
});

test("languageForPath uses only the basename for lookup", () => {
  assert.equal(languageForPath("src/deeply/nested/file.rs"), "rust");
  assert.equal(languageForPath("/abs/path/file.go"), "go");
});

test("languageForPath uses the LAST extension for multi-dot filenames", () => {
  assert.equal(languageForPath("foo.tar.gz"), undefined);
  assert.equal(languageForPath("foo.min.js"), "javascript");
});

test("languageForPath returns undefined for unknown and empty", () => {
  assert.equal(languageForPath("foo.xyz"), undefined);
  assert.equal(languageForPath("noext"), undefined);
  assert.equal(languageForPath(""), undefined);
  assert.equal(languageForPath(".hidden"), undefined);
});
