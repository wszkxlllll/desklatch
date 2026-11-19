import type { ActRequest, Step } from "./contracts.js";
import type { ActResult, ApprovalDecision, ApprovalResolution, DeskSession, StepReceipt } from "./core/session-types.js";
import { validateRequest } from "./request.js";

/** JSON values are deliberately the only values accepted by host-owned reuse stores. */
export type ReuseJson = null | boolean | number | string | ReuseJson[] | { [key: string]: ReuseJson };

export interface ReuseParameter {
  /** A short, non-sensitive name used only for this template. */
  name: string;
  /** Dot paths into `request`, for example `steps.0.text`. */
  paths: readonly string[];
}

export interface ReuseCaptureOptions {
  /** Values identifying the host-owned application/document scope. */
  context?: ReuseJson;
  /** Host-owned description of what the verification covered. */
  coverage?: ReuseJson;
  /** Every value that can vary between tasks must be represented by a slot. */
  parameters: readonly ReuseParameter[];
  /** Primarily useful for deterministic host tests. Defaults to the current time. */
  now?: number;
}

export interface ReuseRunOptions {
  /** Ephemeral values substituted into the template and never stored. */
  values?: Readonly<Record<string, string | number | boolean>>;
  context?: ReuseJson;
  coverage?: ReuseJson;
  signal?: AbortSignal;
}

/**
 * The stored request has the same protocol shape except that selected scalar
 * values are represented by `{ $param: name }`. Version 1 contains only
 * `type`/`setValue` selector steps with same-target value readback; it has no
 * observation id, ref, point, or focus target.
 */
export interface VerifiedStepRecord {
  readonly version: 1;
  readonly key: string;
  readonly request: ReuseJson;
  readonly parameterNames: readonly string[];
  readonly context?: ReuseJson;
  readonly coverage?: ReuseJson;
  readonly verifiedAt: number;
}

/**
 * A host-owned serializable store. Per-key methods are recommended for stores
 * shared by multiple clients; load/save is a simpler single-writer fallback.
 */
export interface VerifiedStepReuseStore {
  /** Recommended for stores shared by multiple reuse clients/processes. */
  get?(key: string): VerifiedStepRecord | unknown | undefined | Promise<VerifiedStepRecord | unknown | undefined>;
  put?(record: VerifiedStepRecord): void | Promise<void>;
  delete?(key: string): boolean | void | Promise<boolean | void>;
  list?(): VerifiedStepRecord[] | readonly unknown[] | { records: readonly unknown[] } | Promise<VerifiedStepRecord[] | readonly unknown[] | { records: readonly unknown[] }>;
  /** Snapshot fallback for a host-owned single-writer store. */
  load?(): VerifiedStepRecord[] | readonly unknown[] | { records: readonly unknown[] } | Promise<VerifiedStepRecord[] | readonly unknown[] | { records: readonly unknown[] }>;
  save?(records: readonly VerifiedStepRecord[]): void | Promise<void>;
}

export type ReuseMissCode =
  | "reuse_not_found"
  | "context_mismatch"
  | "coverage_mismatch"
  | "parameter_missing"
  | "parameter_invalid"
  | "request_invalid"
  | "store_error";

export interface ReuseMiss {
  readonly status: "miss";
  readonly reused: false;
  readonly key: string;
  readonly code: ReuseMissCode;
}

export interface ReuseExecution {
  readonly status: ActResult["status"];
  readonly reused: true;
  /** False for stopped/rejected/unknown or otherwise unverified outcomes. */
  readonly succeeded: boolean;
  readonly key: string;
  readonly record: VerifiedStepRecord;
  readonly result: ActResult;
}

export type ReuseRunResult = ReuseMiss | ReuseExecution;

export class ReuseValidationError extends Error {
  public readonly code: "invalid_key" | "invalid_capture" | "invalid_store";

  public constructor(code: "invalid_key" | "invalid_capture" | "invalid_store") {
    super(code);
    this.name = "ReuseValidationError";
    this.code = code;
  }
}

