// Pure gate decisions. No side effects: functions return decisions; the
// hook layer applies state mutations (tool recording, block counting).

import type { ClassifiedFile } from "./ashfile.ts";
import type { WorkbenchConfig } from "./config.ts";
import type { SessionState } from "./state.ts";

export type CheckLevelGate = "fast" | "focused" | "complete";

/** Substring match over tool names — robust to mcp__server_tool prefixing. */
export const ASH_TOOL_RE =
  /ash_(describe|validate|can|search|context|forbidden|rules|transitions|process_graph|process_instance|processes|decisions|decision_evaluate|daemon_status|reload|inspect|edit)/;

export function hasAshToolUsage(recentTools: string[]): boolean {
  return recentTools.some((t) => ASH_TOOL_RE.test(t));
}

export function hasSymbolToolUsage(recentTools: string[]): boolean {
  return recentTools.some((t) => /lsp|serena/i.test(t) || ASH_TOOL_RE.test(t));
}

export function routeForFile(classified: ClassifiedFile): "ash" | "elixir" | null {
  return classified.kind;
}

// --- DSL search nudge -------------------------------------------------------

const DSL_MARKERS = [
  "actions do",
  "attributes do",
  "relationships do",
  "policies do",
  "calculations do",
  "aggregates do",
  "code_interface",
  "use Ash.Resource",
  "use Ash.Domain",
];

const SEARCH_TOOLS = new Set(["grep", "find", "glob", "read"]);

/** String args worth scanning for DSL markers. */
function markerCandidates(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const item of v) if (typeof item === "string") out.push(item);
  };
  push(input["pattern"]);
  push(input["query"]);
  push(input["path"]);
  push(input["paths"]);
  push(input["grep_keywords"]);
  return out;
}

export function dslSearchNudge(
  toolName: string,
  input: Record<string, unknown>,
): { additionalContext: string } | null {
  if (!SEARCH_TOOLS.has(toolName)) return null;
  const haystack = markerCandidates(input);
  const hit = DSL_MARKERS.some((marker) => haystack.some((s) => s.includes(marker)));
  if (!hit) return null;
  return {
    additionalContext:
      "This is an Ash DSL question — call `ash_inspect` (or `ash_search`) instead of text search: grep cannot see transformer-injected declarations or the compiled contract.",
  };
}

// --- Edit gate ---------------------------------------------------------------

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"]);

export type EditGateDecision =
  | { action: "nudge"; additionalContext: string }
  | { action: "block"; reason: string }
  | null;

export interface EditNudgeInput {
  toolName: string;
  state: SessionState;
  config: WorkbenchConfig;
  classified: ClassifiedFile;
}

export function editNudge(input: EditNudgeInput): EditGateDecision {
  const { toolName, state, config, classified } = input;
  if (!EDIT_TOOLS.has(toolName)) return null;
  if (classified.kind === null || classified.lowRisk) return null;
  if (config.editGate === "off") return null;

  if (classified.kind === "ash") {
    if (hasAshToolUsage(state.recentTools)) return null;
    const message =
      `Ash DSL file \`${classified.relPath}\` — consult the compiled contract first: call ` +
      "`ash_inspect`" +
      ` on the resource you are touching, and use ` +
      "`ash_edit`" +
      " for entity-level changes (dry-run → digest → write with a post-edit gate).";
    if (config.editGate === "block") return { action: "block", reason: message };
    return { action: "nudge", additionalContext: message };
  }

  // elixir branch: symbol tools before editing lib/ modules
  if (!classified.relPath.startsWith("lib/")) return null;
  if (hasSymbolToolUsage(state.recentTools)) return null;
  const symbolHint =
    config.symbolRoute === "serena"
      ? "serena `find_symbol` / `find_referencing_symbols`"
      : "the `lsp` tool (definition/references/symbols)";
  return {
    action: "nudge",
    additionalContext:
      `Editing \`${classified.relPath}\` — check ${symbolHint} for the symbol you're touching before editing.`,
  };
}

// --- Session-stop completion gate --------------------------------------------

export interface SessionDigest {
  head: string;
  dirtyCount: number | null;
}

export type SessionStopDecision =
  | { action: "block"; reason: string }
  | { action: "continue"; additionalContext: string }
  | null;

export function digestKey(digest: SessionDigest): string {
  return `${digest.head}:${String(digest.dirtyCount)}`;
}

function evidenceMatches(
  state: SessionState,
  currentDigest: SessionDigest,
): boolean {
  const ev = state.latestEvidence;
  if (!ev) return false;
  return (
    ev.passed === true &&
    (ev.level === "focused" || ev.level === "complete") &&
    ev.head === currentDigest.head &&
    ev.dirtyCount === currentDigest.dirtyCount &&
    ev.ts >= state.lastEditTs
  );
}

export function shouldBlockSession(
  state: SessionState,
  currentDigest: SessionDigest,
  config: WorkbenchConfig,
): SessionStopDecision {
  if (!config.sessionGate) return null;
  if (!state.ashEdits && !state.elixirEdits) return null;
  if (evidenceMatches(state, currentDigest)) return null;

  const key = digestKey(currentDigest);
  if (state.blockDigest === key && state.blockCount >= 2) {
    return {
      action: "continue",
      additionalContext:
        "Elixir/Ash files remain unverified (no matching ex_check evidence). Before yielding to the user, state explicitly what remains unverified.",
    };
  }
  return {
    action: "block",
    reason:
      "Elixir/Ash files were edited without recorded verification. Run `ex_check` (level `focused` or `complete`) or state explicitly what remains unverified.",
  };
}
