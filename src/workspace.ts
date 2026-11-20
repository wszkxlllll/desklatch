import type { ActResult, ApprovalDecision, ApprovalResolution, DeskSession } from "./core/session-types.js";
import type { Capability } from "./contracts.js";
import { actToolSchema } from "./request.js";
import { addReuseActSchema, reuseQuerySchema } from "./reuse-tools.js";
import type { DiscoverableStepReuse } from "./reuse-tools.js";
import { createDeskTools, observeInputSchema, type ToolEndpoint } from "./tools.js";

export interface WorkspaceApplicationInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/** Context supplied to a trusted host activator and its independent verifier. */
export interface WorkspaceActivationContext {
  readonly application: WorkspaceApplicationInfo;
  readonly previous?: WorkspaceApplicationInfo;
  readonly signal?: AbortSignal;
}

export interface WorkspaceNavigationContext extends WorkspaceActivationContext {
  readonly url: string;
}

export type WorkspaceActivator =
  (context: WorkspaceActivationContext) => unknown | Promise<unknown>;
export type WorkspaceFrontVerifier =
  (context: WorkspaceActivationContext) => boolean | Promise<boolean>;
export type WorkspaceNavigator =
  (context: WorkspaceNavigationContext) => unknown | Promise<unknown>;

/** Host-owned application and its already-authorized DeskSession. */
export interface WorkspaceApplication {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly session: DeskSession;
  readonly activate?: WorkspaceActivator;
  /** Must independently return true after activate has completed. */
  readonly verifyFront?: WorkspaceFrontVerifier;
  /** Optional browser adapter; its own URL allowlist remains authoritative. */
  readonly navigate?: WorkspaceNavigator;
  /** Optional host-owned pair for discovering and replaying verified steps. */
  readonly stepReuse?: DiscoverableStepReuse;
}

export interface WorkspaceOpenedApplication {
  readonly session: DeskSession;
  readonly activate?: WorkspaceActivator;
  readonly verifyFront?: WorkspaceFrontVerifier;
  readonly navigate?: WorkspaceNavigator;
  /** Optional host-owned pair for discovering and replaying verified steps. */
  readonly stepReuse?: DiscoverableStepReuse;
}

export interface OnDemandWorkspaceApplication {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly capabilities: readonly Capability[];
  readonly allowModelDocumentText?: boolean;
  readonly allowModelImages?: boolean;
  readonly allowNavigation?: boolean;
  /** Advertise step-reuse fields before the application is opened. */
  readonly allowStepReuse?: boolean;
  readonly open: (signal?: AbortSignal) => WorkspaceApplication | WorkspaceOpenedApplication | Promise<WorkspaceApplication | WorkspaceOpenedApplication>;
}

export type WorkspaceApplicationEntry = WorkspaceApplication | OnDemandWorkspaceApplication;

export type WorkspaceDiscovery = (context: {
  readonly active: string | null;
  readonly applications: readonly WorkspaceApplicationInfo[];
  readonly signal?: AbortSignal;
}) => readonly WorkspaceApplicationEntry[] | Promise<readonly WorkspaceApplicationEntry[]>;

export interface WorkspaceOptions {
  readonly applications?: readonly WorkspaceApplicationEntry[];
  readonly initialActive?: string | WorkspaceApplicationEntry | null;
  readonly discover?: WorkspaceDiscovery;
  /** Host-owned user preference for whether an enrolled app/window may be automated. */
  readonly canAutomate?: (application: WorkspaceApplicationInfo) => boolean;
}

export interface WorkspaceObservation {
  readonly active: string | null;
  readonly applications: readonly WorkspaceApplicationInfo[];
}

export interface WorkspaceActResult extends ActResult {
  readonly active?: string | null;
  readonly applicationId?: string;
}

export interface Workspace {
  /** Exactly the two model-facing endpoints: observe and act. */
  readonly tools: readonly ToolEndpoint[];
  readonly applications: readonly WorkspaceApplicationInfo[];
  readonly activeApplicationId: string | null;
  observe(input?: unknown, signal?: AbortSignal): Promise<unknown>;
  act(input: unknown, signal?: AbortSignal): Promise<unknown>;
  resolveApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalResolution>;
  correct(reason?: string): void;
  cancel(reason?: string): void;
  registerApplication(application: WorkspaceApplicationEntry): WorkspaceApplicationInfo;
  close(): Promise<void>;
}

interface ObservationBinding {
  readonly applicationId: string;
  readonly activation: number;
}

const MAX_REUSE_REFS = 1024;

interface ApprovalBinding {
  readonly applicationId: string;
  readonly activation: number;
  readonly session: DeskSession;
}

type OperationReason = "corrected" | "cancelled" | "closed";

