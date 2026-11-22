export const CODE_MODE_RESULT_HINTS = Object.freeze({
  readOnlyResult: "Call inspect(value) before returning to expose a read-only result.",
  oversizedObserve: "Observe reply exceeded the bridge limit; narrow by an observed role/container or exact name before requesting full data. Guest-side slicing is too late.",
});

export type CodeModeHint = (typeof CODE_MODE_RESULT_HINTS)[keyof typeof CODE_MODE_RESULT_HINTS];

export interface CodeModeHintInput {
  readonly status: "completed" | "stopped" | "failed";
  readonly code?: string;
  readonly calls: Readonly<Record<"observe" | "act", number>>;
  readonly inspections: readonly unknown[];
}

/** Return only fixed, non-sensitive hints for outcomes with clear recovery actions. */
export function codeModeResultHint(
  result: CodeModeHintInput,
  oversizedObserveReply: boolean,
): CodeModeHint | undefined {
  if (result.code === "tool_result_too_large" && oversizedObserveReply) {
    return CODE_MODE_RESULT_HINTS.oversizedObserve;
  }
  if (result.status === "completed" && result.calls.observe > 0 && result.calls.act === 0
    && result.inspections.length === 0) {
    return CODE_MODE_RESULT_HINTS.readOnlyResult;
  }
  return undefined;
}