const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const MAX_KEY_LENGTH = 256;
const MAX_RECORDS = 1_024;
const MAX_SERIALIZED_RECORD = 256 * 1024;
const PARAMETER_MARKER = "$param";

type ParameterMarker = { $param: string };
type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isParameterMarker(value: unknown): value is ParameterMarker {
  return isRecord(value)
    && Object.keys(value).length === 1
    && typeof value[PARAMETER_MARKER] === "string"
    && PARAMETER_NAME.test(value[PARAMETER_MARKER]);
}

function isJson(value: unknown, depth = 0, seen = new WeakSet<object>()): value is ReuseJson {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.hasOwn(value, "toJSON")) return false;
    const valid = value.every((entry) => isJson(entry, depth + 1, seen));
    seen.delete(value);
    return valid;
  }
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.hasOwn(value, "toJSON")) return false;
  const valid = Object.keys(value).every((key) => key.length <= 256 && isJson(value[key], depth + 1, seen));
  seen.delete(value);
  return valid;
}

function cloneJson<T extends ReuseJson>(value: T): T {
  if (!isJson(value)) throw new ReuseValidationError("invalid_capture");
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: ReuseJson | undefined): string {
  if (value === undefined) return "<undefined>";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeKey(key: string): string {
  if (typeof key !== "string" || key.trim().length === 0 || key.length > MAX_KEY_LENGTH || /[\u0000\r\n]/u.test(key)) {
    throw new ReuseValidationError("invalid_key");
  }
  return key;
}

function normalizePath(path: string): string[] {
  if (typeof path !== "string" || path.trim().length === 0 || path.length > 256 || /[\u0000\r\n]/u.test(path)) {
    throw new ReuseValidationError("invalid_capture");
  }
  const normalized = path.replace(/\[(\d+)\]/gu, ".$1");
  const parts = normalized.split(".");
  if (parts.some((part) => !/^(?:[A-Za-z_$][A-Za-z0-9_$-]*|\d+)$/u.test(part))) {
    throw new ReuseValidationError("invalid_capture");
  }
  return parts;
}

function readPath(root: unknown, parts: readonly string[]): unknown {
  let current = root;
  for (const part of parts) {
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(part)) return undefined;
      current = current[Number(part)];
    } else if (isRecord(current) && Object.hasOwn(current, part)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function writePath(root: unknown, parts: readonly string[], value: unknown): boolean {
  if (parts.length === 0) return false;
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(part) || current[Number(part)] === undefined) return false;
      current = current[Number(part)];
    } else if (isRecord(current) && Object.hasOwn(current, part)) {
      current = current[part];
    } else {
      return false;
    }
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(current)) {
    if (!/^\d+$/u.test(last) || Number(last) >= current.length) return false;
    current[Number(last)] = value;
    return true;
  }
  if (!isRecord(current) || !Object.hasOwn(current, last)) return false;
  current[last] = value;
  return true;
}

