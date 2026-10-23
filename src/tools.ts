// Agent-facing tools: ex_doctor, ash_inspect, ash_edit, ex_check.
// All share: mix-project guard, per-cwd config cache, structured details.

import { stat } from "node:fs/promises";
import { Glob } from "bun";
import { callTool, listTools, rpc, type FetchImpl, type ToolCallResult } from "./daemon.ts";
import { loadConfig, type WorkbenchConfig } from "./config.ts";
import { buildEnvelope, freshnessLine } from "./freshness.ts";
import { relTo } from "./ashfile.ts";
import { defaultEditDeps, runEdit, type EditRequest } from "./editcli.ts";
import { runChecks, type CheckLevel, type CheckDeps } from "./checks.ts";
import { EVIDENCE_CUSTOM_TYPE, type SessionState } from "./state.ts";
import { asRecord, asString, findLocation, findStringDeep, omitKeyDeep } from "./json.ts";
import type { ExecFn, ToolDefinition, ToolEventCtx, AgentToolResult } from "./omp-types.ts";
import type { ZodLike } from "./zodlike.ts";

export interface ToolDeps {
  fetchImpl: FetchImpl;
  exec: ExecFn;
  env: Record<string, string | undefined>;
  appendEntry(customType: string, data: unknown): void | Promise<void>;
  getState(sessionId: string): SessionState;
  now?(): number;
}

function text(content: string, details?: unknown, isError = false): AgentToolResult {
  const result: AgentToolResult = { content: [{ type: "text", text: content }] };
  if (details !== undefined) result.details = details;
  if (isError) result.isError = true;
  return result;
}

function sessionIdOf(ctx: ToolEventCtx): string {
  return ctx.sessionManager?.getSessionId?.() ?? "default";
}

// --- per-cwd caches (dynamic membership -> Map) ------------------------------

const mixProjectCache = new Map<string, boolean>();
const configCache = new Map<string, { config: WorkbenchConfig; warning?: string }>();

async function isMixProject(deps: ToolDeps, cwd: string): Promise<boolean> {
  const cached = mixProjectCache.get(cwd);
  if (cached !== undefined) return cached;
  let exists = false;
  try {
    exists = await Bun.file(`${cwd}/mix.exs`).exists();
  } catch {
    exists = false;
  }
  mixProjectCache.set(cwd, exists);
  return exists;
}

async function configFor(deps: ToolDeps, cwd: string): Promise<{ config: WorkbenchConfig; warning?: string }> {
  const cached = configCache.get(cwd);
  if (cached) return cached;
  const loaded = await loadConfig(cwd, deps.env, (p) => Bun.file(p).text());
  const entry = { config: loaded.config, warning: loaded.warning };
  configCache.set(cwd, entry);
  return entry;
}

const NOT_MIX_PROJECT: AgentToolResult = {
  content: [
    {
      type: "text",
      text: "not a Mix project (no mix.exs at the working directory) — the Elixir/Ash workbench tools only run inside an Elixir project.",
    },
  ],
  isError: true,
};

function failureOf(res: ToolCallResult): { error: string; value?: unknown; down: boolean } {
  if (res.ok) return { error: "unexpected success", down: false };
  if ("down" in res) return { error: res.error, down: true };
  return { error: res.error, value: res.value, down: false };
}

// --- shared helpers -----------------------------------------------------------

type InspectTarget =
  | { type: "path"; file: string; line?: number }
  | { type: "two-part"; module: string; leaf: string }
  | { type: "module"; module: string }
  | { type: "fragment"; query: string };

