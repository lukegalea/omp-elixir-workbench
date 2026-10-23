import { describe, test, expect } from "bun:test";
import { runChecks, changedLibModules, parseEvidence, type CheckDeps, type CheckLevel } from "../src/checks.ts";
import { DEFAULT_CONFIG, type WorkbenchConfig } from "../src/config.ts";
import type { ExecFn, ExecResult } from "../src/omp-types.ts";

interface Call {
  command: string;
  args: string[];
}

function fakeExec(routes: Array<{ match: (command: string, args: string[]) => boolean; result: ExecResult }>): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (command, args) => {
    calls.push({ command, args });
    const hit = routes.find((r) => r.match(command, args));
    return hit ? hit.result : { stdout: "", stderr: "", code: 0, killed: false };
  };
  return { exec, calls };
}

const isGitDiff = (args: string[]) => args[0] === "diff" && args[1] === "HEAD";
const isGitStatus = (args: string[]) => args[0] === "status" && args[1] === "--porcelain";
const isLaws = (args: string[]) => args[0] === "-c" && (args[1] ?? "").includes("ash_agent.laws");

function deps(
  routes: Array<{ match: (command: string, args: string[]) => boolean; result: ExecResult }>,
  overrides: Partial<CheckDeps> = {},
  config: WorkbenchConfig = { ...DEFAULT_CONFIG, checks: {} },
): CheckDeps & { calls: Call[] } {
  const { exec, calls } = fakeExec(routes);
  return {
    exec,
    calls,
    cwd: "/proj",
    config,
    fileExists: async () => false,
    findTestCandidates: async () => [],
    ...overrides,
  };
}

const DIFF_NONEMPTY = { stdout: "diff --git a/lib/a.ex b/lib/a.ex", stderr: "", code: 0, killed: false };
const DIFF_EMPTY = { stdout: "", stderr: "", code: 0, killed: false };

describe("runChecks fast", () => {
  test("clean tree -> not_run without risk, level passes", async () => {
    const d = deps([
      { match: (c, a) => c === "git" && isGitDiff(a), result: DIFF_EMPTY },
      { match: (c, a) => c === "git" && isGitStatus(a), result: { stdout: "", stderr: "", code: 0, killed: false } },
    ]);
    const report = await runChecks("fast", d);
    expect(report.passed).toBe(true);
    expect(report.checks[0]!.status).toBe("not_run");
    expect(report.checks[0]!.reason).toBe("no working-tree diff");
    expect(report.remainingRisks).toEqual([]);
  });

  test("diff with violations -> failed", async () => {
    const d = deps([
      { match: (c, a) => c === "git" && isGitDiff(a), result: DIFF_NONEMPTY },
      {
        match: (c, a) => c === "bash" && isLaws(a),
        result: { stdout: JSON.stringify({ violations: [{ law: "10" }] }), stderr: "", code: 1, killed: false },
      },
    ]);
    const report = await runChecks("fast", d);
    expect(report.checks[0]!.status).toBe("failed");
    expect(report.passed).toBe(false);
    // the sanctioned bash -c one-liner, cwd = repo root
    const lawsCall = d.calls.find((c) => c.command === "bash")!;
    expect(lawsCall.args[1]).toBe("git diff HEAD | mix ash_agent.laws - --diff");
  });

  test("diff clean laws -> passed", async () => {
    const d = deps([
      { match: (c, a) => c === "git" && isGitDiff(a), result: DIFF_NONEMPTY },
      { match: (c, a) => c === "bash" && isLaws(a), result: { stdout: '{"violations":[]}', stderr: "", code: 0, killed: false } },
    ]);
    const report = await runChecks("fast", d);
    expect(report.checks[0]!.status).toBe("passed");
    expect(report.passed).toBe(true);
  });
});

