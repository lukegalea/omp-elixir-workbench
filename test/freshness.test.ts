import { describe, test, expect } from "bun:test";
import { buildEnvelope, freshnessVerdict, gitDigest, freshnessLine, parseDaemonStatus } from "../src/freshness.ts";
import type { ExecFn } from "../src/omp-types.ts";

function execFrom(results: Partial<Record<string, { stdout: string; code: number }>>): ExecFn {
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    const hit = results[key];
    if (!hit) throw new Error(`unexpected exec: ${key}`);
    return { stdout: hit.stdout, stderr: "", code: hit.code, killed: false };
  };
}

describe("gitDigest", () => {
  test("parses head and dirty count", async () => {
    const exec = execFrom({
      "git rev-parse HEAD": { stdout: "abc123\n", code: 0 },
      "git status --porcelain": { stdout: " M a.ex\n?? b.ex\n", code: 0 },
    });
    const digest = await gitDigest(exec, "/proj");
    expect(digest).toEqual({ head: "abc123", dirtyCount: 2 });
  });

  test("git-less checkout -> unknown/null", async () => {
    const exec = execFrom({});
    const digest = await gitDigest(exec, "/proj");
    expect(digest).toEqual({ head: "unknown", dirtyCount: null });
  });
});

describe("freshnessVerdict", () => {
  const compiled = "2026-10-23T19:04:47.900195Z";
  const compiledMs = Date.parse(compiled);

  test("source newer than compiled_at -> stale", () => {
    expect(freshnessVerdict(compiledMs + 1, compiled)).toBe("stale");
  });

  test("compiled after newest source -> current", () => {
    expect(freshnessVerdict(compiledMs - 1000, compiled)).toBe("current");
  });

  test("no source files -> current", () => {
    expect(freshnessVerdict(null, compiled)).toBe("current");
  });

  test("missing compiled_at -> unknown", () => {
    expect(freshnessVerdict(123, undefined)).toBe("unknown");
    expect(freshnessVerdict(123, "not a date")).toBe("unknown");
  });
});

describe("parseDaemonStatus", () => {
  test("extracts booted/compiled/reloads", () => {
    const parsed = parseDaemonStatus({ status: "ready", booted_at: "2026-10-23T17:01:43.960425Z", compiled_at: "2026-10-23T19:04:47.900195Z", reloads: 16, domain_count: 23 });
    expect(parsed.bootedAt).toBe("2026-10-23T17:01:43.960425Z");
    expect(parsed.compiledAt).toBe("2026-10-23T19:04:47.900195Z");
    expect(parsed.reloads).toBe(16);
    expect(parsed.status).toBe("ready");
  });

  test("non-object -> empty", () => {
    expect(parseDaemonStatus("nope").bootedAt).toBeUndefined();
  });
});

describe("buildEnvelope", () => {
  const execOk = execFrom({
    "git rev-parse HEAD": { stdout: "cafe\n", code: 0 },
    "git status --porcelain": { stdout: " M lib/x.ex\n", code: 0 },
  });

  // Minimal fetch stand-in: only ever returns a Response; no preconnect needed in tests.
  const fetchOk = (async (): Promise<Response> =>
    Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "ready", booted_at: "2026-10-23T17:00:00Z", compiled_at: "2026-10-23T19:04:47.900195Z", reloads: 4 }),
          },
        ],
        isError: false,
      },
    })) as unknown as typeof fetch;

  test("stale when newest source mtime after compiled_at", async () => {
    const env = await buildEnvelope({ exec: execOk, fetchImpl: fetchOk, scanNewestMtime: async () => Date.parse("2026-10-23T20:00:00Z"), now: () => 0 }, "/proj", "http://x");
    expect(env.freshness).toBe("stale");
    expect(env.checkout.head).toBe("cafe");
    expect(env.daemon?.reloads).toBe(4);
  });

  test("current when daemon compiled after last source change", async () => {
    const env = await buildEnvelope({ exec: execOk, fetchImpl: fetchOk, scanNewestMtime: async () => Date.parse("2026-10-23T18:00:00Z"), now: () => 0 }, "/proj", "http://x");
    expect(env.freshness).toBe("current");
  });

  test("daemon unreachable -> down, never fabricates", async () => {
    // Always-rejecting fetch stand-in for the unreachable-daemon path.
    const fetchFail = (async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const env = await buildEnvelope(
      { exec: execOk, fetchImpl: fetchFail, scanNewestMtime: async () => 1, now: () => 0 },
      "/proj",
      "http://x",
    );
    expect(env.freshness).toBe("down");
    expect(env.daemon).toBeNull();
  });

  test("freshnessLine renders verdicts", async () => {
    const stale = await buildEnvelope({ exec: execOk, fetchImpl: fetchOk, scanNewestMtime: async () => Date.parse("2026-10-23T20:00:00Z"), now: () => 0 }, "/proj", "http://x");
    expect(freshnessLine(stale)).toContain("STALE");
    expect(freshnessLine(stale)).toContain("ash_reload");
  });
});