export function parseInspectTarget(target: string): InspectTarget {
  const trimmed = target.trim();
  const pathMatch = /^(.+\.exs?)(?::(\d+))?$/.exec(trimmed);
  if (pathMatch) {
    const line = pathMatch[2] !== undefined ? Number(pathMatch[2]) : undefined;
    return { type: "path", file: pathMatch[1]!, ...(line !== undefined && Number.isFinite(line) ? { line } : {}) };
  }
  const slashCount = (trimmed.match(/\//g) ?? []).length;
  if (slashCount >= 1) {
    const first = trimmed.indexOf("/");
    const last = trimmed.lastIndexOf("/");
    return { type: "two-part", module: trimmed.slice(0, first), leaf: trimmed.slice(last + 1) };
  }
  if (/^[A-Z][A-Za-z0-9_]*(\.[A-Z][A-Za-z0-9_]*)*$/.test(trimmed)) {
    return { type: "module", module: trimmed };
  }
  return { type: "fragment", query: trimmed };
}

function errorPayload(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? { raw: String(value) };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function commandOnPath(deps: ToolDeps, command: string): Promise<string | null> {
  try {
    const res = await deps.exec("bash", ["-c", `command -v ${command}`], { timeout: 5_000 });
    if (res.code === 0 && res.stdout.trim().length > 0) return res.stdout.trim();
  } catch {
    // exec unavailable
  }
  return null;
}

/** Newest mtime over Elixir sources under lib/ and config/ (cap 2000 entries). */
export async function scanNewestMtime(cwd: string): Promise<number | null> {
  let newest: number | null = null;
  let count = 0;
  for (const pattern of ["lib/**/*.ex", "lib/**/*.exs", "config/*.exs"]) {
    const glob = new Glob(pattern);
    for await (const rel of glob.scan({ cwd, onlyFiles: true, dot: false })) {
      if (++count > 2000) return newest;
      try {
        const s = await stat(`${cwd}/${rel}`);
        if (newest === null || s.mtimeMs > newest) newest = s.mtimeMs;
      } catch {
        // raced delete
      }
    }
  }
  return newest;
}

// --- ex_doctor -----------------------------------------------------------------

interface DoctorCheck {
  name: string;
  status: "ok" | "degraded" | "down";
  detail: string;
}

async function pingTidewave(deps: ToolDeps): Promise<DoctorCheck> {
  const res = await rpc(deps.fetchImpl, "http://localhost:4000/tidewave/mcp", "tools/list", {}, { timeoutMs: 2_000 });
  if (res.ok) {
    const cards = Array.isArray(res.result["tools"]) ? res.result["tools"] : [];
    return { name: "tidewave", status: "ok", detail: `reachable, ${cards.length} tools` };
  }
  const reason = "down" in res ? res.error : res.error;
  return {
    name: "tidewave",
    status: "degraded",
    detail: `unreachable (${reason}); expected when iex-server is not running`,
  };
}

export function makeExDoctor(deps: ToolDeps, zod: ZodLike): ToolDefinition {
  return {
    name: "ex_doctor",
    label: "Elixir Workbench Doctor",
    description:
      "Whole-stack health for Ash/Elixir work: ash_agent_tools daemon (reachability + tool count + freshness), tidewave, expert LSP binary, serena config, mix, ash_agent_tools dep. Never boots anything. Run this first when daemon-backed tools fail.",
    parameters: zod.object({ verbose: zod.boolean().optional() }),
    hidden: false,
    defaultInactive: false,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!(await isMixProject(deps, ctx.cwd))) return NOT_MIX_PROJECT;
      const { config, warning } = await configFor(deps, ctx.cwd);
      const checks: DoctorCheck[] = [];

      const toolsRes = await listTools(deps.fetchImpl, config.daemonUrl, { timeoutMs: 5_000 });
      if (toolsRes.ok) {
        const env = await buildEnvelope(
          { exec: deps.exec, fetchImpl: deps.fetchImpl, scanNewestMtime, now: deps.now },
          ctx.cwd,
          config.daemonUrl,
        );
        checks.push({
          name: "ash-agent daemon",
          status: env.freshness === "down" ? "down" : "ok",
          detail: `${toolsRes.tools.length} tools; ${freshnessLine(env)}; reloads=${env.daemon?.reloads ?? "?"}`,
        });
      } else {
        const failure = failureOf(toolsRes as ToolCallResult);
        checks.push({
          name: "ash-agent daemon",
          status: failure.down ? "down" : "degraded",
          detail: `unreachable at ${config.daemonUrl} (${failure.error}) — start with /ash-daemon start or devenv run ash-agent (separate VM from iex-server)`,
        });
      }

      checks.push(await pingTidewave(deps));

      const expertPath = await commandOnPath(deps, "expert");
      const expertDir = await isDirectory(`${ctx.cwd}/.expert`);
      checks.push({
        name: "expert LSP",
        status: expertPath ? "ok" : "down",
        detail: `${expertPath ?? "binary not on PATH"}; .expert/ dir ${expertDir ? "present" : "absent"}`,
      });

      let serenaConfigured = false;
      try {
        const mcpJson = asRecord(JSON.parse(await Bun.file(`${ctx.cwd}/.mcp.json`).text()));
        serenaConfigured = mcpJson !== null && "serena" in mcpJson;
      } catch {
        // no .mcp.json
      }
      checks.push({
        name: "serena",
        status: "ok",
        detail: serenaConfigured
          ? `configured in .mcp.json (symbolRoute=${config.symbolRoute})`
          : `not configured; symbolRoute=${config.symbolRoute} uses the native lsp tool`,
      });

      const mixPath = await commandOnPath(deps, "mix");
      checks.push({ name: "mix", status: mixPath ? "ok" : "down", detail: mixPath ?? "mix not on PATH (activate devenv)" });

      let hasDep = false;
      try {
        hasDep = (await Bun.file(`${ctx.cwd}/mix.exs`).text()).includes("ash_agent_tools");
      } catch {
        // unreadable mix.exs
      }
      checks.push({
        name: "ash_agent_tools dep",
        status: hasDep ? "ok" : "down",
        detail: hasDep ? "declared in mix.exs (edit CLI + daemon tools available)" : "not declared in mix.exs",
      });

      const lines = checks.map((c) => `${c.status.toUpperCase().padEnd(8)} ${c.name} — ${c.detail}`);
      if (warning !== undefined) lines.push(`WARN     ${warning}`);
      const anyDown = checks.some((c) => c.status === "down");
      const allOk = checks.every((c) => c.status === "ok");
      const headline = allOk ? "ex_doctor: all checks ok" : anyDown ? "ex_doctor: DOWN present (see lines)" : "ex_doctor: degraded (see lines)";
      return text(`${headline}\n${lines.join("\n")}`, { checks }, anyDown);
    },
  };
}

// --- ash_inspect ---------------------------------------------------------------

const INSPECT_TEXT_LIMIT = 24_000;

export function makeAshInspect(deps: ToolDeps, zod: ZodLike): ToolDefinition {
  return {
    name: "ash_inspect",
    label: "Ash Inspect",
    description:
      "Ask the ash_agent_tools daemon about the compiled Ash contract. Targets: `Module` (resource description), `Module/action` (action input contract), `path.ex:LINE` (Ash context at a source position), or a bare fragment (semantic symbol search). include: references / policies / legend. Read-only; answers with compiled truth incl. transformer-injected declarations.",
    parameters: zod.object({
      target: zod.string(),
      include: zod.enum(["references", "policies", "legend"]).array().optional(),
    }),
    hidden: false,
    defaultInactive: false,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!(await isMixProject(deps, ctx.cwd))) return NOT_MIX_PROJECT;
      const { config } = await configFor(deps, ctx.cwd);
      const url = config.daemonUrl;
      const p = params as { target: string; include?: string[] };
      const include = p.include ?? [];
      const parsed = parseInspectTarget(p.target);

      let primary: { ok: boolean; value?: unknown; error?: string; down: boolean };
      let resourceHint: string | undefined;
      let calls = 0;

      const runCall = async (tool: string, args: Record<string, unknown>): Promise<typeof primary> => {
        calls++;
        const res = await callTool(deps.fetchImpl, url, tool, args);
        if (res.ok) return { ok: true, value: res.value, down: false };
        const failure = failureOf(res);
        return { ok: false, error: failure.error, value: failure.value, down: failure.down };
      };

      if (parsed.type === "path") {
        const args: Record<string, unknown> = { file: parsed.file };
        if (parsed.line !== undefined) args["line"] = parsed.line;
        primary = await runCall("ash_context", args);
      } else if (parsed.type === "two-part") {
        resourceHint = parsed.module;
        const res = await runCall("ash_describe", { resource: parsed.module, action: parsed.leaf });
        if (res.ok) {
          primary = res;
        } else {
          // unknown-action: surface did_you_mean, fall back to search on the leaf
          const search = await runCall("ash_search", { query: parsed.leaf });
          primary = {
            ok: true,
            down: false,
            value: {
              note: `describe ${parsed.module}/${parsed.leaf} failed; showing search hits instead`,
              describe_error: res.error,
              describe_error_payload: res.value !== undefined ? errorPayload(res.value) : { error: res.error },
              search: search.ok ? search.value : { error: search.error },
            },
          };
        }
      } else if (parsed.type === "module") {
        resourceHint = parsed.module;
        primary = await runCall("ash_describe", { resource: parsed.module });
      } else {
        primary = await runCall("ash_search", { query: parsed.query });
      }

      if (!primary.ok) {
        const payload = primary.value !== undefined && primary.value !== null ? errorPayload(primary.value) : { error: primary.error };
        const detail = asString(payload["message"]) ?? asString(payload["error"]) ?? primary.error ?? "unknown error";
        const didYouMean = "did_you_mean" in payload ? `\ndid_you_mean: ${JSON.stringify(payload["did_you_mean"])}` : "";
        return text(
          `ash_inspect failed: ${detail}${didYouMean}${primary.down ? `\ndaemon appears DOWN — run ex_doctor; start with /ash-daemon start` : ""}`,
          { provider: `ash-agent-daemon@${url}`, payload, down: primary.down },
          true,
        );
      }

      const extras: Record<string, unknown> = {};
      if (include.includes("references")) {
        const loc = findLocation(primary.value);
        if (loc && calls < 3) {
          const args: Record<string, unknown> = { file: loc.file };
          if (loc.line !== undefined) args["line"] = loc.line;
          const res = await runCall("ash_context", args);
          extras["references"] = res.ok ? res.value : { error: res.error };
        } else {
          extras["references"] = { note: "no source location in the primary report" };
        }
      }
      if (include.includes("policies") && calls < 3) {
        const resource = resourceHint ?? findStringDeep(primary.value, ["module", "resource"]) ?? p.target.split("/")[0]!;
        const res = await runCall("ash_forbidden", { resource });
        extras["policies"] = res.ok ? res.value : { error: res.error };
      }

      let value: unknown = primary.value;
      if (!include.includes("legend")) value = omitKeyDeep(value, "~legend");
      if (Object.keys(extras).length > 0) value = { report: value, extras };

      const env = await buildEnvelope({ exec: deps.exec, fetchImpl: deps.fetchImpl, scanNewestMtime, now: deps.now }, ctx.cwd, url);
      const header = `provider: ash-agent-daemon@${url} | freshness: ${freshnessLine(env)}`;
      let body = JSON.stringify(value, null, 2);
      if (body.length > INSPECT_TEXT_LIMIT) body = `${body.slice(0, INSPECT_TEXT_LIMIT)}\n… truncated (${body.length} chars total)`;
      return text(`${header}\n${body}`, { target: p.target, freshness: env.freshness });
    },
  };
}

