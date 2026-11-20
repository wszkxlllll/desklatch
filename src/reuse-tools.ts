import { createHash, randomUUID } from "node:crypto";
import type { ActRequest } from "./contracts.js";
import { canonicalRole } from "./grounding.js";
import { createDeskTools, type ToolEndpoint } from "./tools.js";
import type {
  ActResult,
  ControlObservation,
  DeskObservation,
  DeskSession,
} from "./core/session-types.js";
import {
  createVerifiedStepReuse,
  type ReuseJson,
  type ReuseRunResult,
  type ReuseRunOptions,
  type VerifiedStepRecord,
  type VerifiedStepReuse,
  type VerifiedStepReuseStore,
} from "./reuse.js";

/** A short model-facing intention used only to rank already available candidates. */
export const reuseQuerySchema: Record<string, unknown> = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 128,
  description: "A short intention such as 'edit the title' or '填写标题'.",
});

const reuseSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["ref"],
  properties: {
    ref: { type: "string", minLength: 1, maxLength: 256, pattern: "\\S" },
    values: {
      type: "object",
      additionalProperties: {
        oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
      },
    },
  },
};

/**
 * Extend an existing act schema with the optional host-issued reuse form.
 * The input object is never mutated, which lets workspaces compose this
 * fragment into their own schema without changing a shared schema instance.
 */
export function addReuseActSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(schema)) throw new TypeError("invalid_act_schema");
  const result = cloneSchema(schema);
  const originalRequired = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  const originalOneOf = Array.isArray(schema.oneOf) ? cloneSchema(schema.oneOf) : undefined;
  const properties = isRecord(result.properties) ? { ...result.properties } : {};
  properties.reuse = cloneSchema(reuseSchema);
  result.properties = properties;

  result.required = originalRequired.filter((entry) => entry !== "steps");

  // The reviewed schema's `if` assumes that steps is present. Make that
  // conditional explicit before accepting the alternate reuse form.
  if (isRecord(result.if)) result.if = { required: ["steps"], allOf: [result.if] };
  // Keep the original required fields and oneOf branches as the compact
  // regular branch. Do not nest the entire action schema (and its $defs) in
  // every request sent to a model.
  const regularBranch: Record<string, unknown> = {
    ...(originalRequired.length === 0 ? {} : { required: originalRequired }),
    ...(originalOneOf === undefined ? {} : { oneOf: originalOneOf }),
    not: { required: ["reuse"] },
  };
  result.oneOf = [
    regularBranch,
    { required: ["reuse"], maxProperties: 2, not: { required: ["steps"] } },
  ];
  return result;
}

export interface ReuseCandidateAction {
  readonly kind: "click" | "type" | "setValue";
  readonly target: { role?: string; name?: string; within?: string };
  readonly parameter?: string;
  readonly expectState?: string;
}

export interface ReuseCandidate {
  readonly ref: string;
  readonly actions: readonly ReuseCandidateAction[];
  readonly available: boolean;
}

export interface DiscoverableStepReuseOptions {
  session: DeskSession;
  getContext(signal?: AbortSignal): ReuseJson | undefined | Promise<ReuseJson | undefined>;
  store?: VerifiedStepReuseStore;
  maxCandidates?: number;
}

export interface DiscoverableStepReuse {
  /** The original bound session, used by Workspace for host identity. */
  readonly session: DeskSession;
  /** Model-facing observe/act tools, including the optional reuse fields. */
  readonly tools: readonly ToolEndpoint[];
  /** The underlying verified replay companion, for explicit host-side use. */
  readonly verified: VerifiedStepReuse;
  /** Approval resolution for direct standalone use of the wrapped tools. */
  readonly resolveApproval: DeskSession["resolveApproval"];
  close(): Promise<void>;
}

type AnyRecord = Record<string, unknown>;
type Scalar = string | number | boolean;
interface SelectorSnapshot {
  readonly role?: string;
  readonly name?: string;
  readonly within?: string;
  readonly state?: string;
}

interface CandidateActionInternal {
  readonly kind: "click" | "type" | "setValue";
  readonly selector: SelectorSnapshot;
  readonly parameter?: string;
  readonly expectState?: string;
  readonly publicAction: ReuseCandidateAction;
}

