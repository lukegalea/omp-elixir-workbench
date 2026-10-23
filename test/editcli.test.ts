import { describe, test, expect } from "bun:test";
import { buildEditArgs, runEdit, type EditRequest, type EditCliDeps } from "../src/editcli.ts";
import type { ExecFn, ExecResult } from "../src/omp-types.ts";

function expectExecError(fn: () => unknown): string {
  try {
    fn();
    return "<no error>";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("buildEditArgs", () => {
  test("single replace with body uses --body-file placeholder", () => {
    const { argv, batchJson } = buildEditArgs({ op: "replace", target: "M/attributes/score", body: "attribute :score, :integer" });
    expect(argv).toEqual(["ash_agent.edit", "replace", "M/attributes/score", "--body-file", "<body-file>"]);
    expect(batchJson).toBeUndefined();
  });

  test("anchor + position flags", () => {
    const { argv } = buildEditArgs({ op: "insert-after", target: "M/actions/go", body: "x", anchor: "M/actions/stop", position: "before" });
    expect(argv).toEqual([
      "ash_agent.edit",
      "insert-after",
      "M/actions/go",
      "--body-file",
      "<body-file>",
      "--anchor",
      "M/actions/stop",
      "--position",
      "before",
    ]);
  });

  test("write appends digest handshake", () => {
    const { argv } = buildEditArgs({ op: "delete", target: "M/actions/x", write: true, expectedDigest: "abc" });
    expect(argv.slice(-3)).toEqual(["--write", "--expected-digest", "abc"]);
  });

  test("write without digest is refused pre-spawn", () => {
    const msg = expectExecError(() => buildEditArgs({ op: "delete", target: "M/actions/x", write: true }));
    expect(msg).toContain("digest handshake");
  });

  test("create goes through --batch with canonical op map", () => {
    const { argv, batchJson } = buildEditArgs({ op: "create", target: "M.Post/actions", body: "update :go do accept [] end", anchor: "M.Post/actions/stop", position: "after" });
    expect(argv).toEqual(["ash_agent.edit", "--batch", "<batch-file>"]);
    const ops = JSON.parse(batchJson!);
    expect(ops).toEqual([
      { op: "create_entity", section_path: "M.Post/actions", body: "update :go do accept [] end", anchor: "M.Post/actions/stop", position: "after" },
    ]);
  });

  test("batch maps ops to canonical names", () => {
    const { batchJson } = buildEditArgs({
      op: "batch",
      batch: [
        { op: "create", target: "M/actions", body: "b" },
        { op: "replace", target: "M/actions/a", body: "b2" },
        { op: "insert-before", target: "M/actions/b", body: "b3" },
        { op: "insert-after", target: "M/actions/c", body: "b4" },
        { op: "delete", target: "M/actions/d" },
      ],
    });
    expect(JSON.parse(batchJson!)).toEqual([
      { op: "create_entity", section_path: "M/actions", body: "b" },
      { op: "replace_entity_block", name_path: "M/actions/a", body: "b2" },
      { op: "insert_before_entity", name_path: "M/actions/b", body: "b3" },
      { op: "insert_after_entity", name_path: "M/actions/c", body: "b4" },
      { op: "safe_delete_entity", name_path: "M/actions/d" },
    ]);
  });

  test("nested batch refused", () => {
    const msg = expectExecError(() => buildEditArgs({ op: "batch", batch: [{ op: "batch", batch: [] }] }));
    expect(msg).toContain("nested batch");
  });

  test("empty batch refused", () => {
    const msg = expectExecError(() => buildEditArgs({ op: "batch" }));
    expect(msg).toContain("non-empty batch");
  });

  test("missing target refused", () => {
    const msg = expectExecError(() => buildEditArgs({ op: "replace" }));
    expect(msg).toContain("requires target");
  });
});

function fakeExec(responses: ExecResult[], calls: { command: string; args: string[]; options?: Record<string, unknown> }[]): ExecFn {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    return responses.shift() ?? { stdout: "{}", stderr: "", code: 0, killed: false };
  };
}

function memDeps(exec: ExecFn, files: Map<string, string>): EditCliDeps & { removed: Set<string> } {
  let n = 0;
  const removed = new Set<string>();
  return {
    exec,
    cwd: "/proj",
    removed,
    async writeTemp(content) {
      const p = `/tmp/exwb-test-${++n}`;
      files.set(p, content);
      return p;
    },
    async remove(p) {
      removed.add(p);
    },
  };
}

describe("runEdit", () => {
  test("spawns mix with temp body file, cleans up, parses JSON report", async () => {
    const calls: { command: string; args: string[]; options?: Record<string, unknown> }[] = [];
    const files = new Map<string, string>();
    const exec = fakeExec([{ stdout: JSON.stringify({ op: "replace_entity_block", file: "lib/m.ex", dry_run: true, current_digest: "d1" }), stderr: "", code: 0, killed: false }], calls);
    const mem = memDeps(exec, files);
    const res = await runEdit(mem, { op: "replace", target: "M/attributes/score", body: "attribute :score, :integer" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.report["current_digest"]).toBe("d1");
    expect(calls[0]!.command).toBe("mix");
    expect(calls[0]!.args[0]).toBe("ash_agent.edit");
    const bodyPath = calls[0]!.args[calls[0]!.args.indexOf("--body-file") + 1]!;
    expect(mem.removed.has(bodyPath)).toBe(true);
    expect(calls[0]!.options?.cwd).toBe("/proj");
  });

  test("batch content lands in the temp file", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const files = new Map<string, string>();
    const exec = fakeExec([{ stdout: "{}", stderr: "", code: 0, killed: false }], calls);
    await runEdit(memDeps(exec, files), { op: "batch", batch: [{ op: "create", target: "M/actions", body: "b" }] });
    const batchPath = calls[0]!.args[calls[0]!.args.indexOf("--batch") + 1]!;
    expect(JSON.parse(files.get(batchPath) ?? "[]")).toEqual([{ op: "create_entity", section_path: "M/actions", body: "b" }]);
  });

  test("non-JSON stdout falls back to raw text error", async () => {
    const files = new Map<string, string>();
    const exec = fakeExec([{ stdout: "Compiling 12 files (.ex)\nnoise", stderr: "", code: 0, killed: false }], []);
    const res = await runEdit(memDeps(exec, files), { op: "delete", target: "M/actions/x" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("non-JSON");
      expect(res.error).toContain("Compiling");
    }
  });

  test("contract violation reported without spawn", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const exec = fakeExec([], calls);
    const res = await runEdit(memDeps(exec, new Map()), { op: "delete", target: "M/actions/x", write: true });
    expect(res.ok).toBe(false);
    expect(calls.length).toBe(0);
    if (!res.ok) expect(res.error).toContain("digest handshake");
  });
});