interface OperationRecord {
  readonly generation: number;
  readonly controller: AbortController;
  removeExternalAbort?: () => void;
}

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: AnyRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneSchema(value: AnyRecord): AnyRecord {
  return JSON.parse(JSON.stringify(value)) as AnyRecord;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function infoFor(application: WorkspaceApplicationEntry): WorkspaceApplicationInfo {
  return Object.freeze({
    id: application.id,
    name: application.name,
    ...(application.description === undefined ? {} : { description: application.description }),
  });
}

const normalizedOnDemand = new WeakMap<object, OnDemandWorkspaceApplication>();

function isOnDemandApplication(value: WorkspaceApplicationEntry): value is OnDemandWorkspaceApplication {
  return isRecord(value) && !hasOwn(value, "session") && Array.isArray(value.capabilities) && typeof value.open === "function";
}

function isValidStepReuse(value: unknown, session: DeskSession): value is DiscoverableStepReuse {
  if (!isRecord(value) || value.session !== session || typeof value.close !== "function" || !Array.isArray(value.tools)) return false;
  if (value.tools.length !== 2) return false;
  const names = value.tools.map((tool) => isRecord(tool) && typeof tool.name === "string" ? tool.name : undefined);
  if (!(names.includes("observe") && names.includes("act"))) return false;
  return value.tools.every((tool) => isRecord(tool)
    && typeof tool.name === "string"
    && typeof tool.description === "string"
    && isRecord(tool.inputSchema)
    && typeof tool.invoke === "function");
}

function normalizeApplication(application: WorkspaceApplication): WorkspaceApplication {
  if (!isRecord(application) || !validId(application.id)
    || typeof application.name !== "string" || !application.name.trim()) {
    throw new TypeError("invalid_workspace_application");
  }
  if (!application.session || typeof application.session.observe !== "function"
    || typeof application.session.act !== "function" || typeof application.session.close !== "function") {
    throw new TypeError("invalid_workspace_session");
  }
  if (application.stepReuse !== undefined && !isValidStepReuse(application.stepReuse, application.session)) {
    throw new TypeError("invalid_workspace_step_reuse");
  }
  return application;
}

function normalizeOnDemandApplication(application: OnDemandWorkspaceApplication): OnDemandWorkspaceApplication {
  if (!isRecord(application) || !validId(application.id)
    || typeof application.name !== "string" || !application.name.trim()
    || !Array.isArray(application.capabilities) || typeof application.open !== "function") {
    throw new TypeError("invalid_on_demand_workspace_application");
  }
  const cached = normalizedOnDemand.get(application);
  if (cached) return cached;
  if (Object.isFrozen(application)) return application;
  const normalized = Object.freeze({
    id: application.id,
    name: application.name,
    ...(application.description === undefined ? {} : { description: application.description }),
    capabilities: Object.freeze([...application.capabilities]),
    ...(application.allowModelDocumentText === undefined ? {} : { allowModelDocumentText: application.allowModelDocumentText === true }),
    ...(application.allowModelImages === undefined ? {} : { allowModelImages: application.allowModelImages === true }),
    ...(application.allowNavigation === undefined ? {} : { allowNavigation: application.allowNavigation === true }),
    ...(application.allowStepReuse === undefined ? {} : { allowStepReuse: application.allowStepReuse === true }),
    open: application.open,
  });
  normalizedOnDemand.set(application, normalized);
  return normalized;
}

function sameOnDemandDeclaration(left: OnDemandWorkspaceApplication, right: OnDemandWorkspaceApplication): boolean {
  return left.id === right.id && left.name === right.name && left.description === right.description
    && left.allowModelDocumentText === right.allowModelDocumentText
    && left.allowModelImages === right.allowModelImages
    && left.allowNavigation === right.allowNavigation
    && left.allowStepReuse === right.allowStepReuse
    && JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities);
}

const SAFE_HOST_CODES = new Set([
  "activation_failed", "activation_driver_refused", "activation_not_verified", "activation_unsupported", "activation_cancelled",
  "navigation_failed", "navigation_not_authorized", "navigation_not_allowed", "navigation_unsupported",
  "unauthorized_navigation", "browser_origin_not_allowlisted",
  "invalid_url", "url_too_large", "unsupported_scheme", "credentials_not_allowed", "unauthorized_origin",
  "redirect_blocked", "final_url_invalid", "final_origin_untrusted", "navigation_unavailable",
  "navigation_busy", "page_closed",
  "cancelled", "closed", "aborted",
]);

function hostCode(error: unknown, fallback: string): string {
  const value = isRecord(error) && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : undefined;
  return value && SAFE_HOST_CODES.has(value) ? value : fallback;
}

function stepsForRequest(input: unknown, code: string): ActResult["steps"] {
  if (!isRecord(input) || !Array.isArray(input.steps)) return [];
  return input.steps.map((_step, index) => ({ index: index + 1, status: "not_dispatched" as const, code }));
}

function stopped(code: string, input?: unknown, active: string | null = null): WorkspaceActResult {
  return { status: "stopped", code, steps: stepsForRequest(input, code), active };
}

function childSteps(value: unknown): ActResult["steps"] {
  return isRecord(value) && Array.isArray(value.steps) ? value.steps as ActResult["steps"] : [];
}

function interruptedChildResult(value: unknown, code: string, active: string | null): WorkspaceActResult {
  return { status: "stopped", code, steps: childSteps(value), active };
}

function interruptedApproval(value: unknown, requestId: string, code: string): ApprovalResolution {
  return { requestId, status: "stopped", code, steps: childSteps(value) };
}

function rejected(code: string, input?: unknown): WorkspaceActResult {
  return { status: "rejected", code, steps: stepsForRequest(input, code) };
}