interface CandidateInternal {
  readonly record: VerifiedStepRecord;
  readonly actions: readonly CandidateActionInternal[];
  readonly recordSignature: string;
  readonly storeIndex: number;
}

interface CandidateBinding {
  readonly key: string;
  readonly recordSignature: string;
  readonly contextSignature: string;
  readonly observationId: string;
}

interface CandidateScope {
  readonly refs: Map<string, CandidateBinding>;
}

interface PendingCapture {
  readonly request: ActRequest;
  readonly context: ReuseJson;
  readonly contextSignature: string;
}

function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneSchema<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isReuseJson(value: unknown, depth = 0, seen = new WeakSet<object>()): value is ReuseJson {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.hasOwn(value, "toJSON")) return false;
    const valid = value.every((entry) => isReuseJson(entry, depth + 1, seen));
    seen.delete(value);
    return valid;
  }
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.hasOwn(value, "toJSON")) return false;
  const valid = Object.keys(value).every((key) => key.length <= 256 && isReuseJson(value[key], depth + 1, seen));
  seen.delete(value);
  return valid;
}

function canonicalJson(value: ReuseJson | undefined): string {
  if (value === undefined) return "<undefined>";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function snapshotJson(value: unknown): ReuseJson | undefined {
  if (!isReuseJson(value)) return undefined;
  return JSON.parse(JSON.stringify(value)) as ReuseJson;
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function markerName(value: unknown, names: ReadonlySet<string>): string | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.$param !== "string") return undefined;
  return names.has(value.$param) ? value.$param : undefined;
}

function selectorSnapshot(value: unknown): SelectorSnapshot | undefined {
  if (!isRecord(value) || Object.keys(value).length === 0) return undefined;
  const result: { role?: string; name?: string; within?: string; state?: string } = {};
  for (const key of ["role", "name", "within", "state"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string" || value[key].trim().length === 0) return undefined;
      result[key] = value[key];
    }
  }
  if (Object.keys(result).length === 0 || (result.role === undefined && result.name === undefined)) return undefined;
  return result;
}

function publicSelector(selector: SelectorSnapshot): { role?: string; name?: string; within?: string } {
  return {
    ...(selector.role === undefined ? {} : { role: selector.role }),
    ...(selector.name === undefined ? {} : { name: selector.name }),
    ...(selector.within === undefined ? {} : { within: selector.within }),
  };
}

function extractCandidate(record: VerifiedStepRecord, storeIndex: number): CandidateInternal | undefined {
  if (!isRecord(record.request) || !Array.isArray(record.request.steps)) return undefined;
  const names = new Set(record.parameterNames);
  const actions: CandidateActionInternal[] = [];
  for (const rawStep of record.request.steps) {
    if (!isRecord(rawStep) || (rawStep.kind !== "click" && rawStep.kind !== "type" && rawStep.kind !== "setValue")) return undefined;
    const selector = selectorSnapshot(rawStep.target);
    if (selector === undefined || !isRecord(rawStep.expect) || !selectorSnapshot(rawStep.expect.target)) return undefined;
    if (rawStep.kind === "click") {
      if (!isRecord(rawStep.expect) || typeof rawStep.expect.state !== "string" || rawStep.expect.state === "present"
        || (rawStep.button !== undefined && rawStep.button !== "left") || (rawStep.count !== undefined && rawStep.count !== 1)) return undefined;
      const publicAction: ReuseCandidateAction = {
        kind: "click",
        target: publicSelector(selector),
        expectState: rawStep.expect.state,
      };
      actions.push({ kind: "click", selector, expectState: rawStep.expect.state, publicAction });
      continue;
    }
    if (typeof rawStep.expect.valueEquals !== "object" && typeof rawStep.expect.valueEquals !== "string") return undefined;
    const parameter = markerName(rawStep[rawStep.kind === "type" ? "text" : "value"], names);
    const expectedParameter = markerName(rawStep.expect.valueEquals, names);
    if (parameter === undefined || parameter !== expectedParameter) return undefined;
    const publicAction: ReuseCandidateAction = { kind: rawStep.kind, target: publicSelector(selector), parameter };
    actions.push({ kind: rawStep.kind, selector, parameter, publicAction });
  }
  if (actions.length === 0) return undefined;
  const recordSnapshot = snapshotJson(record);
  if (recordSnapshot === undefined) return undefined;
  const recordSignature = canonicalJson(recordSnapshot);
  return {
    record,
    actions,
    recordSignature,
    storeIndex,
  };
}

