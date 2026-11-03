import { afterEach, describe, expect, test } from "bun:test";
import { request } from "node:http";
import { connect } from "node:net";
import { McpHttpServer, type McpCallContext, type McpTool } from "../src/mcpServer.js";

const TOKEN = "test-token-0123456789";
const servers: McpHttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const echo: McpTool = {
  name: "echo",
  title: "Echo",
  description: "Returns its text.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  annotations: { readOnlyHint: true, openWorldHint: false },
  call: async (args) => ({ content: [{ type: "text", text: String(args.text) }] }),
};

async function start(tools: McpTool[] = [echo], port?: number, log?: (line: string) => void): Promise<McpHttpServer> {
  const server = await McpHttpServer.start({ name: "elide-test", version: "1.2.3", instructions: "Render composables.", tools, token: TOKEN, port, log });
  servers.push(server);
  return server;
}

const JSON_HEADERS = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" };
const STREAM_HEADERS = { ...JSON_HEADERS, Accept: "application/json, text/event-stream" };

function post(server: McpHttpServer, body: unknown, headers: Record<string, string> = JSON_HEADERS, signal?: AbortSignal): Promise<Response> {
  return fetch(server.url, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body), signal });
}

interface Reply { jsonrpc: "2.0"; id?: unknown; method?: string; result?: Record<string, unknown>; error?: { code: number; message: string } }

async function rpc(server: McpHttpServer, method: string, params?: unknown, id: number | string = 1): Promise<Reply> {
  const response = await post(server, { jsonrpc: "2.0", id, method, ...params === undefined ? {} : { params } });
  expect(response.headers.get("content-type")).toBe("application/json");
  return (await response.json()) as Reply;
}

/** The JSON-RPC messages of an SSE body. */
function events(body: string): Reply[] {
  return body.split("\n\n").filter((block) => block.includes("data: ")).map((block) => {
    expect(block).toStartWith("event: message\n");
    return JSON.parse(block.slice(block.indexOf("data: ") + 6)) as Reply;
  });
}

/** A request with exactly these headers (fetch would set its own Host). */
function raw(server: McpHttpServer, method: string, headers: Record<string, string>, body = ""): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; headers: Record<string, unknown>; body: string }>();
  const outgoing = request({ host: "127.0.0.1", port: server.port, path: "/mcp", method, headers }, (response) => {
    let data = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => (data += chunk));
    response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: data }));
  });
  outgoing.on("error", reject);
  outgoing.end(body);
  return promise;
}

/** A tool that waits for its signal and reports how it ended. */
function waiting(): { tool: McpTool; started: Promise<McpCallContext>; ended: Promise<string> } {
  const started = Promise.withResolvers<McpCallContext>();
  const ended = Promise.withResolvers<string>();
  const tool: McpTool = {
    name: "wait",
    description: "Waits until cancelled.",
    inputSchema: { type: "object" },
    call: (_args, context) => {
      const call = Promise.withResolvers<never>();
      context.signal.addEventListener("abort", () => {
        const reason = context.signal.reason instanceof Error ? context.signal.reason.message : String(context.signal.reason);
        ended.resolve(reason);
        call.reject(new Error(`aborted: ${reason}`));
      });
      started.resolve(context);
      return call.promise;
    },
  };
  return { tool, started: started.promise, ended: ended.promise };
}

