import { strict as assert } from "node:assert";
import { test } from "node:test";
import { confLockNote, isTransientNpxPath } from "../../src/setup/platform-text.js";

test("isTransientNpxPath: POSIX npx cache path", () => {
  assert.equal(isTransientNpxPath("/home/sam/.npm/_npx/abc123/node_modules/x/dist/index.js"), true);
});

test("isTransientNpxPath: Windows npm-cache npx path", () => {
  assert.equal(
    isTransientNpxPath("C:\\Users\\sam\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\x\\dist\\index.js"),
    true,
  );
});

test("isTransientNpxPath: ordinary install paths are not transient", () => {
  assert.equal(isTransientNpxPath("/usr/lib/node_modules/x/dist/index.js"), false);
  assert.equal(isTransientNpxPath("C:\\Users\\sam\\AppData\\Roaming\\npm\\node_modules\\x\\dist\\index.js"), false);
  assert.equal(isTransientNpxPath("/home/sam/dev/_npx_notes/index.js"), false);
});

test("confLockNote: chmod advice only off win32", () => {
  assert.equal(confLockNote("linux"), "# Lock this file: chmod 600.");
  assert.equal(confLockNote("darwin"), "# Lock this file: chmod 600.");
  assert.doesNotMatch(confLockNote("win32"), /chmod/);
});
