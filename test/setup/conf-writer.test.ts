import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergeConf, readExisting, writeConf } from "../../src/setup/conf-writer.js";

test("mergeConf: fresh file gets header + updated keys + hydra placeholder", () => {
  const out = mergeConf("", {
    SLACK_BOT_TOKEN: "xoxb-abc",
    SLACK_APP_TOKEN: "xapp-def",
  });
  assert.match(out, /hydra-acp-slack setup/);
  assert.match(out, /^SLACK_BOT_TOKEN=xoxb-abc$/m);
  assert.match(out, /^SLACK_APP_TOKEN=xapp-def$/m);
  assert.match(out, /^#\s*HYDRA_TOKEN=/m);
});

test("mergeConf: existing keys are replaced in place", () => {
  const existing = [
    "# user comment",
    "SLACK_BOT_TOKEN=xoxb-old",
    "SLACK_APP_TOKEN=xapp-old",
    "DEBUG=true",
    "",
  ].join("\n");
  const out = mergeConf(existing, { SLACK_BOT_TOKEN: "xoxb-new" });
  assert.match(out, /^# user comment$/m);
  assert.match(out, /^SLACK_BOT_TOKEN=xoxb-new$/m);
  assert.match(out, /^SLACK_APP_TOKEN=xapp-old$/m);
  assert.match(out, /^DEBUG=true$/m);
  assert.doesNotMatch(out, /xoxb-old/);
});

test("mergeConf: HYDRA_TOKEN and unknown keys are preserved", () => {
  const existing = [
    "# comment",
    "HYDRA_TOKEN=secret123",
    "SLACK_BOT_TOKEN=xoxb-old",
    "WEIRD_CUSTOM_KEY=hello",
    "",
  ].join("\n");
  const out = mergeConf(existing, {
    SLACK_BOT_TOKEN: "xoxb-new",
    SLACK_APP_TOKEN: "xapp-new",
  });
  assert.match(out, /^HYDRA_TOKEN=secret123$/m);
  assert.match(out, /^WEIRD_CUSTOM_KEY=hello$/m);
  assert.match(out, /^SLACK_BOT_TOKEN=xoxb-new$/m);
  assert.match(out, /^SLACK_APP_TOKEN=xapp-new$/m);
});

test("mergeConf: undefined values are skipped (no rewrite)", () => {
  const existing = "SLACK_CHANNEL_ID=C123\n";
  const out = mergeConf(existing, { SLACK_CHANNEL_ID: undefined });
  assert.match(out, /^SLACK_CHANNEL_ID=C123$/m);
});

test("mergeConf: new keys append at end with blank-line separator", () => {
  const existing = "SLACK_BOT_TOKEN=xoxb-x\n";
  const out = mergeConf(existing, { SLACK_APP_ID: "A123" });
  assert.match(out, /^SLACK_BOT_TOKEN=xoxb-x$/m);
  assert.match(out, /^SLACK_APP_ID=A123$/m);
});

test("mergeConf: values with whitespace get quoted", () => {
  const out = mergeConf("", { SLACK_BOT_TOKEN: "value with space" });
  assert.match(out, /^SLACK_BOT_TOKEN="value with space"$/m);
});

test("readExisting: returns empty map for missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-test-"));
  const path = join(dir, "nope.conf");
  const { text, map } = readExisting(path);
  assert.equal(text, "");
  assert.equal(map.size, 0);
});

test("readExisting: parses quoted and unquoted values", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-test-"));
  const path = join(dir, "slack.conf");
  writeConf(path, {
    SLACK_BOT_TOKEN: "xoxb-plain",
    SLACK_APP_TOKEN: "xapp-with space",
  });
  const { map } = readExisting(path);
  assert.equal(map.get("SLACK_BOT_TOKEN"), "xoxb-plain");
  assert.equal(map.get("SLACK_APP_TOKEN"), "xapp-with space");
});

test("writeConf: writes file with 0600 permissions on POSIX", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-test-"));
  const path = join(dir, "slack.conf");
  writeConf(path, { SLACK_BOT_TOKEN: "xoxb-t", SLACK_APP_TOKEN: "xapp-t" });
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
  const text = readFileSync(path, "utf8");
  assert.match(text, /^SLACK_BOT_TOKEN=xoxb-t$/m);
});

test("writeConf: round-trips preserving comments across multiple writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-test-"));
  const path = join(dir, "slack.conf");
  writeConf(path, { SLACK_BOT_TOKEN: "xoxb-a", SLACK_APP_TOKEN: "xapp-a", HYDRA_TOKEN: "secret" });
  writeConf(path, { SLACK_BOT_TOKEN: "xoxb-b" });
  const text = readFileSync(path, "utf8");
  assert.match(text, /^SLACK_BOT_TOKEN=xoxb-b$/m);
  assert.match(text, /^SLACK_APP_TOKEN=xapp-a$/m);
  assert.match(text, /^HYDRA_TOKEN=secret$/m);
});