// --- ash_edit ------------------------------------------------------------------

export function makeAshEdit(deps: ToolDeps, zod: ZodLike): ToolDefinition {
  const opSchema = zod.object({
    op: zod.enum(["replace", "insert-before", "insert-after", "delete", "create"]),
    target: zod.string(),
    body: zod.string().optional(),
    anchor: zod.string().optional(),
    position: zod.enum(["before", "after"]).optional(),
  });
  return {
    name: "ash_edit",
    label: "Ash Edit",
    description:
      "Semantic edit of an Ash DSL entity via `mix ash_agent.edit` — the only write path for DSL entities. Ops: replace|insert-before|insert-after|delete NAME_PATH, create SECTION_PATH (body = full entity source), or batch (array of ops). Dry-run by default: returns the planned diff + shape digest. write:true requires expected_digest from the dry-run; a post-edit gate recompiles and auto-reverts on failure. Refuses transformer-injected (synthetic) entities.",
    parameters: zod.object({
      op: zod.enum(["replace", "insert-before", "insert-after", "delete", "create", "batch"]),
      target: zod.string(),
      body: zod.string().optional(),
      anchor: zod.string().optional(),
      position: zod.enum(["before", "after"]).optional(),
      batch: zod.array(opSchema).optional(),
      write: zod.boolean().optional(),
      expected_digest: zod.string().optional(),
    }),
    hidden: false,
    defaultInactive: false,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!(await isMixProject(deps, ctx.cwd))) return NOT_MIX_PROJECT;
      const p = params as {
        op: EditRequest["op"];
        target?: string;
        body?: string;
        anchor?: string;
        position?: "before" | "after";
        batch?: Array<{ op: EditRequest["op"]; target?: string; body?: string; anchor?: string; position?: "before" | "after" }>;
        write?: boolean;
        expected_digest?: string;
      };
      if (p.write === true && !p.expected_digest) {
        return text(
          "ash_edit: write:true requires expected_digest from a prior dry-run (digest handshake). Run the dry-run first, then repeat with write:true + expected_digest.",
          { error: "missing_expected_digest" },
          true,
        );
      }
      const req: EditRequest = {
        op: p.op,
        ...(p.target !== undefined ? { target: p.target } : {}),
        ...(p.body !== undefined ? { body: p.body } : {}),
        ...(p.anchor !== undefined ? { anchor: p.anchor } : {}),
        ...(p.position !== undefined ? { position: p.position } : {}),
        ...(p.batch !== undefined ? { batch: p.batch } : {}),
        ...(p.write !== undefined ? { write: p.write } : {}),
        ...(p.expected_digest !== undefined ? { expectedDigest: p.expected_digest } : {}),
      };
      const res = await runEdit(defaultEditDeps(deps.exec, ctx.cwd), req);
      if (!res.ok) {
        return text(`ash_edit failed: ${res.error}`, { error: res.error, exitCode: res.exitCode }, true);
      }
      const report = res.report;
      const isError = report["is_error?"] === true;
      const file = asString(report["file"]);
      if (!isError && p.write === true) {
        const state = deps.getState(sessionIdOf(ctx));
        state.ashEdits = true;
        state.lastEditTs = Math.max(state.lastEditTs, (deps.now ?? Date.now)());
        if (file) {
          const rel = relTo(ctx.cwd, file);
          if (rel && !state.editedPaths.includes(rel)) state.editedPaths.push(rel);
        }
      }
      const digest = asString(report["current_digest"]);
      const headline = isError
        ? "ash_edit error report:"
        : p.write
          ? "ash_edit applied (post-edit gate report below):"
          : "ash_edit dry-run (nothing written):";
      const note = !isError && !p.write && digest ? `\nTo apply: repeat with write:true and expected_digest:"${digest}".` : "";
      return text(`${headline}\n${JSON.stringify(report, null, 2)}${note}`, { report }, isError);
    },
  };
}

