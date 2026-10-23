// JSON-RPC 2.0 client for the ash_agent_tools MCP daemon
// (POST-only, stateless, loopback). Structured results, never raw throws:
// unreachable daemon -> {ok:false, down:true}.

import { asRecord, asString } from "./json.ts";

export type FetchImpl = typeof fetch;

export interface RpcOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type RpcResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; down: true; error: string }
  | { ok: false; down?: false; error: string; httpStatus?: number };

export type ToolCallResult =
  | { ok: true; value: unknown; raw: string }
  | { ok: false; down: true; error: string }
  | { ok: false; isError: true; error: string; value?: unknown };

export const PROTOCOL_VERSION = "2025-03-26";

let nextId = 1;

export function rpcBody(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params !== undefined ? { params } : {}) });
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return `timeout: ${err.message}`;
    // Bun/undici wrap ECONNREFUSED in a TypeError with an Error cause.
    let causeMsg = "";
    if ("cause" in err) {
      const cause: unknown = err.cause;
      if (cause instanceof Error) causeMsg = ` (${cause.message})`;
    }
    return `${err.message}${causeMsg}`;
  }
  return String(err);
}

export async function rpc(
  fetchImpl: FetchImpl,
  url: string,
  method: string,
  params: unknown,
  opts: RpcOptions = {},
): Promise<RpcResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    opts.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([opts.signal, timeoutSignal]) : (opts.signal ?? timeoutSignal);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
      },
      body: rpcBody(method, params),
      signal,
    });
  } catch (err) {
    return { ok: false, down: true, error: describeFetchError(err) };
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      // body unreadable; status alone is the answer
    }
    return { ok: false, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}`, httpStatus: response.status };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    return { ok: false, error: `non-JSON response: ${describeFetchError(err)}` };
  }
  const envelope = asRecord(payload);
  if (!envelope) return { ok: false, error: "response is not a JSON object" };

  const errorField = asRecord(envelope["error"]);
  if (errorField) {
    const code = errorField["code"];
    const codeStr = code === undefined ? "?" : typeof code === "string" ? code : String(code);
    const message = typeof errorField["message"] === "string" ? errorField["message"] : "unknown";
    return { ok: false, error: `JSON-RPC error ${codeStr}: ${message}` };
  }
  const result = asRecord(envelope["result"]);
  if (!result) return { ok: false, error: "response missing result object" };
  return { ok: true, result };
}

/** tools/list -> the daemon's tool names. */
export async function listTools(
  fetchImpl: FetchImpl,
  url: string,
  opts: RpcOptions = {},
): Promise<{ ok: true; tools: string[] } | { ok: false; down: true; error: string } | { ok: false; error: string }> {
  const res = await rpc(fetchImpl, url, "tools/list", {}, opts);
  if (!res.ok) {
    return res.down ? { ok: false, down: true, error: res.error } : { ok: false, error: res.error };
  }
  const cards = Array.isArray(res.result["tools"]) ? res.result["tools"] : [];
  const tools: string[] = [];
  for (const card of cards) {
    const rec = asRecord(card);
    const name = rec ? asString(rec["name"]) : undefined;
    if (name) tools.push(name);
  }
  return { ok: true, tools };
}

/** tools/call with content[0].text JSON parsing; isError / "is_error?" -> structured error. */
export async function callTool(
  fetchImpl: FetchImpl,
  url: string,
  tool: string,
  args: Record<string, unknown>,
  opts: RpcOptions = {},
): Promise<ToolCallResult> {
  const res = await rpc(fetchImpl, url, "tools/call", { name: tool, arguments: args ?? {} }, opts);
  if (!res.ok) {
    return res.down ? { ok: false, down: true, error: res.error } : { ok: false, isError: true, error: res.error };
  }

  const isErrorFlag = res.result["isError"] === true;
  const contentBlocks = Array.isArray(res.result["content"]) ? res.result["content"] : [];
  const first = asRecord(contentBlocks[0]);
  const text = first && typeof first["text"] === "string" ? first["text"] : "";

  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // non-JSON text is a legitimate payload
  }
  const valueRec = asRecord(value);
  const structuredError = isErrorFlag || (valueRec !== null && valueRec["is_error?"] === true);
  if (structuredError) {
    const errMsg = valueRec ? (asString(valueRec["message"]) ?? asString(valueRec["error"]) ?? text) : text;
    return { ok: false, isError: true, error: errMsg, value };
  }
  return { ok: true, value, raw: text };
}

/** ash_daemon_status report (booted_at/compiled_at ISO strings, reloads, counts). */
export async function daemonStatus(
  fetchImpl: FetchImpl,
  url: string,
  opts: RpcOptions = {},
): Promise<ToolCallResult> {
  return callTool(fetchImpl, url, "ash_daemon_status", {}, opts);
}

/** 2s-class liveness probe. True only when the daemon answered ping. */
export async function ping(fetchImpl: FetchImpl, url: string, opts: RpcOptions = {}): Promise<boolean> {
  const res = await rpc(fetchImpl, url, "ping", {}, { timeoutMs: 2_000, ...opts });
  return res.ok;
}
