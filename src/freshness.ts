// Freshness envelope: git checkout state + newest Ash source mtime vs the
// daemon's compiled_at. Never fabricates: unreachable or git-less -> unknown.

import { asNumber, asRecord, asString } from "./json.ts";
import type { ExecFn, ExecResult } from "./omp-types.ts";
import { daemonStatus, type FetchImpl } from "./daemon.ts";

export type Freshness = "down" | "stale" | "current" | "unknown";

export interface FreshnessEnvelope {
  checkout: { head: string; dirtyCount: number | null };
  newestSourceMtime: number | null;
  daemon: { status?: string; bootedAt?: string; compiledAt?: string; reloads?: number } | null;
  freshness: Freshness;
  daemonError?: string;
  observedAt: string;
}

export interface FreshnessDeps {
  exec: ExecFn;
  fetchImpl: FetchImpl;
  /** newest mtime (ms) over Elixir sources under lib/ and config; null when none found. */
  scanNewestMtime(cwd: string): Promise<number | null>;
  now?: () => number;
}

export interface SourceDigest {
  head: string;
  dirtyCount: number | null;
}

/** git rev-parse HEAD + porcelain dirty count. head "unknown" / count null on git failure. */
export async function gitDigest(exec: ExecFn, cwd: string): Promise<SourceDigest> {
  let head = "unknown";
  let dirtyCount: number | null = null;
  try {
    const headRes: ExecResult = await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5_000 });
    if (headRes.code === 0) head = headRes.stdout.trim() || "unknown";
    const statusRes: ExecResult = await exec("git", ["status", "--porcelain"], { cwd, timeout: 5_000 });
    if (statusRes.code === 0) {
      dirtyCount = statusRes.stdout.split("\n").filter((line) => line.trim().length > 0).length;
    }
  } catch {
    // git absent or not a repo -> unknown/null
  }
  return { head, dirtyCount };
}

export function parseDaemonStatus(value: unknown): {
  status?: string;
  bootedAt?: string;
  compiledAt?: string;
  reloads?: number;
} {
  const rec = asRecord(value);
  if (!rec) return {};
  const reloads = asNumber(rec["reloads"]);
  return {
    status: asString(rec["status"]),
    bootedAt: asString(rec["booted_at"]),
    compiledAt: asString(rec["compiled_at"]),
    ...(reloads !== undefined ? { reloads } : {}),
  };
}

export function freshnessVerdict(newestSourceMtime: number | null, compiledAt: string | undefined): Freshness {
  if (compiledAt === undefined) return "unknown";
  const compiledMs = Date.parse(compiledAt);
  if (Number.isNaN(compiledMs)) return "unknown";
  if (newestSourceMtime !== null && newestSourceMtime > compiledMs) return "stale";
  return "current";
}

export async function buildEnvelope(
  deps: FreshnessDeps,
  cwd: string,
  daemonUrl: string,
): Promise<FreshnessEnvelope> {
  const observedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const [checkout, newestSourceMtime, statusRes] = await Promise.all([
    gitDigest(deps.exec, cwd),
    deps.scanNewestMtime(cwd).catch(() => null),
    daemonStatus(deps.fetchImpl, daemonUrl, { timeoutMs: 5_000 }),
  ]);

  if (!statusRes.ok) {
    if ("down" in statusRes && statusRes.down) {
      return { checkout, newestSourceMtime, daemon: null, freshness: "down", daemonError: statusRes.error, observedAt };
    }
    return { checkout, newestSourceMtime, daemon: null, freshness: "unknown", daemonError: statusRes.error, observedAt };
  }

  const daemon = parseDaemonStatus(statusRes.value);
  return {
    checkout,
    newestSourceMtime,
    daemon,
    freshness: freshnessVerdict(newestSourceMtime, daemon.compiledAt),
    observedAt,
  };
}

/** One-line summary for prefixing tool output. */
export function freshnessLine(env: FreshnessEnvelope): string {
  const dirty = env.checkout.dirtyCount === null ? "?" : String(env.checkout.dirtyCount);
  const head = env.checkout.head === "unknown" ? "unknown" : env.checkout.head.slice(0, 8);
  switch (env.freshness) {
    case "current":
      return `daemon current (HEAD ${head}, ${dirty} dirty, compiled ${env.daemon?.compiledAt ?? "?"})`;
    case "stale":
      return `daemon STALE — sources newer than compiled_at; run ash_reload (HEAD ${head}, ${dirty} dirty)`;
    case "down":
      return `daemon DOWN${env.daemonError ? `: ${env.daemonError}` : ""}`;
    default:
      return `daemon freshness unknown${env.daemonError ? `: ${env.daemonError}` : ""}`;
  }
}
