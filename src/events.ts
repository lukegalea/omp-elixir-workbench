// Event payload narrowing for host-dispatched hooks. Events arrive as
// unknown; every field read is validated here once.

import { asRecord, asString } from "./json.ts";

export interface ToolCallEventView {
  toolName: string;
  input: Record<string, unknown>;
}

export function asToolCallEvent(event: unknown): ToolCallEventView | null {
  const rec = asRecord(event);
  if (!rec) return null;
  const toolName = asString(rec["toolName"]);
  if (toolName === undefined) return null;
  const input = asRecord(rec["input"]) ?? {};
  return { toolName, input };
}

export interface ToolResultEventView {
  toolName: string;
  isError: boolean;
}

export function asToolResultEvent(event: unknown): ToolResultEventView | null {
  const rec = asRecord(event);
  if (!rec) return null;
  const toolName = asString(rec["toolName"]);
  if (toolName === undefined) return null;
  return { toolName, isError: rec["isError"] === true };
}

/** First editable path from edit/write/apply_patch input. */
export function editInputPath(input: Record<string, unknown>): string | undefined {
  const direct = asString(input["path"]);
  if (direct !== undefined) return direct;
  const paths = input["paths"];
  if (Array.isArray(paths)) {
    const first = paths[0];
    if (typeof first === "string") return first;
  }
  return undefined;
}
