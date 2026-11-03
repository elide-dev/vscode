import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface McpToolResult { content: McpContent[]; isError?: boolean }
export interface McpCallContext {
  /** Aborted when the client cancels the call (`notifications/cancelled`), disconnects, or the server closes. */
  signal: AbortSignal;
  /** Reports progress, sent only to a streaming (SSE) client that asked for it with `_meta.progressToken`. */
  progress(message: string): void;
}
export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** A thrown error becomes a tool result with `isError`. */
  call(args: Record<string, unknown>, context: McpCallContext): Promise<McpToolResult>;
}

export interface McpServerOptions {
  name: string;
  version: string;
  instructions?: string;
  tools: readonly McpTool[];
  token: string;
  port?: number;
  log?: (line: string) => void;
}

/** Newest first: `initialize` echoes the client's version when listed, else offers the first. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const BODY_LIMIT = 4 * 1024 * 1024;
/** How long an oversized request is still drained after its 413, so the client reads the reply rather than a reset. */
const DRAIN_GRACE_MS = 1_000;
const KEEP_ALIVE_MS = 10_000;

type Id = string | number;
type Response = { jsonrpc: "2.0"; id: Id | null } & ({ result: unknown } | { error: { code: number; message: string } });

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is Id => typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

/** Hashing first makes the comparison constant-time for tokens of any length. */
function sameToken(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * A stateless MCP server over Streamable HTTP, on loopback only: `POST /mcp` takes JSON-RPC requests (or a batch), answers in JSON,
 * or streams a `tools/call` as SSE (progress notifications, keep-alives, then the result) to a client that accepts
 * `text/event-stream`. No server-initiated stream. `initialize` hands out an `Mcp-Session-Id` that only scopes request ids (a
 * client's `notifications/cancelled` names its own calls); no session state is kept, so any id, or none, is accepted. Every
 * request needs the bearer token and a loopback `Host`/`Origin` naming the server's port (DNS rebinding).
 */
export class McpHttpServer {
  /** http://127.0.0.1:<port>/mcp */
  readonly url: string;
  private readonly tools: ReadonlyMap<string, McpTool>;
  /** In-flight calls by session id and `JSON.stringify(id)`; clients without a session share one id space, so a key may have several. */
  private readonly calls = new Map<string, Set<AbortController>>();
  private closed = false;

  private constructor(
    private readonly server: Server,
    private readonly sockets: Set<Socket>,
    readonly port: number,
    private readonly options: McpServerOptions,
  ) {
    this.url = `http://127.0.0.1:${port}/mcp`;
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  }

  /** Listens on 127.0.0.1:`port`, or an ephemeral port when `port` is absent or taken. */
  static async start(options: McpServerOptions): Promise<McpHttpServer> {
    let instance: McpHttpServer | undefined;
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      if (instance) instance.handle(request, response);
      else response.writeHead(503).end();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    const listen = (port: number) => {
      const { promise, resolve, reject } = Promise.withResolvers<number>();
      server.once("error", reject);
      server.listen({ port, host: "127.0.0.1" }, () => {
        server.off("error", reject);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
      return promise;
    };
    let port: number;
    try {
      port = await listen(options.port ?? 0);
    } catch (error) {
      if (!options.port || !(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
      options.log?.(`MCP: port ${options.port} is taken; listening on an ephemeral port`);
      port = await listen(0);
    }
    instance = new McpHttpServer(server, sockets, port, options);
    return instance;
  }

  /** Stops listening, aborts every in-flight call and destroys open connections. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controllers of this.calls.values()) for (const controller of controllers) controller.abort(new Error("The MCP server closed"));
    this.calls.clear();
    const closed = Promise.withResolvers<void>();
    this.server.close(() => closed.resolve());
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await closed.promise;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const reject = (status: number, message: string, headers: Record<string, string> = {}) => {
      this.options.log?.(`MCP: ${request.method} ${request.url} rejected: ${status} ${message}`);
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers }).end(message);
    };
    const host = request.headers.host?.toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return reject(403, "Forbidden host");
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${this.port}` && origin !== `http://localhost:${this.port}`) {
      return reject(403, "Forbidden origin");
    }
    const authorization = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? "")?.[1];
    if (authorization === undefined || !sameToken(authorization, this.options.token)) {
      return reject(401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
    }
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") return reject(404, "Not found");
    if (request.method !== "POST") return reject(405, "Method not allowed", { Allow: "POST" });
    const version = request.headers["mcp-protocol-version"];
    if (typeof version === "string" && !PROTOCOL_VERSIONS.includes(version)) return reject(400, `Unsupported MCP-Protocol-Version ${version}`);

    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      const over = size > BODY_LIMIT;
      size += chunk.length;
      if (over) return; // already answered 413; discard until the connection is closed below
      if (size <= BODY_LIMIT) return void chunks.push(chunk);
      chunks.length = 0;
      // Keep draining so the client reads the 413 instead of a reset, but only briefly after it is sent.
      response.once("finish", () => setTimeout(() => request.destroy(), DRAIN_GRACE_MS).unref());
      reject(413, "Request body too large", { Connection: "close" });
    });
    request.on("end", () => {
      if (size > BODY_LIMIT) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return this.json(response, 400, failure(null, new RpcError(-32700, "Parse error")));
      }
      void this.dispatch(body, request, response).catch((error: unknown) => {
        this.options.log?.(`MCP: ${String(error)}`);
        if (!response.headersSent) this.json(response, 500, failure(null, new RpcError(-32603, "Internal error")));
        else response.end();
      });
    });
  }

  private async dispatch(body: unknown, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = request.headers["mcp-session-id"];
    const scope = typeof session === "string" ? session : "";
    const abort = new AbortController();
    response.once("close", () => {
      if (!response.writableFinished) abort.abort(new Error("The MCP client disconnected"));
    });
    if (Array.isArray(body)) {
      if (body.length === 0) return this.json(response, 400, failure(null, new RpcError(-32600, "Invalid request: empty batch")));
      const answers = await Promise.all(body.map((message) => this.message(message, scope, abort.signal)));
      const responses = answers.filter((answer): answer is Response => answer !== undefined);
      if (responses.length === 0) return void response.writeHead(202).end();
      return this.json(response, 200, responses);
    }
    const streams = object(body) && body.method === "tools/call" && isId(body.id)
      && (request.headers.accept ?? "").toLowerCase().includes("text/event-stream");
    if (!streams) {
      if (object(body) && body.method === "initialize") response.setHeader("Mcp-Session-Id", randomUUID());
      const answer = await this.message(body, scope, abort.signal);
      if (answer === undefined) return void response.writeHead(202).end();
      return this.json(response, "error" in answer && answer.error.code === -32600 ? 400 : 200, answer);
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    response.flushHeaders();
    const send = (value: unknown) => {
      if (!response.writableEnded && !response.destroyed) response.write(`event: message\ndata: ${JSON.stringify(value)}\n\n`);
    };
    const keepAlive = setInterval(() => {
      if (!response.writableEnded && !response.destroyed) response.write(": keep-alive\n\n");
    }, KEEP_ALIVE_MS);
    // A tool that ignores its signal must not keep writing to (and the process alive for) a closed connection.
    abort.signal.addEventListener("abort", () => clearInterval(keepAlive), { once: true });
    try {
      send(await this.message(body, scope, abort.signal, send));
    } finally {
      clearInterval(keepAlive);
      response.end();
    }
  }

  /** The response to one JSON-RPC message; none for notifications and client responses. */
  private async message(value: unknown, scope: string, signal: AbortSignal, stream?: (notification: unknown) => void): Promise<Response | undefined> {
    if (!object(value) || value.jsonrpc !== "2.0") return failure(null, new RpcError(-32600, "Invalid request"));
    const id = value.id;
    if (typeof value.method !== "string") {
      // A response to a server request (this server sends none) needs no answer.
      if (isId(id) && ("result" in value || "error" in value)) return undefined;
      return failure(isId(id) ? id : null, new RpcError(-32600, "Invalid request"));
    }
    if (id === undefined) {
      this.notification(scope, value.method, value.params);
      return undefined;
    }
    if (!isId(id)) return failure(null, new RpcError(-32600, "Invalid request: id must be a string or number"));
    try {
      return { jsonrpc: "2.0", id, result: await this.request(scope, id, value.method, value.params, signal, stream) };
    } catch (error) {
      if (error instanceof RpcError) return failure(id, error);
      this.options.log?.(`MCP: ${value.method} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      return failure(id, new RpcError(-32603, "Internal error"));
    }
  }

  private notification(scope: string, method: string, params: unknown): void {
    if (method !== "notifications/cancelled" || !object(params) || !isId(params.requestId)) return;
    const key = `${scope}\0${JSON.stringify(params.requestId)}`;
    const reason = typeof params.reason === "string" && params.reason ? params.reason : "The MCP client cancelled the call";
    for (const controller of this.calls.get(key) ?? []) controller.abort(new Error(reason));
  }

  private async request(scope: string, id: Id, method: string, params: unknown, signal: AbortSignal, stream?: (notification: unknown) => void): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requested = object(params) ? params.protocolVersion : undefined;
        const protocolVersion = typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.options.name, version: this.options.version },
          ...this.options.instructions ? { instructions: this.options.instructions } : {},
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [...this.tools.values()].map((tool) => ({
            name: tool.name,
            ...tool.title ? { title: tool.title } : {},
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...tool.annotations ? { annotations: tool.annotations } : {},
          })),
        };
      case "tools/call":
        return this.call(scope, id, params, signal, stream);
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  private async call(scope: string, id: Id, params: unknown, signal: AbortSignal, stream?: (notification: unknown) => void): Promise<McpToolResult> {
    if (!object(params) || typeof params.name !== "string") throw new RpcError(-32602, "Invalid params: tools/call needs a tool name");
    const tool = this.tools.get(params.name);
    if (!tool) throw new RpcError(-32602, `Unknown tool: ${params.name}`);
    const args = params.arguments ?? {};
    if (!object(args)) throw new RpcError(-32602, "Invalid params: arguments must be an object");
    const token = object(params._meta) && isId(params._meta.progressToken) ? params._meta.progressToken : undefined;
    const controller = new AbortController();
    const forward = () => controller.abort(signal.reason);
    if (signal.aborted) forward();
    else signal.addEventListener("abort", forward, { once: true });
    const key = `${scope}\0${JSON.stringify(id)}`;
    const pending = this.calls.get(key) ?? new Set();
    pending.add(controller);
    this.calls.set(key, pending);
    let progress = 0;
    const context: McpCallContext = {
      signal: controller.signal,
      progress: (message) => {
        if (token === undefined || !stream || controller.signal.aborted) return;
        stream({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++progress, message } });
      },
    };
    try {
      return await tool.call(args, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log?.(`MCP: ${tool.name} failed: ${message}`);
      return { content: [{ type: "text", text: message }], isError: true };
    } finally {
      signal.removeEventListener("abort", forward);
      pending.delete(controller);
      if (pending.size === 0 && this.calls.get(key) === pending) this.calls.delete(key);
    }
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    if (response.destroyed) return;
    response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  }
}

function failure(id: Id | null, error: RpcError): Response {
  return { jsonrpc: "2.0", id, error: { code: error.code, message: error.message } };
}
