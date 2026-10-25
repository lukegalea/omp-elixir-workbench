// Verification ladder: fast (iron-laws on the working-tree diff), focused
// (compile + mapped tests + laws), complete (format/compile/credo/test/laws
// or the project's configured argv). Evidence carries the git digest so the
// session-stop gate can match it against the current tree.

import { basename } from "node:path";
import { asNumber, asRecord, asString, asRecordArray } from "./json.ts";
import type { ExecFn } from "./omp-types.ts";
import { gitDigest, type SourceDigest } from "./freshness.ts";
import type { WorkbenchConfig } from "./config.ts";
import type { EvidenceRecord } from "./state.ts";

export type CheckLevel = "fast" | "focused" | "complete";
export type CheckStatus = "passed" | "failed" | "not_run";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  summary: string;
  /** why a check did not run (informational, no risk). */
  reason?: string;
  /** set when a skipped check leaves coverage unproven (blocks `passed`). */
  risk?: string;
}

export interface ChecksReport {
  sourceDigest: SourceDigest;
  checks: CheckResult[];
  remainingRisks: string[];
  passed: boolean;
}

export interface CheckDeps {
  exec: ExecFn;
  cwd: string;
  /**
   * How to run mix here: ["mix"] when it is on PATH, ["devenv","shell","--","mix"]
   * for devenv projects on a host without devenv activated. Every ladder stage
   * must go through it or the run dies on PATH alone.
   */
  mixArgv(): Promise<string[]>;
  /** test/**\/<base>_test.exs candidates for one changed lib module. */
  findTestCandidates(base: string): Promise<string[]>;
  fileExists(p: string): Promise<boolean>;
  config: WorkbenchConfig;
}

const SUMMARY_LIMIT = 400;

function summarize(execRes: { stdout: string; stderr: string }): string {
  const err = execRes.stderr.trim();
  const out = execRes.stdout.trim();
  const text = err.length > 0 ? `${err}\n${out}` : out;
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text;
}

