// `mix ash_agent.edit` wrapper: argv construction, JSON stdout parsing,
// digest-handshake enforcement, write serialization.
// Single ops: `edit OP NAME_PATH [--body-file F] [--anchor NP --position P] [--write --expected-digest D]`
// create/batch always go through `--batch FILE` with canonical op maps:
//   create_entity / replace_entity_block / insert_before_entity /
//   insert_after_entity / safe_delete_entity

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecFn } from "./omp-types.ts";

export type EditOpName = "replace" | "insert-before" | "insert-after" | "delete" | "create" | "batch";

export interface EditRequest {
  op: EditOpName;
  /** name path (single ops) or section path (create). */
  target?: string;
  body?: string;
  anchor?: string;
  position?: "before" | "after";
  /** sub-ops for op:"batch"; no nested batch. */
  batch?: EditRequest[];
  write?: boolean;
  expectedDigest?: string;
}

export interface EditCliDeps {
  exec: ExecFn;
  cwd: string;
  writeTemp(content: string): Promise<string>;
  remove(path: string): Promise<void>;
  tmpDir?(): string;
}

export type EditRunResult =
  | { ok: true; report: Record<string, unknown>; raw: string }
  | { ok: false; error: string; raw?: string; exitCode?: number };

const CANONICAL_OP: Record<Exclude<EditOpName, "batch">, string> = {
  replace: "replace_entity_block",
  "insert-before": "insert_before_entity",
  "insert-after": "insert_after_entity",
  delete: "safe_delete_entity",
  create: "create_entity",
};

function isSingleOp(op: EditOpName): op is Exclude<EditOpName, "create" | "batch"> {
  return op === "replace" || op === "insert-before" || op === "insert-after" || op === "delete";
}

/** Pure argv/batch-json construction; throws on contract violations before any spawn. */
export function buildEditArgs(req: EditRequest): { argv: string[]; batchJson?: string } {
  if (req.op === "batch") {
    const ops = req.batch ?? [];
    if (ops.length === 0) throw new Error("batch op requires a non-empty batch array");
    const maps = ops.map((sub) => {
      if (sub.op === "batch") throw new Error("nested batch ops are not supported");
      const map: Record<string, unknown> = { op: CANONICAL_OP[sub.op] };
      if (sub.op === "create") {
        if (!sub.target) throw new Error("create op requires target (section path)");
        map["section_path"] = sub.target;
      } else {
        if (!sub.target) throw new Error(`${sub.op} requires target (name path)`);
        map["name_path"] = sub.target;
      }
      if (sub.body !== undefined) map["body"] = sub.body;
      if (sub.anchor !== undefined) map["anchor"] = sub.anchor;
      if (sub.position !== undefined) map["position"] = sub.position;
      return map;
    });
    return { argv: ["ash_agent.edit", "--batch", "<batch-file>"], batchJson: JSON.stringify(maps) };
  }

  if (req.op === "create") {
    if (!req.target) throw new Error("create op requires target (section path)");
    const map: Record<string, unknown> = { op: "create_entity", section_path: req.target };
    if (req.body !== undefined) map["body"] = req.body;
    if (req.anchor !== undefined) map["anchor"] = req.anchor;
    if (req.position !== undefined) map["position"] = req.position;
    return { argv: ["ash_agent.edit", "--batch", "<batch-file>"], batchJson: JSON.stringify([map]) };
  }

  if (!isSingleOp(req.op)) throw new Error(`unsupported op ${String(req.op)}`);
  if (!req.target) throw new Error(`${req.op} requires target (name path)`);
  if (req.write && !req.expectedDigest) {
    throw new Error("write requires expectedDigest from a prior dry-run (digest handshake)");
  }

  const argv = ["ash_agent.edit", req.op, req.target];
  if (req.body !== undefined) argv.push("--body-file", "<body-file>");
  if (req.anchor !== undefined) argv.push("--anchor", req.anchor);
  if (req.position !== undefined) argv.push("--position", req.position);
  if (req.write) {
    argv.push("--write", "--expected-digest", req.expectedDigest ?? "");
  }
  return { argv };
}

/** Write serialization: one edit write in flight at a time, process-wide. */
let writeChain: Promise<unknown> = Promise.resolve();
function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

export const EDIT_DEFAULTS = { dryRunTimeoutMs: 180_000, writeTimeoutMs: 300_000 };

export async function runEdit(deps: EditCliDeps, req: EditRequest): Promise<EditRunResult> {
  let args: { argv: string[]; batchJson?: string };
  try {
    args = buildEditArgs(req);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const timeoutMs = req.write ? EDIT_DEFAULTS.writeTimeoutMs : EDIT_DEFAULTS.dryRunTimeoutMs;

  const spawn = async (argv: string[]): Promise<EditRunResult> => {
    let execRes;
    try {
      execRes = await deps.exec("mix", argv, { cwd: deps.cwd, timeout: timeoutMs });
    } catch (err) {
      return { ok: false, error: `mix spawn failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    // Pure-JSON stdout contract; cold-start compile noise can precede JSON,
    // so fall back to the raw text as the error payload.
    try {
      const parsed: unknown = JSON.parse(execRes.stdout);
      const rec = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      if (!rec) return { ok: false, error: "edit stdout was JSON but not an object", raw: execRes.stdout, exitCode: execRes.code };
      return { ok: true, report: rec, raw: execRes.stdout };
    } catch {
      const detail = execRes.stderr.trim().length > 0 ? execRes.stderr.trim() : execRes.stdout.trim();
      return { ok: false, error: `non-JSON output from ash_agent.edit (exit ${execRes.code}): ${detail.slice(0, 400)}`, raw: execRes.stdout, exitCode: execRes.code };
    }
  };

  const cleanup = (path: string): void => {
    deps.remove(path).catch(() => undefined);
  };

  if (args.batchJson !== undefined) {
    const run = async (): Promise<EditRunResult> => {
      let batchPath: string | undefined;
      try {
        batchPath = await deps.writeTemp(args.batchJson!);
        const argv = args.argv.map((a) => (a === "<batch-file>" ? batchPath! : a));
        const res = await spawn(argv);
        if (batchPath) cleanup(batchPath);
        return res;
      } catch (err) {
        if (batchPath) cleanup(batchPath);
        return { ok: false, error: `batch file setup failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    };
    return req.write ? enqueueWrite(run) : run();
  }

  if (req.body !== undefined) {
    const run = async (): Promise<EditRunResult> => {
      let bodyPath: string | undefined;
      try {
        bodyPath = await deps.writeTemp(req.body!);
        const argv = args.argv.map((a) => (a === "<body-file>" ? bodyPath! : a));
        const res = await spawn(argv);
        if (bodyPath) cleanup(bodyPath);
        return res;
      } catch (err) {
        if (bodyPath) cleanup(bodyPath);
        return { ok: false, error: `body file setup failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    };
    return req.write ? enqueueWrite(run) : run();
  }

  return spawn(args.argv);
}

export function defaultEditDeps(exec: ExecFn, cwd: string): EditCliDeps {
  return {
    exec,
    cwd,
    async writeTemp(content: string): Promise<string> {
      const path = join(tmpdir(), `omp-exwb-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
      await Bun.write(path, content);
      return path;
    },
    async remove(path: string): Promise<void> {
      await rm(path, { force: true });
    },
  };
}
