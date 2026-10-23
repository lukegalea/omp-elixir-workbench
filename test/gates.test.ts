import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFile } from "../src/ashfile.ts";
import { dslSearchNudge, editNudge, shouldBlockSession, digestKey } from "../src/gates.ts";
import { StateStore, newState } from "../src/state.ts";
import { DEFAULT_CONFIG, type WorkbenchConfig } from "../src/config.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "exwb-gates-"));
  await mkdir(join(dir, "lib"), { recursive: true });
  await mkdir(join(dir, "test"), { recursive: true });
  await writeFile(
    join(dir, "lib", "ash_resource.ex"),
    "defmodule A do\n  use Ash.Resource,\n    domain: A,\n    extensions: []\nend\n",
  );
  await writeFile(
    join(dir, "lib", "platform_resource.ex"),
    "defmodule B do\n  use VendorpmKeystone.Platform.Resource\nend\n",
  );
  await writeFile(
    join(dir, "lib", "auth.ex"),
    "defmodule C do\n  use AshAuthentication, domain: C\nend\n",
  );
  await writeFile(join(dir, "lib", "plain.ex"), "defmodule M do\n  use GenServer\nend\n");
  await writeFile(join(dir, "test", "plain_test.exs"), "defmodule T do\n  use ExUnit.Case\nend\n");
  await writeFile(join(dir, "tpl.html.heex"), "<div>hello</div>");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function cfg(overrides: Partial<WorkbenchConfig> = {}): WorkbenchConfig {
  return { ...DEFAULT_CONFIG, checks: {}, ...overrides };
}

describe("classifyFile", () => {
  test("use Ash.Resource -> ash", async () => {
    const c = await classifyFile(join(dir, "lib", "ash_resource.ex"), dir);
    expect(c.kind).toBe("ash");
    expect(c.lowRisk).toBe(false);
  });

  test("use VendorpmKeystone.Platform.Resource -> ash", async () => {
    const c = await classifyFile(join(dir, "lib", "platform_resource.ex"), dir);
    expect(c.kind).toBe("ash");
  });

  test("use AshAuthentication -> ash", async () => {
    const c = await classifyFile(join(dir, "lib", "auth.ex"), dir);
    expect(c.kind).toBe("ash");
  });

  test("plain module -> elixir", async () => {
    const c = await classifyFile(join(dir, "lib", "plain.ex"), dir);
    expect(c.kind).toBe("elixir");
  });

  test("test file -> elixir low-risk", async () => {
    const c = await classifyFile(join(dir, "test", "plain_test.exs"), dir);
    expect(c.kind).toBe("elixir");
    expect(c.lowRisk).toBe(true);
  });

  test("non-elixir -> null", async () => {
    const c = await classifyFile(join(dir, "tpl.html.heex"), dir);
    expect(c.kind).toBeNull();
  });

  test("outside cwd -> null", async () => {
    const c = await classifyFile("/etc/hostname", dir);
    expect(c.kind).toBeNull();
  });
});

describe("dslSearchNudge", () => {
  test("fires on DSL marker in grep pattern", () => {
    const d = dslSearchNudge("grep", { pattern: "actions do", path: "lib" });
    expect(d).not.toBeNull();
    expect(d!.additionalContext).toContain("ash_inspect");
  });

  test("fires on use Ash.Resource in find query", () => {
    expect(dslSearchNudge("find", { query: "use Ash.Resource", grep_keywords: [] })).not.toBeNull();
  });

  test("no fire on ordinary pattern", () => {
    expect(dslSearchNudge("grep", { pattern: "handle_event" })).toBeNull();
  });

  test("no fire on unrelated tool", () => {
    expect(dslSearchNudge("bash", { command: "grep 'actions do' lib" })).toBeNull();
  });
});

