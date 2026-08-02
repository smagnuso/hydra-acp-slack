const SLACK_API_BASE = "https://slack.com/api";

export class SlackApiError extends Error {
  readonly method: string;
  readonly slackError: string;
  readonly details: unknown;
  constructor(method: string, slackError: string, details: unknown) {
    super(`Slack API ${method} failed: ${slackError}`);
    this.method = method;
    this.slackError = slackError;
    this.details = details;
  }
}

export async function callSlack(
  method: string,
  token: string,
  payload?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: payload ? JSON.stringify(payload) : "{}",
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!json.ok) {
    const err = typeof json.error === "string" ? json.error : "unknown_error";
    throw new SlackApiError(method, err, json);
  }
  return json;
}

export async function callSlackForm(
  method: string,
  token: string,
  payload: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(payload).toString();
  const res = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!json.ok) {
    const err = typeof json.error === "string" ? json.error : "unknown_error";
    throw new SlackApiError(method, err, json);
  }
  return json;
}

// Scopes actually granted to `token`, as opposed to the scopes the
// app's manifest declares. Slack only reports these in the
// `x-oauth-scopes` response header, not in any response body, so this
// goes to fetch directly rather than through callSlack. auth.test is
// used because it needs no scope of its own.
//
// Returns undefined when the call fails or the header is absent — the
// caller must treat that as "unknown", never as "nothing granted".
export async function grantedScopes(
  token: string,
): Promise<Set<string> | undefined> {
  try {
    const res = await fetch(`${SLACK_API_BASE}/auth.test`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const header = res.headers.get("x-oauth-scopes");
    if (!header) {
      return undefined;
    }
    return new Set(
      header
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  } catch {
    return undefined;
  }
}

export async function exchangeOAuthCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    redirect_uri: args.redirectUri,
  }).toString();
  const res = await fetch(`${SLACK_API_BASE}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!json.ok) {
    const err = typeof json.error === "string" ? json.error : "unknown_error";
    throw new SlackApiError("oauth.v2.access", err, json);
  }
  return json;
}
