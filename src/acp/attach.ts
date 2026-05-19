import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { logger } from "../util/log.js";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };
import {
  ACP_PROTOCOL_VERSION,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  isNotification,
  isRequest,
  isResponse,
} from "./protocol.js";

const log = logger("acp");

export interface AttachOptions {
  // Hydra-side session id we're attaching to.
  sessionId: string;
  // Hydra daemon's WebSocket URL, e.g. ws://127.0.0.1:8765/acp
  daemonWsUrl: string;
  // Bearer token, sent as the `hydra-acp-token.<token>` WS subprotocol.
  token: string;
  // Optional initialize/clientCapabilities; sent on connect.
  clientCapabilities?: Record<string, unknown>;
  protocolVersion?: number;
}

export interface AttachEvents {
  open: [];
  close: [{ hadError: boolean }];
  error: [Error];
  request: [JsonRpcRequest];
  notification: [JsonRpcNotification];
  response: [JsonRpcResponse];
}

interface PendingRequest {
  resolve: (r: JsonRpcResponse) => void;
  reject: (err: Error) => void;
}

export class AcpAttach extends EventEmitter<AttachEvents> {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private connected = false;
  private lastFrameAt = 0;
  private _agentInfo: { name?: string; version?: string } | undefined;
  private _attachMeta: Record<string, unknown> | undefined;
  // clientId hydra assigned us on session/attach. Lets the bridge
  // recognize its own hydra-acp/prompt_queue_added events (so peer-
  // originated queue events don't trigger local-entry binding).
  private _clientId: string | undefined;

  constructor(private readonly opts: AttachOptions) {
    super();
  }

  get sessionId(): string {
    return this.opts.sessionId;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get lastFrameTime(): number {
    return this.lastFrameAt;
  }

  // Returns the upstream agent info if exposed via _meta["hydra-acp"].agentId
  // on the attach response, falling back to the daemon's own agentInfo from
  // initialize.
  get agentInfo(): { name?: string; version?: string } | undefined {
    return this._agentInfo;
  }

  get attachMeta(): Record<string, unknown> | undefined {
    return this._attachMeta;
  }

  get clientId(): string | undefined {
    return this._clientId;
  }

  start(): void {
    log.debug(`connecting ${this.opts.daemonWsUrl} for ${this.opts.sessionId}`);
    const subprotocols = ["acp.v1", `hydra-acp-token.${this.opts.token}`];
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.daemonWsUrl, subprotocols);
    } catch (err) {
      this.emit("error", err as Error);
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.connected = true;
      this.lastFrameAt = Date.now();
      log.info(`ws open ${this.opts.sessionId}`);
      // Send initialize and session/attach before "open" is emitted to
      // listeners; if the handshake fails (e.g. session not found and
      // no resume hints on disk), surface as "error" + close instead of
      // pretending the attach succeeded — otherwise listeners proceed
      // with rendering for a bridge that hydra never registered.
      void this.handshake()
        .then(() => {
          this.emit("open");
        })
        .catch((err: unknown) => {
          this.emit("error", err as Error);
          try {
            this.ws?.close();
          } catch {
            void 0;
          }
        });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      this.lastFrameAt = Date.now();
      const text = data.toString("utf8");
      try {
        const parsed = JSON.parse(text) as JsonRpcMessage;
        this.onMessage(parsed);
      } catch (err) {
        log.warn(
          `parse error on ${this.opts.sessionId}: ${(err as Error).message}; raw=${text.slice(0, 200)}`,
        );
      }
    });

    ws.on("error", (err) => {
      log.warn(`ws error ${this.opts.sessionId}: ${err.message}`);
      this.emit("error", err);
    });

    ws.on("close", (code, reason) => {
      const hadError = code >= 4000 || code === 1006 || code === 1011;
      const reasonText = reason.toString("utf8");
      this.connected = false;
      log.info(
        `ws closed ${this.opts.sessionId} code=${code}${reasonText ? ` reason=${reasonText}` : ""}`,
      );
      for (const [, p] of this.pending) {
        p.reject(new Error("ws closed"));
      }
      this.pending.clear();
      this.emit("close", { hadError });
    });
  }

  stop(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      try {
        this.ws.close();
      } catch {
        void 0;
      }
    }
  }

  // Send a JSON-RPC request and await the response.
  async request<R = unknown>(method: string, params?: unknown): Promise<R> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.write(msg);
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (resp) => {
          if (resp.error) {
            reject(new Error(`${resp.error.code}: ${resp.error.message}`));
          } else {
            resolve(resp.result as R);
          }
        },
        reject,
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.write(msg);
  }

  reply(id: JsonRpcId, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    log.info(
      `reply id=${typeof id}:${String(id)} result=${JSON.stringify(result).slice(0, 200)}`,
    );
    this.write(msg);
  }

  replyError(id: JsonRpcId, code: number, message: string): void {
    const msg: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    };
    log.info(
      `replyError id=${typeof id}:${String(id)} code=${code} message=${message}`,
    );
    this.write(msg);
  }

  private async handshake(): Promise<void> {
    try {
      const initResult = await this.request<{
        agentInfo?: { name?: string; version?: string };
      }>("initialize", {
        protocolVersion: this.opts.protocolVersion ?? ACP_PROTOCOL_VERSION,
        clientCapabilities: this.opts.clientCapabilities ?? {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      if (initResult?.agentInfo && typeof initResult.agentInfo === "object") {
        this._agentInfo = initResult.agentInfo;
      }
    } catch (err) {
      log.warn(
        `initialize failed for ${this.opts.sessionId}: ${(err as Error).message}`,
      );
    }
    try {
      const attachResult = await this.request<{
        sessionId: string;
        clientId?: string;
        replayed?: number;
        _meta?: Record<string, unknown>;
      }>("session/attach", {
        sessionId: this.opts.sessionId,
        historyPolicy: "full",
        clientInfo: { name: "hydra-acp-slack", version: pkg.version },
      });
      this._attachMeta = attachResult._meta;
      this._clientId = attachResult.clientId;
      const hydraMeta = (attachResult._meta?.["hydra-acp"] ?? {}) as {
        agentId?: string;
      };
      if (hydraMeta.agentId) {
        this._agentInfo = {
          name: hydraMeta.agentId,
          version: this._agentInfo?.version,
        };
      }
      log.info(
        `attached ${this.opts.sessionId}${
          this._agentInfo?.name ? ` agent=${this._agentInfo.name}` : ""
        }${
          attachResult.replayed !== undefined
            ? ` replayed=${attachResult.replayed}`
            : ""
        }`,
      );
    } catch (err) {
      log.warn(
        `session/attach failed for ${this.opts.sessionId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  private write(msg: JsonRpcMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn(`drop write to closed ws: ${JSON.stringify(msg)}`);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private onMessage(m: JsonRpcMessage): void {
    if (isResponse(m)) {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        p.resolve(m);
      } else {
        log.debug(`unmatched response id=${String(m.id)}`);
      }
      this.emit("response", m);
    } else if (isRequest(m)) {
      this.emit("request", m);
    } else if (isNotification(m)) {
      this.emit("notification", m);
    }
  }
}
