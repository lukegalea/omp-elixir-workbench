// Project configuration: <cwd>/.omp/ex-workbench.json over defaults,
// env overrides on top. Unknown keys ignored; malformed JSON -> defaults
// plus a warning surfaced by ex_doctor.

import { asRecord, asString } from "./json.ts";

export interface CompleteCheck {
  name: string;
  argv: string[];
}

export interface WorkbenchConfig {
  daemonUrl: string;
  symbolRoute: "lsp" | "serena";
  editGate: "nudge" | "block" | "off";
  sessionGate: boolean;
  usageLookback: number;
  checks: { complete?: CompleteCheck[] };
}

export type ConfigEnv = Record<string, string | undefined>;

export interface LoadedConfig {
  config: WorkbenchConfig;
  /** Set when the project file was malformed or a value was ignored. */
  warning?: string;
  usedProjectFile: boolean;
}

export const DEFAULT_CONFIG: WorkbenchConfig = {
  daemonUrl: "http://127.0.0.1:4197",
  symbolRoute: "lsp",
  editGate: "nudge",
  sessionGate: true,
  usageLookback: 15,
  // No default complete override: ex_check falls back to its built-in ladder
  // (format + compile [+credo] + test + laws). Projects override via
  // checks.complete, e.g. ["mix precommit"].
  checks: {},
};

export function isDisabled(env: ConfigEnv): boolean {
  const v = env["OMP_EXWB_DISABLE"];
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/** Accepts argv arrays or space-split strings: ["mix precommit"] -> one check. */
export function parseCompleteEntries(raw: unknown, warnings: string[]): CompleteCheck[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    warnings.push(`checks.complete must be an array, got ${typeof raw}; ignoring`);
    return undefined;
  }
  const out: CompleteCheck[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const argv = entry.trim().split(/\s+/).filter(Boolean);
      if (argv.length > 0) out.push({ name: entry, argv });
    } else if (Array.isArray(entry) && entry.every((w) => typeof w === "string")) {
      const argv: string[] = [];
      for (const w of entry) if (typeof w === "string") argv.push(w);
      if (argv.length > 0) out.push({ name: argv.join(" "), argv });
    } else {
      warnings.push(`checks.complete entry must be a string or string array; ignored`);
    }
  }
  return out;
}

function readProjectFile(parsed: unknown, config: WorkbenchConfig, warnings: string[]): void {
  const obj = asRecord(parsed);
  if (!obj) {
    warnings.push(".omp/ex-workbench.json must be a JSON object; using defaults");
    return;
  }
  if (typeof obj["daemonUrl"] === "string") config.daemonUrl = obj["daemonUrl"];
  if (obj["symbolRoute"] === "lsp" || obj["symbolRoute"] === "serena") {
    config.symbolRoute = obj["symbolRoute"];
  }
  if (obj["editGate"] === "nudge" || obj["editGate"] === "block" || obj["editGate"] === "off") {
    config.editGate = obj["editGate"];
  }
  if (typeof obj["sessionGate"] === "boolean") config.sessionGate = obj["sessionGate"];
  const lookback = obj["usageLookback"];
  if (typeof lookback === "number" && Number.isInteger(lookback) && lookback > 0) {
    config.usageLookback = lookback;
  }
  const checks = asRecord(obj["checks"]);
  if (checks) {
    const complete = parseCompleteEntries(checks["complete"], warnings);
    if (complete !== undefined) config.checks.complete = complete;
  }
}

export function loadConfigFromData(
  fileData: string | undefined,
  env: ConfigEnv,
  warnings: string[],
): WorkbenchConfig {
  const config: WorkbenchConfig = {
    daemonUrl: DEFAULT_CONFIG.daemonUrl,
    symbolRoute: DEFAULT_CONFIG.symbolRoute,
    editGate: DEFAULT_CONFIG.editGate,
    sessionGate: DEFAULT_CONFIG.sessionGate,
    usageLookback: DEFAULT_CONFIG.usageLookback,
    checks: {},
  };

  if (fileData !== undefined) {
    try {
      readProjectFile(JSON.parse(fileData), config, warnings);
    } catch (err) {
      warnings.push(`.omp/ex-workbench.json is malformed (${err instanceof Error ? err.message : String(err)}); using defaults`);
    }
  }

  // Environment overrides (highest precedence).
  const envUrl = env["OMP_EXWB_DAEMON_URL"];
  if (envUrl) {
    if (/^https?:\/\//.test(envUrl)) config.daemonUrl = envUrl;
    else warnings.push(`OMP_EXWB_DAEMON_URL must be an http(s) URL, got ${envUrl}; ignoring`);
  }
  const envRoute = asString(env["OMP_EXWB_SYMBOL_ROUTE"]);
  if (envRoute) {
    const r = envRoute.toLowerCase();
    if (r === "lsp" || r === "serena") config.symbolRoute = r;
    else warnings.push(`OMP_EXWB_SYMBOL_ROUTE must be lsp or serena, got ${envRoute}; ignoring`);
  }
  const envGate = asString(env["OMP_EXWB_EDIT_GATE"]);
  if (envGate) {
    const g = envGate.toLowerCase();
    if (g === "nudge" || g === "block" || g === "off") config.editGate = g;
    else warnings.push(`OMP_EXWB_EDIT_GATE must be nudge, block or off, got ${envGate}; ignoring`);
  }
  const envSessionGate = env["OMP_EXWB_SESSION_GATE"];
  if (envSessionGate !== undefined) {
    const v = envSessionGate.toLowerCase();
    config.sessionGate = !(v === "0" || v === "false" || v === "no" || v === "off");
  }

  return config;
}

export async function loadConfig(
  cwd: string,
  env: ConfigEnv,
  readFile: (path: string) => Promise<string>,
): Promise<LoadedConfig> {
  const warnings: string[] = [];
  const path = `${cwd}/.omp/ex-workbench.json`;
  let fileData: string | undefined;
  try {
    fileData = await readFile(path);
  } catch {
    fileData = undefined; // absent is normal
  }
  const config = loadConfigFromData(fileData, env, warnings);
  return { config, warning: warnings[0], usedProjectFile: fileData !== undefined };
}
