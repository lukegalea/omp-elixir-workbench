import { describe, test, expect, afterAll } from "bun:test";
import { callTool, listTools, ping, rpc, rpcBody, PROTOCOL_VERSION } from "../src/daemon.ts";

let server: Bun.Server<never> | null = null;
let url = "";
const seen: { path: string; headers: Headers; body: unknown }[] = [];

afterAll(() => {
  server?.stop(true);
});

function startServer(handler: (body: unknown) => Response | { status: number; payload: unknown }): string {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body: unknown = await req.json();
      seen.push({ path: new URL(req.url).pathname, headers: req.headers, body });
      const res = handler(body);
      if (res instanceof Response) return res;
      return Response.json(res.payload, { status: res.status });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
  return url;
}

function toolResultEnvelope(value: unknown, isError = false): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(value) }], isError },
  });
}

describe("daemon rpc", () => {
  test("rpcBody produces JSON-RPC 2.0 envelope", () => {
    const body = JSON.parse(rpcBody("tools/call", { name: "t", arguments: {} }));
    expect(body["jsonrpc"]).toBe("2.0");
    expect(typeof body["id"]).toBe("number");
    expect(body["method"]).toBe("tools/call");
  });

  test("callTool parses content[0].text JSON and sends protocol headers", async () => {
    const u = startServer((body) => {
      expect((body as Record<string, unknown>)["method"]).toBe("tools/call");
      return toolResultEnvelope({ status: "ready", reloads: 3 });
    });
    const res = await callTool(fetch, u, "ash_daemon_status", {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ status: "ready", reloads: 3 });
    expect(seen[0]!.headers.get("content-type")).toContain("application/json");
    expect(seen[0]!.headers.get("MCP-Protocol-Version")).toBe(PROTOCOL_VERSION);
    const sent = seen[0]!.body as Record<string, unknown>;
    expect((sent["params"] as Record<string, unknown>)["name"]).toBe("ash_daemon_status");
  });

  test("isError: true -> structured error with parsed payload", async () => {
    const u = startServer(() => toolResultEnvelope({ error: "unknown_action", message: "nope", did_you_mean: ["dig"] }, true));
    const res = await callTool(fetch, u, "ash_describe", {});
    expect(res.ok).toBe(false);
    expect(!res.ok && "isError" in res && res.isError).toBe(true);
    if (!res.ok && "value" in res) {
      expect((res.value as Record<string, unknown>)["did_you_mean"]).toEqual(["dig"]);
    }
  });

  test('"is_error?" in payload -> structured error even without isError flag', async () => {
    const u = startServer(() => toolResultEnvelope({ "is_error?": true, message: "boom" }, false));
    const res = await callTool(fetch, u, "ash_edit", {});
    expect(res.ok).toBe(false);
    expect(!res.ok && "isError" in res && res.isError).toBe(true);
  });

  test("connection refused -> down, never throws", async () => {
    const res = await callTool(fetch, "http://127.0.0.1:9", "ash_daemon_status", {}, { timeoutMs: 2_000 });
    expect(res.ok).toBe(false);
    expect(!res.ok && "down" in res && res.down).toBe(true);
  });

  test("HTTP 500 -> error, not down", async () => {
    const u = startServer(() => ({ status: 500, payload: { error: "kaboom" } }));
    const res = await rpc(fetch, u, "ping", {});
    expect(res.ok).toBe(false);
    expect(!res.ok && "down" in res && res.down).toBeFalsy();
    expect(!res.ok && "httpStatus" in res && res.httpStatus).toBe(500);
  });

  test("JSON-RPC error envelope -> error with message", async () => {
    const u = startServer(() => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } }));
    const res = await rpc(fetch, u, "tools/call", {});
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain("-32602");
    expect(!res.ok && res.error).toContain("bad params");
  });

  test("listTools extracts tool names", async () => {
    const u = startServer(() =>
      Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "ash_describe" }, { name: "ash_search" }] } }),
    );
    const res = await listTools(fetch, u);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tools).toEqual(["ash_describe", "ash_search"]);
  });

  test("ping returns true when daemon answers", async () => {
    const u = startServer(() => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    expect(await ping(fetch, u)).toBe(true);
  });

  test("ping false when daemon unreachable", async () => {
    expect(await ping(fetch, "http://127.0.0.1:9", { timeoutMs: 2_000 })).toBe(false);
  });

  test("non-JSON payload is passed through as raw text value", async () => {
    const u = startServer(() =>
      Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "plain prose" }], isError: false } }),
    );
    const res = await callTool(fetch, u, "x", {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe("plain prose");
  });
});