// --- ex_check --------------------------------------------------------------------

export function makeExCheck(deps: ToolDeps, zod: ZodLike): ToolDefinition {
  return {
    name: "ex_check",
    label: "Elixir Verification",
    description:
      "Verification ladder for Elixir/Ash edits. fast: iron-laws judge on the working-tree diff (seconds). focused: compile --warnings-as-errors + tests mapped from changed lib modules + laws. complete: format + compile + test + laws (or the project's configured checks, e.g. mix precommit). Records evidence consumed by the session-stop gate — run focused or complete after editing .ex files.",
    parameters: zod.object({
      level: zod.enum(["fast", "focused", "complete"]),
    }),
    hidden: false,
    defaultInactive: false,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!(await isMixProject(deps, ctx.cwd))) return NOT_MIX_PROJECT;
      const level = (params as { level: CheckLevel }).level;
      const { config } = await configFor(deps, ctx.cwd);
      const checkDeps: CheckDeps = {
        exec: deps.exec,
        cwd: ctx.cwd,
        config,
        fileExists,
        async findTestCandidates(base: string): Promise<string[]> {
          const found: string[] = [];
          const glob = new Glob(`test/**/${base}`);
          for await (const rel of glob.scan({ cwd: ctx.cwd, onlyFiles: true, dot: false })) found.push(rel);
          return found;
        },
      };
      const report = await runChecks(level, checkDeps);
      const evidence = {
        ts: (deps.now ?? Date.now)(),
        level,
        passed: report.passed,
        head: report.sourceDigest.head,
        dirtyCount: report.sourceDigest.dirtyCount,
        checks: report.checks,
        remainingRisks: report.remainingRisks,
      };
      deps.getState(sessionIdOf(ctx)).latestEvidence = evidence;
      await deps.appendEntry(EVIDENCE_CUSTOM_TYPE, evidence);

      const lines = report.checks.map((c) => {
        const suffix = c.status === "not_run" ? ` (${c.risk ? `risk: ${c.risk}` : c.reason ?? "skipped"})` : "";
        return `${c.status.toUpperCase().padEnd(8)} ${c.name}${suffix}`;
      });
      const headline = report.passed
        ? `ex_check ${level}: PASSED${report.remainingRisks.length > 0 ? " (with risks, see lines)" : ""}`
        : `ex_check ${level}: FAILED`;
      return text(
        `${headline}\nhead ${report.sourceDigest.head.slice(0, 8)}, dirty ${String(report.sourceDigest.dirtyCount)}\n${lines.join("\n")}`,
        { report, evidence },
        !report.passed,
      );
    },
  };
}

export function createToolDefinitions(deps: ToolDeps, zod: ZodLike): ToolDefinition[] {
  return [makeExDoctor(deps, zod), makeAshInspect(deps, zod), makeAshEdit(deps, zod), makeExCheck(deps, zod)];
}
