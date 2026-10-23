// File classification for gate routing: Ash-declaring source vs plain Elixir
// vs irrelevant. Test trees are Elixir but low-risk (gates skip them).

import { open } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export type FileKind = "ash" | "elixir" | null;

export interface ClassifiedFile {
  kind: FileKind;
  absPath: string;
  /** cwd-relative path; "" when outside the project root. */
  relPath: string;
  lowRisk: boolean;
}

/** use Ash.Resource / use Ash.Domain / use VendorpmKeystone.Platform.Resource / use AshAuthentication ... */
const ASH_USE_PATTERNS: RegExp[] = [
  /^\s*use\s+[A-Z][A-Za-z0-9_.]*(Resource|Domain)\s*(,|$)/m,
  /^\s*use\s+Ash(Postgres|Authentication|Policy|Oban)?/m,
];

export function isElixirPath(p: string): boolean {
  return p.endsWith(".ex") || p.endsWith(".exs");
}

export function isTestPath(relPath: string): boolean {
  return relPath === "test" || relPath.startsWith("test/") || relPath.startsWith(`test${sep}`);
}

export function contentDeclaresAsh(content: string): boolean {
  return ASH_USE_PATTERNS.some((re) => re.test(content));
}

/** cwd-relative path, or "" when outside cwd. Accepts absolute or relative input. */
export function relTo(cwd: string, p: string): string {
  const abs = isAbsolute(p) ? p : `${cwd}/${p}`;
  const rel = relative(cwd, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return "";
  return rel.split(sep).join("/");
}

export function resolveAgainst(cwd: string, p: string): string {
  return isAbsolute(p) ? p : `${cwd}/${p}`;
}

/** First 8KB is enough to see the `use` line; avoids reading huge files whole. */
export async function readHeadDefault(p: string, bytes = 8192): Promise<string> {
  const fh = await open(p, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

export async function classifyFile(
  absPath: string,
  cwd: string,
  readHead: (p: string) => Promise<string> = readHeadDefault,
): Promise<ClassifiedFile> {
  const relPath = relTo(cwd, absPath);
  if (relPath === "") return { kind: null, absPath, relPath, lowRisk: false };
  if (!isElixirPath(relPath)) return { kind: null, absPath, relPath, lowRisk: false };
  // Test trees are low-risk Elixir regardless of content.
  if (isTestPath(relPath)) return { kind: "elixir", absPath, relPath, lowRisk: true };
  try {
    const head = await readHead(absPath);
    if (contentDeclaresAsh(head)) return { kind: "ash", absPath, relPath, lowRisk: false };
    return { kind: "elixir", absPath, relPath, lowRisk: false };
  } catch {
    // unreadable (deleted mid-flight, permissions): plain Elixir path shape
    return { kind: "elixir", absPath, relPath, lowRisk: false };
  }
}
