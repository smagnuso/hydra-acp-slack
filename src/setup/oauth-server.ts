import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export interface OAuthResult {
  code: string;
  state?: string;
}

export interface OAuthServer {
  port: number;
  redirectUri: string;
  awaitCallback(): Promise<OAuthResult>;
  close(): void;
}

export async function startOAuthServer(port: number): Promise<OAuthServer> {
  let resolve: ((r: OAuthResult) => void) | undefined;
  let reject: ((e: Error) => void) | undefined;
  const promise = new Promise<OAuthResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname !== "/callback") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? undefined;
    const err = url.searchParams.get("error");
    if (!code) {
      // Slack explicitly denied the grant — surface the reason and stop.
      if (err) {
        const desc = url.searchParams.get("error_description");
        res.statusCode = 400;
        res.end(`OAuth denied: ${err}`);
        reject?.(new Error(desc ? `${err} — ${desc}` : err));
        return;
      }
      // A bare hit with no code and no error (favicon probe, manual visit,
      // duplicate request). Don't tear down the flow; keep waiting for the
      // real redirect from Slack.
      res.statusCode = 400;
      res.end("Waiting for the Slack authorization redirect. You can close this tab.");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      "<!doctype html><html><body style=\"font-family: system-ui; padding: 2rem;\">" +
        "<h2>Authorized.</h2><p>You can close this tab and return to the terminal.</p>" +
        "</body></html>",
    );
    resolve?.({ code, state });
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rej);
      res();
    });
  });

  const actualPort = (server.address() as AddressInfo).port;
  const redirectUri = `http://localhost:${actualPort}/callback`;

  return {
    port: actualPort,
    redirectUri,
    awaitCallback: () => promise,
    close: () => server.close(),
  };
}