function completed(code: string, active: string, extra: AnyRecord = {}): WorkspaceActResult {
  return { status: "completed", code, steps: [], active, applicationId: active, ...extra };
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function annotate(value: unknown, application: WorkspaceApplication): unknown {
  if (!isRecord(value)) return value;
  return { ...value, applicationId: application.id, application: infoFor(application) };
}

function callbackResult(value: unknown, active: string): WorkspaceActResult {
  if (isRecord(value) && (value.status === "completed" || value.status === "stopped" || value.status === "rejected")) {
    return {
      ...value,
      active,
      applicationId: active,
      steps: Array.isArray(value.steps) ? value.steps as WorkspaceActResult["steps"] : [],
    } as WorkspaceActResult;
  }
  if (isRecord(value)) {
    const { status: _status, ...extra } = value;
    return completed(typeof value.code === "string" ? value.code : "dispatched", active, extra);
  }
  return completed("dispatched", active);
}

/** Register host-owned metadata now and defer session creation until activation. */
export function createOnDemandWorkspaceApplication(
  options: OnDemandWorkspaceApplication,
): OnDemandWorkspaceApplication {
  return normalizeOnDemandApplication(options);
}

/** Create a workspace whose only model surface is the existing observe/act pair. */
export function createWorkspace(options: WorkspaceOptions = {}): Workspace {
  const entries = new Map<string, WorkspaceApplicationEntry>();
  const applications = new Map<string, WorkspaceApplication>();
  const sessionTools = new Map<string, readonly ToolEndpoint[]>();
  const observations = new Map<string, ObservationBinding>();
  const reuseRefs = new Map<string, ObservationBinding>();
  const approvals = new Map<string, ApprovalBinding>();
  const approvalResults = new Map<string, ApprovalResolution>();
  const closedStepReuses = new WeakSet<object>();
  let activeId: string | null = null;
  let activation = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let discoveryInFlight: Promise<void> | undefined;
  let sequence: Promise<void> = Promise.resolve();
  let operationGeneration = 0;
  let operationReason: OperationReason = "cancelled";
  let runningOperation: OperationRecord | undefined;
  const queuedOperations = new Set<OperationRecord>();

  function operationCode(record: OperationRecord): OperationReason {
    if (closed || record.controller.signal.reason === "closed") return "closed";
    if (record.generation !== operationGeneration) return operationReason;
    return record.controller.signal.aborted ? "cancelled" : operationReason;
  }

  function enqueue<T>(
    operation: (signal: AbortSignal, generation: number, record: OperationRecord) => Promise<T>,
    stale: (record: OperationRecord) => T,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const record: OperationRecord = {
      generation: operationGeneration,
      controller: new AbortController(),
    };
    if (externalSignal) {
      const abort = (): void => record.controller.abort("cancelled");
      if (externalSignal.aborted) abort();
      else externalSignal.addEventListener("abort", abort, { once: true });
      record.removeExternalAbort = () => externalSignal.removeEventListener("abort", abort);
    }
    queuedOperations.add(record);
    const execute = async (): Promise<T> => {
      queuedOperations.delete(record);
      if (closed || record.generation !== operationGeneration || record.controller.signal.aborted) {
        record.removeExternalAbort?.();
        return stale(record);
      }
      runningOperation = record;
      try {
        return await operation(record.controller.signal, record.generation, record);
      } finally {
        if (runningOperation === record) runningOperation = undefined;
        record.removeExternalAbort?.();
      }
    };
    const run = sequence.then(execute, execute);
    sequence = run.then(() => undefined, () => undefined);
    return run;
  }

  function abortOperations(reason: OperationReason): void {
    operationReason = reason;
    operationGeneration += 1;
    for (const record of queuedOperations) record.controller.abort(reason);
    runningOperation?.controller.abort(reason);
  }

  function addApplication(value: WorkspaceApplicationEntry): WorkspaceApplicationInfo {
    const application = isOnDemandApplication(value) ? normalizeOnDemandApplication(value) : normalizeApplication(value);
    const prior = entries.get(application.id);
    if (prior && prior !== application) {
      const priorLazy = isOnDemandApplication(prior);
      const currentLazy = isOnDemandApplication(application);
      if (priorLazy && currentLazy && prior.open === application.open) {
        if (!sameOnDemandDeclaration(prior, application)) throw new Error("duplicate_workspace_application");
        return infoFor(prior);
      }
      if (priorLazy || currentLazy) throw new Error("duplicate_workspace_application");
      if (prior.session !== application.session) throw new Error("duplicate_workspace_application");
    }
    entries.set(application.id, application);
    if (!isOnDemandApplication(application)) applications.set(application.id, application);
    sessionTools.delete(application.id);
    return infoFor(application);
  }

  for (const application of options.applications ?? []) addApplication(application);

  function seedId(value: string | WorkspaceApplicationEntry | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const id = typeof value === "string" ? value : value.id;
    if (!validId(id) || !entries.has(id)) throw new Error("unknown_workspace_application");
    if (isOnDemandApplication(entries.get(id)!)) throw new Error("initial_active_requires_open_application");
    return id;
  }

  activeId = seedId(options.initialActive);
  if (activeId !== null) activation = 1;

  function canAutomateEntry(entry: WorkspaceApplicationEntry | undefined): boolean {
    if (!entry || !options.canAutomate) return entry !== undefined;
    try {
      return options.canAutomate(infoFor(entry)) === true;
    } catch {
      return false;
    }
  }

  function publicActiveId(): string | null {
    if (!activeId || !canAutomateEntry(entries.get(activeId))) return null;
    return activeId;
  }

  function visibleEntries(): readonly WorkspaceApplicationEntry[] {
    return [...entries.values()].filter((entry) => canAutomateEntry(entry));
  }

  async function discover(signal?: AbortSignal): Promise<void> {
    if (!options.discover) return;
    if (discoveryInFlight) return discoveryInFlight;
    discoveryInFlight = Promise.resolve(options.discover({
      active: activeId,
      applications: [...entries.values()].map(infoFor),
      signal,
    })).then((found) => {
      if (closed || signal?.aborted) return;
      if (!Array.isArray(found)) throw new TypeError("invalid_workspace_discovery");
      for (const application of found) addApplication(application);
    }).finally(() => { discoveryInFlight = undefined; });
    await discoveryInFlight;
  }

  function invalidateObservations(): void {
    observations.clear();
    reuseRefs.clear();
  }

  function operationStop(record: OperationRecord, input?: unknown, active: string | null = activeId): WorkspaceActResult | undefined {
    if (!record.controller.signal.aborted && record.generation === operationGeneration && !closed) return undefined;
    return stopped(operationCode(record), input, active);
  }

  function current(): WorkspaceApplication | undefined {
    return activeId === null ? undefined : applications.get(activeId);
  }

  async function closeStepReuse(value: DiscoverableStepReuse | undefined): Promise<void> {
    if (!value || typeof value !== "object" || closedStepReuses.has(value)) return;
    closedStepReuses.add(value);
    await value.close().catch(() => undefined);
  }

  async function closeApplication(value: WorkspaceApplication): Promise<void> {
    if (value.stepReuse) await closeStepReuse(value.stepReuse);
    else await value.session.close().catch(() => undefined);
  }

  async function materialize(entry: OnDemandWorkspaceApplication, signal: AbortSignal, record: OperationRecord): Promise<WorkspaceApplication> {
    const cached = applications.get(entry.id);
    if (cached) return cached;
    const opened = await entry.open(signal);
    const candidate = isRecord(opened) && "session" in opened
      ? {
        id: typeof opened.id === "string" ? opened.id : entry.id,
        name: typeof opened.name === "string" ? opened.name : entry.name,
        ...(typeof opened.description === "string" ? { description: opened.description } : entry.description === undefined ? {} : { description: entry.description }),
        session: opened.session,
        ...(typeof opened.activate === "function" ? { activate: opened.activate.bind(opened) } : {}),
        ...(typeof opened.verifyFront === "function" ? { verifyFront: opened.verifyFront.bind(opened) } : {}),
        ...(entry.allowNavigation === true && typeof opened.navigate === "function" ? { navigate: opened.navigate.bind(opened) } : {}),
        ...(entry.allowStepReuse === true && hasOwn(opened, "stepReuse") ? { stepReuse: opened.stepReuse } : {}),
      } : undefined;
    let application: WorkspaceApplication;
    try {
      if (!candidate || candidate.id !== entry.id) throw new TypeError("invalid_on_demand_open_result");
      application = normalizeApplication(candidate);
    } catch (error) {
      if (candidate?.stepReuse && isRecord(candidate.stepReuse) && typeof candidate.stepReuse.close === "function") {
        await (candidate.stepReuse.close as () => Promise<void>)().catch(() => undefined);
      }
      if (candidate?.session) await candidate.session.close().catch(() => undefined);
      throw error;
    }
    if (operationStop(record)) {
      await closeApplication(application);
      return application;
    }
    applications.set(entry.id, application);
    sessionTools.delete(entry.id);
    return application;
  }

  function rememberObservation(value: unknown, applicationId: string): void {
    if (!isRecord(value)) return;
    const ids = new Set<string>();
    if (typeof value.observationId === "string") ids.add(value.observationId);
    if (Array.isArray(value.candidates)) {
      for (const candidate of value.candidates) {
        if (isRecord(candidate) && typeof candidate.observationId === "string") ids.add(candidate.observationId);
      }
    }
    for (const id of ids) observations.set(id, { applicationId, activation });
    if (Array.isArray(value.reuseCandidates)) {
      for (const candidate of value.reuseCandidates) {
        if (!isRecord(candidate) || typeof candidate.ref !== "string" || candidate.ref.trim().length === 0) continue;
        reuseRefs.set(candidate.ref, { applicationId, activation });
      }
      while (reuseRefs.size > MAX_REUSE_REFS) {
        const oldest = reuseRefs.keys().next().value;
        if (typeof oldest !== "string") break;
        reuseRefs.delete(oldest);
      }
    }
  }

  function isStaleObservation(input: unknown, appId: string): boolean {
    if (!isRecord(input) || typeof input.observationId !== "string") return false;
    const binding = observations.get(input.observationId);
    return !binding || binding.applicationId !== appId || binding.activation !== activation;
  }

  function isStaleReuse(input: unknown, appId: string): boolean {
    if (!isRecord(input) || !isRecord(input.reuse) || typeof input.reuse.ref !== "string") return false;
    const binding = reuseRefs.get(input.reuse.ref);
    return !binding || binding.applicationId !== appId || binding.activation !== activation;
  }

  function deskTools(application: WorkspaceApplication): readonly ToolEndpoint[] {
    const cached = sessionTools.get(application.id);
    if (cached) return cached;
    const stepReuse = application.stepReuse;
    if (stepReuse !== undefined && !isValidStepReuse(stepReuse, application.session)) {
      throw new TypeError("invalid_workspace_step_reuse");
    }
    const tools = Object.freeze(stepReuse ? [...stepReuse.tools] : createDeskTools(application.session));
    sessionTools.set(application.id, tools);
    return tools;
  }

  function findTool(application: WorkspaceApplication, name: string): ToolEndpoint | undefined {
    return deskTools(application).find((tool) => tool.name === name);
  }

  async function dispatchObserve(input: unknown, signal: AbortSignal, record: OperationRecord): Promise<unknown> {
    if (closed) return stopped("closed", undefined, null);
    const application = current();
    if (!application) return stopped("no_active_application");
    if (!canAutomateEntry(entries.get(application.id))) return stopped("application_automation_blocked", undefined, null);
    if (isRecord(input) && hasOwn(input, "reuseQuery") && !application.stepReuse) {
      return stopped("reuse_unsupported", input, application.id);
    }
    const tool = findTool(application, "observe");
    if (!tool) return stopped("observe_unsupported", undefined, application.id);
    const result = await tool.invoke(input, signal);
    const interrupted = operationStop(record, undefined, application.id);
    if (interrupted) return interrupted;
    rememberObservation(result, application.id);
    return annotate(result, application);
  }

  async function dispatchAct(input: unknown, signal: AbortSignal, record: OperationRecord): Promise<unknown> {
    if (closed) return stopped("closed", input, null);
    if (!options.canAutomate && isRecord(input) && typeof input.observationId === "string"
      && isStaleObservation(input, activeId ?? "")) {
      return stopped("stale_observation", input, activeId);
    }
    const application = current();
    if (!application) return stopped("no_active_application", input);
    if (!canAutomateEntry(entries.get(application.id))) return stopped("application_automation_blocked", input, null);
    if (isRecord(input) && hasOwn(input, "reuseQuery")) return rejected("invalid_workspace_act", input);
    if (isRecord(input) && hasOwn(input, "reuse")) {
      if (!application.stepReuse) return stopped("reuse_unsupported", input, application.id);
      if (isStaleReuse(input, application.id)) return stopped("stale_reuse", input, application.id);
    }
    if (isRecord(input) && typeof input.observationId === "string" && isStaleObservation(input, application.id)) {
      return stopped("stale_observation", input, application.id);
    }
    const tool = findTool(application, "act");
    if (!tool) return stopped("act_unsupported", input, application.id);
    const result = await tool.invoke(input, signal);
    const interrupted = operationStop(record, input, application.id);
    if (interrupted) {
      return interruptedChildResult(result, operationCode(record), closed ? null : application.id);
    }
    rememberObservation(result, application.id);
    if (isRecord(result) && typeof result.requestId === "string") {
      approvals.set(result.requestId, { applicationId: application.id, activation, session: application.session });
    }
    return annotate(result, application);
  }

  async function retainPreviousOrClear(previous: WorkspaceApplication | undefined, signal?: AbortSignal): Promise<void> {
    if (!previous || !previous.verifyFront) {
      activeId = null;
      return;
    }
    try {
      const verified = await previous.verifyFront({ application: infoFor(previous), signal });
      if (verified === true) return;
    } catch {
      // A failed probe cannot establish that the prior app remains foreground.
    }
    activeId = null;
  }

  async function activate(id: string, signal: AbortSignal, _generation: number, record: OperationRecord): Promise<WorkspaceActResult> {
    if (!validId(id)) return rejected("invalid_application_id");
    const knownEntry = entries.get(id);
    if (!knownEntry || !isOnDemandApplication(knownEntry)) {
      try {
        await discover(signal);
      } catch {
        return stopped("discovery_failed", undefined, publicActiveId());
      }
      const duringDiscovery = operationStop(record);
      if (duringDiscovery) return duringDiscovery;
    }
    if (closed) return stopped("closed", undefined, null);
    const entry = entries.get(id);
    if (!entry) return stopped("application_not_found", undefined, publicActiveId());
    if (!canAutomateEntry(entry)) return stopped("application_automation_blocked", undefined, publicActiveId());
    const priorBeforeOpen = current();
    let application = applications.get(id);
    if (!application && isOnDemandApplication(entry)) {
      try {
        application = await materialize(entry, signal, record);
      } catch (error) {
        const interrupted = operationStop(record);
        if (interrupted) {
          await retainPreviousOrClear(priorBeforeOpen, signal);
          activeId = null;
          return { ...interrupted, active: null };
        }
        await retainPreviousOrClear(priorBeforeOpen, signal);
        return stopped(hostCode(error, "activation_failed"), undefined, publicActiveId());
      }
      const interrupted = operationStop(record);
      if (interrupted) {
        await retainPreviousOrClear(priorBeforeOpen, signal);
        activeId = null;
        return { ...interrupted, active: null };
      }
    }
    if (!application) return stopped("activation_unsupported", undefined, publicActiveId());
    if (!canAutomateEntry(entry)) {
      if (isOnDemandApplication(entry) && applications.get(id) === application) {
        applications.delete(id);
        sessionTools.delete(id);
        await closeApplication(application);
      }
      await retainPreviousOrClear(priorBeforeOpen, signal);
      return stopped("application_automation_blocked", undefined, publicActiveId());
    }
    if (isOnDemandApplication(entry) && !application.verifyFront) {
      applications.delete(id);
      sessionTools.delete(id);
      await closeApplication(application);
      await retainPreviousOrClear(priorBeforeOpen, signal);
      const interrupted = operationStop(record);
      if (interrupted) {
        activeId = null;
        return { ...interrupted, active: null };
      }
      return stopped("activation_unverified", undefined, publicActiveId());
    }
    if (activeId === id) {
      if (!application.verifyFront) return completed("already_active", id);
      try {
        const verified = await application.verifyFront({ application: infoFor(application), signal });
        const interrupted = operationStop(record);
        if (interrupted) return interrupted;
        if (verified === true) {
          if (!canAutomateEntry(entry)) return stopped("application_automation_blocked", undefined, null);
          return completed("already_active", id);
        }
      } catch {
        // Treat an unsuccessful probe as loss of physical focus below.
      }
      activeId = null;
      invalidateObservations();
      activation += 1;
      return stopped("activation_not_verified", undefined, null);
    }
    if (signal?.aborted) return stopped("cancelled", undefined, publicActiveId());
    const prior = current();
    const context: WorkspaceActivationContext = Object.freeze({
      application: infoFor(application),
      ...(prior ? { previous: infoFor(prior) } : {}),
      signal,
    });
    const failedActivation = async (code: string): Promise<WorkspaceActResult> => {
      await retainPreviousOrClear(prior, signal);
      const interrupted = operationStop(record);
      if (interrupted) {
        activeId = null;
        invalidateObservations();
        return { ...interrupted, active: null };
      }
      return stopped(code, undefined, publicActiveId());
    };
    invalidateObservations();
    activation += 1;
    if ((!application.activate && !isOnDemandApplication(entry)) || !application.verifyFront) {
      return stopped("activation_unsupported", undefined, publicActiveId());
    }
    try {
      const activated = application.activate ? await application.activate(context) : undefined;
      const interrupted = operationStop(record);
      if (interrupted) {
        activeId = null;
        invalidateObservations();
        return { ...interrupted, active: null };
      }
      if (!canAutomateEntry(entry)) return failedActivation("application_automation_blocked");
      if (activated === false) {
        return failedActivation("activation_failed");
      }
      if (isRecord(activated) && (activated.status === "refused" || activated.status === "failed")) {
        return failedActivation(hostCode(activated, "activation_failed"));
      }
      if (signal.aborted) {
        await retainPreviousOrClear(prior, signal);
        return stopped("cancelled", undefined, publicActiveId());
      }
      const verified = await application.verifyFront(context);
      const duringVerify = operationStop(record);
      if (duringVerify) {
        activeId = null;
        invalidateObservations();
        return { ...duringVerify, active: null };
      }
      if (verified !== true) {
        return failedActivation("activation_not_verified");
      }
      if (!canAutomateEntry(entry)) return failedActivation("application_automation_blocked");
      const afterVerify = operationStop(record);
      if (afterVerify) {
        activeId = null;
        invalidateObservations();
        return { ...afterVerify, active: null };
      }
      activeId = id;
      return completed("activated", id);
    } catch (error) {
      const interrupted = operationStop(record);
      if (interrupted) {
        activeId = null;
        invalidateObservations();
        return { ...interrupted, active: null };
      }
      return failedActivation(hostCode(error, "activation_failed"));
    }
  }

  async function navigate(contextUrl: string, signal: AbortSignal, _generation: number, record: OperationRecord): Promise<WorkspaceActResult> {
    if (closed) return stopped("closed", undefined, null);
    const application = current();
    if (!application) return stopped("no_active_application");
    if (!canAutomateEntry(entries.get(application.id))) return stopped("application_automation_blocked", undefined, null);
    if (!isAbsoluteHttpUrl(contextUrl)) return rejected("invalid_navigation_url");
    if (!application.navigate) return stopped("navigation_unsupported", undefined, application.id);
    if (signal?.aborted) return stopped("cancelled", undefined, application.id);
    const context: WorkspaceNavigationContext = Object.freeze({
      application: infoFor(application),
      url: contextUrl,
      signal,
    });
    invalidateObservations();
    try {
      const result = await application.navigate(context);
      const interrupted = operationStop(record, undefined, application.id);
      if (!canAutomateEntry(entries.get(application.id))) return stopped("application_automation_blocked", undefined, null);
      return interrupted ?? callbackResult(result, application.id);
    } catch (error) {
      const interrupted = operationStop(record, undefined, null);
      if (interrupted) return interrupted;
      return stopped(hostCode(error, "navigation_failed"), undefined, publicActiveId());
    }
  }

  function ordinaryObserveInput(input: unknown): unknown {
    if (!isRecord(input) || !hasOwn(input, "workspace")) return input;
    const { workspace: _workspace, ...rest } = input;
    return rest;
  }

  async function invokeObserve(input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (isRecord(input) && input.workspace === true) {
      const wantsReuse = hasOwn(input, "reuseQuery");
      if (Object.keys(input).some((key) => key !== "workspace" && key !== "reuseQuery" && !(wantsReuse && key === "where"))
        || (wantsReuse && !advertisesStepReuse())) throw new Error("invalid_workspace_observe");
      return enqueue(async (operationSignal, _generation, record) => {
        if (closed) return stopped("closed", undefined, null);
        try {
          await discover(operationSignal);
        } catch {
          const interrupted = operationStop(record);
          if (interrupted) return interrupted;
          return stopped("discovery_failed", undefined, publicActiveId());
        }
        const interrupted = operationStop(record);
        if (interrupted) return interrupted;
        const inventory = {
          active: publicActiveId(),
          applications: Object.freeze(visibleEntries().map(infoFor)),
        } satisfies WorkspaceObservation;
        if (wantsReuse && inventory.active !== null && current()?.stepReuse) {
          const observation = await dispatchObserve(ordinaryObserveInput(input), operationSignal, record);
          return isRecord(observation) && typeof observation.observationId === "string"
            ? { ...observation, ...inventory }
            : observation;
        }
        return inventory;
      }, (record) => stopped(operationCode(record), undefined, publicActiveId()), signal);
    }
    return enqueue(
      (operationSignal, _generation, record) => dispatchObserve(ordinaryObserveInput(input), operationSignal, record),
      (record) => stopped(operationCode(record), undefined, publicActiveId()),
      signal,
    );
  }

  async function invokeAct(input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (isRecord(input) && hasOwn(input, "activate")) {
      if (Object.keys(input).length !== 1 || typeof input.activate !== "string") return rejected("invalid_workspace_act", input);
      return enqueue(
        (operationSignal, generation, record) => activate(input.activate as string, operationSignal, generation, record),
      (record) => stopped(operationCode(record), undefined, publicActiveId()),
        signal,
      );
    }
    if (isRecord(input) && hasOwn(input, "navigate")) {
      if (Object.keys(input).length !== 1 || typeof input.navigate !== "string") return rejected("invalid_workspace_act", input);
      return enqueue(
        (operationSignal, generation, record) => navigate(input.navigate as string, operationSignal, generation, record),
      (record) => stopped(operationCode(record), undefined, publicActiveId()),
        signal,
      );
    }
    return enqueue(
      (operationSignal, _generation, record) => dispatchAct(input, operationSignal, record),
      (record) => stopped(operationCode(record), input, publicActiveId()),
      signal,
    );
  }

  function enrolledCapabilities(): readonly Capability[] {
    const unique = new Map<string, Capability>();
    for (const entry of entries.values()) {
      const capabilities = isOnDemandApplication(entry) ? entry.capabilities : entry.session.capabilities;
      for (const capability of capabilities) {
        unique.set(JSON.stringify(capability), capability);
      }
    }
    return [...unique.values()];
  }

  function enrolledLimits(): { maxSteps?: number; maxTextLength?: number; maxScrollAmount?: number } {
    const limits = [...applications.values()].map((application) => application.session.limits);
    const maximum = (key: "maxSteps" | "maxTextLength" | "maxScrollAmount"): number | undefined => {
      const values = limits.map((limit) => limit[key]).filter((value): value is number => Number.isSafeInteger(value));
      return values.length === 0 ? undefined : Math.max(...values);
    };
    return { maxSteps: maximum("maxSteps"), maxTextLength: maximum("maxTextLength"), maxScrollAmount: maximum("maxScrollAmount") };
  }

  function advertisesActivation(): boolean {
    return options.discover !== undefined || [...entries.values()].some((entry) => isOnDemandApplication(entry) || (entry.activate && entry.verifyFront));
  }

  function advertisesNavigation(): boolean {
    return options.discover !== undefined || [...entries.values()].some((entry) => isOnDemandApplication(entry) ? entry.allowNavigation === true : Boolean(entry.navigate));
  }

  function advertisesStepReuse(): boolean {
    return [...entries.values()].some((entry) => isOnDemandApplication(entry) ? entry.allowStepReuse === true : entry.stepReuse !== undefined);
  }

  function observeSchema(): AnyRecord {
    const bases = [...entries.values()]
      .map((entry) => isOnDemandApplication(entry) ? staticObserveSchema(entry) : findTool(entry, "observe")?.inputSchema)
      .filter((value): value is AnyRecord => isRecord(value));
    const reuseEnabled = advertisesStepReuse();
    const base = bases[0];
    if (!isRecord(base)) {
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          workspace: { type: "boolean" },
          ...(reuseEnabled ? { reuseQuery: cloneSchema(reuseQuerySchema) } : {}),
        },
        oneOf: [
          { required: ["workspace"], properties: { workspace: { const: true } } },
          { properties: { workspace: { const: false } } },
        ],
      };
    }
    const properties = isRecord(base.properties) ? { ...base.properties } : {};
    const viewEnums = bases.flatMap((schema) => {
      const view = isRecord(schema.properties) && isRecord(schema.properties.view) ? schema.properties.view : undefined;
      return view && Array.isArray(view.enum) ? view.enum : [];
    });
    if (isRecord(properties.view) && viewEnums.length > 0) properties.view = { ...properties.view, enum: [...new Set(viewEnums)] };
    const readSchema = bases
      .map((schema) => isRecord(schema.properties) && isRecord(schema.properties.read) ? schema.properties.read : undefined)
      .find((value): value is AnyRecord => isRecord(value));
    if (readSchema && !isRecord(properties.read)) properties.read = readSchema;
    if (reuseEnabled) properties.reuseQuery = cloneSchema(reuseQuerySchema);
    return {
      ...base,
      additionalProperties: false,
      properties: { ...properties, workspace: { type: "boolean" } },
      oneOf: [
        { required: ["workspace"], properties: { workspace: { const: true } }, not: { anyOf: [
          { required: ["view"] }, { required: ["read"] }, { required: ["where"], not: { required: ["reuseQuery"] } },
        ] } },
        { properties: { workspace: { const: false } } },
      ],
    };
  }

  function actSchema(): AnyRecord {
    let base = actToolSchema(enrolledCapabilities(), enrolledLimits());
    const activation = advertisesActivation();
    const navigation = advertisesNavigation();
    const reuseEnabled = advertisesStepReuse();
    if (reuseEnabled && isRecord(base)) base = addReuseActSchema(base);
    if (!isRecord(base)) {
      const properties: AnyRecord = { steps: { type: "array" } };
      const branches: AnyRecord[] = [{ required: ["steps"] }];
      if (activation) {
        properties.activate = { type: "string", minLength: 1 };
        branches.unshift({ required: ["activate"] });
      }
      if (navigation) {
        properties.navigate = { type: "string", format: "uri" };
        branches.unshift({ required: ["navigate"] });
      }
      let schema: AnyRecord = {
        type: "object",
        additionalProperties: false,
        properties,
        oneOf: branches,
      };
      return schema;
    }
    const { required: _required, if: baseIf, then: baseThen, ...withoutRequired } = base;
    const properties = isRecord(base.properties) ? base.properties : {};
    const regularRequired = Array.isArray(base.required) && base.required.length > 0 ? base.required : ["steps"];
    const guardedIf = isRecord(baseIf)
      ? { ...baseIf, required: Array.isArray(baseIf.required) ? [...new Set([...baseIf.required, "steps"])] : ["steps"] }
      : undefined;
    const propertiesWithWorkspace: AnyRecord = { ...properties };
    if (activation) propertiesWithWorkspace.activate = { type: "string", minLength: 1 };
    if (navigation) propertiesWithWorkspace.navigate = { type: "string", format: "uri" };
    const workspaceBranches: AnyRecord[] = [];
    const reuseNot = reuseEnabled ? [{ required: ["reuse"] }] : [];
    if (activation) workspaceBranches.push({ required: ["activate"], not: { anyOf: [{ required: ["navigate"] }, { required: ["steps"] }, { required: ["observationId"] }, ...reuseNot] } });
    if (navigation) workspaceBranches.push({ required: ["navigate"], not: { anyOf: [{ required: ["activate"] }, { required: ["steps"] }, { required: ["observationId"] }, ...reuseNot] } });
    workspaceBranches.push({ required: regularRequired, not: { anyOf: [{ required: ["activate"] }, { required: ["navigate"] }, ...reuseNot] } });
    if (reuseEnabled) workspaceBranches.push({ required: ["reuse"], not: { anyOf: [{ required: ["activate"] }, { required: ["navigate"] }, { required: ["steps"] }, { required: ["observationId"] }] } });
    const schema: AnyRecord = {
      ...withoutRequired,
      additionalProperties: false,
      properties: propertiesWithWorkspace,
      ...(guardedIf && baseThen ? { if: guardedIf, then: baseThen } : {}),
      oneOf: workspaceBranches,
    };
    return schema;
  }

  function staticObserveSchema(application: OnDemandWorkspaceApplication): AnyRecord {
    return observeInputSchema(application.allowModelImages === true, application.allowModelDocumentText === true);
  }

  const tools: readonly ToolEndpoint[] = Object.freeze([
    {
      name: "observe",
      get description() {
        const documents = [...entries.values()].some((entry) => isOnDemandApplication(entry)
          ? entry.allowModelDocumentText === true
          : entry.session.allowModelDocumentText === true);
        const reuse = advertisesStepReuse();
        return "Use {workspace:true} to discover available owned applications and the actual active application; otherwise observe the active application's controls."
          + (documents ? ' When the active browser grants rendered text, start with {"read":"document"}, find a literal keyword with {"read":{"query":"..."}}, or pass the returned document.nextCursor as {"read":{"cursor":"..."}}.' : "")
          + (reuse ? " When reusable verified steps are available, ordinary observe automatically lists scoped reuseCandidates; use reuseQuery only to rank them by intention." : "");
      },
      get inputSchema() { return observeSchema(); },
      invoke: invokeObserve,
    },
    {
      name: "act",
      get description() {
        const base = [...entries.values()]
          .filter((entry): entry is WorkspaceApplication => !isOnDemandApplication(entry))
          .map((application) => findTool(application, "act")?.description)
          .find((description): description is string => typeof description === "string");
        const modes = [
          ...(advertisesActivation() ? ["If no app is active, or to switch apps, use {activate: applicationId} with an ID from the workspace."] : []),
          ...(advertisesNavigation() ? ["On an active browser use {navigate: url} to open an authorized address."] : []),
        ];
        return [...modes, base ?? "Use {steps:[...]} on the active application. Refs, points, and drags need the observationId they came from."].join(" ");
      },
      get inputSchema() { return actSchema(); },
      invoke: invokeAct,
    },
  ]);

  const workspace: Workspace = {
    get tools() { return tools; },
    get applications() { return Object.freeze([...entries.values()].map(infoFor)); },
    get activeApplicationId() { return activeId; },
    observe: invokeObserve,
    act: invokeAct,
    resolveApproval: (requestId, decision) => enqueue(async (_signal, _generation, record) => {
      const before = operationStop(record);
      if (before) return { ...before, requestId };
      const completedResult = approvalResults.get(requestId);
      if (completedResult) return completedResult;
      const binding = approvals.get(requestId);
      const application = binding ? applications.get(binding.applicationId) : current();
      const session = binding?.session ?? application?.session;
      if (!session) return { requestId, status: "stopped" as const, code: "approval_not_found", steps: [] };
      const settle = application?.stepReuse?.resolveApproval ?? session.resolveApproval.bind(session);
      const entry = binding ? entries.get(binding.applicationId) : application ? entries.get(application.id) : undefined;
      if (!canAutomateEntry(entry)) {
        const blocked: ApprovalResolution = { requestId, status: "stopped", code: "application_automation_blocked", steps: [] };
        approvalResults.set(requestId, blocked);
        // Release the session's host approval without allowing it to dispatch.
        void settle(requestId, "deny").catch(() => undefined);
        return blocked;
      }
      if (binding && (binding.applicationId !== activeId || binding.activation !== activation)) {
        const stale: ApprovalResolution = { requestId, status: "stopped", code: "stale_activation", steps: [] };
        approvalResults.set(requestId, stale);
        // Release the session's host approval without allowing it to dispatch.
        void settle(requestId, "deny").catch(() => undefined);
        return stale;
      }
      const result = await settle(requestId, decision);
      const interrupted = operationStop(record);
      if (interrupted) {
        const stoppedApproval = interruptedApproval(result, requestId, operationCode(record));
        approvalResults.set(requestId, stoppedApproval);
        return stoppedApproval;
      }
      if (result.requestId) approvals.set(result.requestId, {
        applicationId: binding?.applicationId ?? application!.id,
        activation,
        session,
      });
      // The original request is settled even when the session hands back a
      // fresh approval request for the next step. Cache only settled IDs;
      // the fresh ID must remain resumable.
      if (result.requestId !== requestId || result.code !== "approval_required") {
        approvalResults.set(requestId, result);
      }
      if (result.requestId !== requestId && result.code !== "approval_required") {
        approvalResults.set(result.requestId, result);
      }
      return result;
    }, (record) => ({ ...stopped(operationCode(record), undefined, publicActiveId()), requestId })),
    correct: (reason = "corrected") => {
      abortOperations("corrected");
      invalidateObservations();
      const sessions = new Set<DeskSession>();
      for (const application of applications.values()) {
        if (sessions.has(application.session)) continue;
        sessions.add(application.session);
        application.session.correct(reason);
      }
    },
    cancel: (reason = "cancelled") => {
      abortOperations("cancelled");
      invalidateObservations();
      const sessions = new Set<DeskSession>();
      for (const application of applications.values()) {
        if (sessions.has(application.session)) continue;
        sessions.add(application.session);
        application.session.cancel(reason);
      }
    },
    registerApplication: (application) => {
      if (closed) throw new Error("closed");
      return addApplication(application);
    },
    close: async () => {
      if (closePromise) return closePromise;
      abortOperations("closed");
      closed = true;
      activeId = null;
      activation += 1;
      invalidateObservations();
      for (const application of applications.values()) application.session.cancel("closed");
      const closeSessions = async (): Promise<void> => {
        const sessions = new Map<DeskSession, DiscoverableStepReuse | undefined>();
        for (const application of applications.values()) {
          const prior = sessions.get(application.session);
          if (prior === undefined && application.stepReuse) sessions.set(application.session, application.stepReuse);
          else if (!sessions.has(application.session)) sessions.set(application.session, undefined);
        }
        for (const [session, stepReuse] of sessions) {
          if (stepReuse) await closeStepReuse(stepReuse);
          else await session.close().catch(() => undefined);
        }
      };
      closePromise = sequence.then(closeSessions, closeSessions);
      sequence = closePromise.then(() => undefined, () => undefined);
      return closePromise;
    },
  };

  return workspace;
}

export function createWorkspaceTools(workspace: Workspace): readonly ToolEndpoint[] {
  return workspace.tools;
}