function pathString(parts: readonly string[]): string {
  return parts.join(".");
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function isSelector(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  const allowed = new Set(["role", "name", "within", "state"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return Object.values(value).every((entry) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 1024);
}

function assertReusableStep(step: unknown): asserts step is Step {
  if (!isRecord(step) || typeof step.kind !== "string") throw new ReuseValidationError("invalid_capture");
  if (step.kind !== "type" && step.kind !== "setValue") throw new ReuseValidationError("invalid_capture");
  if (!isSelector(step.target)) throw new ReuseValidationError("invalid_capture");
  if (step.expect !== undefined) {
    if (!isRecord(step.expect) || !isSelector(step.expect.target)) throw new ReuseValidationError("invalid_capture");
    if ("valueEquals" in step.expect && typeof step.expect.valueEquals !== "string") throw new ReuseValidationError("invalid_capture");
    if (!("state" in step.expect) && !("valueEquals" in step.expect)) throw new ReuseValidationError("invalid_capture");
  }
}

function validateParameterOptions(options: ReuseCaptureOptions): Map<string, string[][]> {
  if (options === undefined || !Array.isArray(options.parameters)) throw new ReuseValidationError("invalid_capture");
  const byName = new Map<string, string[][]>();
  const usedPaths = new Set<string>();
  for (const parameter of options.parameters) {
    if (!isRecord(parameter) || typeof parameter.name !== "string" || !PARAMETER_NAME.test(parameter.name) || byName.has(parameter.name)) {
      throw new ReuseValidationError("invalid_capture");
    }
    if (!Array.isArray(parameter.paths) || parameter.paths.length === 0) throw new ReuseValidationError("invalid_capture");
    const paths: string[][] = [];
    for (const rawPath of parameter.paths) {
      const parts = normalizePath(rawPath);
      if (parts[0] !== "steps" || parts.length !== 3 && parts.length !== 4 || !/^\d+$/u.test(parts[1])) throw new ReuseValidationError("invalid_capture");
      const path = pathString(parts);
      if (usedPaths.has(path)) throw new ReuseValidationError("invalid_capture");
      usedPaths.add(path);
      paths.push(parts);
    }
    byName.set(parameter.name, paths);
  }
  return byName;
}

function parameterNameAt(paths: Map<string, string[][]>, path: string): string | undefined {
  for (const [name, entries] of paths) {
    if (entries.some((parts) => pathString(parts) === path)) return name;
  }
  return undefined;
}

function allowedParameterPath(step: Step, index: number, parts: readonly string[]): boolean {
  if (parts[0] !== "steps" || parts[1] !== String(index)) return false;
  if (parts.length === 3 && ((step.kind === "type" && parts[2] === "text") || (step.kind === "setValue" && parts[2] === "value"))) return true;
  return parts.length === 4 && parts[2] === "expect" && parts[3] === "valueEquals"
    && (step.kind === "type" || step.kind === "setValue");
}

function parameterizeRequest(request: ActRequest, options: ReuseCaptureOptions): { template: ReuseJson; names: string[] } {
  if (request.observationId !== undefined) throw new ReuseValidationError("invalid_capture");
  const parameterPaths = validateParameterOptions(options);
  const template = cloneJson({ steps: request.steps } as unknown as ReuseJson);
  const names: string[] = [];
  for (const [name, paths] of parameterPaths) {
    for (const parts of paths) {
      const index = Number(parts[1]);
      const step = request.steps[index];
      if (step === undefined || !allowedParameterPath(step, index, parts)) throw new ReuseValidationError("invalid_capture");
      const current = readPath(request, parts);
      if (!isScalar(current)) throw new ReuseValidationError("invalid_capture");
      if (!writePath(template, parts, { [PARAMETER_MARKER]: name })) throw new ReuseValidationError("invalid_capture");
    }
    names.push(name);
  }
  for (let index = 0; index < request.steps.length; index += 1) {
    const step = request.steps[index];
    assertReusableStep(step);
    if (step.expect === undefined) throw new ReuseValidationError("invalid_capture");
    if ((step.kind === "type" || step.kind === "setValue") && !("valueEquals" in step.expect)) {
      throw new ReuseValidationError("invalid_capture");
    }
    if ("valueEquals" in step.expect && step.kind !== "type" && step.kind !== "setValue") {
      throw new ReuseValidationError("invalid_capture");
    }
    const payloadPath = step.kind === "type"
      ? `steps.${index}.text`
      : step.kind === "setValue" ? `steps.${index}.value` : undefined;
    if (payloadPath !== undefined) {
      const expectPath = `steps.${index}.expect.valueEquals`;
      const payloadName = parameterNameAt(parameterPaths, payloadPath);
      const expectName = parameterNameAt(parameterPaths, expectPath);
      if (payloadName === undefined || expectName === undefined || payloadName !== expectName) {
        throw new ReuseValidationError("invalid_capture");
      }
    }
  }
  return { template, names };
}

function markerAt(root: unknown, parts: readonly string[], names: ReadonlySet<string>): string | undefined {
  const value = readPath(root, parts);
  return isParameterMarker(value) && names.has(value[PARAMETER_MARKER]) ? value[PARAMETER_MARKER] : undefined;
}

function hasUnexpectedMarker(value: unknown, path: readonly string[], allowed: ReadonlySet<string>): boolean {
  if (isParameterMarker(value)) return !allowed.has(pathString(path));
  if (Array.isArray(value)) return value.some((entry, index) => hasUnexpectedMarker(entry, [...path, String(index)], allowed));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => hasUnexpectedMarker(entry, [...path, key], allowed));
}

function collectMarkerNames(value: unknown, result = new Set<string>()): Set<string> {
  if (isParameterMarker(value)) {
    result.add(value[PARAMETER_MARKER]);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectMarkerNames(entry, result);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) collectMarkerNames(entry, result);
  }
  return result;
}

function validateTemplateStep(step: unknown, index: number, names: ReadonlySet<string>): boolean {
  if (!isRecord(step) || !isSelector(step.target) || !["type", "setValue"].includes(String(step.kind))) return false;
  if (!isRecord(step.expect) || !isSelector(step.expect.target)) return false;
  if ("state" in step.expect && typeof step.expect.state !== "string") return false;
  if (!("state" in step.expect) && !("valueEquals" in step.expect)) return false;
  if ("state" in step.expect && "valueEquals" in step.expect) return false;
  const payloadPath = step.kind === "type"
    ? ["steps", String(index), "text"]
    : step.kind === "setValue" ? ["steps", String(index), "value"] : undefined;
  const expectPath = ["steps", String(index), "expect", "valueEquals"];
  const allowed = new Set<string>();
  if (payloadPath !== undefined) {
    if (!("valueEquals" in step.expect) || !isParameterMarker(step.expect.valueEquals)) return false;
    const payloadName = markerAt({ steps: [step] }, ["steps", "0", payloadPath[2]], names);
    const expectName = isParameterMarker(step.expect.valueEquals) && names.has(step.expect.valueEquals[PARAMETER_MARKER])
      ? step.expect.valueEquals[PARAMETER_MARKER] : undefined;
    if (payloadName === undefined || expectName === undefined || payloadName !== expectName) return false;
    allowed.add(pathString(payloadPath));
    allowed.add(pathString(expectPath));
  } else if ("valueEquals" in step.expect || hasUnexpectedMarker(step, ["steps", String(index)], new Set())) {
    return false;
  }
  return !hasUnexpectedMarker(step, ["steps", String(index)], allowed);
}

function validateRecord(record: unknown): record is VerifiedStepRecord {
  if (!isRecord(record) || record.version !== 1 || typeof record.key !== "string" || record.key.trim().length === 0 || record.key.length > MAX_KEY_LENGTH || /[\u0000\r\n]/u.test(record.key) || !Array.isArray(record.parameterNames)
    || !record.parameterNames.every((name) => typeof name === "string" && PARAMETER_NAME.test(name))
    || !isJson(record.request) || (record.context !== undefined && !isJson(record.context))
    || (record.coverage !== undefined && !isJson(record.coverage))
    || typeof record.verifiedAt !== "number" || !Number.isSafeInteger(record.verifiedAt) || record.verifiedAt < 0) return false;
  if (!isRecord(record.request) || !Array.isArray(record.request.steps) || record.request.steps.length === 0 || "observationId" in record.request) return false;
  try {
    if (new Set(record.parameterNames).size !== record.parameterNames.length) return false;
    const names = new Set(record.parameterNames);
    if (!record.request.steps.every((step, index) => validateTemplateStep(step, index, names))) return false;
    const markerNames = collectMarkerNames(record.request);
    if (markerNames.size !== names.size || [...markerNames].some((name) => !names.has(name))) return false;
    const serializedRequest = JSON.stringify(record.request);
    if (serializedRequest.includes('"ref"') || serializedRequest.includes('"point"') || serializedRequest.includes('"focusFromStep"')) return false;
  } catch {
    return false;
  }
  const names = new Set(record.parameterNames);
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch {
    return false;
  }
  if (serialized.length > MAX_SERIALIZED_RECORD) return false;
  return !serialized.includes('"$param":""') && [...serialized.matchAll(/"\$param":"([^"]+)"/gu)].every((match) => names.has(match[1]));
}

function validateResult(request: ActRequest, result: ActResult): boolean {
  if (!result || typeof result !== "object" || result.status !== "completed" || !Array.isArray(result.steps) || result.steps.length !== request.steps.length) return false;
  const receipts = new Map<number, StepReceipt>();
  for (const receipt of result.steps) {
    if (!receipt || typeof receipt !== "object" || !Number.isSafeInteger(receipt.index) || receipts.has(receipt.index)) return false;
    receipts.set(receipt.index, receipt);
  }
  return request.steps.every((step, index) => {
    const receipt = receipts.get(index + 1);
    return step.expect !== undefined && receipt?.index === index + 1 && receipt.kind === step.kind && receipt.status === "verified";
  });
}

function parseStorePayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.records)) return value.records;
  return [];
}