describe("runChecks focused", () => {
  test("compile failure fails the level; tests not_run with risk when no candidates", async () => {
    const d = deps([
      { match: (c, a) => c === "git" && isGitStatus(a), result: { stdout: " M lib/a.ex\n?? lib/new.ex\n", stderr: "", code: 0, killed: false } },
      { match: (c, a) => c === "mix" && a[0] === "compile", result: { stdout: "", stderr: "error: something", code: 1, killed: false } },
      { match: (c, a) => c === "bash" && isLaws(a), result: { stdout: '{"violations":[]}', stderr: "", code: 0, killed: false } },
    ]);
    const report = await runChecks("focused", d);
    const compile = report.checks.find((c) => c.name === "compile")!;
    expect(compile.status).toBe("failed");
    expect(compile.summary).toContain("error: something");
    const tests = report.checks.find((c) => c.name === "focused tests")!;
    expect(tests.status).toBe("not_run");
    expect(tests.risk).toContain("no test files derived");
    expect(report.passed).toBe(false);
  });

  test("changed lib modules map to existing test files (capped)", async () => {
    const d = deps(
      [
        { match: (c, a) => c === "git" && isGitStatus(a), result: { stdout: " M lib/a.ex\n M lib/b.ex\n", stderr: "", code: 0, killed: false } },
        { match: (c, a) => c === "bash" && isLaws(a), result: { stdout: '{"violations":[]}', stderr: "", code: 0, killed: false } },
      ],
      {
        findTestCandidates: async (base) => [`test/a_test.exs`, `test/sub/${base}`],
      },
    );
    const report = await runChecks("focused", d);
    const tests = report.checks.find((c) => c.name === "focused tests")!;
    expect(tests.status).toBe("passed");
    const mixTest = d.calls.find((c) => c.command === "mix" && c.args[0] === "test")!;
    expect(mixTest.args).toContain("test/a_test.exs");
    expect(mixTest.args.length).toBeLessThanOrEqual(6); // "test" + up to 5 files
  });

  test("compile + tests + laws all green -> passed", async () => {
    const d = deps([
      { match: (c, a) => c === "git" && isGitStatus(a), result: { stdout: "", stderr: "", code: 0, killed: false } },
      { match: (c, a) => c === "mix" && a[0] === "compile", result: { stdout: "", stderr: "", code: 0, killed: false } },
      { match: (c, a) => c === "bash" && isLaws(a), result: { stdout: '{"violations":[]}', stderr: "", code: 0, killed: false } },
    ]);
    const report = await runChecks("focused", d);
    expect(report.passed).toBe(true);
  });
});

describe("runChecks complete", () => {
  test("configured complete overrides the default ladder", async () => {
    const config: WorkbenchConfig = {
      ...DEFAULT_CONFIG,
      checks: { complete: [{ name: "mix precommit", argv: ["mix", "precommit"] }] },
    };
    const d = deps(
      [
        { match: (c, a) => c === "mix" && a[0] === "precommit", result: { stdout: "precommit ok", stderr: "", code: 0, killed: false } },
        { match: (c, a) => c === "git" && isGitDiff(a), result: DIFF_EMPTY },
        { match: (c, a) => c === "git" && isGitStatus(a), result: { stdout: "", stderr: "", code: 0, killed: false } },
      ],
      {},
      config,
    );
    const report = await runChecks("complete", d);
    expect(report.checks.map((c) => c.name)).toEqual(["mix precommit", "iron-laws (diff)"]);
    expect(report.passed).toBe(true);
    expect(d.calls.some((c) => c.command === "mix" && c.args[0] === "precommit")).toBe(true);
  });

  test("default ladder runs format + compile + test + laws (credo only with config)", async () => {
    const d = deps(
      [
        { match: (c, a) => c === "git" && isGitDiff(a), result: DIFF_EMPTY },
        { match: (c, a) => c === "mix", result: { stdout: "", stderr: "", code: 0, killed: false } },
      ],
      { fileExists: async () => false },
    );
    const report = await runChecks("complete", d);
    expect(report.checks.map((c) => c.name)).toEqual(["format", "compile", "test", "iron-laws (diff)"]);
  });
});

describe("changedLibModules", () => {
  test("parses porcelain including untracked and renames", async () => {
    const d = deps([
      {
        match: (c, a) => c === "git" && isGitStatus(a),
        result: { stdout: " M lib/a.ex\n?? lib/new.ex\nR  lib/old.ex -> lib/renamed.ex\n M test/x_test.exs\n", stderr: "", code: 0, killed: false },
      },
    ]);
    const changed = await changedLibModules(d);
    expect(changed).toEqual(["lib/a.ex", "lib/new.ex", "lib/renamed.ex"]);
  });
});

describe("parseEvidence", () => {
  test("accepts well-shaped records, rejects garbage", () => {
    const good = { ts: 1, level: "focused", passed: true, head: "h", dirtyCount: 0, checks: [], remainingRisks: [] };
    expect(parseEvidence(good)?.level).toBe("focused");
    expect(parseEvidence({ ts: "x" })).toBeNull();
    expect(parseEvidence(null)).toBeNull();
    expect(parseEvidence({ ts: 1, level: "bogus", passed: true, head: "h" })).toBeNull();
  });
});

describe("check level routing", () => {
  test("unknown level excluded by type", () => {
    const levels: CheckLevel[] = ["fast", "focused", "complete"];
    expect(levels.length).toBe(3);
  });
});