function tokenize(value: string): string[] {
  const result: string[] = [];
  for (const token of value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    result.push(token);
    // Splitting CJK text into characters makes short Chinese intentions useful
    // without relying on a site dictionary or a language-specific model.
    if (/^[\u3400-\u9fff\u3040-\u30ff]+$/u.test(token)) {
      result.push(...[...token]);
    }
  }
  return result;
}

function queryScore(query: string, candidate: CandidateInternal): number {
  if (query.length === 0) return 0;
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const fields = [candidate.record.key, ...candidate.actions.flatMap((action) => [
    action.parameter ?? "",
    action.selector.role ?? "",
    action.selector.name ?? "",
    action.selector.within ?? "",
    action.selector.state ?? "",
    action.expectState ?? "",
  ])].join(" ");
  const fieldTokens = tokenize(fields);
  const fieldText = fields.normalize("NFKC").toLocaleLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (fieldTokens.includes(token)) score += token.length > 1 ? 6 : 4;
    else if (fieldTokens.some((entry) => entry.startsWith(token) || token.startsWith(entry))) score += 2;
    else if (fieldText.includes(token)) score += 1;
  }
  return score;
}

function controlWithin(control: ControlObservation): string | undefined {
  return (control as ControlObservation & { within?: string }).within;
}

function normalizedAccessibleName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function selectorMatch(selector: SelectorSnapshot, control: ControlObservation): { matched: boolean; unconfirmed: boolean } {
  if (selector.role !== undefined && canonicalRole(control.role) !== canonicalRole(selector.role)) {
    return { matched: false, unconfirmed: false };
  }
  if (selector.name !== undefined) {
    const names = [control.name, ...(control.labels ?? [])].filter((name): name is string => typeof name === "string");
    if (!names.some((name) => normalizedAccessibleName(name) === normalizedAccessibleName(selector.name!))) {
      return { matched: false, unconfirmed: false };
    }
  }
  let unconfirmed = false;
  if (selector.within !== undefined) {
    const within = controlWithin(control);
    if (within === undefined) unconfirmed = true;
    else if (normalizedAccessibleName(within) !== normalizedAccessibleName(selector.within)) return { matched: false, unconfirmed: false };
  }
  if (selector.state !== undefined && !control.states.includes(selector.state as never)) return { matched: false, unconfirmed: false };
  return { matched: true, unconfirmed };
}

function normalizeQuery(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error("invalid_reuse_query");
  const query = value.trim();
  if (query.length === 0 || query.length > 128 || /[\u0000\r\n]/u.test(query)) throw new Error("invalid_reuse_query");
  return query;
}

function parseReuseRequest(raw: unknown): { ref: string; observationId?: string; values: Readonly<Record<string, Scalar>> } | undefined {
  if (!isRecord(raw) || !Object.hasOwn(raw, "reuse")) return undefined;
  if (Object.keys(raw).some((key) => key !== "reuse" && key !== "observationId") || !isRecord(raw.reuse)) throw new Error("reuse_invalid");
  if (Object.keys(raw.reuse).some((key) => key !== "ref" && key !== "values")
    || typeof raw.reuse.ref !== "string" || raw.reuse.ref.trim().length === 0 || raw.reuse.ref.length > 256
    || /[\u0000\r\n]/u.test(raw.reuse.ref)) throw new Error("reuse_invalid");
  if (raw.observationId !== undefined
    && (typeof raw.observationId !== "string" || raw.observationId.trim().length === 0
      || raw.observationId.length > 512 || /[\u0000\r\n]/u.test(raw.observationId))) throw new Error("reuse_invalid");
  const values = raw.reuse.values === undefined ? {} : raw.reuse.values;
  if (!isRecord(values) || Object.values(values).some((value) => !isScalar(value))) throw new Error("reuse_invalid");
  return {
    ref: raw.reuse.ref,
    ...(raw.observationId === undefined ? {} : { observationId: raw.observationId }),
    values: values as Readonly<Record<string, Scalar>>,
  };
}