function validStoredRecords(value: unknown): VerifiedStepRecord[] {
  return parseStorePayload(value)
    .filter((record): record is VerifiedStepRecord => validateRecord(record))
    .map((record) => cloneJson(record as unknown as ReuseJson) as unknown as VerifiedStepRecord)
    .sort((left, right) => right.verifiedAt - left.verifiedAt)
    .slice(0, MAX_RECORDS);
}

function serializeRecord(record: VerifiedStepRecord): VerifiedStepRecord {
  return cloneJson(record as unknown as ReuseJson) as unknown as VerifiedStepRecord;
}

function substitute(template: ReuseJson, values: Readonly<Record<string, string | number | boolean>>, names: readonly string[]): ReuseJson | undefined {
  const allowed = new Set(names);
  for (const name of names) {
    if (!Object.hasOwn(values, name) || !isScalar(values[name])) return undefined;
  }
  if (Object.keys(values).some((name) => !allowed.has(name))) return undefined;
  if (isParameterMarker(template)) return values[template[PARAMETER_MARKER]] as ReuseJson;
  if (Array.isArray(template)) {
    const result: ReuseJson[] = [];
    for (const entry of template) {
      const replaced = substitute(entry, values, names);
      if (replaced === undefined) return undefined;
      result.push(replaced);
    }
    return result;
  }
  if (template !== null && typeof template === "object") {
    const result: { [key: string]: ReuseJson } = {};
    for (const [key, value] of Object.entries(template)) {
      const replaced = substitute(value, values, names);
      if (replaced === undefined) return undefined;
      result[key] = replaced;
    }
    return result;
  }
  return template;
}

