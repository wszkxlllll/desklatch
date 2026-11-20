/** Limits on the private JSON channel between the trusted runner and its child. */
export const MAX_TOOL_INPUT_BYTES = 16 * 1024;
export const MAX_TOOL_REPLY_BYTES = 128 * 1024;
export const MAX_INSPECTIONS = 16;

export type CodeTool = "observe" | "act";
export interface CodeProgram { readonly code: string; readonly language: "javascript" | "typescript" }

export interface CodeModeLimits {
  readonly timeoutMs: number;
  readonly memoryBytes: number;
  readonly maxCalls: number;
  readonly maxInspectBytes: number;
}

export type StartMessage = CodeProgram & CodeModeLimits & { type: "start" };
export type ReplyMessage = { type: "reply"; id: number; json: string };
