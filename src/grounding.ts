import type { ActionKind, Control, Effect, Frame, Selector, State } from "./contracts.js";

export interface MatchOptions {
  kind?: ActionKind;
  aliases?: boolean;
}

export interface MatchResult {
  control?: Control;
  code?: string;
  candidates?: Control[];
}

const STATES: readonly State[] = ["visible", "enabled", "editable", "focused", "checked", "selected", "expanded"];
const ACTIONS: readonly ActionKind[] = ["click", "type", "setValue", "scroll", "keypress", "hotkey", "drag"];
const EFFECTS: readonly Effect[] = [
  "read",
  "navigate",
  "edit",
  "external",
  "financial",
  "destructive",
  "security",
  "sensitive",
  "unknown",
];
const UNSAFE_FILTER_EFFECTS = new Set<Effect>([
  "edit",
  "external",
  "financial",
  "destructive",
  "security",
  "sensitive",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

/** Equivalent names reported by common accessibility APIs for a text editing control. */
export function canonicalRole(value: string): string {
  const role = normalize(value);
  return role === "edit" || role === "input" || role === "textfield" ? "textbox" : role;
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && /\S/u.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function validState(value: unknown): value is State {
  return typeof value === "string" && (STATES as readonly string[]).includes(value);
}

function validAction(value: unknown): value is ActionKind {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

function validSelector(value: unknown): value is Selector {
  if (!isRecord(value) || !hasOnlyKeys(value, ["role", "name", "within", "state"])) return false;
  if (!("role" in value) && !("name" in value)) return false;
  if ("role" in value && !nonblank(value.role)) return false;
  if ("name" in value && !nonblank(value.name)) return false;
  if ("within" in value && !nonblank(value.within)) return false;
  if ("state" in value && !validState(value.state)) return false;
  return true;
}

function validControl(value: unknown): value is Control {
  if (!isRecord(value)) return false;
  if (!nonblank(value.id) || !nonblank(value.role)) return false;
  if (!Array.isArray(value.states) || !value.states.every(validState)) return false;
  if (!Array.isArray(value.actions) || !value.actions.every(validAction)) return false;
  if ("name" in value && value.name !== undefined && !nonblank(value.name)) return false;
  if ("within" in value && value.within !== undefined && !nonblank(value.within)) return false;
  if ("labels" in value && value.labels !== undefined && (!Array.isArray(value.labels) || !value.labels.every(nonblank))) return false;
  if ("effect" in value && value.effect !== undefined && (typeof value.effect !== "string" || !(EFFECTS as readonly string[]).includes(value.effect))) return false;
  if ("filterAction" in value && value.filterAction !== undefined && typeof value.filterAction !== "boolean") return false;
  return true;
}

function realNames(control: Control): string[] {
  return [
    ...(control.name === undefined ? [] : [control.name]),
    ...(control.labels === undefined ? [] : [...control.labels]),
  ];
}

function nameMatches(control: Control, wanted: string): boolean {
  const normalized = normalize(wanted);
  return realNames(control).some((name) => normalize(name) === normalized);
}

function scopeMatches(control: Control, within: string | undefined): boolean {
  return within === undefined || [control.within, control.windowScope].some(scope => scope !== undefined && normalize(scope) === normalize(within));
}

function actionMatches(control: Control, kind: ActionKind | undefined): boolean {
  return kind === undefined || control.actions.includes(kind);
}

function stateMatches(control: Control, state: State | undefined): boolean {
  return state === undefined || control.states.includes(state);
}

function filterCandidates(frame: Frame, selector: Selector, options: MatchOptions): Control[] {
  return frame.controls.filter((control) => {
    if (!scopeMatches(control, selector.within)) return false;
    if (!actionMatches(control, options.kind)) return false;
    return stateMatches(control, selector.state);
  });
}

function exactCandidates(frame: Frame, selector: Selector, options: MatchOptions): { matches: Control[]; conflict: Control[] } {
  const candidates = filterCandidates(frame, selector, options);
  const roleCandidates = selector.role === undefined ? candidates : candidates.filter((control) => canonicalRole(control.role) === canonicalRole(selector.role!));
  const namedCandidates = selector.name === undefined ? candidates : candidates.filter((control) => nameMatches(control, selector.name!));
  if (selector.role !== undefined && selector.name !== undefined) {
    const intersection = roleCandidates.filter((control) => namedCandidates.includes(control));
    if (intersection.length > 0) return { matches: intersection, conflict: [] };
    if (roleCandidates.length > 0 || namedCandidates.length > 0) {
      return { matches: [], conflict: [...new Set([...roleCandidates, ...namedCandidates])] };
    }
    return { matches: [], conflict: [] };
  }
  return { matches: selector.role === undefined ? namedCandidates : roleCandidates, conflict: [] };
}

function aliasName(selector: Selector): boolean {
  if (selector.name === undefined) return false;
  const wanted = normalize(selector.name);
  return wanted === "search" || wanted === "搜索";
}

function isSafeFilterControl(control: Control, kind: ActionKind | undefined): boolean {
  if (control.filterAction !== true || !control.actions.includes("click")) return false;
  if (kind !== undefined && kind !== "click") return false;
  return control.effect === undefined || !UNSAFE_FILTER_EFFECTS.has(control.effect);
}

function aliasCandidates(frame: Frame, selector: Selector, options: MatchOptions): Control[] {
  if (selector.within === undefined) return [];
  return filterCandidates(frame, selector, { ...options, kind: options.kind ?? "click" }).filter((control) => nameMatches(control, "查询"));
}

/**
 * Resolve a selector only against a complete, authorized observation. Exact
 * role/name matching is preferred. The one intentionally supported alias is
 * scoped to a low-risk, structurally marked search/filter control.
 */
export function matchControl(frame: Frame, selector: Selector, options: MatchOptions = {}): MatchResult {
  if (!isRecord(frame) || !nonblank(frame.scope)) return { code: "frame_unauthorized" };
  if (frame.complete !== true) return { code: "frame_incomplete" };
  if (!Array.isArray(frame.controls) || !frame.controls.every(validControl)) return { code: "frame_invalid" };
  if (!validSelector(selector)) return { code: "selector_invalid" };
  if (!isRecord(options) || !hasOnlyKeys(options, ["kind", "aliases"]) || ("kind" in options && options.kind !== undefined && !validAction(options.kind))) return { code: "selector_invalid" };
  if ("aliases" in options && options.aliases !== undefined && typeof options.aliases !== "boolean") return { code: "selector_invalid" };

  const exact = exactCandidates(frame, selector, options);
  // A scoped search alias may intentionally fill in the name half of a
  // role+name selector. Other role/name conflicts remain hard refusals.
  if (exact.conflict.length > 0 && !(options.aliases === true && aliasName(selector))) {
    return { code: "selector_conflict", candidates: exact.conflict };
  }
  if (exact.matches.length === 1) return { control: exact.matches[0] };
  if (exact.matches.length > 1) return { code: "ambiguous", candidates: exact.matches };

  if (options.aliases !== true || !aliasName(selector)) return { code: "no_match" };
  if (selector.within === undefined) return { code: "alias_scope_required" };
  if (options.kind !== undefined && options.kind !== "click") return { code: "alias_unsafe" };

  const aliases = aliasCandidates(frame, selector, options);
  if (aliases.length === 0) return { code: "no_match" };
  const actionKind = options.kind as ActionKind | undefined;
  if (aliases.some((control) => !isSafeFilterControl(control, actionKind))) {
    return { code: "alias_unsafe", candidates: aliases };
  }
  if (aliases.length > 1) return { code: "ambiguous", candidates: aliases };
  return { control: aliases[0] };
}