describe("MCP server", () => {
  test("negotiates the protocol version and describes itself", async () => {
    const server = await start();
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/mcp`);
    const initialize = await rpc(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(initialize).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "elide-test", version: "1.2.3" },
        instructions: "Render composables.",
      },
    });
    for (const version of ["2025-11-25", "2025-03-26", "2024-11-05"]) {
      expect((await rpc(server, "initialize", { protocolVersion: version })).result?.protocolVersion).toBe(version);
    }
    expect((await rpc(server, "initialize", { protocolVersion: "1999-01-01" })).result?.protocolVersion).toBe("2025-11-25");
    expect(await rpc(server, "ping", undefined, "p")).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  test("lists tools with their schema and annotations", async () => {
    const bare: McpTool = { name: "bare", description: "No extras.", inputSchema: { type: "object" }, call: echo.call };
    const server = await start([echo, bare]);
    expect((await rpc(server, "tools/list", {})).result).toEqual({
      tools: [
        { name: "echo", title: "Echo", description: "Returns its text.", inputSchema: echo.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
        { name: "bare", description: "No extras.", inputSchema: { type: "object" } },
      ],
    });
  });

  test("answers a tool call in JSON, and a thrown error as a tool error", async () => {
    const failing: McpTool = { name: "fail", description: "Throws.", inputSchema: { type: "object" }, call: async () => { throw new Error("no device"); } };
    const lines: string[] = [];
    const server = await start([echo, failing], undefined, (line) => lines.push(line));
    expect(await rpc(server, "tools/call", { name: "echo", arguments: { text: "hi" } })).toEqual({
      jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hi" }] },
    });
    expect((await rpc(server, "tools/call", { name: "fail", arguments: {} })).result).toEqual({ content: [{ type: "text", text: "no device" }], isError: true });
    expect(lines.some((line) => line.includes("no device"))).toBe(true);
  });

  test("streams progress and the result as SSE when the client accepts it", async () => {
    const steps: McpTool = {
      name: "steps",
      description: "Reports progress.",
      inputSchema: { type: "object" },
      call: async (_args, context) => {
        context.progress("Compiling");
        await Promise.resolve();
        context.progress("Rendering");
        return { content: [{ type: "image", data: "iVBO", mimeType: "image/png" }] };
      },
    };
    const server = await start([steps]);
    const response = await post(server, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "steps", _meta: { progressToken: "tok" } } }, STREAM_HEADERS);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(events(await response.text())).toEqual([
      { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "tok", progress: 1, message: "Compiling" } },
      { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "tok", progress: 2, message: "Rendering" } },
      { jsonrpc: "2.0", id: 9, result: { content: [{ type: "image", data: "iVBO", mimeType: "image/png" }] } },
    ]);
    // Without a progress token only the result is sent; JSON clients get no progress.
    const quiet = await post(server, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "steps" } }, STREAM_HEADERS);
    expect(events(await quiet.text()).map((message) => message.id)).toEqual([10]);
    expect(await rpc(server, "tools/call", { name: "steps", _meta: { progressToken: 1 } })).toEqual({
      jsonrpc: "2.0", id: 1, result: { content: [{ type: "image", data: "iVBO", mimeType: "image/png" }] },
    });
  });

  test("reports protocol errors with JSON-RPC codes", async () => {
    const server = await start();
    expect((await rpc(server, "tools/call", { name: "missing" })).error).toEqual({ code: -32602, message: "Unknown tool: missing" });
    expect((await rpc(server, "tools/call", { name: "echo", arguments: [1] })).error?.code).toBe(-32602);
    expect((await rpc(server, "tools/call", {})).error?.code).toBe(-32602);
    expect((await rpc(server, "resources/list", {})).error).toEqual({ code: -32601, message: "Method not found: resources/list" });
    const parse = await post(server, "{not json");
    expect(parse.status).toBe(400);
    expect(await parse.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    const invalid = await post(server, { id: 1, method: "ping" });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as Reply).error?.code).toBe(-32600);
    const version = await post(server, { jsonrpc: "2.0", id: 1, method: "ping" }, { ...JSON_HEADERS, "MCP-Protocol-Version": "2000-01-01" });
    expect(version.status).toBe(400);
  });

  test("accepts notifications and client responses with 202, and batches", async () => {
    const server = await start();
    for (const message of [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 404 } },
      { jsonrpc: "2.0", id: 5, result: {} },
    ]) {
      const response = await post(server, message, STREAM_HEADERS);
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("");
    }
    const batch = await post(server, [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "b" } } },
    ], STREAM_HEADERS);
    expect(await batch.json()).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "b" }] } },
    ]);
    expect((await post(server, [{ jsonrpc: "2.0", method: "notifications/initialized" }])).status).toBe(202);
  });

  test("rejects other HTTP methods, a missing or wrong token, foreign hosts and origins", async () => {
    const server = await start();
    const host = `127.0.0.1:${server.port}`;
    const auth = { Authorization: `Bearer ${TOKEN}` };
    for (const method of ["GET", "DELETE"]) expect((await raw(server, method, { Host: host, ...auth })).status).toBe(405);
    const missing = await raw(server, "POST", { Host: host, "Content-Type": "application/json" }, '{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect(missing.status).toBe(401);
    expect(missing.headers["www-authenticate"]).toBe("Bearer");
    expect((await raw(server, "POST", { Host: host, Authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
    expect((await raw(server, "POST", { Host: host, Authorization: "Basic abc" })).status).toBe(401);
    expect((await raw(server, "POST", { Host: `evil.example:${server.port}`, ...auth })).status).toBe(403);
    expect((await raw(server, "POST", { Host: "127.0.0.1:1", ...auth })).status).toBe(403);
    expect((await raw(server, "POST", { Host: host, Origin: "http://evil.example", ...auth })).status).toBe(403);
    expect((await raw(server, "POST", { Host: host, Origin: `http://127.0.0.1:${server.port + 1}`, ...auth })).status).toBe(403);
    const ping = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    const local = await raw(server, "POST", { Host: `localhost:${server.port}`, Origin: `http://localhost:${server.port}`, "Content-Type": "application/json", ...auth }, ping);
    expect([local.status, JSON.parse(local.body)]).toEqual([200, { jsonrpc: "2.0", id: 1, result: {} }]);
    // Far past the limit, so the client is still writing when the 413 is sent; a reset must not replace it.
    expect((await raw(server, "POST", { Host: host, ...auth }, "x".repeat(64 * 1024 * 1024))).status).toBe(413);
  });

  test("rejects malformed request targets without taking down the server", async () => {
    const server = await start();
    for (const path of ["//", "http://["]) {
      // Bun 1.3's node:http client normalizes the target through fetch before sending it.
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      let data = "";
      const socket = connect(server.port, "127.0.0.1", () => {
        socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      });
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => { data += chunk; });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
      expect(await promise).toStartWith("HTTP/1.1 400 ");
    }
    expect((await rpc(server, "ping")).result).toEqual({});
  });

  test("aborts a call on notifications/cancelled", async () => {
    const { tool, started, ended } = waiting();
    const server = await start([tool]);
    const call = post(server, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "wait" } });
    const context = await started;
    expect(context.signal.aborted).toBe(false);
    const cancel = await post(server, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "user stopped it" } });
    expect(cancel.status).toBe(202);
    expect(await ended).toBe("user stopped it");
    expect(((await (await call).json()) as Reply).result).toEqual({ content: [{ type: "text", text: "aborted: user stopped it" }], isError: true });
  });

  test("a cancellation aborts only the call of the cancelling client's session", async () => {
    const first = waiting();
    const second = waiting();
    let calls = 0;
    const tool: McpTool = { ...first.tool, call: (args, context) => (calls++ === 0 ? first : second).tool.call(args, context) };
    const server = await start([tool]);
    const session = async () => {
      const response = await post(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      return { ...JSON_HEADERS, "Mcp-Session-Id": response.headers.get("mcp-session-id")! };
    };
    const [a, b] = [await session(), await session()];
    expect(a["Mcp-Session-Id"]).toBeString();
    expect(a["Mcp-Session-Id"]).not.toBe(b["Mcp-Session-Id"]);
    const callA = post(server, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "wait" } }, a);
    const contextA = await first.started;
    const callB = post(server, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "wait" } }, b);
    const contextB = await second.started;
    expect((await post(server, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "a stopped" } }, a)).status).toBe(202);
    expect(await first.ended).toBe("a stopped");
    expect(contextA.signal.aborted).toBe(true);
    expect(contextB.signal.aborted).toBe(false);
    await post(server, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "b stopped" } }, b);
    expect(await second.ended).toBe("b stopped");
    await Promise.all([callA, callB]);
  });

  // Bun 1.3's HTTP server never reports a client that disconnects after its request body was read (Node and Bun 1.4 do).
  test.skipIf(Bun.semver.order(Bun.version, "1.4.0") < 0)("aborts a call when its client disconnects", async () => {
    for (const headers of [STREAM_HEADERS, JSON_HEADERS]) {
      const { tool, started, ended } = waiting();
      const server = await start([tool]);
      const client = new AbortController();
      const call = post(server, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait" } }, headers, client.signal);
      await started;
      client.abort();
      await call.catch(() => undefined);
      expect(await ended).toBe("The MCP client disconnected");
    }
  });

  test("close ends open calls and connections", async () => {
    const { tool, started, ended } = waiting();
    const server = await start([tool]);
    const pending = post(server, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait" } }, STREAM_HEADERS)
      .then((response) => response.text()).catch(() => "");
    await started;
    await server.close();
    expect(await ended).toBe("The MCP server closed");
    await pending;
  });

  test("falls back to an ephemeral port when the requested one is taken", async () => {
    const first = await start();
    const lines: string[] = [];
    const second = await start([echo], first.port, (line) => lines.push(line));
    expect(second.port).not.toBe(first.port);
    expect(lines).toEqual([`MCP: port ${first.port} is taken; listening on an ephemeral port`]);
    expect((await rpc(second, "ping")).result).toEqual({});
    const port = second.port;
    await second.close();
    servers.splice(servers.indexOf(second), 1);
    const reused = await start([echo], port);
    expect(reused.port).toBe(port);
  });
});