function stoppedResult(code: string): ActResult {
  return { status: "stopped", atStep: 1, code, steps: [] };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function automaticCaptureShape(request: unknown): { parameters: { name: string; paths: string[] }[]; shape: ReuseJson } | undefined {
  if (!isRecord(request) || !Array.isArray(request.steps) || request.steps.length === 0) return undefined;
  if (Object.hasOwn(request, "observationId")
    && (typeof request.observationId !== "string" || request.observationId.trim().length === 0
      || request.observationId.length > 512 || /[\u0000\r\n]/u.test(request.observationId))) return undefined;
  const parameters: { name: string; paths: string[] }[] = [];
  const shapeSteps: ReuseJson[] = [];
  for (let index = 0; index < request.steps.length; index += 1) {
    const step = request.steps[index];
    if (!isRecord(step) || (step.kind !== "click" && step.kind !== "type" && step.kind !== "setValue")) return undefined;
    const target = selectorSnapshot(step.target);
    const expect = isRecord(step.expect) ? selectorSnapshot(step.expect.target) : undefined;
    if (step.kind === "click") {
      const expectedState = isRecord(step.expect) ? step.expect.state : undefined;
      const targetRole = target?.role?.normalize("NFKC").trim().toLocaleLowerCase("en-US");
      if (target === undefined || expect === undefined || !isRecord(step.expect)
        || canonicalJson(target as unknown as ReuseJson) !== canonicalJson(expect as unknown as ReuseJson)
        || typeof expectedState !== "string" || expectedState === "present"
        || (step.button !== undefined && step.button !== "left") || (step.count !== undefined && step.count !== 1)
        || (targetRole !== "tab" && !(targetRole === "button" && expectedState === "expanded")
          && !(targetRole === "checkbox" && expectedState === "checked"))) return undefined;
      shapeSteps.push({
        kind: "click",
        target: target as unknown as ReuseJson,
        expect: { target: expect as unknown as ReuseJson, state: expectedState },
      });
      continue;
    }
    const expectedValue = isRecord(step.expect) ? step.expect.valueEquals : undefined;
    const payload = step.kind === "type" ? step.text : step.value;
    if (target === undefined || expect === undefined || !isRecord(step.expect)
      || typeof payload !== "string" || typeof expectedValue !== "string" || payload !== expectedValue
      || canonicalJson(target as unknown as ReuseJson) !== canonicalJson(expect as unknown as ReuseJson)) return undefined;
    const name = `value${index}`;
    parameters.push({
      name,
      paths: [
        `steps.${index}.${step.kind === "type" ? "text" : "value"}`,
        `steps.${index}.expect.valueEquals`,
      ],
    });
    shapeSteps.push({
      kind: step.kind,
      target: target as unknown as ReuseJson,
      expect: expect as unknown as ReuseJson,
      parameter: name,
    });
  }
  return { parameters, shape: { steps: shapeSteps } };
}

function contextForKey(context: ReuseJson, shape: ReuseJson): string {
  return `desklatch-reuse-v1:${digest(canonicalJson({ context, shape } as unknown as ReuseJson))}`;
}

function withReplayMetadata(result: ActResult, succeeded: boolean): ActResult {
  return { ...result, replayed: true, succeeded } as ActResult;
}

function isCompletedVerified(result: ActResult, request: ActRequest): boolean {
  if (result.status !== "completed" || result.steps.length !== request.steps.length) return false;
  return request.steps.every((step, index) => {
    const receipt = result.steps[index];
    return receipt?.index === index + 1 && receipt.kind === step.kind && receipt.status === "verified";
  });
}

function normalizeResult(result: ReuseRunResult): ActResult {
  if (result.status === "miss") return stoppedResult(result.code);
  return withReplayMetadata(result.result, result.succeeded);
}

function candidateAvailability(
  candidate: CandidateInternal,
  observation: DeskObservation,
  query: string,
): { available: boolean; matchScore: number } | undefined {
  const controls = Array.isArray(observation.controls) ? observation.controls : [];
  let matched = 0;
  let unavailable = false;
  let fallback = false;
  for (const action of candidate.actions) {
    const matches = controls
      .map((control) => ({ control, match: selectorMatch(action.selector, control) }))
      .filter((entry) => entry.match.matched);
    if (matches.length > 1) return undefined;
    if (matches.length === 1) {
      matched += 1;
      if (matches[0].match.unconfirmed) fallback = true;
      if (!matches[0].control.actions.includes(action.kind)) unavailable = true;
      if (action.kind === "click") {
        const control = matches[0].control;
        const structural = control.effect === "read" && ((control.disclosure === true && action.expectState === "expanded")
          || (control.filterAction === true && canonicalRole(control.role) === "checkbox" && action.expectState === "checked")
          || (canonicalRole(control.role) === "tab" && control.sameDocumentTab === true && action.expectState === "selected"));
        if (!structural) unavailable = true;
      }
    } else if (observation.complete) {
      // A complete observation is authoritative enough to reject a role/name
      // mismatch. Incomplete control lists are deliberately handled below.
      return undefined;
    } else {
      fallback = true;
    }
  }
  const labelScore = queryScore(query, candidate);
  // A confidently matching actionable control is useful even when the short
  // intention uses a synonym that is not present in the stored label. An
  // unavailable exact target is never offered as an actionable candidate;
  // uncertain (truncated) absence can remain as an explicitly unavailable
  // fallback, but only when the intention identifies it.
  if (unavailable) return undefined;
  if (query.length > 0 && labelScore === 0 && (fallback || matched === 0)) return undefined;
  const available = !fallback && !unavailable && matched === candidate.actions.length;
  const matchScore = matched * 32 + (available ? 24 : 0) + labelScore * 100 - (fallback ? 2 : 0);
  return { available, matchScore };
}

/**
 * Wrap a DeskSession with host-issued reuse candidates. Candidate lookup is
 * intentionally local: it reads only the host's verified store and the one
 * observation supplied by the caller, and never asks a model or performs a
 * second observation to rank results.
 */
export function createDiscoverableStepReuse(options: DiscoverableStepReuseOptions): DiscoverableStepReuse {
  if (!options || !options.session || typeof options.getContext !== "function"
    || typeof options.session.observe !== "function" || typeof options.session.close !== "function") throw new TypeError("invalid_discoverable_session");
  const maxCandidates = options.maxCandidates === undefined ? 3 : options.maxCandidates;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 128) throw new TypeError("invalid_max_candidates");

  const verified = createVerifiedStepReuse({ session: options.session, store: options.store });
  let generation = 0;
  let refSequence = 0;
  let scope: CandidateScope | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let actQueue: Promise<void> = Promise.resolve();
  const pendingCaptures = new Map<string, PendingCapture>();

  function invalidateScope(): void {
    scope = undefined;
  }

  async function readContext(signal?: AbortSignal): Promise<{ value: ReuseJson; signature: string } | undefined> {
    try {
      const value = await options.getContext(signal);
      const snapshot = snapshotJson(value);
      if (snapshot === undefined) return undefined;
      return { value: snapshot, signature: canonicalJson(snapshot) };
    } catch {
      return undefined;
    }
  }

  async function capture(request: ActRequest, result: ActResult, before: PendingCapture | undefined, signal?: AbortSignal): Promise<void> {
    if (!isCompletedVerified(result, request)) return;
    const shape = automaticCaptureShape(request);
    if (shape === undefined) return;
    const contextBefore = before;
    const after = await readContext(signal);
    if (after === undefined || contextBefore === undefined || after.signature !== contextBefore.contextSignature) {
      invalidateScope();
      return;
    }
    const key = contextForKey(contextBefore.context, shape.shape);
    try {
      await verified.remember(key, request, result, {
        context: contextBefore.context,
        parameters: shape.parameters,
      });
    } catch {
      // Automatic caching is opportunistic. Store validation or persistence
      // failures must never alter the already-issued action receipt.
    }
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = actQueue.then(operation, operation);
    actQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async function discover(observation: DeskObservation, contextSignature: string, query: string, observationGeneration: number, signal?: AbortSignal): Promise<readonly ReuseCandidate[]> {
    let records: readonly VerifiedStepRecord[];
    try {
      records = await verified.list();
    } catch {
      return [];
    }
    if (closed || signal?.aborted || generation !== observationGeneration) return [];
    const scoped = records
      .filter((record) => record.coverage === undefined
        && record.context !== undefined && canonicalJson(record.context) === contextSignature)
      .map((record, index) => extractCandidate(record, index))
      .filter((candidate): candidate is CandidateInternal => candidate !== undefined);
    const ranked: { candidate: CandidateInternal; available: boolean; score: number }[] = [];
    for (const candidate of scoped) {
      const availability = candidateAvailability(candidate, observation, query);
      if (availability === undefined) continue;
      ranked.push({ candidate, available: availability.available, score: availability.matchScore });
    }
    ranked.sort((left, right) => right.score - left.score || left.candidate.storeIndex - right.candidate.storeIndex);

    const refs = new Map<string, CandidateBinding>();
    const publicCandidates: ReuseCandidate[] = [];
    for (const entry of ranked.slice(0, maxCandidates)) {
      const ref = `reuse-${generation}-${++refSequence}-${randomUUID()}`;
      refs.set(ref, {
        key: entry.candidate.record.key,
        recordSignature: entry.candidate.recordSignature,
        contextSignature,
        observationId: observation.observationId,
      });
      publicCandidates.push({
        ref,
        actions: entry.candidate.actions.map((action) => action.publicAction),
        available: entry.available,
      });
    }
    scope = { refs };
    return publicCandidates;
  }

  async function decorateObservation(
    observation: DeskObservation,
    query: string,
    signal: AbortSignal | undefined,
    eligibleByDefault: boolean,
    filtered: boolean,
  ): Promise<DeskObservation & { reuseCandidates: readonly ReuseCandidate[] }> {
    const observationGeneration = ++generation;
    invalidateScope();
    if (!eligibleByDefault && query.length === 0) return { ...observation, reuseCandidates: [] };
    const context = await readContext(signal);
    // A complete filtered response only describes the requested selector.
    // An explicit reuse query can still surface relevant unconfirmed targets.
    const evidence = filtered && query.length > 0 ? { ...observation, complete: false } : observation;
    const candidates = context === undefined ? [] : await discover(evidence, context.signature, query, observationGeneration, signal);
    return { ...observation, reuseCandidates: candidates };
  }

  async function replay(raw: unknown, signal?: AbortSignal): Promise<ActResult> {
    if (closed) return stoppedResult("closed");
    if (signal?.aborted) return stoppedResult("cancelled");
    let request: { ref: string; observationId?: string; values: Readonly<Record<string, Scalar>> };
    try {
      const parsed = parseReuseRequest(raw);
      if (parsed === undefined) return stoppedResult("reuse_invalid");
      request = parsed;
    } catch {
      return stoppedResult("reuse_invalid");
    }
    const currentScope = scope;
    if (currentScope === undefined) return stoppedResult("reuse_not_found");
    const binding = currentScope.refs.get(request.ref);
    if (binding === undefined) return stoppedResult("reuse_not_found");
    if (request.observationId !== undefined && request.observationId !== binding.observationId) return stoppedResult("reuse_stale");
    // A ref is consumed on its first use. This makes stale/cross-scope races
    // fail closed and avoids hidden automatic retries after an uncertain act.
    currentScope.refs.delete(request.ref);
    let currentRecord: VerifiedStepRecord | undefined;
    try {
      currentRecord = await verified.get(binding.key);
    } catch {
      return stoppedResult("store_error");
    }
    if (currentRecord === undefined) return stoppedResult("reuse_stale");
    const snapshot = snapshotJson(currentRecord);
    if (snapshot === undefined || canonicalJson(snapshot) !== binding.recordSignature) return stoppedResult("reuse_stale");
    const context = await readContext(signal);
    if (closed || signal?.aborted) return stoppedResult(closed ? "closed" : "cancelled");
    if (scope !== currentScope) return stoppedResult("reuse_stale");
    if (context === undefined || context.signature !== binding.contextSignature) {
      invalidateScope();
      return stoppedResult("context_mismatch");
    }
    const runOptions: ReuseRunOptions = { values: request.values, context: context.value, signal };
    let result: ReuseRunResult;
    try {
      // Execute the exact validated snapshot we just compared. The verified
      // layer's runRecord path avoids a second store read that could race with
      // a host update between candidate validation and dispatch.
      result = verified.runRecord
        ? await verified.runRecord(currentRecord, runOptions)
        : await verified.run(binding.key, runOptions);
    } catch {
      return stoppedResult("store_error");
    }
    return normalizeResult(result);
  }

  async function ordinaryAct(raw: unknown, signal?: AbortSignal): Promise<ActResult> {
    if (closed) return stoppedResult("closed");
    if (signal?.aborted) return stoppedResult("cancelled");
    const shape = automaticCaptureShape(raw);
    let before: PendingCapture | undefined;
    if (shape !== undefined) {
      const context = await readContext(signal);
      if (context !== undefined) before = { request: raw as ActRequest, context: context.value, contextSignature: context.signature };
      else invalidateScope();
    }
    if (closed || signal?.aborted) return stoppedResult(closed ? "closed" : "cancelled");
    const result = await verified.act(raw, signal);
    if (before !== undefined && result.code === "approval_required" && typeof result.requestId === "string") {
      pendingCaptures.set(result.requestId, before);
    } else if (before !== undefined) {
      await capture(before.request, result, before, signal);
    }
    return result;
  }

  async function act(raw: unknown, signal?: AbortSignal): Promise<ActResult> {
    if (closed) return stoppedResult("closed");
    if (isRecord(raw) && Object.hasOwn(raw, "reuse")) return enqueue(() => replay(raw, signal));
    return enqueue(() => ordinaryAct(raw, signal));
  }

  async function resolveApproval(requestId: string, decision: "approve" | "deny"): Promise<ActResult & { requestId: string }> {
    if (closed) return { requestId, status: "stopped", code: "closed", steps: [] };
    return enqueue(async () => {
      if (closed) return { requestId, status: "stopped", code: "closed", steps: [] };
      const pending = pendingCaptures.get(requestId);
      const result = typeof options.session.resolveApproval === "function"
        ? await verified.resolveApproval(requestId, decision)
        : { requestId, status: "stopped" as const, code: "approval_unsupported", steps: [] };
      pendingCaptures.delete(requestId);
      if (pending !== undefined) {
        if (result.code === "approval_required") pendingCaptures.set(result.requestId, pending);
        else await capture(pending.request, result, pending);
      }
      return result;
    });
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    invalidateScope();
    pendingCaptures.clear();
    closePromise = options.session.close();
    return closePromise;
  }

  // Keep the original observe endpoint as the validation authority. The
  // wrapper only removes the optional query before invoking it, then ranks the
  // exact observation returned by that already-reviewed endpoint.
  const baseTools = createDeskTools(options.session);
  const baseObserve = baseTools.find((tool) => tool.name === "observe");
  const tools: ToolEndpoint[] = baseTools.map((tool) => {
    if (tool.name === "observe") {
      return {
        ...tool,
        inputSchema: (() => {
          const schema = cloneSchema(tool.inputSchema);
          const properties = isRecord(schema.properties) ? { ...schema.properties } : {};
          properties.reuseQuery = cloneSchema(reuseQuerySchema);
          schema.properties = properties;
          return schema;
        })(),
        invoke: async (input: unknown, signal?: AbortSignal) => {
          if (closed) throw new Error("closed");
          if (!isRecord(input)) throw new Error("invalid_observe");
          const query = normalizeQuery(input.reuseQuery);
          const rest = { ...input };
          delete rest.reuseQuery;
          if (baseObserve === undefined) throw new Error("invalid_observe");
          const observation = await baseObserve.invoke(rest, signal) as DeskObservation;
          const filtered = rest.where !== undefined;
          const eligibleByDefault = (observation.view === "controls" || observation.view === "both")
            && (!filtered || observation.controls.length > 0);
          return decorateObservation(observation, query, signal, eligibleByDefault, filtered);
        },
      };
    }
    return {
      ...tool,
      inputSchema: addReuseActSchema(tool.inputSchema),
      description: `${tool.description} After observe, a host-issued reuse candidate can be replayed with {"reuse":{"ref":"...","values":{...}}}.`,
      invoke: act,
    };
  });

  return Object.freeze({
    session: options.session,
    tools: Object.freeze(tools),
    verified,
    resolveApproval,
    close,
  });
}
