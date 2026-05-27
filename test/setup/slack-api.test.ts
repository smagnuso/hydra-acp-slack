import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import { callSlack, callSlackForm, exchangeOAuthCode, SlackApiError } from "../../src/setup/slack-api.js";

interface CapturedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
}

const realFetch = globalThis.fetch;
let captured: CapturedRequest[] = [];
let nextResponse: { status?: number; body: unknown } = { body: { ok: true } };

function installMockFetch(): void {
  captured = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h)
      for (const [k, v] of Object.entries(h))
        headers[k] = v;
    captured.push({
      url,
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  installMockFetch();
  nextResponse = { body: { ok: true } };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("callSlack: posts JSON to the right URL with bearer token", async () => {
  nextResponse = { body: { ok: true, app_id: "A123", credentials: { client_id: "cid", client_secret: "sec" } } };
  const res = await callSlack("apps.manifest.create", "xoxe-token", { manifest: { foo: "bar" } });
  assert.equal(res.app_id, "A123");
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.url, "https://slack.com/api/apps.manifest.create");
  assert.equal(captured[0]!.method, "POST");
  assert.equal(captured[0]!.headers["Authorization"], "Bearer xoxe-token");
  assert.match(captured[0]!.headers["Content-Type"] ?? "", /application\/json/);
  assert.deepEqual(JSON.parse(captured[0]!.body!), { manifest: { foo: "bar" } });
});

test("callSlack: throws SlackApiError on ok:false with the slack error code", async () => {
  nextResponse = { body: { ok: false, error: "invalid_manifest", errors: [{ message: "bad" }] } };
  await assert.rejects(
    () => callSlack("apps.manifest.create", "t", {}),
    (err: unknown) =>
      err instanceof SlackApiError &&
      err.method === "apps.manifest.create" &&
      err.slackError === "invalid_manifest",
  );
});

test("callSlackForm: posts url-encoded body", async () => {
  nextResponse = { body: { ok: true, channels: [] } };
  await callSlackForm("conversations.list", "xoxb-t", {
    types: "public_channel,private_channel",
    exclude_archived: "true",
    limit: "200",
  });
  assert.equal(captured.length, 1);
  assert.match(captured[0]!.headers["Content-Type"] ?? "", /application\/x-www-form-urlencoded/);
  assert.equal(
    captured[0]!.body,
    "types=public_channel%2Cprivate_channel&exclude_archived=true&limit=200",
  );
});

test("exchangeOAuthCode: sends client_id/secret/code/redirect_uri form-encoded", async () => {
  nextResponse = { body: { ok: true, access_token: "xoxb-new", authed_user: { id: "U999" } } };
  const res = await exchangeOAuthCode({
    clientId: "cid",
    clientSecret: "csec",
    code: "the-code",
    redirectUri: "http://localhost:4817/callback",
  });
  assert.equal(res.access_token, "xoxb-new");
  assert.equal(captured[0]!.url, "https://slack.com/api/oauth.v2.access");
  assert.equal(
    captured[0]!.body,
    "client_id=cid&client_secret=csec&code=the-code&redirect_uri=http%3A%2F%2Flocalhost%3A4817%2Fcallback",
  );
});

test("exchangeOAuthCode: throws when slack returns ok:false", async () => {
  nextResponse = { body: { ok: false, error: "invalid_code" } };
  await assert.rejects(
    () =>
      exchangeOAuthCode({
        clientId: "cid",
        clientSecret: "csec",
        code: "x",
        redirectUri: "http://localhost/cb",
      }),
    (err: unknown) => err instanceof SlackApiError && err.slackError === "invalid_code",
  );
});