function contextMatches(record: VerifiedStepRecord, options: ReuseRunOptions): ReuseMissCode | undefined {
  if (record.context !== undefined && canonicalJson(record.context) !== canonicalJson(options.context)) return "context_mismatch";
  if (record.context === undefined && options.context !== undefined) return "context_mismatch";
  if (record.coverage !== undefined && canonicalJson(record.coverage) !== canonicalJson(options.coverage)) return "coverage_mismatch";
  if (record.coverage === undefined && options.coverage !== undefined) return "coverage_mismatch";
  return undefined;
}

/** A simple serializable in-memory store for tests and hosts without persistence. */
export class MemoryVerifiedStepReuseStore implements VerifiedStepReuseStore {
  private records: VerifiedStepRecord[] = [];
  private readonly maxRecords: number;

  public constructor(initial: readonly VerifiedStepRecord[] = [], maxRecords = 128) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) throw new ReuseValidationError("invalid_store");
    this.maxRecords = maxRecords;
    this.records = validStoredRecords(initial).slice(0, maxRecords);
  }

  public load(): VerifiedStepRecord[] {
    return this.records.map(serializeRecord);
  }

  public list(): VerifiedStepRecord[] {
    return this.load();
  }

  public get(key: string): VerifiedStepRecord | undefined {
    const record = this.records.find((entry) => entry.key === key);
    return record === undefined ? undefined : serializeRecord(record);
  }

  public put(record: VerifiedStepRecord): void {
    this.records = validStoredRecords([record, ...this.records.filter((entry) => entry.key !== record.key)]).slice(0, this.maxRecords);
  }

  public delete(key: string): boolean {
    const next = this.records.filter((entry) => entry.key !== key);
    const changed = next.length !== this.records.length;
    this.records = next;
    return changed;
  }

  public save(records: readonly VerifiedStepRecord[]): void {
    this.records = validStoredRecords(records).slice(0, this.maxRecords);
  }
}

