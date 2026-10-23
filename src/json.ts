// Validated narrowing helpers for external JSON (RPC payloads, config files,
// parsed CLI output). Every access to outside-controlled data goes through
// these — no unchecked inline casts.

/** object (not array, not null) -> record; else null. */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** array of objects -> records; non-object elements are skipped. */
export function asRecordArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of v) {
    const rec = asRecord(item);
    if (rec) out.push(rec);
  }
  return out;
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** first string value under any of the keys, walking nested records breadth-first. */
export function findStringDeep(value: unknown, keys: string[], maxDepth = 6): string | undefined {
  let frontier: unknown[] = [value];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of frontier) {
      const rec = asRecord(node);
      if (!rec) continue;
      for (const key of keys) {
        const v = rec[key];
        if (typeof v === "string") return v;
      }
      next.push(...Object.values(rec));
    }
    frontier = next;
  }
  return undefined;
}

/** first (file, line) pair found in a report (Spark annotations live on fields/actions). */
export function findLocation(
  value: unknown,
  maxDepth = 6,
): { file: string; line?: number } | undefined {
  let frontier: unknown[] = [value];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of frontier) {
      const rec = asRecord(node);
      if (!rec) continue;
      const file = asString(rec["file"]);
      if (file) return { file, line: asNumber(rec["line"]) };
      next.push(...Object.values(rec));
    }
    frontier = next;
  }
  return undefined;
}

/** recursively drop a key (e.g. "~legend") from parsed reports. */
export function omitKeyDeep(value: unknown, key: string): unknown {
  const rec = asRecord(value);
  if (rec) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k !== key) out[k] = omitKeyDeep(v, key);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => omitKeyDeep(item, key));
  return value;
}
