import type {
  ActionKind,
  ActRequest,
  Control,
  Delivery,
  DesktopBackend,
  Dispatch,
  Frame,
  RiskDecision,
  State,
  View,
  Selector,
  Expect,
} from "./contracts.js";
import type {
  ActResult,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolution,
  CandidateSummary,
  DeskObservation,
  DeskObserveOptions,
  DeskSession,
  DeskSessionOptions,
  StepReceipt,
} from "./core/session-types.js";
export type {
  ActResult,
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  ApprovalResolution,
  CandidateSummary,
  ControlObservation,
  DeskObservation,
  DeskObserveOptions,
  DeskSession,
  DeskSessionOptions,
  StepReceipt,
  StepReceiptStatus,
} from "./core/session-types.js";
import { randomUUID } from "node:crypto";
import { validateRequest } from "./request.js";
import { matchControl } from "./grounding.js";
import { defaultRiskPolicy } from "./policy.js";
import { awaitAbortable, deepFreeze, freezeCapabilities, intersectCapabilities, mergeSignals, safeAdapterCode, safeValidationCode } from "./core/session-support.js";
import { approvalActionParams, approvalSummary, normalizeApprovalDecision } from "./core/session-approval.js";
import { isSensitiveControl, ObservationRegistry, sanitizeText, type StoredObservation } from "./core/observation-registry.js";
import { sameBinding, TargetResolver, type Binding, type FocusRecord, type PreparedStep } from "./core/session-target-resolver.js";

interface PendingApproval {
  request: ApprovalRequest;
  binding: Binding;
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

interface ActiveExecution {
  controller: AbortController;
  epoch: number;
  reason?: string;
  pendingApprovals: Set<PendingApproval>;
  pinnedObservations: Set<StoredObservation>;
  focusRecords: Map<number, FocusRecord>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  removeGlobalAbort?: () => void;
  suspended?: SuspendedBatch;
}

const DEFAULT_MAX_STEPS = 32;
const DEFAULT_MAX_TEXT_LENGTH = 16_384;
const DEFAULT_MAX_SCROLL_AMOUNT = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;
const OBSERVATION_VIEWS: readonly View[] = ["controls", "image", "both"];

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

  function grantedAction(kind: ActionKind): boolean {
    return effectiveCapabilities.some((capability) => capability.kind === kind
      && capability.targets.some((target) => target === "selector" || target === "ref"));
  }

