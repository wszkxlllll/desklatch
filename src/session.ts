import type {
  ActionKind,
  ActRequest,
  Control,
  DocumentRead,
  Delivery,
  DesktopBackend,
  Dispatch,
  Frame,
  HostPolicyEvidence,
  RiskDecision,
  RiskInput,
  State,
  View,
  Selector,
  Expect,
  Step,
} from "./contracts.js";
import type {
  ActResult,
  ActValidationDiagnostic,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolution,
  CandidateSummary,
  DeskObservation,
  DeskObserveOptions,
  ObservationProjectionRequest,
  DeskSession,
  DeskSessionActOptions,
  DeskSessionOptions,
  StepReceipt,
  VerifiedStepEvidence,
} from "./core/session-types.js";
import { ACT_EXPECTATION_FAILURE_HINT, ACT_POINT_CLICK_EVIDENCE_HINT } from "./core/session-types.js";
export type {
  ActResult,
  ActValidationDiagnostic,
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  ApprovalResolution,
  CandidateSummary,
  ControlObservation,
  DeskObservation,
  DeskObserveOptions,
  ObservationProjection,
  ObservationProjectionRequest,
  DeskSession,
  DeskSessionActOptions,
  DeskSessionOptions,
  StepReceipt,
  StepReceiptStatus,
  VerifiedStepEvidence,
} from "./core/session-types.js";
import { randomUUID } from "node:crypto";
import { RequestValidationError, validateRequest } from "./request.js";
import { canonicalRole, matchControl } from "./grounding.js";
import { defaultRiskPolicy, recheckRiskApproval } from "./policy.js";
import { awaitAbortable, deepFreeze, freezeCapabilities, intersectCapabilities, mergeSignals, safeAdapterCode, safeValidationCode } from "./core/session-support.js";
import { approvalActionParams, approvalContextSummary, approvalSummary, normalizeApprovalDecision } from "./core/session-approval.js";
import { isSensitiveControl, ObservationRegistry, sanitizeText, type StoredObservation } from "./core/observation-registry.js";
import { sameBinding, TargetResolver, type Binding, type FocusRecord, type PreparedStep } from "./core/session-target-resolver.js";

interface PendingApproval {
  request: ApprovalRequest;
  binding: Binding;
  /** Host-only risk facts used to recheck live rules without repeating exact evidence. */
  riskDecision?: RiskDecision;
  riskInput?: RiskInput;
  timer?: ReturnType<typeof setTimeout>;
  state: "pending" | "approved" | "denied" | "expired" | "cancelled";
  settle: (decision: ApprovalDecision | "expired" | "cancelled") => void;
  promise: Promise<ApprovalDecision | "expired" | "cancelled">;
  suspended?: SuspendedBatch;
  resumePromise?: Promise<ApprovalResolution>;
  syncDecision?: ApprovalDecision;
}

interface SuspendedBatch {
  request: ActRequest;
  index: number;
  prepared: PreparedStep;
  receipts: StepReceipt[];
  execution: ActiveExecution;
  pending: PendingApproval;
  result?: ApprovalResolution;
}

interface FocusBindingRecord {
  readonly binding: string;
  readonly signal: AbortSignal;
  readonly sourceStep: number;
  readonly controlId: string;
  readonly windowScope: string;
  readonly sourceControlId: string;
  readonly proof: FocusBindingProof;
}

interface FocusBindingProof extends HostPolicyEvidence {
  readonly binding: string;
  readonly sourceControlId: string;
  readonly focusControlId: string;
  readonly windowScope: string;
}

interface FocusHandoffPolicyEvidence extends HostPolicyEvidence {
  readonly kind: "focus_handoff";
  readonly binding: string;
  readonly sourceStep: number;
  readonly commitStep: number;
  readonly sourceControlId: string;
  readonly focusControlId: string;
  readonly windowScope: string;
  /** Backend-specific proof is opaque to Core and visible only to host policy. */
  readonly proof: HostPolicyEvidence;
}

function evidenceRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isFocusBindingProof(value: HostPolicyEvidence | undefined): value is FocusBindingProof {
  if (!value || typeof value.kind !== "string" || value.kind.length === 0) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.binding === "string" && raw.binding.length > 0 && raw.binding.length <= 128
    && typeof raw.sourceControlId === "string" && raw.sourceControlId.length > 0
    && typeof raw.focusControlId === "string" && raw.focusControlId.length > 0
    && typeof raw.windowScope === "string" && raw.windowScope.length > 0;
}

interface ActiveExecution {
  controller: AbortController;
  epoch: number;
  replay: boolean;
  onVerifiedStep?: (evidence: VerifiedStepEvidence) => void;
  reason?: string;
  pendingApprovals: Set<PendingApproval>;
  pinnedObservations: Set<StoredObservation>;
  focusRecords: Map<number, FocusRecord>;
  focusBindings: Map<number, FocusBindingRecord>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  removeParentAbort?: () => void;
  suspended?: SuspendedBatch;
}

const DEFAULT_MAX_STEPS = 32;
const DEFAULT_MAX_TEXT_LENGTH = 16_384;
const DEFAULT_MAX_SCROLL_AMOUNT = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;
const OBSERVATION_VIEWS: readonly View[] = ["controls", "image", "both", "document"];

function controlsQueryKey(where: Selector | undefined): string {
  return JSON.stringify([where?.role, where?.name, where?.within, where?.state]);
}

function isBroadControlsQuery(view: View, where: Selector | undefined, read: DocumentRead | undefined): boolean {
  if ((view !== "controls" && view !== "both") || read !== undefined) return false;
  return where === undefined || (Object.keys(where).length === 1 && typeof where.role === "string");
}

function compactDocumentRead(read: DocumentRead): DocumentRead {
  const requested = read === "document" ? { kind: "document" as const } : read;
  if (requested.cursor !== undefined) return requested;
  return {
    ...requested,
    maxChars: Math.min(requested.maxChars ?? 4_096, 4_096),
    maxChunks: Math.min(requested.maxChunks ?? 8, 8),
    chunkSize: Math.min(requested.chunkSize ?? 1_024, 1_024),
  };
}

/**
 * Construct an execution-only desktop session. The session contains no provider
 * assumptions: the supplied backend is the only component that can observe or
 * dispatch physical desktop work.
 */
