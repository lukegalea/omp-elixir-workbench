import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMixArgv, type ToolDeps } from "../src/tools.ts";

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

/** exec fake: `command -v <bin>` resolves per available set; anything else 1. */
function execWith(available: string[]) {
  return async (command: string, args: string[]) => {
    if (command === "bash" && args[0] === "-c" && (args[1] ?? "").startsWith("command -v ")) {
      const bin = (args[1] ?? "").slice("command -v ".length).trim();
      return available.includes(bin)
        ? { stdout: `/bin/${bin}`, stderr: "", code: 0, killed: false }
        : { stdout: "", stderr: "", code: 1, killed: false };
    }
    return { stdout: "", stderr: "", code: 1, killed: false };
  };
}

function depsWith(available: string[]): ToolDeps {
  return { exec: execWith(available) } as unknown as ToolDeps;
}

async function projectDir(files: { "devenv.nix"?: boolean; ".devenv"?: boolean }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mixargv-"));
  tmpDirs.push(dir);
  if (files["devenv.nix"]) await writeFile(join(dir, "devenv.nix"), "{ }\n");
  if (files[".devenv"]) await mkdir(join(dir, ".devenv"), { recursive: true });
  return dir;
}

describe("resolveMixArgv", () => {
  test("mix on PATH wins regardless of project shape", async () => {
    const dir = await projectDir({ "devenv.nix": true });
    const invocation = await resolveMixArgv(depsWith(["mix", "devenv"]), dir);
    expect(invocation.via).toBe("path");
    expect(invocation.argv).toEqual(["mix"]);
  });

  test("devenv project without PATH mix wraps in devenv shell", async () => {
    const dir = await projectDir({ "devenv.nix": true });
    const invocation = await resolveMixArgv(depsWith(["devenv"]), dir);
    expect(invocation.via).toBe("devenv");
    expect(invocation.argv).toEqual(["devenv", "shell", "--", "mix"]);
  });

  test(".devenv directory alone marks a devenv project", async () => {
    const dir = await projectDir({ ".devenv": true });
    const invocation = await resolveMixArgv(depsWith(["devenv"]), dir);
    expect(invocation.via).toBe("devenv");
    expect(invocation.argv).toEqual(["devenv", "shell", "--", "mix"]);
  });

  test("non-devenv project without PATH mix stays unresolved (bare mix, old failure shape)", async () => {
    const dir = await projectDir({});
    const invocation = await resolveMixArgv(depsWith(["devenv"]), dir);
    expect(invocation.via).toBe("unresolved");
    expect(invocation.argv).toEqual(["mix"]);
  });

  test("devenv binary missing keeps bare mix", async () => {
    const dir = await projectDir({ "devenv.nix": true });
    const invocation = await resolveMixArgv(depsWith([]), dir);
    expect(invocation.via).toBe("unresolved");
    expect(invocation.argv).toEqual(["mix"]);
  });
});
