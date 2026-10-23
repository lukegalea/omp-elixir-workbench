// Per-session gate state, keyed by sessionId (module globals are shared
// across subagent bindings, so every factory binding must hit the same map).

import type { BranchEntry } from "./omp-types.ts";

export const EVIDENCE_CUSTOM_TYPE = "io.github.lukegalea.omp-elixir-workbench.evidence";

/** One ex_check run, persisted via appendEntry and matched by the stop gate. */
export interface EvidenceRecord {
  ts: number;
  level: "fast" | "focused" | "complete";
  passed: boolean;
  head: string;
  dirtyCount: number | null;
  checks: unknown[];
  remainingRisks: string[];
}

export interface SessionState {
  recentTools: string[];
  lastEditTs: number;
  ashEdits: boolean;
  elixirEdits: boolean;
  editedPaths: string[];
  blockCount: number;
  blockDigest: string | null;
  latestEvidence: EvidenceRecord | null;
  /** path of the in-flight edit/write/apply_patch attempt (tool_result attribution). */
  pendingEditPath?: string;
}

export function newState(): SessionState {
  return {
    recentTools: [],
    lastEditTs: 0,
    ashEdits: false,
    elixirEdits: false,
    editedPaths: [],
    blockCount: 0,
    blockDigest: null,
    latestEvidence: null,
  };
}

export class StateStore {
  private states = new Map<string, SessionState>();

  get(sessionId: string): SessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = newState();
      this.states.set(sessionId, state);
    }
    return state;
  }

  recordTool(sessionId: string, toolName: string, lookback: number): void {
    const state = this.get(sessionId);
    state.recentTools.push(toolName);
    while (state.recentTools.length > lookback) state.recentTools.shift();
  }

  recordEdit(sessionId: string, relPath: string, kind: "ash" | "elixir", ts: number): void {
    const state = this.get(sessionId);
    if (kind === "ash") state.ashEdits = true;
    else state.elixirEdits = true;
    if (!state.editedPaths.includes(relPath)) state.editedPaths.push(relPath);
    state.lastEditTs = Math.max(state.lastEditTs, ts);
  }

  recordEvidence(sessionId: string, evidence: EvidenceRecord): void {
    this.get(sessionId).latestEvidence = evidence;
  }

  noteBlock(sessionId: string, digestKey: string): void {
    const state = this.get(sessionId);
    if (state.blockDigest === digestKey) {
      state.blockCount += 1;
    } else {
      state.blockDigest = digestKey;
      state.blockCount = 1;
    }
  }

  /** Rebuild from persisted evidence entries; latest wins. */
  restoreFromBranch(sessionId: string, entries: BranchEntry[]): void {
    let latest: EvidenceRecord | null = null;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === EVIDENCE_CUSTOM_TYPE) {
        const candidate = entry["data"];
        if (isEvidenceShaped(candidate)) latest = candidate;
      }
    }
    if (latest) this.get(sessionId).latestEvidence = latest;
  }
}

export function isEvidenceShaped(data: unknown): data is EvidenceRecord {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const rec = data as Record<string, unknown>;
  return typeof rec["ts"] === "number" && typeof rec["passed"] === "boolean" && typeof rec["head"] === "string";
}

export function sessionIdOf(ctx: { sessionManager?: { getSessionId?(): string | undefined } }): string {
  return ctx.sessionManager?.getSessionId?.() ?? "default";
}