export function createDeskSession(backend: DesktopBackend, options: DeskSessionOptions = {}): DeskSession {
  if (!backend || typeof backend.observe !== "function" || typeof backend.dispatch !== "function" || typeof backend.close !== "function") {
    throw new TypeError("invalid_backend");
  }

  const allowModelImages = options.allowModelImages === true;
  const backendDocumentText = (backend as DesktopBackend & { readonly allowDocumentText?: boolean }).allowDocumentText === true;
  // The model delivery gate is an intersection: an explicit session grant
  // cannot make a native/unsupported backend advertise document text.
  const allowModelDocumentText = backendDocumentText && options.allowModelDocumentText === true;
  const policy = options.policy ?? defaultRiskPolicy;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const maxScrollAmount = options.maxScrollAmount ?? DEFAULT_MAX_SCROLL_AMOUNT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const expectTimeoutMs = options.expectTimeoutMs ?? Math.min(1_000, timeoutMs);
  const approvalHandler = options.onApprovalRequested;
  const grantedCapabilities = intersectCapabilities(backend.capabilities, options.capabilities);
  const effectiveCapabilities = freezeCapabilities(allowModelImages
    ? grantedCapabilities
    : grantedCapabilities.flatMap((capability) => {
      const targets = capability.targets.filter((target) => target !== "point" && target !== "path");
      return targets.length > 0 ? [{ ...capability, targets }] : [];
    }));
  const sessionLimits = Object.freeze({ maxSteps, maxTextLength, maxScrollAmount });
  const defaultObservationProjection: ObservationProjectionRequest | undefined =
    options.defaultObservationProjection === "compact" || options.defaultObservationProjection === "incremental"
    ? { mode: "compact" }
    : undefined;

  function grantedAction(kind: ActionKind): boolean {
    return effectiveCapabilities.some((capability) => capability.kind === kind
      && capability.targets.some((target) => target === "selector" || target === "ref"));
  }

  const observationRegistry = new ObservationRegistry({
    allowModelImages,
    allowModelDocumentText,
    grantedAction,
    refsGranted: effectiveCapabilities.some((capability) => capability.targets.includes("ref")),
    maxPublicControls: options.maxPublicControls,
  });

  let closed = false;
  let closePromise: Promise<void> | undefined;
  let approvalSequence = 0;
  let epoch = 0;
  let actQueue: Promise<void> = Promise.resolve();
  let active: ActiveExecution | undefined;
  const targetResolver = new TargetResolver({
    backend,
    observe: observeInternal,
    getObservation: (observationId) => observationRegistry.get(observationId),
    pin: (stored) => {
      if (active) observationRegistry.pin(stored, active.pinnedObservations);
    },
    getFocus: (step) => active?.focusRecords.get(step),
  });
  const approvalRecords = new Map<string, PendingApproval>();
  const completedApprovals = new Map<string, ApprovalResolution>();
  const suspendedBatches = new Set<SuspendedBatch>();

  const globalAbort = new AbortController();
  const abortGlobal = (): void => {
    if (!globalAbort.signal.aborted) {
      globalAbort.abort("cancelled");
    }
  };
  if (options.signal) {
    if (options.signal.aborted) abortGlobal();
    else options.signal.addEventListener("abort", abortGlobal, { once: true });
  }

  function makeApprovalId(): string {
    approvalSequence += 1;
    return `approval-${randomUUID()}-${approvalSequence}`;
  }

  function policyControl(control: Control): Control {
    const { approvalContext: _approvalContext, ...withoutContext } = control;
    if (!isSensitiveControl(control)) return withoutContext;
    const { value: _value, ...withoutValue } = withoutContext;
    return withoutValue;
  }

  function hasState(control: Control, state: State): boolean {
    return control.states.includes(state);
  }

  function isExactNamedSelector(value: unknown): value is Selector {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const selector = value as Record<string, unknown>;
    return typeof selector.role === "string" && selector.role.trim().length > 0
      && typeof selector.name === "string" && selector.name.trim().length > 0
      && Object.keys(selector).every((key) => ["role", "name", "within", "state"].includes(key))
      && (selector.within === undefined || typeof selector.within === "string")
      && (selector.state === undefined || typeof selector.state === "string");
  }

  function selectorSignature(value: Selector): string {
    return JSON.stringify(["role", "name", "within", "state"].flatMap((key) =>
      Object.hasOwn(value, key) ? [key, (value as Record<string, unknown>)[key]] : []));
  }

  /**
   * Only browser/native controls carrying an independent read-only marker may
   * be short-circuited or emitted as click-capture evidence. Effect alone is
   * intentionally insufficient: arbitrary host controls can report `read`.
   */
  function isVerifiedClickCandidate(step: Extract<import("./contracts.js").Step, { kind: "click" }>, target: Control): boolean {
    if ((step.button ?? "left") !== "left" || (step.count ?? 1) !== 1) return false;
    if (!isExactNamedSelector(step.target) || !step.expect || !isExactNamedSelector(step.expect.target)) return false;
    if (selectorSignature(step.target) !== selectorSignature(step.expect.target)) return false;
    if (!("state" in step.expect) || step.expect.state === "present") return false;
    const state = "state" in step.expect ? step.expect.state : undefined;
    const disclosure = (target as Control & { disclosure?: unknown }).disclosure === true && state === "expanded";
    const filter = target.filterAction === true && canonicalRole(target.role) === "checkbox" && state === "checked";
    const tab = canonicalRole(target.role) === "tab"
      && (target as Control & { sameDocumentTab?: unknown }).sameDocumentTab === true && state === "selected";
    return target.effect === "read" && (disclosure || filter || tab);
  }

  function capturesFocusForLaterStep(request: ActRequest, position: number, index: number): boolean {
    for (let later = position + 1; later < request.steps.length; later += 1) {
      const candidate = request.steps[later];
      if (!("target" in candidate)) continue;
      if ("focusFromStep" in candidate.target && candidate.target.focusFromStep === index) return true;
    }
    return false;
  }

  function capturesFocusForEnterLater(request: ActRequest, position: number, index: number): boolean {
    for (let later = position + 1; later < request.steps.length; later += 1) {
      const candidate = request.steps[later];
      if (candidate.kind === "keypress" && candidate.key === "Enter"
        && "target" in candidate && "focusFromStep" in candidate.target
        && candidate.target.focusFromStep === index) return true;
    }
    return false;
  }

  function currentReason(execution: ActiveExecution): string {
    if (execution.reason) return execution.reason;
    if (closed) return "closed";
    if (globalAbort.signal.aborted) return "cancelled";
    if (execution.controller.signal.aborted) {
      const reason = execution.controller.signal.reason;
      if (typeof reason === "string") return reason;
      return "cancelled";
    }
    return "cancelled";
  }

  function stoppedResult(
    request: ActRequest | undefined,
    index: number,
    code: string,
    prior: StepReceipt[] = [],
    currentKind?: ActionKind,
    candidates?: readonly CandidateSummary[],
    requestId?: string,
    observationId?: string,
  ): ActResult {
    const steps = [...prior];
    const allSteps = request?.steps ?? [];
    if (index >= 1 && index <= allSteps.length && !steps.some((receipt) => receipt.index === index)) {
      steps.push({ index, kind: currentKind ?? allSteps[index - 1]?.kind, status: "not_dispatched", code });
    }
    for (let cursor = index + 1; cursor <= allSteps.length; cursor += 1) {
      if (!steps.some((receipt) => receipt.index === cursor)) {
        steps.push({ index: cursor, kind: allSteps[cursor - 1]?.kind, status: "not_dispatched", code: "not_reached" });
      }
    }
    return {
      status: "stopped",
      atStep: index > 0 ? index : undefined,
      code,
      steps,
      ...(candidates && candidates.length > 0 ? { candidates } : {}),
      ...(requestId ? { requestId } : {}),
      ...(observationId ? { observationId } : {}),
    };
  }

  function pointClickEvidenceHint(step: Step, code: string | undefined): typeof ACT_POINT_CLICK_EVIDENCE_HINT | undefined {
    if (step.kind !== "click" || !("point" in step.target)) return undefined;
    if (code !== "ambiguous_click_target" && code !== "unknown_effect") return undefined;
    return ACT_POINT_CLICK_EVIDENCE_HINT;
  }

  function rejectedResult(rawRequest: ActRequest | undefined, code: string, candidates?: readonly CandidateSummary[], atStep?: number, validation?: ActValidationDiagnostic): ActResult {
    const steps: StepReceipt[] = [];
    for (let index = 1; index <= (rawRequest?.steps.length ?? 0); index += 1) {
      steps.push({ index, kind: rawRequest?.steps[index - 1]?.kind, status: "not_dispatched", code: "preflight_failed" });
    }
    return {
      status: "rejected",
      code,
      steps,
      ...(Number.isSafeInteger(atStep) && (atStep as number) >= 1 ? { atStep } : {}),
      ...(validation ? { validation } : {}),
      ...(candidates && candidates.length > 0 ? { candidates } : {}),
    };
  }

  function preflight(raw: unknown): ActRequest {
    const request = validateRequest(raw, effectiveCapabilities, {
      maxSteps,
      maxTextLength,
      maxScrollAmount,
    });
    // The validator is the protocol authority. Nothing is observed or
    // dispatched until the complete request has passed its schema, capability,
    // focus-order, and budget checks.
    return deepFreeze(JSON.parse(JSON.stringify(request)) as ActRequest);
  }

  async function observeInternal(
    optionsForBackend: { view: View; where?: Selector; read?: DocumentRead; signal?: AbortSignal },
    exposed: boolean,
    documentRequested = false,
  ): Promise<StoredObservation> {
    const frame = await awaitAbortable(backend.observe(optionsForBackend), optionsForBackend.signal ?? new AbortController().signal);
    if (!isFrame(frame)) throw new Error("invalid_frame");
    return observationRegistry.remember(frame, exposed, active?.pinnedObservations, documentRequested);
  }

  function isFrame(value: unknown): value is Frame {
    if (!value || typeof value !== "object") return false;
    const frame = value as Partial<Frame>;
    return typeof frame.scope === "string" && Array.isArray(frame.controls) && typeof frame.complete === "boolean";
  }

  function makeApproval(
    prepared: PreparedStep,
    index: number,
    execution: ActiveExecution,
    riskDecision: RiskDecision,
    riskInput: RiskInput,
  ): PendingApproval {
    const requestId = makeApprovalId();
    const contextSummary = approvalContextSummary(prepared.target, riskDecision.code);
    const request: ApprovalRequest = {
      requestId,
      step: index,
      kind: prepared.step.kind,
      summary: approvalSummary(prepared.step, prepared.target, prepared.destination),
      ...(contextSummary ? { contextSummary } : {}),
      params: approvalActionParams(prepared.step),
      expiresAt: Date.now() + Math.max(1, approvalTimeoutMs),
    };
    if (prepared.target.role || prepared.target.name) {
      request.target = {
        role: sanitizeText(prepared.target.role, 128),
        ...(prepared.target.name ? { name: sanitizeText(prepared.target.name, 256) } : {}),
      };
    }
    let settle!: (decision: ApprovalDecision | "expired" | "cancelled") => void;
    const promise = new Promise<ApprovalDecision | "expired" | "cancelled">((resolve) => {
      settle = resolve;
    });
    const pending: PendingApproval = {
      request,
      binding: prepared.binding,
      riskDecision,
      riskInput,
      state: "pending",
      settle,
      promise,
    };
    pending.timer = setTimeout(() => {
      if (pending.state !== "pending") return;
      pending.state = "expired";
      if (pending.suspended) {
        const result = suspendedResult(pending.suspended, "approval_expired");
        finalizeSuspended(pending.suspended, result);
      } else {
        completedApprovals.set(requestId, {
          requestId,
          status: "stopped",
          code: "approval_expired",
          steps: [],
        });
        releasePendingRisk(pending);
      }
      pending.settle("expired");
    }, Math.max(1, approvalTimeoutMs));
    if (typeof pending.timer === "object" && "unref" in pending.timer) pending.timer.unref();
    approvalRecords.set(requestId, pending);
    execution.pendingApprovals.add(pending);
    if (approvalHandler) {
      try {
        const answer = approvalHandler(pending.request);
        if (answer instanceof Promise) {
          void answer.then((decision) => {
            const normalized = normalizeApprovalDecision(decision);
            if (normalized) void resolveApprovalInternal(requestId, normalized);
          }).catch(() => resolveApprovalInternal(requestId, "deny"));
        } else {
          const normalized = normalizeApprovalDecision(answer);
          if (normalized) pending.syncDecision = normalized;
        }
      } catch {
        pending.syncDecision = "deny";
      }
    }
    return pending;
  }

  function suspendedResult(suspended: SuspendedBatch, code: string): ApprovalResolution {
    const result = stoppedResult(
      suspended.request,
      suspended.index,
      code,
      suspended.receipts,
      suspended.prepared.step.kind,
      undefined,
      suspended.pending.request.requestId,
    );
    return { ...result, requestId: suspended.pending.request.requestId };
  }

  function unknownApprovalResult(requestId: string): ApprovalResolution {
    return {
      requestId,
      status: "stopped",
      code: "approval_not_found",
      steps: [],
    };
  }

  function finalizeSuspended(suspended: SuspendedBatch, result: ApprovalResolution): void {
    suspended.result = result;
    suspendedBatches.delete(suspended);
    suspended.execution.suspended = undefined;
    if (suspended.pending.timer) clearTimeout(suspended.pending.timer);
    completedApprovals.set(suspended.pending.request.requestId, result);
    releasePendingRisk(suspended.pending);
    finishExecution(suspended.execution);
  }

  function releasePendingRisk(pending: PendingApproval): void {
    pending.riskDecision = undefined;
    pending.riskInput = undefined;
    pending.suspended = undefined;
    approvalRecords.delete(pending.request.requestId);
  }

  async function resolveApprovalInternal(requestId: string, decision: ApprovalDecision): Promise<ApprovalResolution> {
    const pending = approvalRecords.get(requestId);
    if (!pending) return completedApprovals.get(requestId) ?? unknownApprovalResult(requestId);
    if (pending.state !== "pending") {
      if (pending.resumePromise) return pending.resumePromise;
      return completedApprovals.get(requestId) ?? unknownApprovalResult(requestId);
    }
    if (closed || globalAbort.signal.aborted || pending.suspended?.execution.controller.signal.aborted) {
      pending.state = "cancelled";
      if (pending.timer) clearTimeout(pending.timer);
      const result = pending.suspended
        ? suspendedResult(pending.suspended, "cancelled")
        : { requestId, status: "stopped" as const, code: "cancelled", steps: [] };
      if (pending.suspended) finalizeSuspended(pending.suspended, result);
      else {
        completedApprovals.set(requestId, result);
        releasePendingRisk(pending);
      }
      pending.settle("cancelled");
      return result;
    }
    pending.state = decision === "approve" ? "approved" : "denied";
    if (pending.timer) clearTimeout(pending.timer);
    pending.settle(decision);
    if (!pending.suspended) {
      const result: ApprovalResolution = {
        requestId,
        status: "stopped",
        code: decision === "approve" ? "approved" : "approval_denied",
        steps: [],
      };
      completedApprovals.set(requestId, result);
      releasePendingRisk(pending);
      return result;
    }
    if (decision === "deny") {
      const result = suspendedResult(pending.suspended, "approval_denied");
      finalizeSuspended(pending.suspended, result);
      return result;
    }
    const suspended = pending.suspended;
    pending.resumePromise = resumeSuspended(suspended);
    return pending.resumePromise;
  }

  function cancelPending(execution: ActiveExecution, reason: "cancelled" | "corrected" | "closed"): void {
    for (const pending of execution.pendingApprovals) {
      if (pending.state !== "pending") continue;
      pending.state = "cancelled";
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.suspended) {
        const result = suspendedResult(pending.suspended, reason);
        finalizeSuspended(pending.suspended, result);
      } else {
        completedApprovals.set(pending.request.requestId, {
          requestId: pending.request.requestId,
          status: "stopped",
          code: reason,
          steps: [],
        });
        releasePendingRisk(pending);
      }
      pending.settle("cancelled");
    }
  }

  function startExecution(callSignal?: AbortSignal, executionOptions: DeskSessionActOptions = {}): ActiveExecution {
    const controller = new AbortController();
    const execution: ActiveExecution = {
      controller,
      epoch,
      replay: executionOptions.replay === true,
      ...(executionOptions.onVerifiedStep ? { onVerifiedStep: executionOptions.onVerifiedStep } : {}),
      pendingApprovals: new Set(),
      pinnedObservations: new Set(),
      focusRecords: new Map(),
      focusBindings: new Map(),
    };
    active = execution;
    const limit = Math.max(1, timeoutMs);
    execution.timeoutTimer = setTimeout(() => {
      if (active === execution && !controller.signal.aborted) {
        execution.reason = "timeout";
        controller.abort("timeout");
        cancelPending(execution, "cancelled");
      }
    }, limit);
    if (typeof execution.timeoutTimer === "object" && "unref" in execution.timeoutTimer) execution.timeoutTimer.unref();
    const parent = callSignal ? AbortSignal.any([globalAbort.signal, callSignal]) : globalAbort.signal;
    const onAbort = (): void => {
      if ((active !== execution && !execution.suspended) || controller.signal.aborted) return;
      execution.reason = "cancelled";
      controller.abort("cancelled");
      cancelPending(execution, "cancelled");
    };
    if (parent.aborted) onAbort();
    else {
      parent.addEventListener("abort", onAbort, { once: true });
      execution.removeParentAbort = () => parent.removeEventListener("abort", onAbort);
    }
    return execution;
  }

  function finishExecution(execution: ActiveExecution): void {
    if (active === execution) active = undefined;
    if (execution.timeoutTimer) clearTimeout(execution.timeoutTimer);
    execution.removeParentAbort?.();
    try { backend.clearExecutionState?.(execution.controller.signal); } catch { /* cleanup cannot change the action result */ }
    execution.focusBindings.clear();
    if (!execution.suspended) {
      cancelPending(execution, execution.reason === "corrected" ? "corrected" : execution.reason === "closed" ? "closed" : "cancelled");
    }
    observationRegistry.release(execution.pinnedObservations);
  }

  async function revalidateApproval(
    request: ActRequest,
    index: number,
    prepared: PreparedStep,
    execution: ActiveExecution,
  ): Promise<{ prepared?: PreparedStep; code?: string; candidates?: readonly Control[]; candidateObservation?: StoredObservation }> {
    const refreshed = await targetResolver.resolve(request, index, prepared.step, execution.controller.signal);
    if (!refreshed.prepared) return refreshed;
    if (!sameBinding(prepared.binding, refreshed.prepared.binding)) return { code: "approval_stale" };
    return refreshed;
  }

  async function verifyApproved(
    request: ActRequest,
    index: number,
    prepared: PreparedStep,
    execution: ActiveExecution,
    pending: PendingApproval,
  ): Promise<{ prepared?: PreparedStep; code?: string; candidates?: readonly Control[]; candidateObservation?: StoredObservation }> {
    const refreshed = await revalidateApproval(request, index, prepared, execution);
    if (!refreshed.prepared) return refreshed;
    const hostEvidence = pending.riskInput?.hostEvidence;
    if (hostEvidence?.kind === "focus_handoff") {
      const evidence = hostEvidence as Record<string, unknown>;
      const proof = evidenceRecord(evidence.proof);
      const sourceStep = evidence.sourceStep;
      const commitStep = evidence.commitStep;
      const focusTarget = refreshed.prepared.step.kind === "keypress"
        ? refreshed.prepared.step.target
        : undefined;
      if (pending.riskInput?.signal !== execution.controller.signal
        || !Number.isSafeInteger(sourceStep) || !Number.isSafeInteger(commitStep) || commitStep !== index
        || !focusTarget || !("focusFromStep" in focusTarget)
        || focusTarget.focusFromStep !== sourceStep
        || evidence.focusControlId !== refreshed.prepared.target.id
        || evidence.windowScope !== refreshed.prepared.target.windowScope
        || !proof || evidence.binding !== proof.binding || evidence.sourceControlId !== proof.sourceControlId
        || evidence.focusControlId !== proof.focusControlId || evidence.windowScope !== proof.windowScope) {
        return { code: "approval_stale" };
      }
    }
    const refreshedInput: RiskInput = {
      step: refreshed.prepared.step,
      target: policyControl(refreshed.prepared.target),
      ...(refreshed.prepared.destination ? { destination: policyControl(refreshed.prepared.destination) } : {}),
      signal: execution.controller.signal,
      ...(hostEvidence ? { hostEvidence } : {}),
    };
    let finalDecision: RiskDecision;
    try {
      if (!pending.riskDecision || !pending.riskInput) return { code: "approval_evidence_unavailable" };
      const internalRecheck = recheckRiskApproval(policy, pending.riskDecision, pending.riskInput, refreshedInput);
      finalDecision = await awaitAbortable(internalRecheck ?? policy(refreshedInput), execution.controller.signal);
    } catch {
      if (execution.controller.signal.aborted) return { code: currentReason(execution) };
      return { code: "risk_policy_error" };
    }
    if (finalDecision.decision === "needs_evidence") return { code: "risk_evidence_required" };
    if (finalDecision.decision !== "approve" && finalDecision.decision !== "allow") return { code: finalDecision.code || "risk_recheck_denied" };
    return refreshed;
  }

  async function resumeSuspended(suspended: SuspendedBatch): Promise<ApprovalResolution> {
    const resume = async (): Promise<ApprovalResolution> => {
      if (suspended.result) return suspended.result;
      suspendedBatches.delete(suspended);
      suspended.execution.suspended = undefined;
      active = suspended.execution;
      const execution = suspended.execution;
      if (execution.controller.signal.aborted || execution.epoch !== epoch || closed) {
        const result = suspendedResult(suspended, currentReason(execution));
        finalizeSuspended(suspended, result);
        return result;
      }
      let verified: { prepared?: PreparedStep; code?: string; candidates?: readonly Control[]; candidateObservation?: StoredObservation };
      try {
        verified = await verifyApproved(suspended.request, suspended.index, suspended.prepared, execution, suspended.pending);
      } catch {
        verified = { code: "approval_recheck_failed" };
      }
      if (!verified.prepared) {
        const result = suspendedResult(suspended, verified.code ?? "risk_recheck_denied");
        finalizeSuspended(suspended, result);
        return result;
      }
      const resumed = await runBatch(
        suspended.request,
        execution,
        suspended.index - 1,
        suspended.receipts,
        verified.prepared,
      );
      const result: ApprovalResolution = {
        ...resumed,
        requestId: resumed.requestId ?? suspended.pending.request.requestId,
      };
      suspended.result = result;
      completedApprovals.set(suspended.pending.request.requestId, result);
      releasePendingRisk(suspended.pending);
      // A later step may itself be waiting for approval. In that case the
      // resumed execution remains live under the newer pending request.
      if (!execution.suspended) finishExecution(execution);
      return result;
    };
    const queued = actQueue.then(resume, resume);
    actQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async function checkExpectation(expectation: Expect, signal: AbortSignal, waitForChange = true): Promise<{ ok: boolean; code?: string; control?: Control }> {
    const deadline = Date.now() + (waitForChange ? Math.max(0, expectTimeoutMs) : 0);
    let lastCode = "expect_failed";
    let lastControl: Control | undefined;
    while (true) {
      if (signal.aborted) return { ok: false, code: "cancelled" };
      const stored = await observeInternal({ view: "controls", where: expectation.target, signal }, false);
      if (!stored.frame.complete) {
        lastCode = "expect_observation_incomplete";
      } else {
        const result = matchControl(stored.frame, expectation.target, { aliases: false });
        if (!result.control) {
          lastCode = result.candidates && result.candidates.length > 1
            ? "expect_target_ambiguous"
            : "expect_target_not_found";
        } else if ("state" in expectation) {
          if (expectation.state === "present" || hasState(result.control, expectation.state)) return { ok: true, control: result.control };
          lastControl = result.control;
          lastCode = "expect_state_failed";
        } else if (isSensitiveControl(result.control) || result.control.value === undefined) {
          // A valueEquals readback must never turn an unreadable/protected
          // field into evidence of success.
          return { ok: false, code: "expect_value_unavailable" };
        } else if (result.control.value === expectation.valueEquals) {
          return { ok: true, control: result.control };
        } else {
          lastControl = result.control;
          lastCode = "expect_value_failed";
        }
      }
      if (Date.now() >= deadline) return { ok: false, code: lastCode, ...(lastControl ? { control: lastControl } : {}) };
      const delay = Math.min(25, Math.max(1, deadline - Date.now()));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        if (typeof timer === "object" && "unref" in timer) timer.unref();
      });
    }
  }

  async function runBatch(
    request: ActRequest,
    execution: ActiveExecution,
    startPosition: number,
    receipts: StepReceipt[],
    initialPrepared?: PreparedStep,
  ): Promise<ActResult> {
    try {
      for (let position = startPosition; position < request.steps.length; position += 1) {
        const index = position + 1;
        const step = request.steps[position];
        const usingInitialPrepared = position === startPosition && initialPrepared !== undefined;
        if (execution.controller.signal.aborted || execution.epoch !== epoch) {
          return stoppedResult(request, index, currentReason(execution), receipts, step.kind);
        }
        let prepared: PreparedStep;
        if (usingInitialPrepared) {
          prepared = initialPrepared;
        } else {
          let resolution: { prepared?: PreparedStep; code?: string; candidates?: readonly Control[]; candidateObservation?: StoredObservation };
          try {
            resolution = await targetResolver.resolve(request, index, step, execution.controller.signal);
          } catch (error) {
            if (execution.controller.signal.aborted) return stoppedResult(request, index, currentReason(execution), receipts, step.kind);
            return stoppedResult(request, index, safeValidationCode(error, "observe_failed"), receipts, step.kind);
          }
          if (!resolution.prepared) {
            if (resolution.candidateObservation) observationRegistry.markExposed(resolution.candidateObservation);
            const candidates = resolution.candidates?.map((candidate) => observationRegistry.candidateSummary(candidate, resolution.candidateObservation));
            const candidateObservationId = candidates?.some((candidate) => candidate.ref !== undefined)
              ? resolution.candidateObservation?.observationId
              : undefined;
            return stoppedResult(request, index, resolution.code ?? "target_not_found", receipts, step.kind, candidates, undefined, candidateObservationId);
          }
          prepared = resolution.prepared;
        }

        const focusFromStep = step.kind === "keypress" && step.key === "Enter" && "focusFromStep" in step.target
          ? step.target.focusFromStep
          : undefined;
        const focusBindingRecord = focusFromStep === undefined ? undefined : execution.focusBindings.get(focusFromStep);
        let hostEvidence: HostPolicyEvidence | undefined;
        if (focusBindingRecord) {
          const proof = focusBindingRecord.proof;
          if (focusBindingRecord.signal !== execution.controller.signal
            || focusBindingRecord.sourceStep !== focusFromStep
            || focusBindingRecord.controlId !== prepared.target.id
            || focusBindingRecord.windowScope !== prepared.target.windowScope
            || proof.binding !== focusBindingRecord.binding
            || proof.sourceControlId !== focusBindingRecord.sourceControlId
            || proof.focusControlId !== prepared.target.id
            || proof.windowScope !== focusBindingRecord.windowScope) {
            return stoppedResult(request, index, "grid_commit_proof_expired", receipts, step.kind);
          }
          const evidence: FocusHandoffPolicyEvidence = Object.freeze({
            kind: "focus_handoff",
            binding: focusBindingRecord.binding,
            sourceStep: focusFromStep,
            commitStep: index,
            sourceControlId: focusBindingRecord.sourceControlId,
            focusControlId: focusBindingRecord.controlId,
            windowScope: focusBindingRecord.windowScope,
            proof,
          });
          hostEvidence = evidence;
        }

        let decision: RiskDecision | undefined;
        let riskInput: RiskInput | undefined;
        if (!usingInitialPrepared) {
          try {
            riskInput = {
              step,
              target: policyControl(prepared.target),
              ...(prepared.destination ? { destination: policyControl(prepared.destination) } : {}),
              signal: execution.controller.signal,
              ...(hostEvidence ? { hostEvidence } : {}),
            };
            decision = await awaitAbortable(policy(riskInput), execution.controller.signal);
          } catch {
            if (execution.controller.signal.aborted) return stoppedResult(request, index, currentReason(execution), receipts, step.kind);
            return stoppedResult(request, index, "risk_policy_error", receipts, step.kind);
          }
        }
        if (execution.controller.signal.aborted || execution.epoch !== epoch) {
          return stoppedResult(request, index, currentReason(execution), receipts, step.kind);
        }
        if (!usingInitialPrepared && decision && decision.decision === "deny") {
          return stoppedResult(request, index, decision.code || "risk_denied", receipts, step.kind);
        }
        if (!usingInitialPrepared && decision?.decision === "needs_evidence") {
          const result = stoppedResult(request, index, decision.code || "risk_evidence_required", receipts, step.kind);
          const recoveryHint = pointClickEvidenceHint(step, decision.code);
          return {
            ...result,
            code: "risk_evidence_required",
            ...(recoveryHint ? { recoveryHint } : {}),
          };
        }
        if (!usingInitialPrepared && (!decision || (decision.decision !== "allow" && decision.decision !== "approve"))) {
          return stoppedResult(request, index, decision?.code || "risk_policy_invalid", receipts, step.kind);
        }
        if (!usingInitialPrepared && decision?.decision === "approve") {
          const pending = makeApproval(prepared, index, execution, decision, riskInput!);
          if (pending.syncDecision) {
            const syncDecision = pending.syncDecision;
            pending.state = syncDecision === "approve" ? "approved" : "denied";
            if (pending.timer) clearTimeout(pending.timer);
            pending.settle(syncDecision);
            if (syncDecision === "deny") {
              const result = stoppedResult(request, index, "approval_denied", receipts, step.kind);
              const requestId = pending.request.requestId;
              completedApprovals.set(requestId, { ...result, requestId });
              releasePendingRisk(pending);
              return result;
            }
            let verified: { prepared?: PreparedStep; code?: string; candidates?: readonly Control[]; candidateObservation?: StoredObservation };
            try {
              verified = await verifyApproved(request, index, prepared, execution, pending);
            } catch {
              verified = { code: "approval_recheck_failed" };
            }
            if (!verified.prepared) {
              releasePendingRisk(pending);
              return stoppedResult(request, index, verified.code ?? "approval_stale", receipts, step.kind);
            }
            prepared = verified.prepared;
            releasePendingRisk(pending);
          } else {
          const suspended: SuspendedBatch = {
            request,
            index,
            prepared,
            receipts,
            execution,
            pending,
          };
          pending.suspended = suspended;
          execution.suspended = suspended;
          suspendedBatches.add(suspended);
          if (execution.timeoutTimer) clearTimeout(execution.timeoutTimer);
          active = undefined;
          return stoppedResult(request, index, "approval_required", receipts, step.kind, undefined, pending.request.requestId);
          }
        }
        if (execution.controller.signal.aborted || execution.epoch !== epoch) {
          return stoppedResult(request, index, currentReason(execution), receipts, step.kind);
        }

        // Host-owned replay may avoid toggling a disclosure/tab that already
        // satisfies its recorded goal. The target and risk policy above still
        // ran against the fresh live frame; this read is the final pre-dispatch
        // expectation check and never retries the action.
        if (execution.replay && step.kind === "click") {
          if (!isVerifiedClickCandidate(step, prepared.target)) {
            return stoppedResult(request, index, "replay_unsafe_target", receipts, step.kind);
          }
          let current: { ok: boolean; code?: string; control?: Control };
          try {
            current = await checkExpectation(step.expect!, execution.controller.signal, false);
          } catch {
            if (execution.controller.signal.aborted) return stoppedResult(request, index, currentReason(execution), receipts, step.kind);
            current = { ok: false, code: "expect_observe_failed" };
          }
          if (current.ok && current.control !== undefined && current.control.id === prepared.target.id
            && isVerifiedClickCandidate(step, current.control)) {
            receipts.push({ index, kind: step.kind, status: "verified", code: "already_satisfied" });
            continue;
          }
          if (current.code === "cancelled") return stoppedResult(request, index, current.code, receipts, step.kind);
          // A click may proceed only when this exact live target was found and
          // the one expected state is still absent. Ambiguous, incomplete,
          // missing, or structurally changed evidence must stop before input.
          if (current.code !== "expect_state_failed" || current.control === undefined
            || current.control.id !== prepared.target.id || !isVerifiedClickCandidate(step, current.control)) {
            return stoppedResult(request, index, current.code ?? "expect_failed", receipts, step.kind);
          }
        }

        const focusBinding = focusBindingRecord?.binding;
        const dispatch: Dispatch = {
          step,
          frame: prepared.frame,
          target: prepared.target,
          ...(prepared.destination ? { destination: prepared.destination } : {}),
          ...(prepared.origin ? { origin: prepared.origin } : {}),
          ...(capturesFocusForLaterStep(request, position, index) ? { captureFocus: true } : {}),
          ...(capturesFocusForEnterLater(request, position, index) ? { captureFocusForEnter: true } : {}),
          ...(focusBinding ? { focusBinding } : {}),
          signal: execution.controller.signal,
        };
        if (focusFromStep !== undefined && focusBindingRecord) {
          execution.focusBindings.delete(focusFromStep);
          execution.focusRecords.delete(focusFromStep);
        }
        let delivery: Delivery;
        try {
          delivery = await awaitAbortable(backend.dispatch(dispatch), execution.controller.signal);
          if (!delivery || !["dispatched", "refused", "partial", "unknown"].includes(delivery.status)) {
            delivery = { status: "unknown", code: "invalid_delivery" };
          }
        } catch {
          // Dispatch may have reached a remote/OS boundary before rejecting;
          // never retry and never claim that it was not delivered.
          delivery = { status: "unknown", code: "dispatch_unknown" };
        }

        if (delivery.status === "refused") {
          const code = safeAdapterCode(delivery.code, "backend_refused");
          receipts.push({ index, kind: step.kind, status: "not_dispatched", code });
          return stoppedResult(request, index, code, receipts);
        }
        if (delivery.status === "unknown") {
          const code = safeAdapterCode(delivery.code, "dispatch_unknown");
          receipts.push({ index, kind: step.kind, status: "unknown", code });
          return stoppedResult(request, index, code, receipts);
        }
        if (delivery.status === "partial") {
          const code = safeAdapterCode(delivery.code, "partial");
          receipts.push({ index, kind: step.kind, status: "partial", code });
          return stoppedResult(request, index, code, receipts);
        }

        if (delivery.focusId) {
          const proof = isFocusBindingProof(delivery.hostEvidence) ? delivery.hostEvidence : undefined;
          const hasPrivateBinding = typeof delivery.focusBinding === "string" || delivery.hostEvidence !== undefined;
          const validBinding = typeof delivery.focusBinding === "string" && proof !== undefined
            && proof.binding === delivery.focusBinding
            && proof.sourceControlId === prepared.target.id
            && proof.focusControlId === delivery.focusId
            && proof.windowScope === prepared.target.windowScope;
          if (hasPrivateBinding && !validBinding) {
            // A private host binding without its matching evidence cannot
            // become a generic focusFromStep target.
            execution.focusRecords.delete(index);
            execution.focusBindings.delete(index);
          } else {
            execution.focusRecords.set(index, {
              scope: prepared.frame.scope,
              controlId: delivery.focusId,
              step: index,
              ...(prepared.target.windowScope ? { windowScope: prepared.target.windowScope } : {}),
            });
            if (validBinding && proof) execution.focusBindings.set(index, {
              binding: delivery.focusBinding!,
              signal: execution.controller.signal,
              sourceStep: index,
              controlId: delivery.focusId,
              windowScope: proof.windowScope,
              sourceControlId: proof.sourceControlId,
              proof,
            });
            else execution.focusBindings.delete(index);
          }
        } else if (delivery.suppressFocusHandoff !== true) {
          execution.focusRecords.set(index, {
            scope: prepared.frame.scope,
            controlId: prepared.target.id,
            step: index,
            ...(prepared.target.windowScope ? { windowScope: prepared.target.windowScope } : {}),
          });
          execution.focusBindings.delete(index);
        } else {
          execution.focusRecords.delete(index);
          execution.focusBindings.delete(index);
        }
        if (step.expect) {
          let expectation: { ok: boolean; code?: string; control?: Control };
          try {
            expectation = await checkExpectation(step.expect, execution.controller.signal);
          } catch {
            if (execution.controller.signal.aborted) {
              const code = currentReason(execution);
              receipts.push({ index, kind: step.kind, status: "dispatched", code });
              return stoppedResult(request, index, code, receipts);
            }
            expectation = { ok: false, code: "expect_observe_failed" };
          }
          if (!expectation.ok) {
            receipts.push({ index, kind: step.kind, status: "dispatched", code: expectation.code ?? "expect_failed" });
            const stopped = stoppedResult(request, index, expectation.code ?? "expect_failed", receipts);
            return index < request.steps.length && expectation.code !== "cancelled"
              ? { ...stopped, recoveryHint: ACT_EXPECTATION_FAILURE_HINT }
              : stopped;
          }
          receipts.push({ index, kind: step.kind, status: "verified" });
          if (execution.onVerifiedStep && expectation.control && step.kind === "click") {
            const stateChanged = "state" in step.expect && step.expect.state !== "present"
              && !hasState(prepared.target, step.expect.state)
              && hasState(expectation.control, step.expect.state);
            try {
              execution.onVerifiedStep({
                index,
                step,
                target: prepared.target,
                after: expectation.control,
                expectation: step.expect,
                changed: stateChanged,
              });
            } catch {
              // Capture is opportunistic and must never change the action receipt.
            }
          }
        } else {
          receipts.push({ index, kind: step.kind, status: "dispatched" });
        }
      }
      return { status: "completed", steps: receipts };
    } finally {
      if (!execution.suspended) finishExecution(execution);
    }
  }

  async function execute(raw: unknown, queuedEpoch: number, signal?: AbortSignal, executionOptions: DeskSessionActOptions = {}): Promise<ActResult> {
    let request: ActRequest | undefined;
    try {
      request = preflight(raw);
    } catch (error) {
      const atStep = error instanceof RequestValidationError ? error.atStep : undefined;
      const validation = error instanceof RequestValidationError ? error.diagnostic : undefined;
      return rejectedResult(undefined, safeValidationCode(error, "invalid_request"), undefined, atStep, validation);
    }
    if (closed) return stoppedResult(request, 1, "closed");
    if (queuedEpoch !== epoch || globalAbort.signal.aborted || signal?.aborted) return stoppedResult(request, 1, "cancelled");

    const execution = startExecution(signal, executionOptions);
    // focusFromStep is scoped to this act batch, never to a prior batch.
    execution.focusRecords.clear();
    execution.focusBindings.clear();
    return runBatch(request, execution, 0, []);
  }

  async function observe(optionsForObserve: DeskObserveOptions = {}): Promise<DeskObservation> {
    if (closed) throw new Error("closed");
    const documentOnly = optionsForObserve.view === "document"
      || (optionsForObserve.view === undefined && optionsForObserve.read !== undefined && !optionsForObserve.where);
    if (documentOnly && optionsForObserve.where) throw new Error("invalid_document_scope");
    if (documentOnly && !allowModelDocumentText) throw new Error("document_delivery_not_authorized");
    const view = documentOnly ? "document" : optionsForObserve.view ?? "controls";
    if (!OBSERVATION_VIEWS.includes(view)) throw new Error("invalid_view");
    const backendView: View = view === "document" ? "document" : view !== "controls" && !allowModelImages ? "controls" : view;
    const read = allowModelDocumentText && !optionsForObserve.where
      ? optionsForObserve.read ?? (documentOnly ? "document" : undefined)
      : undefined;
    const explicitProjection = optionsForObserve.projection;
    const broadControlsQuery = isBroadControlsQuery(view, optionsForObserve.where, read);
    const broadIncremental = options.defaultObservationProjection === "incremental"
      && explicitProjection === undefined
      && (view === "controls" || view === "both")
      && read === undefined
      && optionsForObserve.where === undefined;
    const requestedProjection = explicitProjection
      ?? (broadIncremental ? { mode: "compact", since: "previous" } as const : defaultObservationProjection);
    const defaultBroadPreview = broadControlsQuery
      && requestedProjection?.mode === "compact"
      && requestedProjection.maxControls === undefined;
    // Keep compact output bounded for broad control discovery at the public
    // observation boundary. Scoped selectors, explicit limits, and full/legacy
    // observations keep their existing behavior.
    const projection = requestedProjection?.mode === "compact" && broadControlsQuery
      ? { ...requestedProjection, maxControls: requestedProjection.maxControls ?? 6 }
      : requestedProjection;
    const effectiveRead = projection?.mode === "compact" && read !== undefined ? compactDocumentRead(read) : read;
    const observeEpoch = epoch;
    const merged = mergeSignals([globalAbort.signal, optionsForObserve.signal]);
    try {
      const queryKey = projection?.mode === "compact"
        && (view === "controls" || view === "both")
        && read === undefined
        ? controlsQueryKey(optionsForObserve.where)
        : undefined;
      const stored = await observeInternal({
        view: backendView,
        ...(optionsForObserve.where ? { where: { ...optionsForObserve.where } } : {}),
        ...(effectiveRead ? { read: effectiveRead } : {}),
        signal: merged.signal,
      }, true, effectiveRead !== undefined);
      if (projection?.mode === "compact" && (observeEpoch !== epoch || closed || merged.signal.aborted)) {
        throw new Error("observation_cancelled");
      }
      const observation = observationRegistry.publicObservation(stored, view, projection, queryKey, broadIncremental);
      const projectionResult = observation.projection;
      if (broadControlsQuery
        && projectionResult?.mode === "compact"
        && projectionResult.kind === "snapshot"
        && (!projectionResult.backendComplete || (defaultBroadPreview && projectionResult.truncated))) {
        const reasons = [
          ...(!projectionResult.backendComplete ? ["The backend control query was incomplete."] : []),
          ...(projectionResult.truncated ? ["The compact preview hit its row or byte budget."] : []),
        ].join(" ");
        return {
          ...observation,
          projection: {
            ...projectionResult,
            guidance: `${reasons} Narrow with an exact where:{name:"..."} or where:{within:"..."}; use where:{state:"focused"} for the current field.${allowModelDocumentText ? " Use read.query for page prose." : ""}`,
          },
        };
      }
      return observation;
    } catch (error) {
      if (typeof effectiveRead === "object" && effectiveRead.cursor && error instanceof Error
        && ["document_cursor_stale", "document_route_changed"].includes(error.message)) {
        throw new Error("document_cursor_stale");
      }
      throw new Error("observe_failed");
    } finally {
      merged.dispose();
    }
  }

  function act(raw: unknown, signal?: AbortSignal, executionOptions: DeskSessionActOptions = {}): Promise<ActResult> {
    const queuedEpoch = epoch;
    const run = () => execute(raw, queuedEpoch, signal, executionOptions);
    const next = actQueue.then(run, run);
    actQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  function replay(raw: unknown, signal?: AbortSignal): Promise<ActResult> {
    const queuedEpoch = epoch;
    const run = () => execute(raw, queuedEpoch, signal, { replay: true });
    const next = actQueue.then(run, run);
    actQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  function cancel(reason = "cancelled"): void {
    if (closed) return;
    epoch += 1;
    const pendingReason: "cancelled" | "corrected" = reason === "corrected" ? "corrected" : "cancelled";
    if (active) {
      active.reason = reason;
      if (!active.controller.signal.aborted) active.controller.abort(reason);
      cancelPending(active, pendingReason);
    }
    for (const suspended of [...suspendedBatches]) {
      suspended.execution.reason = reason;
      if (!suspended.execution.controller.signal.aborted) suspended.execution.controller.abort(reason);
      cancelPending(suspended.execution, pendingReason);
    }
    observationRegistry.invalidatePublicSnapshots();
  }

  function correct(reason = "corrected"): void {
    cancel(reason);
  }

  async function resolveApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalResolution> {
    if (decision !== "approve" && decision !== "deny") {
      return { requestId, status: "stopped", code: "invalid_decision", steps: [] };
    }
    return resolveApprovalInternal(requestId, decision);
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    epoch += 1;
    if (active) {
      active.reason = "closed";
      if (!active.controller.signal.aborted) active.controller.abort("closed");
      cancelPending(active, "closed");
    }
    for (const suspended of [...suspendedBatches]) {
      suspended.execution.reason = "closed";
      if (!suspended.execution.controller.signal.aborted) suspended.execution.controller.abort("closed");
      cancelPending(suspended.execution, "closed");
    }
    abortGlobal();
    observationRegistry.invalidatePublicSnapshots();
    closePromise = Promise.resolve().then(() => backend.close()).then(() => undefined);
    return closePromise;
  }

  return Object.freeze({
    capabilities: effectiveCapabilities,
    allowModelImages,
    allowModelDocumentText,
    limits: sessionLimits,
    supportsObservationProjection: true as const,
    ...(options.defaultObservationProjection === undefined ? {} : { defaultObservationProjection: options.defaultObservationProjection }),
    observe,
    act,
    replay,
    resolveApproval,
    correct,
    cancel,
    invalidateObservationSnapshots: () => observationRegistry.invalidatePublicSnapshots(),
    close,
  });
}
