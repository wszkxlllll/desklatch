export const CODE_MODE_MAX_CALLS_DEFAULT = 16;
export const CODE_MODE_MAX_CALLS_MIN = 1;
export const CODE_MODE_MAX_CALLS_MAX = 48;

/**
 * Parse the operator-owned Code Mode budget. Undefined means "use the SDK
 * default"; a present malformed value fails before a host is opened.
 */
export function parseCodeModeMaxCallsEnvironment(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/u.test(value)) throw invalidCodeModeMaxCalls();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)
    || parsed < CODE_MODE_MAX_CALLS_MIN
    || parsed > CODE_MODE_MAX_CALLS_MAX) throw invalidCodeModeMaxCalls();
  return parsed;
}

function invalidCodeModeMaxCalls(): Error {
  return Object.assign(
    new Error("DESKLATCH_CODE_MODE_MAX_CALLS must be a base-10 integer from 1 to 48. Set a value in that range or unset it to use the default of 16."),
    { code: "invalid_code_mode_max_calls" },
  );
}
