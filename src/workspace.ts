import type { ActResult, ApprovalDecision, ApprovalResolution, DeskSession } from "./core/session-types.js";
import type { Capability } from "./contracts.js";
import { actToolSchema } from "./request.js";
import { createDeskTools, type ToolEndpoint } from "./tools.js";

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
}

export type WorkspaceDiscovery = (context: {
  readonly active: string | null;
  readonly applications: readonly WorkspaceApplicationInfo[];
  readonly signal?: AbortSignal;
}) => readonly WorkspaceApplication[] | Promise<readonly WorkspaceApplication[]>;

export interface WorkspaceOptions {
  readonly applications?: readonly WorkspaceApplication[];
  readonly initialActive?: string | WorkspaceApplication | null;
  readonly discover?: WorkspaceDiscovery;
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
  registerApplication(application: WorkspaceApplication): WorkspaceApplicationInfo;
  close(): Promise<void>;
}

interface ObservationBinding {
  readonly applicationId: string;
  readonly activation: number;
}

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

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function infoFor(application: WorkspaceApplication): WorkspaceApplicationInfo {
  return Object.freeze({
    id: application.id,
    name: application.name,
    ...(application.description === undefined ? {} : { description: application.description }),
  });
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
  return application;
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

/** Create a workspace whose only model surface is the existing observe/act pair. */
export function createWorkspace(options: WorkspaceOptions = {}): Workspace {
  const applications = new Map<string, WorkspaceApplication>();
  const sessionTools = new Map<string, readonly ToolEndpoint[]>();
  const observations = new Map<string, ObservationBinding>();
  const approvals = new Map<string, ApprovalBinding>();
  const approvalResults = new Map<string, ApprovalResolution>();
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

  function addApplication(value: WorkspaceApplication): WorkspaceApplicationInfo {
    const application = normalizeApplication(value);
    const prior = applications.get(application.id);
    if (prior && prior.session !== application.session) throw new Error("duplicate_workspace_application");
    applications.set(application.id, application);
    sessionTools.delete(application.id);
    return infoFor(application);
  }

  for (const application of options.applications ?? []) addApplication(application);

  function seedId(value: string | WorkspaceApplication | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const id = typeof value === "string" ? value : value.id;
    if (!validId(id) || !applications.has(id)) throw new Error("unknown_workspace_application");
    return id;
  }

  activeId = seedId(options.initialActive);
  if (activeId !== null) activation = 1;

  async function discover(signal?: AbortSignal): Promise<void> {
    if (!options.discover) return;
    if (discoveryInFlight) return discoveryInFlight;
    discoveryInFlight = Promise.resolve(options.discover({
      active: activeId,
      applications: [...applications.values()].map(infoFor),
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
  }

  function operationStop(record: OperationRecord, input?: unknown, active: string | null = activeId): WorkspaceActResult | undefined {
    if (!record.controller.signal.aborted && record.generation === operationGeneration && !closed) return undefined;
    return stopped(operationCode(record), input, active);
  }

  function current(): WorkspaceApplication | undefined {
    return activeId === null ? undefined : applications.get(activeId);
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
  }

  function isStaleObservation(input: unknown, appId: string): boolean {
    if (!isRecord(input) || typeof input.observationId !== "string") return false;
    const binding = observations.get(input.observationId);
    return !binding || binding.applicationId !== appId || binding.activation !== activation;
  }

  function deskTools(application: WorkspaceApplication): readonly ToolEndpoint[] {
    const cached = sessionTools.get(application.id);
    if (cached) return cached;
    const tools = Object.freeze(createDeskTools(application.session));
    sessionTools.set(application.id, tools);
    return tools;
  }

  function findTool(application: WorkspaceApplication, name: "observe" | "act"): ToolEndpoint | undefined {
    return deskTools(application).find((tool) => tool.name === name);
  }

  async function dispatchObserve(input: unknown, signal: AbortSignal, record: OperationRecord): Promise<unknown> {
    if (closed) return stopped("closed", undefined, null);
    const application = current();
    if (!application) return stopped("no_active_application");
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
    if (isRecord(input) && typeof input.observationId === "string" && isStaleObservation(input, activeId ?? "")) {
      return stopped("stale_observation", input, activeId);
    }
    const application = current();
    if (!application) return stopped("no_active_application", input);
    if (isStaleObservation(input, application.id)) return stopped("stale_observation", input, application.id);
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
    try {
      await discover(signal);
    } catch {
      return stopped("discovery_failed", undefined, activeId);
    }
    const duringDiscovery = operationStop(record);
    if (duringDiscovery) return duringDiscovery;
    if (closed) return stopped("closed", undefined, activeId);
    if (!validId(id)) return rejected("invalid_application_id");
    const application = applications.get(id);
    if (!application) return stopped("application_not_found", undefined, activeId);
    if (activeId === id) {
      if (!application.verifyFront) return completed("already_active", id);
      try {
        const verified = await application.verifyFront({ application: infoFor(application), signal });
        const interrupted = operationStop(record);
        if (interrupted) return interrupted;
        if (verified === true) return completed("already_active", id);
      } catch {
        // Treat an unsuccessful probe as loss of physical focus below.
      }
      activeId = null;
      invalidateObservations();
      activation += 1;
      return stopped("activation_not_verified", undefined, null);
    }
    if (signal?.aborted) return stopped("cancelled", undefined, activeId);
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
      return stopped(code, undefined, activeId);
    };
    invalidateObservations();
    activation += 1;
    if (!application.activate || !application.verifyFront) return stopped("activation_unsupported", undefined, activeId);
    try {
      const activated = await application.activate(context);
      const interrupted = operationStop(record);
      if (interrupted) {
        activeId = null;
        invalidateObservations();
        return { ...interrupted, active: null };
      }
      if (activated === false) {
        return failedActivation("activation_failed");
      }
      if (isRecord(activated) && (activated.status === "refused" || activated.status === "failed")) {
        return failedActivation(hostCode(activated, "activation_failed"));
      }
      if (signal.aborted) {
        await retainPreviousOrClear(prior, signal);
        return stopped("cancelled", undefined, activeId);
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
      return interrupted ?? callbackResult(result, application.id);
    } catch (error) {
      const interrupted = operationStop(record, undefined, null);
      if (interrupted) return interrupted;
      return stopped(hostCode(error, "navigation_failed"), undefined, application.id);
    }
  }

  function ordinaryObserveInput(input: unknown): unknown {
    if (!isRecord(input) || !hasOwn(input, "workspace")) return input;
    const { workspace: _workspace, ...rest } = input;
    return rest;
  }

  async function invokeObserve(input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (isRecord(input) && input.workspace === true) {
      if (Object.keys(input).some((key) => key !== "workspace")) throw new Error("invalid_workspace_observe");
      return enqueue(async (operationSignal, _generation, record) => {
        if (closed) return stopped("closed", undefined, null);
        try {
          await discover(operationSignal);
        } catch {
          const interrupted = operationStop(record);
          if (interrupted) return interrupted;
          return stopped("discovery_failed", undefined, activeId);
        }
        const interrupted = operationStop(record);
        if (interrupted) return interrupted;
        return {
          active: activeId,
          applications: Object.freeze([...applications.values()].map(infoFor)),
        } satisfies WorkspaceObservation;
      }, (record) => stopped(operationCode(record), undefined, activeId), signal);
    }
    return enqueue(
      (operationSignal, _generation, record) => dispatchObserve(ordinaryObserveInput(input), operationSignal, record),
      (record) => stopped(operationCode(record), undefined, activeId),
      signal,
    );
  }

  async function invokeAct(input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (isRecord(input) && hasOwn(input, "activate")) {
      if (Object.keys(input).length !== 1 || typeof input.activate !== "string") return rejected("invalid_workspace_act", input);
      return enqueue(
        (operationSignal, generation, record) => activate(input.activate as string, operationSignal, generation, record),
        (record) => stopped(operationCode(record), undefined, activeId),
        signal,
      );
    }
    if (isRecord(input) && hasOwn(input, "navigate")) {
      if (Object.keys(input).length !== 1 || typeof input.navigate !== "string") return rejected("invalid_workspace_act", input);
      return enqueue(
        (operationSignal, generation, record) => navigate(input.navigate as string, operationSignal, generation, record),
        (record) => stopped(operationCode(record), undefined, activeId),
        signal,
      );
    }
    return enqueue(
      (operationSignal, _generation, record) => dispatchAct(input, operationSignal, record),
      (record) => stopped(operationCode(record), input, activeId),
      signal,
    );
  }

  function enrolledCapabilities(): readonly Capability[] {
    const unique = new Map<string, Capability>();
    for (const application of applications.values()) {
      for (const capability of application.session.capabilities) {
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
    return options.discover !== undefined || [...applications.values()].some((application) => application.activate && application.verifyFront);
  }

  function advertisesNavigation(): boolean {
    return options.discover !== undefined || [...applications.values()].some((application) => application.navigate);
  }

  function observeSchema(): AnyRecord {
    const bases = [...applications.values()]
      .map((application) => findTool(application, "observe")?.inputSchema)
      .filter((value): value is AnyRecord => isRecord(value));
    const base = bases[0];
    if (!isRecord(base)) {
      return {
        type: "object",
        additionalProperties: false,
        properties: { workspace: { type: "boolean" } },
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
    const read = bases.some((schema) => isRecord(schema.properties) && isRecord(schema.properties.read));
    if (read && !isRecord(properties.read)) properties.read = { type: "string", enum: ["document"] };
    return {
      ...base,
      additionalProperties: false,
      properties: { ...properties, workspace: { type: "boolean" } },
      oneOf: [
        { required: ["workspace"], properties: { workspace: { const: true } }, not: { anyOf: [{ required: ["view"] }, { required: ["where"] }, { required: ["read"] }] } },
        { properties: { workspace: { const: false } } },
      ],
    };
  }

  function actSchema(): AnyRecord {
    const base = actToolSchema(enrolledCapabilities(), enrolledLimits());
    const activation = advertisesActivation();
    const navigation = advertisesNavigation();
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
      return {
        type: "object",
        additionalProperties: false,
        properties,
        oneOf: branches,
      };
    }
    const { required: _required, if: baseIf, then: baseThen, ...withoutRequired } = base;
    const properties = isRecord(base.properties) ? base.properties : {};
    const regularRequired = Array.isArray(base.required) && base.required.length > 0 ? base.required : ["steps"];
    const guardedIf = isRecord(baseIf)
      ? { ...baseIf, required: Array.isArray(baseIf.required) ? [...baseIf.required, "steps"] : ["steps"] }
      : undefined;
    const propertiesWithWorkspace: AnyRecord = { ...properties };
    if (activation) propertiesWithWorkspace.activate = { type: "string", minLength: 1 };
    if (navigation) propertiesWithWorkspace.navigate = { type: "string", format: "uri" };
    const workspaceBranches: AnyRecord[] = [];
    if (activation) workspaceBranches.push({ required: ["activate"], not: { anyOf: [{ required: ["navigate"] }, { required: ["steps"] }, { required: ["observationId"] }] } });
    if (navigation) workspaceBranches.push({ required: ["navigate"], not: { anyOf: [{ required: ["activate"] }, { required: ["steps"] }, { required: ["observationId"] }] } });
    workspaceBranches.push({ required: regularRequired, not: { anyOf: [{ required: ["activate"] }, { required: ["navigate"] }] } });
    return {
      ...withoutRequired,
      additionalProperties: false,
      properties: propertiesWithWorkspace,
      ...(guardedIf && baseThen ? { if: guardedIf, then: baseThen } : {}),
      oneOf: workspaceBranches,
    };
  }

  const tools: readonly ToolEndpoint[] = Object.freeze([
    {
      name: "observe",
      get description() {
        const documents = [...applications.values()].some((application) => application.session.allowModelDocumentText === true);
        return "Use {workspace:true} to discover available owned applications and the actual active application; otherwise observe the active application's controls."
          + (documents ? " The active browser may permit {read:\"document\"} for bounded rendered page text." : "");
      },
      get inputSchema() { return observeSchema(); },
      invoke: invokeObserve,
    },
    {
      name: "act",
      get description() {
        const base = [...applications.values()]
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
    get applications() { return Object.freeze([...applications.values()].map(infoFor)); },
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
      if (binding && (binding.applicationId !== activeId || binding.activation !== activation)) {
        const stale: ApprovalResolution = { requestId, status: "stopped", code: "stale_activation", steps: [] };
        approvalResults.set(requestId, stale);
        // Release the session's host approval without allowing it to dispatch.
        void session.resolveApproval(requestId, "deny").catch(() => undefined);
        return stale;
      }
      const result = await session.resolveApproval(requestId, decision);
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
    }, (record) => ({ ...stopped(operationCode(record), undefined, activeId), requestId })),
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
        const sessions = new Set<DeskSession>();
        for (const application of applications.values()) {
          if (sessions.has(application.session)) continue;
          sessions.add(application.session);
          await application.session.close();
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