export interface VerifiedStepReuse {
  /** Execute through the same public session act boundary and retain private provenance. */
  act(raw: unknown, signal?: AbortSignal): Promise<ActResult>;
  /** Resume an approval returned by this reuse instance's act call. */
  resolveApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalResolution>;
  /** Capture only a completed result returned by this instance's act/resolveApproval methods. */
  remember(key: string, request: ActRequest, result: ActResult, options: ReuseCaptureOptions): Promise<VerifiedStepRecord>;
  run(key: string, options?: ReuseRunOptions): Promise<ReuseRunResult>;
  reuse(key: string, options?: ReuseRunOptions): Promise<ReuseRunResult>;
  get(key: string): Promise<VerifiedStepRecord | undefined>;
  list(): Promise<readonly VerifiedStepRecord[]>;
  forget(key: string): Promise<boolean>;
}

export interface VerifiedStepReuseOptions {
  session: DeskSession;
  store?: VerifiedStepReuseStore;
  /** Bound for the built-in/snapshot stores; a shared per-key store owns its capacity policy. */
  maxRecords?: number;
}

const storeWriteQueues = new WeakMap<object, Promise<void>>();

async function withStoreWriteLock<T>(store: VerifiedStepReuseStore, operation: () => Promise<T>): Promise<T> {
  const previous = storeWriteQueues.get(store as object) ?? Promise.resolve();
  let resolveQueue!: () => void;
  const queue = new Promise<void>((resolve) => { resolveQueue = resolve; });
  const queued = previous.then(() => queue, () => queue);
  storeWriteQueues.set(store as object, queued);
  await previous;
  try {
    return await operation();
  } finally {
    resolveQueue();
    if (storeWriteQueues.get(store as object) === queued) storeWriteQueues.delete(store as object);
  }
}

interface ActProvenance {
  readonly request: ReuseJson;
  readonly requestSignature: string;
  readonly resultSignature: string;
}

function jsonSnapshot(value: unknown): ReuseJson | undefined {
  return isJson(value) ? cloneJson(value) : undefined;
}

function resultProvenance(result: unknown, request: ReuseJson | undefined): ActProvenance | undefined {
  if (request === undefined) return undefined;
  const snapshot = jsonSnapshot(result);
  if (snapshot === undefined) return undefined;
  return {
    request,
    requestSignature: canonicalJson(request),
    resultSignature: canonicalJson(snapshot),
  };
}

/**
 * Construct an optional verified-step cache. This wrapper never dispatches
 * directly: every reuse calls the session's public `act`, so live target
 * resolution, expectations, risk policy, and approval remain authoritative.
 */