  const observationRegistry = new ObservationRegistry({
    allowModelImages,
    grantedAction,
    refsGranted: effectiveCapabilities.some((capability) => capability.targets.includes("ref")),
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

  function rejectedResult(rawRequest: ActRequest | undefined, code: string, candidates?: readonly CandidateSummary[]): ActResult {
    const steps: StepReceipt[] = [];
    for (let index = 1; index <= (rawRequest?.steps.length ?? 0); index += 1) {
      steps.push({ index, kind: rawRequest?.steps[index - 1]?.kind, status: "not_dispatched", code: "preflight_failed" });
    }
    return {
      status: "rejected",
      code,
      steps,
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
    optionsForBackend: { view: View; where?: Selector; signal?: AbortSignal },
    exposed: boolean,
  ): Promise<StoredObservation> {
    const frame = await awaitAbortable(backend.observe(optionsForBackend), optionsForBackend.signal ?? new AbortController().signal);
    if (!isFrame(frame)) throw new Error("invalid_frame");
    return observationRegistry.remember(frame, exposed, active?.pinnedObservations);
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
  ): PendingApproval {
    const requestId = makeApprovalId();
    const request: ApprovalRequest = {
      requestId,
      step: index,
      kind: prepared.step.kind,
      summary: approvalSummary(prepared.step, prepared.target, prepared.destination),
      ...(prepared.target.approvalContext?.summary
        ? { contextSummary: sanitizeText(prepared.target.approvalContext.summary, 512) }
        : {}),
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
    finishExecution(suspended.execution);
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
      else completedApprovals.set(requestId, result);
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
      }
      pending.settle("cancelled");
    }
  }

  function startExecution(): ActiveExecution {
    const controller = new AbortController();
    const execution: ActiveExecution = {
      controller,
      epoch,
      pendingApprovals: new Set(),
      pinnedObservations: new Set(),
      focusRecords: new Map(),
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
    const onGlobalAbort = (): void => {
      if ((active !== execution && !execution.suspended) || controller.signal.aborted) return;
      execution.reason = "cancelled";
      controller.abort("cancelled");
      cancelPending(execution, "cancelled");
    };
    if (globalAbort.signal.aborted) onGlobalAbort();
    else {
      globalAbort.signal.addEventListener("abort", onGlobalAbort, { once: true });
      execution.removeGlobalAbort = () => globalAbort.signal.removeEventListener("abort", onGlobalAbort);
    }
    return execution;
  }

  function finishExecution(execution: ActiveExecution): void {
    if (active === execution) active = undefined;
    if (execution.timeoutTimer) clearTimeout(execution.timeoutTimer);
    execution.removeGlobalAbort?.();
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
  ): Promise<{ prepared?: PreparedStep; code?: string; candidates?: readonly Control[]; candidateObservation?: StoredObservation }> {
    const refreshed = await revalidateApproval(request, index, prepared, execution);
    if (!refreshed.prepared) return refreshed;
    let finalDecision: RiskDecision;
    try {
      finalDecision = await awaitAbortable(policy({
        step: refreshed.prepared.step,
        target: policyControl(refreshed.prepared.target),
        destination: refreshed.prepared.destination ? policyControl(refreshed.prepared.destination) : undefined,
        signal: execution.controller.signal,
      }), execution.controller.signal);
    } catch {
      if (execution.controller.signal.aborted) return { code: currentReason(execution) };
      return { code: "risk_policy_error" };
    }
    if (finalDecision.decision !== "approve") return { code: finalDecision.code || "risk_recheck_denied" };
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
        verified = await verifyApproved(suspended.request, suspended.index, suspended.prepared, execution);
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
      // A later step may itself be waiting for approval. In that case the
      // resumed execution remains live under the newer pending request.
      if (!execution.suspended) finishExecution(execution);
      return result;
    };
    const queued = actQueue.then(resume, resume);
    actQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async function checkExpectation(expectation: Expect, signal: AbortSignal): Promise<{ ok: boolean; code?: string }> {
    const deadline = Date.now() + Math.max(0, expectTimeoutMs);
    let lastCode = "expect_failed";
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
          if (expectation.state === "present" || hasState(result.control, expectation.state)) return { ok: true };
          lastCode = "expect_state_failed";
        } else if (isSensitiveControl(result.control) || result.control.value === undefined) {
          // A valueEquals readback must never turn an unreadable/protected
          // field into evidence of success.
          return { ok: false, code: "expect_value_unavailable" };
        } else if (result.control.value === expectation.valueEquals) {
          return { ok: true };
        } else {
          lastCode = "expect_value_failed";
        }
      }
      if (Date.now() >= deadline) return { ok: false, code: lastCode };
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

        let decision: RiskDecision | undefined;
        if (!usingInitialPrepared) {
          try {
            decision = await awaitAbortable(policy({
              step,
              target: policyControl(prepared.target),
              destination: prepared.destination ? policyControl(prepared.destination) : undefined,
              signal: execution.controller.signal,
            }), execution.controller.signal);
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
        if (!usingInitialPrepared && (!decision || (decision.decision !== "allow" && decision.decision !== "approve"))) {
          return stoppedResult(request, index, decision?.code || "risk_policy_invalid", receipts, step.kind);
        }
        if (!usingInitialPrepared && decision?.decision === "approve") {
          const pending = makeApproval(prepared, index, execution);
          if (pending.syncDecision) {
            const syncDecision = pending.syncDecision;
            pending.state = syncDecision === "approve" ? "approved" : "denied";
            if (pending.timer) clearTimeout(pending.timer);
            pending.settle(syncDecision);
            if (syncDecision === "deny") {
              return stoppedResult(request, index, "approval_denied", receipts, step.kind);
            }
            let verified: { prepared?: PreparedStep; code?: string; candidates?: readonly Control[]; candidateObservation?: StoredObservation };
            try {
              verified = await verifyApproved(request, index, prepared, execution);
            } catch {
              verified = { code: "approval_recheck_failed" };
            }
            if (!verified.prepared) {
              return stoppedResult(request, index, verified.code ?? "approval_stale", receipts, step.kind);
            }
            prepared = verified.prepared;
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

        const dispatch: Dispatch = {
          step,
          frame: prepared.frame,
          target: prepared.target,
          ...(prepared.destination ? { destination: prepared.destination } : {}),
          ...(prepared.origin ? { origin: prepared.origin } : {}),
          signal: execution.controller.signal,
        };
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
          execution.focusRecords.set(index, { scope: prepared.frame.scope, controlId: delivery.focusId, step: index });
        } else {
          execution.focusRecords.set(index, { scope: prepared.frame.scope, controlId: prepared.target.id, step: index });
        }
        if (step.expect) {
          let expectation: { ok: boolean; code?: string };
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
            return stoppedResult(request, index, expectation.code ?? "expect_failed", receipts);
          }
          receipts.push({ index, kind: step.kind, status: "verified" });
        } else {
          receipts.push({ index, kind: step.kind, status: "dispatched" });
        }
      }
      return { status: "completed", steps: receipts };
    } finally {
      if (!execution.suspended) finishExecution(execution);
    }
  }

  async function execute(raw: unknown, queuedEpoch: number): Promise<ActResult> {
    let request: ActRequest | undefined;
    try {
      request = preflight(raw);
    } catch (error) {
      return rejectedResult(undefined, safeValidationCode(error, "invalid_request"));
    }
    if (closed) return stoppedResult(request, 1, "closed");
    if (queuedEpoch !== epoch || globalAbort.signal.aborted) return stoppedResult(request, 1, "cancelled");

    const execution = startExecution();
    // focusFromStep is scoped to this act batch, never to a prior batch.
    execution.focusRecords.clear();
    return runBatch(request, execution, 0, []);
  }

  async function observe(optionsForObserve: DeskObserveOptions = {}): Promise<DeskObservation> {
    if (closed) throw new Error("closed");
    const view = optionsForObserve.view ?? "controls";
    if (!OBSERVATION_VIEWS.includes(view)) throw new Error("invalid_view");
    const backendView: View = view !== "controls" && !allowModelImages ? "controls" : view;
    const merged = mergeSignals([globalAbort.signal, optionsForObserve.signal]);
    try {
      const stored = await observeInternal({
        view: backendView,
        ...(optionsForObserve.where ? { where: { ...optionsForObserve.where } } : {}),
        signal: merged.signal,
      }, true);
      return observationRegistry.publicObservation(stored, view);
    } catch {
      throw new Error("observe_failed");
    } finally {
      merged.dispose();
    }
  }

  function act(raw: unknown): Promise<ActResult> {
    const queuedEpoch = epoch;
    const next = actQueue.then(() => execute(raw, queuedEpoch), () => execute(raw, queuedEpoch));
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
    closePromise = Promise.resolve().then(() => backend.close()).then(() => undefined);
    return closePromise;
  }

  return Object.freeze({
    capabilities: effectiveCapabilities,
    allowModelImages,
    limits: sessionLimits,
    observe,
    act,
    resolveApproval,
    correct,
    cancel,
    close,
  });
}