async function runCommand(
  deps: CheckDeps,
  name: string,
  command: string,
  args: string[],
  timeoutMs = 600_000,
): Promise<CheckResult> {
  try {
    const res = await deps.exec(command, args, { cwd: deps.cwd, timeout: timeoutMs });
    if (res.code === 0) {
      const out = res.stdout.trim();
      return { name, status: "passed", summary: out.length > SUMMARY_LIMIT ? `${out.slice(0, SUMMARY_LIMIT)}…` : out };
    }
    return { name, status: "failed", summary: summarize(res) };
  } catch (err) {
    return { name, status: "failed", summary: `spawn failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The one sanctioned `bash -c`: fixed string, cwd = repo root. */
const LAWS_DIFF_PIPELINE = (mixArgv: string[]): string =>
  `git diff HEAD | ${mixArgv.join(" ")} ash_agent.laws - --diff`;

async function lawsCheck(deps: CheckDeps): Promise<CheckResult> {
  let diffEmpty: boolean;
  try {
    const diff = await deps.exec("git", ["diff", "HEAD"], { cwd: deps.cwd, timeout: 10_000 });
    if (diff.code !== 0) {
      return { name: "iron-laws (diff)", status: "not_run", summary: "", reason: "git diff HEAD failed; cannot judge" };
    }
    diffEmpty = diff.stdout.trim().length === 0;
  } catch {
    return { name: "iron-laws (diff)", status: "not_run", summary: "", reason: "git unavailable" };
  }
  if (diffEmpty) {
    return { name: "iron-laws (diff)", status: "not_run", summary: "", reason: "no working-tree diff" };
  }
  const mixArgv = await deps.mixArgv();
  const res = await runCommand(deps, "iron-laws (diff)", "bash", ["-c", LAWS_DIFF_PIPELINE(mixArgv)]);
  if (res.status === "failed") {
    const violations = parseLawsViolations(res.summary);
    if (violations !== undefined) {
      res.summary = `${violations} iron-law violation(s) in added diff lines; ${res.summary.slice(0, SUMMARY_LIMIT - 50)}`;
    }
  }
  return res;
}

function parseLawsViolations(summary: string): number | undefined {
  // Best-effort: the laws task prints {"violations":[...]} JSON; fall back to text.
  const start = summary.indexOf("{");
  if (start === -1) return undefined;
  try {
    const rec = asRecord(JSON.parse(summary.slice(start)));
    const violations = rec ? rec["violations"] : undefined;
    if (Array.isArray(violations)) return violations.length;
  } catch {
    // not JSON in the excerpt
  }
  return undefined;
}

/** changed lib Elixir module paths from git status (covers modified + untracked). */
export async function changedLibModules(deps: CheckDeps): Promise<string[]> {
  try {
    const res = await deps.exec("git", ["status", "--porcelain"], { cwd: deps.cwd, timeout: 10_000 });
    if (res.code !== 0) return [];
    const paths: string[] = [];
    for (const line of res.stdout.split("\n")) {
      if (line.trim().length === 0) continue;
      // "XY <path>" or "XY <old> -> <new>"
      const body = line.slice(3);
      const path = body.includes(" -> ") ? body.split(" -> ")[1]! : body;
      if (path.startsWith("lib/") && path.endsWith(".ex")) paths.push(path);
    }
    return paths;
  } catch {
    return [];
  }
}

async function focusedTestsCheck(deps: CheckDeps): Promise<CheckResult> {
  const changed = await changedLibModules(deps);
  if (changed.length === 0) {
    return { name: "focused tests", status: "not_run", summary: "", reason: "no changed lib modules" };
  }
  const candidates: string[] = [];
  for (const path of changed) {
    const base = basename(path).replace(/\.ex$/, "");
    const found = await deps.findTestCandidates(`${base}_test.exs`);
    candidates.push(...found);
  }
  const unique = [...new Set(candidates)].slice(0, 5);
  if (unique.length === 0) {
    return {
      name: "focused tests",
      status: "not_run",
      summary: "",
      reason: "no test files derived for changed lib modules",
      risk: `no test files derived for changed lib modules: ${changed.slice(0, 5).join(", ")}`,
    };
  }
  const argv = await deps.mixArgv();
  return runCommand(deps, "focused tests", argv[0]!, [...argv.slice(1), "test", ...unique], 900_000);
}

function completeCommands(deps: CheckDeps, mixArgv: string[]): Array<{ name: string; command: string; args: string[] }> {
  const configured = deps.config.checks.complete;
  if (configured && configured.length > 0) {
    return configured.map((check) => ({ name: check.name, command: check.argv[0]!, args: check.argv.slice(1) }));
  }
  const mix = (args: string[]) => ({ command: mixArgv[0]!, args: [...mixArgv.slice(1), ...args] });
  return [
    { name: "format", ...mix(["format", "--check-formatted"]) },
    { name: "compile", ...mix(["compile", "--warnings-as-errors"]) },
  ];
}

export async function runChecks(level: CheckLevel, deps: CheckDeps): Promise<ChecksReport> {
  const sourceDigest = await gitDigest(deps.exec, deps.cwd);
  const checks: CheckResult[] = [];

  if (level === "fast") {
    checks.push(await lawsCheck(deps));
  } else if (level === "focused") {
    const argv = await deps.mixArgv();
    checks.push(await runCommand(deps, "compile", argv[0]!, [...argv.slice(1), "compile", "--warnings-as-errors"]));
    checks.push(await focusedTestsCheck(deps));
    checks.push(await lawsCheck(deps));
  } else {
    const argv = await deps.mixArgv();
    const mixRun = (name: string, args: string[], timeoutMs?: number) =>
      runCommand(deps, name, argv[0]!, [...argv.slice(1), ...args], timeoutMs);
    const configured = deps.config.checks.complete;
    if (configured && configured.length > 0) {
      for (const cmd of completeCommands(deps, argv)) {
        checks.push(await runCommand(deps, cmd.name, cmd.command, cmd.args));
      }
    } else {
      checks.push(await mixRun("format", ["format", "--check-formatted"]));
      checks.push(await mixRun("compile", ["compile", "--warnings-as-errors"]));
      if (await deps.fileExists(`${deps.cwd}/.credo.exs`)) {
        checks.push(await mixRun("credo", ["credo", "--strict"]));
      }
      checks.push(await mixRun("test", ["test"], 1_200_000));
    }
    checks.push(await lawsCheck(deps));
  }

  const remainingRisks = checks.filter((c) => c.risk).map((c) => c.risk!);
  const passed = checks.every((c) => c.status === "passed" || (c.status === "not_run" && c.risk === undefined));
  return { sourceDigest, checks, remainingRisks, passed };
}

/** Defensive parse of a persisted/round-tripped evidence record. */
export function parseEvidence(data: unknown): EvidenceRecord | null {
  const rec = asRecord(data);
  if (!rec) return null;
  const ts = asNumber(rec["ts"]);
  const level = rec["level"];
  const head = asString(rec["head"]);
  if (ts === undefined || head === undefined) return null;
  if (level !== "fast" && level !== "focused" && level !== "complete") return null;
  const dirtyCount = asNumber(rec["dirtyCount"]);
  return {
    ts,
    level,
    passed: rec["passed"] === true,
    head,
    dirtyCount: dirtyCount === undefined ? null : dirtyCount,
    checks: asRecordArray(rec["checks"]),
    remainingRisks: Array.isArray(rec["remainingRisks"])
      ? rec["remainingRisks"].filter((r): r is string => typeof r === "string")
      : [],
  };
}
