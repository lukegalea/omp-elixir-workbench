// Minimal vendored type surface for the oh-my-pi extension API.
// Only the shapes this plugin uses; `@oh-my-pi/pi-coding-agent` types are not
// npm-installable here, so this file is the compile-time contract.
// `bun test` is the blocking gate; `tsc --noEmit` (advisory) checks against these.

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type ExecOptions = {
  cwd?: string;
  timeout?: number; // ms
  signal?: AbortSignal;
};

export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export interface ExtensionUIContext {
  notify(message: string, level?: "info" | "warn" | "error"): unknown;
  [key: string]: unknown;
}

export interface BranchEntry {
  type: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SessionManagerLike {
  getSessionId?(): string | undefined;
  getBranch?(): BranchEntry[];
}

export interface ToolEventCtx {
  ui?: ExtensionUIContext;
  cwd: string;
  sessionManager?: SessionManagerLike;
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
  agent?: { kind: "main" | "sub"; id?: string; name?: string; depth?: number };
  addAdditionalContext?(text: string): void;
  [key: string]: unknown;
}

export interface ToolCallEvent {
  toolName: string;
  input: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolResultEvent {
  toolName: string;
  isError?: boolean;
  [key: string]: unknown;
}

export interface SessionStopEvent {
  [key: string]: unknown;
}

export interface CompactingEvent {
  sessionId?: string;
  messages?: unknown[];
  [key: string]: unknown;
}

/** tool_call return: block / revise input / passive context. */
export interface ToolCallReturn {
  block?: boolean;
  reason?: string;
  input?: Record<string, unknown>;
  additionalContext?: string;
}

/** session_stop return: block decision or advisory continuation. */
export interface SessionStopReturn {
  decision?: "block";
  reason?: string;
  continue?: boolean;
  additionalContext?: string;
}

/** session.compacting return. */
export interface CompactingReturn {
  context?: string[];
  prompt?: string;
  preserveData?: Record<string, unknown>;
}

export type HookReturn =
  | ToolCallReturn
  | SessionStopReturn
  | CompactingReturn
  | void
  | undefined;

export interface AgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

export interface ToolDefinition<P = Record<string, unknown>> {
  name: string;
  label?: string;
  description: string;
  parameters: unknown; // pi.zod schema
  execute(
    toolCallId: string,
    params: P,
    signal: AbortSignal | undefined,
    onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
    ctx: ToolEventCtx,
  ): Promise<AgentToolResult>;
  hidden?: boolean;
  defaultInactive?: boolean;
  [key: string]: unknown;
}

export interface CommandContext extends ToolEventCtx {
  waitForIdle?(): Promise<void>;
  newSession?(...args: unknown[]): unknown;
  [key: string]: unknown;
}

export interface ExtensionAPI {
  on(
    event: string,
    handler: (event: unknown, ctx: ToolEventCtx) => Promise<HookReturn> | HookReturn,
  ): void;
  registerTool(def: ToolDefinition): void;
  registerCommand(
    name: string,
    cmd: {
      description?: string;
      handler: (args: string, ctx: CommandContext) => Promise<void> | void;
    },
  ): void;
  setLabel(label: string): void;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  appendEntry(customType: string, data: unknown): void | Promise<void>;
  zod: unknown;
  sendUserMessage?(content: string, opts?: Record<string, unknown>): Promise<void> | void;
  logger?: {
    info?(...args: unknown[]): void;
    warn?(...args: unknown[]): void;
    error?(...args: unknown[]): void;
  };
  [key: string]: unknown;
}
