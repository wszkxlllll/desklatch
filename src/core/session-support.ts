import type { Capability } from "../contracts.js";

const SAFE_ADAPTER_CODES = new Set([
  "backend_refused", "invalid_delivery", "dispatch_unknown", "cancelled_before_dispatch", "target_changed", "material_target_changed", "stale", "partial",
  "unknown", "cancelled", "timeout", "closed", "target_occluded", "point_occluded", "occluded", "focus_changed", "target_unavailable",
  "action_refused_before_dispatch", "element_action_refused", "set_value_unavailable", "write_not_applied", "value_pattern_unavailable", "value_unavailable", "value_read_only_state_unavailable",
  "target_not_verified", "background_target_unavailable", "background_target_not_verified", "stale_observation",
  "stale_origin", "stale_point", "stale_snapshot", "point_outside_target", "invalid_window_point",
  "window_scope_unverified", "pointer_focus_changed", "pointer_focus_unverified",
  "window_point_gesture_unavailable", "window_point_input_busy", "window_point_display_changed",
  "window_point_recipient_changed", "window_point_partial", "window_point_not_queued",
  "window_point_delivery_unknown", "window_point_geometry_unavailable",
  "grid_commit_binding_action_mismatch", "grid_commit_proof_expired", "grid_commit_foreground_changed",
  "grid_commit_focus_changed", "grid_commit_proof_unavailable", "grid_commit_authorization_unknown",
  "native_grid_commit_proof_invalid", "native_grid_commit_target_unavailable", "native_grid_commit_reply_invalid",
  "native_grid_commit_postcheck_unknown", "native_grid_commit_unknown",
  "invalid_desktop_point", "background_point_not_verified", "point_not_unique", "window_evidence_unavailable",
  "control_token_unavailable", "sensitive_control_not_writable", "background_delivery_not_authorized",
  "foreground_input_not_authorized", "desktop_image_not_authorized", "focus_target_unsupported", "invalid_focus",
  "invalid_arguments", "windows_action_not_supported", "background_action_not_verified", "background_control_not_verified",
  "background_text_not_verified", "background_scroll_not_verified", "foreground_activation_unavailable",
  "foreground_not_confirmed", "foreground_activation_unknown", "window_profile_changed", "window_scope_changed",
  "background_occluded", "background_target_unavailable", "guest_page_scope_ambiguous", "invalid_guest_timeout",
  "session_closed", "invalid_window_scope", "invalid_background_source", "duplicate_window_scope", "control_ref_expired",
]);
const SAFE_VALIDATION_CODES = new Set([
  "schema_invalid", "capability_combination_invalid", "budget_exceeded", "focus_reference_order_invalid",
]);

export function safeValidationCode(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const match = /^([a-z][a-z0-9_:-]{1,63})\b/i.exec(error.message.trim());
  if (!match) return fallback;
  const code = match[1].toLowerCase();
  return SAFE_VALIDATION_CODES.has(code) ? code : fallback;
}

export function safeAdapterCode(code: string | undefined, fallback: string): string {
  return typeof code === "string" && SAFE_ADAPTER_CODES.has(code) ? code : fallback;
}

export function mergeSignals(signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const source of signals) {
    if (!source) continue;
    const onAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(source.reason ?? "cancelled");
    };
    if (source.aborted) onAbort();
    else {
      source.addEventListener("abort", onAbort, { once: true });
      listeners.push(() => source.removeEventListener("abort", onAbort));
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of listeners) remove();
    },
  };
}

export async function awaitAbortable<T>(value: PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("aborted");
  let onAbort!: () => void;
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve(value), abort]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function intersectList<T>(left: readonly T[] | undefined, right: readonly T[] | undefined): readonly T[] | undefined {
  if (!left && !right) return undefined;
  if (!left) return [...(right ?? [])];
  if (!right) return [...left];
  return left.filter((entry) => right.some((candidate) => Object.is(candidate, entry)));
}

/** Intersect host grants with backend capabilities without mutating either input. */
export function intersectCapabilities(
  backendCapabilities: readonly Capability[],
  grantedCapabilities: readonly Capability[] | undefined,
): readonly Capability[] {
  if (!grantedCapabilities) return backendCapabilities.map((capability) => ({
    ...capability,
    targets: [...capability.targets],
    ...(capability.foreground === true ? { foreground: true as const } : {}),
    ...(capability.buttons ? { buttons: [...capability.buttons] } : {}),
    ...(capability.counts ? { counts: [...capability.counts] } : {}),
    ...(capability.directions ? { directions: [...capability.directions] } : {}),
    ...(capability.units ? { units: [...capability.units] } : {}),
    ...(capability.keys ? { keys: [...capability.keys] } : {}),
    ...(capability.chords ? { chords: capability.chords.map((chord) => [...chord]) } : {}),
  }));
  const result: Capability[] = [];
  for (const backendCapability of backendCapabilities) {
    for (const grant of grantedCapabilities) {
      if (backendCapability.kind !== grant.kind) continue;
      const targets = backendCapability.targets.filter((target) => grant.targets.includes(target));
      if (targets.length === 0) continue;
      const buttons = intersectList(backendCapability.buttons, grant.buttons);
      const counts = intersectList(backendCapability.counts, grant.counts);
      const directions = intersectList(backendCapability.directions, grant.directions);
      const units = intersectList(backendCapability.units, grant.units);
      const keys = intersectList(backendCapability.keys, grant.keys);
      const chords = backendCapability.chords && grant.chords
        ? backendCapability.chords.filter((chord) => grant.chords?.some((candidate) =>
          chord.length === candidate.length && chord.every((key, index) => key === candidate[index])))
        : backendCapability.chords ?? grant.chords;
      if (buttons && buttons.length === 0) continue;
      if (counts && counts.length === 0) continue;
      if (directions && directions.length === 0) continue;
      if (units && units.length === 0) continue;
      if (keys && keys.length === 0) continue;
      if (chords && chords.length === 0) continue;
      result.push({
        kind: backendCapability.kind,
        targets,
        ...(backendCapability.kind === "type" && backendCapability.foreground === true && grant.foreground === true ? { foreground: true as const } : {}),
        ...(buttons ? { buttons } : {}),
        ...(counts ? { counts } : {}),
        ...(directions ? { directions } : {}),
        ...(units ? { units } : {}),
        ...(keys ? { keys } : {}),
        ...(chords ? { chords: chords.map((chord) => [...chord]) } : {}),
      });
    }
  }
  return result;
}

export function freezeCapabilities(capabilities: readonly Capability[]): readonly Capability[] {
  return Object.freeze(capabilities.map((capability) => Object.freeze({
    ...capability,
    targets: Object.freeze([...capability.targets]),
    ...(capability.foreground === true ? { foreground: true as const } : {}),
    ...(capability.buttons ? { buttons: Object.freeze([...capability.buttons]) } : {}),
    ...(capability.counts ? { counts: Object.freeze([...capability.counts]) } : {}),
    ...(capability.directions ? { directions: Object.freeze([...capability.directions]) } : {}),
    ...(capability.units ? { units: Object.freeze([...capability.units]) } : {}),
    ...(capability.keys ? { keys: Object.freeze([...capability.keys]) } : {}),
    ...(capability.chords ? { chords: Object.freeze(capability.chords.map((chord) => Object.freeze([...chord]))) } : {}),
  })));
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