describe("editNudge", () => {
  const ashFile = { kind: "ash" as const, absPath: "/x/lib/a.ex", relPath: "lib/a.ex", lowRisk: false };
  const elixirFile = { kind: "elixir" as const, absPath: "/x/lib/b.ex", relPath: "lib/b.ex", lowRisk: false };
  const testFile = { kind: "elixir" as const, absPath: "/x/test/b_test.exs", relPath: "test/b_test.exs", lowRisk: true };

  test("ash file with no recent ash usage -> nudge", () => {
    const d = editNudge({ toolName: "edit", state: newState(), config: cfg(), classified: ashFile });
    expect(d?.action).toBe("nudge");
    expect(d?.action === "nudge" && d.additionalContext).toContain("ash_edit");
  });

  test("ash file with recent ash MCP usage -> null (substring match)", () => {
    const state = newState();
    state.recentTools = ["bash", "mcp__ash_agent_ash_describe"];
    expect(editNudge({ toolName: "edit", state, config: cfg(), classified: ashFile })).toBeNull();
  });

  test("editGate block -> block decision on ash file", () => {
    const d = editNudge({ toolName: "write", state: newState(), config: cfg({ editGate: "block" }), classified: ashFile });
    expect(d?.action).toBe("block");
  });

  test("editGate off -> null", () => {
    expect(
      editNudge({ toolName: "edit", state: newState(), config: cfg({ editGate: "off" }), classified: ashFile }),
    ).toBeNull();
  });

  test("lib elixir file without symbol tools -> lsp nudge", () => {
    const d = editNudge({ toolName: "edit", state: newState(), config: cfg(), classified: elixirFile });
    expect(d?.action).toBe("nudge");
    expect(d?.action === "nudge" && d.additionalContext).toContain("`lsp`");
  });

  test("lib elixir file with lsp usage -> null", () => {
    const state = newState();
    state.recentTools = ["lsp"];
    expect(editNudge({ toolName: "edit", state, config: cfg(), classified: elixirFile })).toBeNull();
  });

  test("serena route names serena", () => {
    const d = editNudge({ toolName: "edit", state: newState(), config: cfg({ symbolRoute: "serena" }), classified: elixirFile });
    expect(d?.action === "nudge" && d.additionalContext).toContain("serena");
  });

  test("test files never nudged", () => {
    expect(editNudge({ toolName: "write", state: newState(), config: cfg(), classified: testFile })).toBeNull();
  });

  test("non-edit tools ignored", () => {
    expect(editNudge({ toolName: "bash", state: newState(), config: cfg(), classified: ashFile })).toBeNull();
  });
});

describe("shouldBlockSession", () => {
  const digest = { head: "aaa", dirtyCount: 1 };

  test("no edits -> null", () => {
    expect(shouldBlockSession(newState(), digest, cfg())).toBeNull();
  });

  test("edits without evidence -> block", () => {
    const s = newState();
    s.elixirEdits = true;
    const d = shouldBlockSession(s, digest, cfg());
    expect(d?.action).toBe("block");
    expect(d?.action === "block" && d.reason).toContain("ex_check");
  });

  test("fast-level evidence does not satisfy", () => {
    const s = newState();
    s.elixirEdits = true;
    s.latestEvidence = { ts: 100, level: "fast", passed: true, head: "aaa", dirtyCount: 1, checks: [], remainingRisks: [] };
    expect(shouldBlockSession(s, digest, cfg())?.action).toBe("block");
  });

  test("focused evidence for same head+dirty+after last edit -> null", () => {
    const s = newState();
    s.elixirEdits = true;
    s.lastEditTs = 50;
    s.latestEvidence = { ts: 100, level: "focused", passed: true, head: "aaa", dirtyCount: 1, checks: [], remainingRisks: [] };
    expect(shouldBlockSession(s, digest, cfg())).toBeNull();
  });

  test("head mismatch -> block", () => {
    const s = newState();
    s.elixirEdits = true;
    s.latestEvidence = { ts: 100, level: "focused", passed: true, head: "bbb", dirtyCount: 1, checks: [], remainingRisks: [] };
    expect(shouldBlockSession(s, digest, cfg())?.action).toBe("block");
  });

  test("dirtyCount mismatch -> block", () => {
    const s = newState();
    s.elixirEdits = true;
    s.latestEvidence = { ts: 100, level: "focused", passed: true, head: "aaa", dirtyCount: 2, checks: [], remainingRisks: [] };
    expect(shouldBlockSession(s, digest, cfg())?.action).toBe("block");
  });

  test("evidence before last edit -> block", () => {
    const s = newState();
    s.elixirEdits = true;
    s.lastEditTs = 150;
    s.latestEvidence = { ts: 100, level: "complete", passed: true, head: "aaa", dirtyCount: 1, checks: [], remainingRisks: [] };
    expect(shouldBlockSession(s, digest, cfg())?.action).toBe("block");
  });

  test("failed evidence -> block", () => {
    const s = newState();
    s.elixirEdits = true;
    s.latestEvidence = { ts: 100, level: "complete", passed: false, head: "aaa", dirtyCount: 1, checks: [], remainingRisks: [] };
    expect(shouldBlockSession(s, digest, cfg())?.action).toBe("block");
  });

  test("gate off -> null", () => {
    const s = newState();
    s.elixirEdits = true;
    expect(shouldBlockSession(s, digest, cfg({ sessionGate: false }))).toBeNull();
  });

  test("third block for same digest downgrades to advisory", () => {
    const s = newState();
    s.elixirEdits = true;
    const store = new StateStore();
    store.noteBlock("s1", digestKey(digest));
    store.noteBlock("s1", digestKey(digest));
    const st = store.get("s1");
    st.ashEdits = true;
    const d = shouldBlockSession(st, digest, cfg());
    expect(d?.action).toBe("continue");
  });

  test("new digest resets the block counter", () => {
    const store = new StateStore();
    store.noteBlock("s1", digestKey({ head: "aaa", dirtyCount: 1 }));
    store.noteBlock("s1", digestKey({ head: "aaa", dirtyCount: 1 }));
    const st = store.get("s1");
    st.elixirEdits = true;
    const d = shouldBlockSession(st, { head: "bbb", dirtyCount: 1 }, cfg());
    expect(d?.action).toBe("block");
  });
});
