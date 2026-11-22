/** Limits on the private JSON channel between the trusted runner and its child. */
export const MAX_TOOL_INPUT_BYTES = 16 * 1024;
export const MAX_TOOL_REPLY_BYTES = 128 * 1024;
export const MAX_TRACE_BYTES = 64 * 1024;
export const MAX_INSPECTIONS = 16;

export type CodeTool = "observe" | "act";
export interface CodeProgram { readonly code: string; readonly language: "javascript" | "typescript" }

/**
 * Evaluation-only counters produced by the trusted guest instrumentation.
 *
 * These records travel over the private runner channel and are deliberately
 * not part of the public `run_code` result.  A branch's `taken`/`notTaken`
 * values describe the value observed by the instrumented condition.  For a
 * logical expression they describe the left-hand short-circuit decision; a
 * switch case records execution in `taken` because a selected case has no
 * boolean value of its own.
 */
export interface CodeModeBranchCounter {
  readonly id: number;
  readonly kind: "if" | "conditional" | "loop_condition" | "logical" | "switch_case";
  readonly operator?: "&&" | "||" | "??";
  readonly line: number;
  readonly column: number;
  readonly evaluations: number;
  readonly taken: number;
  readonly notTaken: number;
}

/** One execution count per loop body entry. */
export interface CodeModeLoopCounter {
  readonly id: number;
  readonly kind: "for" | "for_of" | "for_in" | "while" | "do";
  readonly line: number;
  readonly column: number;
  readonly iterations: number;
}

/**
 * Private, host-side control-flow evidence.  `fallback` means the original
 * source ran without AST rewriting (for example when TypeScript is absent in
 * a packaged runtime); `unsupported` keeps that limitation explicit.
 */
export interface CodeModeControlFlow {
  readonly status: "instrumented" | "fallback";
  readonly transformer: "typescript-ast" | "none";
  readonly branches: readonly CodeModeBranchCounter[];
  readonly loops: readonly CodeModeLoopCounter[];
  readonly unsupported: readonly string[];
  /** True only when the supported source has no dynamic control-flow nodes. */
  readonly fixedWrapper: boolean;
}

export interface CodeModeLimits {
  readonly timeoutMs: number;
  readonly memoryBytes: number;
  readonly maxCalls: number;
  readonly maxInspectBytes: number;
  /** Maximum bounded wait for one host observe/act call, including approval. */
  readonly toolWaitTimeoutMs?: number;
  /** Full run wall cap, including child startup and bounded host waits. */
  readonly overallTimeoutMs?: number;
}

export type StartMessage = CodeProgram & CodeModeLimits & {
  type: "start";
  /** Private host opt-in; never supplied by a public run_code argument. */
  evaluation?: boolean;
};
export type ReplyMessage = { type: "reply"; id: number; json: string };

/** Private child-to-runner message; never exposed through a public tool. */
export type TraceMessage = { type: "trace"; json: string };
