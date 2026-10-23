// omp-elixir-workbench — Ash/Elixir coding-workflow enforcement for oh-my-pi.
// Routing gates + ash_agent_tools composition + verification evidence.
// Kill switch: OMP_EXWB_DISABLE (any non-empty value) registers nothing.

import { isDisabled, loadConfig, type WorkbenchConfig } from "./config.ts";
import { classifyFile, resolveAgainst } from "./ashfile.ts";
import { editInputPath, asToolCallEvent, asToolResultEvent } from "./events.ts";
import { dslSearchNudge, editNudge, shouldBlockSession, digestKey, ASH_TOOL_RE } from "./gates.ts";
import { gitDigest } from "./freshness.ts";
import { StateStore, sessionIdOf } from "./state.ts";
import { createToolDefinitions, type ToolDeps } from "./tools.ts";
import { ping } from "./daemon.ts";
import type {
  ExtensionAPI,
  ToolCallReturn,
  SessionStopReturn,
  CompactingReturn,
} from "./omp-types.ts";
import type { ZodLike } from "./zodlike.ts";

const DEFAULT_DAEMON_PORT = 4197;
const EDIT_TOOLS = ["edit", "write", "apply_patch"];

export default function ompElixirWorkbench(pi: ExtensionAPI): void {
  if (isDisabled(process.env)) return;

  pi.setLabel("Elixir/Ash Workbench");
  const zod = pi.zod as ZodLike; // host-provided zod-compatible builder; named boundary cast
  const store = new StateStore();
  const deps: ToolDeps = {
    fetchImpl: fetch,
    exec: (command, args, options) => pi.exec(command, args, options),
    env: process.env,
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
    getState: (sessionId) => store.get(sessionId),
  };

  async function configOf(cwd: string): Promise<WorkbenchConfig> {
    const loaded = await loadConfig(cwd, process.env, (p) => Bun.file(p).text());
    return loaded.config;
  }

  for (const def of createToolDefinitions(deps, zod)) {
    pi.registerTool(def);
  }

  // --- hooks -----------------------------------------------------------------

  pi.on("tool_call", async (event, ctx): Promise<ToolCallReturn | void> => {
    const view = asToolCallEvent(event);
    if (!view) return;
    const state = store.get(sessionIdOf(ctx));
    state.recentTools.push(view.toolName);
    while (state.recentTools.length > 15) state.recentTools.shift();

    const dsl = dslSearchNudge(view.toolName, view.input);
    if (dsl) return dsl;

    if (!EDIT_TOOLS.includes(view.toolName)) return;
    const pathArg = editInputPath(view.input);
    if (pathArg === undefined) return;
    const absPath = resolveAgainst(ctx.cwd, pathArg);
    const classified = await classifyFile(absPath, ctx.cwd);
    // tool_result events carry no input; remember the attempt for attribution.
    if (classified.kind !== null) state.pendingEditPath = absPath;
    const decision = editNudge({
      toolName: view.toolName,
      state,
      config: await configOf(ctx.cwd),
      classified,
    });
    if (!decision) return;
    if (decision.action === "block") return { block: true, reason: decision.reason };
    return { additionalContext: decision.additionalContext };
  });

  pi.on("tool_result", async (event, ctx): Promise<{ additionalContext: string } | void> => {
    const view = asToolResultEvent(event);
    if (!view) return;

    if (EDIT_TOOLS.includes(view.toolName)) {
      if (view.isError) return;
      const state = store.get(sessionIdOf(ctx));
      const attempted = state.pendingEditPath;
      state.pendingEditPath = undefined;
      if (attempted === undefined) return;
      const classified = await classifyFile(attempted, ctx.cwd);
      if (classified.kind !== null) {
        store.recordEdit(sessionIdOf(ctx), classified.relPath, classified.kind, Date.now());
      }
      return;
    }
    if (view.isError && ASH_TOOL_RE.test(view.toolName)) {
      return {
        additionalContext:
          "ash-agent daemon call failed — run `ex_doctor`; if the daemon is down start it with `/ash-daemon start` or `devenv run ash-agent` (separate VM from iex-server).",
      };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    store.restoreFromBranch(sessionIdOf(ctx), ctx.sessionManager?.getBranch?.() ?? []);
    const config = await configOf(ctx.cwd);
    const up = await ping(fetch, config.daemonUrl);
    if (!up && ctx.ui) ctx.ui.notify("ash-agent daemon down — /ex-doctor to diagnose, /ash-daemon to start", "warn");
  });

  pi.on("session_stop", async (_event, ctx): Promise<SessionStopReturn | void> => {
    const state = store.get(sessionIdOf(ctx));
    if (!state.ashEdits && !state.elixirEdits) return;
    const config = await configOf(ctx.cwd);
    const digest = await gitDigest(deps.exec, ctx.cwd);
    const decision = shouldBlockSession(state, digest, config);
    if (!decision) return;
    if (decision.action === "block") {
      store.noteBlock(sessionIdOf(ctx), digestKey(digest));
      return { decision: "block", reason: decision.reason };
    }
    return { continue: true, additionalContext: decision.additionalContext };
  });

  pi.on("session.compacting", async (_event, ctx): Promise<CompactingReturn | void> => {
    const state = store.get(sessionIdOf(ctx));
    if (!state.ashEdits && !state.elixirEdits && state.editedPaths.length === 0) return;
    return {
      context: [
        `Ash/Elixir workbench state: edited paths ${state.editedPaths.join(", ") || "none"}; ` +
          `verification evidence ${state.latestEvidence ? `${state.latestEvidence.level}@${state.latestEvidence.head.slice(0, 8)} passed=${state.latestEvidence.passed}` : "none"}; ` +
          `daemon freshness tracked via ash_daemon_status.`,
      ],
      preserveData: {
        editedPaths: [...state.editedPaths],
        evidence: state.latestEvidence,
        recentTools: [...state.recentTools],
      },
    };
  });

  // --- commands ----------------------------------------------------------------

  pi.registerCommand("ex-doctor", {
    description: "Elixir/Ash workbench whole-stack health",
    handler: async (_args, ctx) => {
      const config = await configOf(ctx.cwd);
      const up = await ping(fetch, config.daemonUrl);
      ctx.ui?.notify(
        up
          ? "ash-agent daemon: reachable"
          : "ash-agent daemon DOWN — run ex_doctor; start with /ash-daemon start or devenv run ash-agent",
        up ? "info" : "warn",
      );
    },
  });

  pi.registerCommand("ash-daemon", {
    description: "ash_agent_tools daemon control: start | status | stop",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] ?? "status";
      const config = await configOf(ctx.cwd);
      const port = extractPort(config.daemonUrl) ?? DEFAULT_DAEMON_PORT;
      if (sub === "start") {
        if (process.env["TMUX"]) {
          await deps.exec("tmux", ["new-session", "-d", "-s", "ash-agent", "-c", ctx.cwd, "mix", "ash_agent.serve", "--port", String(port)]);
          ctx.ui?.notify(`ash-agent daemon starting in tmux session 'ash-agent' on :${port}`, "info");
        } else {
          const logDir = `${process.env.HOME ?? "~"}/.cache/omp-elixir-workbench`;
          await deps.exec(
            "bash",
            ["-c", `mkdir -p ${logDir} && nohup mix ash_agent.serve --port ${port} >> ${logDir}/daemon-${port}.log 2>&1 &`],
            { cwd: ctx.cwd },
          );
          ctx.ui?.notify(`ash-agent daemon starting on :${port} (log ${logDir}/daemon-${port}.log)`, "info");
        }
        return;
      }
      if (sub === "stop") {
        await deps.exec("bash", ["-c", `pkill -f 'ash_agent.serve --port ${port}'`]);
        ctx.ui?.notify(`sent stop signal to ash-agent daemon on :${port}`, "info");
        return;
      }
      const up = await ping(fetch, config.daemonUrl);
      ctx.ui?.notify(
        up ? `ash-agent daemon reachable at ${config.daemonUrl}` : `ash-agent daemon DOWN at ${config.daemonUrl}`,
        up ? "info" : "warn",
      );
    },
  });
}

function extractPort(url: string): number | undefined {
  const match = /:(\d+)(?:\/|$)/.exec(url);
  return match ? Number(match[1]) : undefined;
}