export function createVerifiedStepReuse(options: VerifiedStepReuseOptions): VerifiedStepReuse {
  if (!options || !options.session || typeof options.session.act !== "function") throw new ReuseValidationError("invalid_store");
  const maxRecords = options.maxRecords === undefined ? 128 : options.maxRecords;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) throw new ReuseValidationError("invalid_store");
  const store = options.store ?? new MemoryVerifiedStepReuseStore([], maxRecords);
  const perKeyStore = typeof store.get === "function" && typeof store.put === "function";
  const snapshotStore = typeof store.load === "function" && typeof store.save === "function";
  if (!perKeyStore && !snapshotStore) throw new ReuseValidationError("invalid_store");

  const provenanceByResult = new WeakMap<object, ActProvenance>();
  const pendingProvenance = new Map<string, ActProvenance>();

  function rememberProvenance(result: unknown, provenance: ActProvenance | undefined): void {
    if (provenance === undefined || result === null || typeof result !== "object") return;
    provenanceByResult.set(result, provenance);
    const requestId = (result as { requestId?: unknown }).requestId;
    const code = (result as { code?: unknown }).code;
    if (code === "approval_required" && typeof requestId === "string") pendingProvenance.set(requestId, provenance);
  }

  async function read(): Promise<VerifiedStepRecord[]> {
    try {
      const value = typeof store.list === "function"
        ? await store.list()
        : typeof store.load === "function" ? await store.load() : [];
      return validStoredRecords(value);
    } catch {
      throw new ReuseValidationError("invalid_store");
    }
  }

  async function readOne(key: string): Promise<VerifiedStepRecord | undefined> {
    try {
      if (perKeyStore) {
        const value = await store.get!(key);
        return validateRecord(value) && value.key === key ? serializeRecord(value) : undefined;
      }
      return (await read()).find((entry) => entry.key === key);
    } catch {
      throw new ReuseValidationError("invalid_store");
    }
  }

  async function write(records: readonly VerifiedStepRecord[]): Promise<void> {
    try {
      if (typeof store.save !== "function") throw new Error("snapshot_store_unavailable");
      await store.save(records.map(serializeRecord));
    } catch {
      throw new ReuseValidationError("invalid_store");
    }
  }

  const api: VerifiedStepReuse = {
    async act(raw, signal) {
      const request = jsonSnapshot(raw);
      const result = await options.session.act(raw, signal);
      rememberProvenance(result, resultProvenance(result, request));
      return result;
    },

    async resolveApproval(requestId, decision) {
      const provenance = pendingProvenance.get(requestId);
      const result = await options.session.resolveApproval(requestId, decision);
      pendingProvenance.delete(requestId);
      rememberProvenance(result, provenance === undefined ? undefined : resultProvenance(result, provenance.request));
      return result;
    },

    async remember(key, request, result, captureOptions) {
      const normalizedKey = normalizeKey(key);
      if (captureOptions === undefined || captureOptions === null) throw new ReuseValidationError("invalid_capture");
      const provenance = result !== null && typeof result === "object" ? provenanceByResult.get(result) : undefined;
      const requestSnapshot = jsonSnapshot(request);
      if (provenance === undefined || requestSnapshot === undefined || provenance.requestSignature !== canonicalJson(requestSnapshot)) {
        throw new ReuseValidationError("invalid_capture");
      }
      const resultSnapshot = jsonSnapshot(result);
      if (resultSnapshot === undefined || provenance.resultSignature !== canonicalJson(resultSnapshot)) {
        throw new ReuseValidationError("invalid_capture");
      }
      let validated: ActRequest;
      try {
        validated = validateRequest(request, options.session.capabilities, options.session.limits);
      } catch {
        throw new ReuseValidationError("invalid_capture");
      }
      if (!validateResult(validated, result)) throw new ReuseValidationError("invalid_capture");
      if (captureOptions.context !== undefined && !isJson(captureOptions.context)) throw new ReuseValidationError("invalid_capture");
      if (captureOptions.coverage !== undefined && !isJson(captureOptions.coverage)) throw new ReuseValidationError("invalid_capture");
      const { template, names } = parameterizeRequest(validated, captureOptions);
      const verifiedAt = captureOptions.now ?? Date.now();
      if (!Number.isSafeInteger(verifiedAt) || verifiedAt < 0) throw new ReuseValidationError("invalid_capture");
      const record = serializeRecord({
        version: 1,
        key: normalizedKey,
        request: template,
        parameterNames: names,
        ...(captureOptions.context === undefined ? {} : { context: cloneJson(captureOptions.context) }),
        ...(captureOptions.coverage === undefined ? {} : { coverage: cloneJson(captureOptions.coverage) }),
        verifiedAt,
      });
      if (!validateRecord(record)) throw new ReuseValidationError("invalid_capture");
      if (perKeyStore) {
        try {
          await store.put!(record);
        } catch {
          throw new ReuseValidationError("invalid_store");
        }
        return record;
      }
      return withStoreWriteLock(store, async () => {
        const records = await read();
        const next = [record, ...records.filter((entry) => entry.key !== normalizedKey)]
          .sort((left, right) => right.verifiedAt - left.verifiedAt)
          .slice(0, maxRecords);
        await write(next);
        return record;
      });
    },

    async run(key, runOptions = {}) {
      const normalizedKey = normalizeKey(key);
      if (!isRecord(runOptions)) return { status: "miss", reused: false, key: normalizedKey, code: "parameter_invalid" };
      const normalizedOptions = runOptions as ReuseRunOptions;
      if (normalizedOptions.context !== undefined && !isJson(normalizedOptions.context)) return { status: "miss", reused: false, key: normalizedKey, code: "context_mismatch" };
      if (normalizedOptions.coverage !== undefined && !isJson(normalizedOptions.coverage)) return { status: "miss", reused: false, key: normalizedKey, code: "coverage_mismatch" };
      let record: VerifiedStepRecord | undefined;
      try {
        record = await readOne(normalizedKey);
      } catch {
        return { status: "miss", reused: false, key: normalizedKey, code: "store_error" };
      }
      if (!record) return { status: "miss", reused: false, key: normalizedKey, code: "reuse_not_found" };
      const contextCode = contextMatches(record, normalizedOptions);
      if (contextCode) return { status: "miss", reused: false, key: normalizedKey, code: contextCode };
      const values = normalizedOptions.values ?? {};
      if (!isRecord(values)) return { status: "miss", reused: false, key: normalizedKey, code: "parameter_invalid" };
      const materialized = substitute(record.request, values as Readonly<Record<string, string | number | boolean>>, record.parameterNames);
      if (!materialized) {
        const missing = record.parameterNames.some((name) => !Object.hasOwn(values, name));
        return { status: "miss", reused: false, key: normalizedKey, code: missing ? "parameter_missing" : "parameter_invalid" };
      }
      let request: ActRequest;
      try {
        request = validateRequest(materialized, options.session.capabilities, options.session.limits);
      } catch {
        return { status: "miss", reused: false, key: normalizedKey, code: "request_invalid" };
      }
      const result = await options.session.act(request, normalizedOptions.signal);
      const succeeded = result.status === "completed"
        && result.steps.length === request.steps.length
        && result.steps.every((receipt, index) => receipt.index === index + 1 && receipt.status === "verified");
      return { status: result.status, reused: true, succeeded, key: normalizedKey, record, result };
    },

    async reuse(key, runOptions = {}) {
      return api.run(key, runOptions);
    },

    async get(key) {
      const normalizedKey = normalizeKey(key);
      const record = await readOne(normalizedKey);
      return record === undefined ? undefined : serializeRecord(record);
    },

    async list() {
      return (await read()).map(serializeRecord);
    },

    async forget(key) {
      const normalizedKey = normalizeKey(key);
      if (perKeyStore) {
        if (typeof store.delete !== "function") return false;
        try {
          return Boolean(await store.delete(normalizedKey));
        } catch {
          throw new ReuseValidationError("invalid_store");
        }
      }
      return withStoreWriteLock(store, async () => {
        const records = await read();
        const next = records.filter((entry) => entry.key !== normalizedKey);
        if (next.length === records.length) return false;
        await write(next);
        return true;
      });
    },
  };
  return api;
}
