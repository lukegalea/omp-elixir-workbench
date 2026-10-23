import { describe, test, expect } from "bun:test";
import { loadConfig, loadConfigFromData, isDisabled, DEFAULT_CONFIG, parseCompleteEntries } from "../src/config.ts";

const FILE_OK = JSON.stringify({ daemonUrl: "http://127.0.0.1:9999", editGate: "block", usageLookback: 5 });
const ALWAYS_THROWS = async () => {
  throw new Error("absent");
};

describe("loadConfig", () => {
  test("file overrides defaults", async () => {
    const { config, warning, usedProjectFile } = await loadConfig("/proj", {}, async (p) => {
      expect(p).toBe("/proj/.omp/ex-workbench.json");
      return FILE_OK;
    });
    expect(usedProjectFile).toBe(true);
    expect(warning).toBeUndefined();
    expect(config.daemonUrl).toBe("http://127.0.0.1:9999");
    expect(config.editGate).toBe("block");
    expect(config.usageLookback).toBe(5);
    expect(config.sessionGate).toBe(true);
  });

  test("env overrides file", async () => {
    const { config } = await loadConfig(
      "/proj",
      { OMP_EXWB_DAEMON_URL: "http://127.0.0.1:7000", OMP_EXWB_EDIT_GATE: "off", OMP_EXWB_SESSION_GATE: "0", OMP_EXWB_SYMBOL_ROUTE: "serena" },
      async () => FILE_OK,
    );
    expect(config.daemonUrl).toBe("http://127.0.0.1:7000");
    expect(config.editGate).toBe("off");
    expect(config.sessionGate).toBe(false);
    expect(config.symbolRoute).toBe("serena");
  });

  test("absent file -> defaults, no warning", async () => {
    const { config, warning } = await loadConfig("/proj", {}, ALWAYS_THROWS);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warning).toBeUndefined();
  });

  test("malformed JSON -> defaults + warning", async () => {
    const { config, warning, usedProjectFile } = await loadConfig("/proj", {}, async () => "{not json");
    expect(usedProjectFile).toBe(true);
    expect(config.daemonUrl).toBe(DEFAULT_CONFIG.daemonUrl);
    expect(warning).toContain("malformed");
  });

  test("invalid env values warn and are ignored", async () => {
    const warnings: string[] = [];
    const cfg = loadConfigFromData(undefined, { OMP_EXWB_EDIT_GATE: "explode", OMP_EXWB_SYMBOL_ROUTE: "vim" }, warnings);
    expect(cfg.editGate).toBe("nudge");
    expect(cfg.symbolRoute).toBe("lsp");
    expect(warnings.length).toBe(2);
  });

  test("unknown keys ignored", async () => {
    const { config, warning } = await loadConfig("/proj", {}, async () => JSON.stringify({ wat: 1, editGate: "block" }));
    expect(warning).toBeUndefined();
    expect(config.editGate).toBe("block");
  });
});

describe("isDisabled", () => {
  test("kill switch values", () => {
    expect(isDisabled({ OMP_EXWB_DISABLE: "1" })).toBe(true);
    expect(isDisabled({ OMP_EXWB_DISABLE: "" })).toBe(false);
    expect(isDisabled({ OMP_EXWB_DISABLE: "0" })).toBe(false);
    expect(isDisabled({ OMP_EXWB_DISABLE: "false" })).toBe(false);
    expect(isDisabled({})).toBe(false);
  });
});

describe("parseCompleteEntries", () => {
  test("splits space-separated strings into argv", () => {
    const warnings: string[] = [];
    const entries = parseCompleteEntries(["mix precommit"], warnings);
    expect(entries).toEqual([{ name: "mix precommit", argv: ["mix", "precommit"] }]);
    expect(warnings).toEqual([]);
  });

  test("accepts argv arrays and multi-command lists", () => {
    const entries = parseCompleteEntries([["mix", "test"], "mix format --check-formatted"], []);
    expect(entries).toEqual([
      { name: "mix test", argv: ["mix", "test"] },
      { name: "mix format --check-formatted", argv: ["mix", "format", "--check-formatted"] },
    ]);
  });

  test("non-array warns", () => {
    const warnings: string[] = [];
    parseCompleteEntries("mix test", warnings);
    expect(warnings.length).toBe(1);
  });
});
