import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { resolveDeskToolHost, type DeskToolHost, type DeskToolSource } from "../integrations/shared.js";
import { describeActParameters, describeObserveParameters } from "../request.js";
import { CODE_MODE_MAX_CALLS_DEFAULT, CODE_MODE_MAX_CALLS_MAX, CODE_MODE_MAX_CALLS_MIN } from "./operator-options.js";
import type { ToolEndpoint } from "../tools.js";
import type { CodeModeLimits, CodeProgram } from "./protocol.js";
import {
  actionResultDeliveryUncertain, actionResultNeedsNormalization, emptyCodeResult, startCodeRun,
  type CodeModeEvaluation, type CodeModeReconciliationIncident, type CodeModeResult, type RunningCode,
} from "./runner.js";

export type { CodeModeBranchCounter, CodeModeControlFlow, CodeModeLimits, CodeModeLoopCounter } from "./protocol.js";
export type { CodeActionReceipt, CodeModeEvaluation, CodeModeReconciliationIncident, CodeModeResult } from "./runner.js";
export type { CodeModeHint } from "./result-hints.js";
export { parseCodeModeMaxCallsEnvironment } from "./operator-options.js";
export interface CodeModeOptions extends Partial<CodeModeLimits> {
  /** Host-only evidence sink; never advertised in the public tool schema. */
  readonly onEvaluation?: (evaluation: CodeModeEvaluation) => void | Promise<void>;
}
/** Host-owned approval integration. The supplied callback executes the original act endpoint. */
export type CodeActScope = (invoke: () => Promise<unknown>, signal: AbortSignal) => Promise<unknown>;

export interface DeskCodeModeHost extends DeskToolHost {
  runCode(input: unknown, signal?: AbortSignal, actScope?: CodeActScope): Promise<CodeModeResult>;
  /** Host-only current incident query; no model tool exposes this control. */
  getReconciliationIncident(): CodeModeReconciliationIncident | undefined;
  /** Host-only explicit reconciliation. A mismatched or in-flight incident cannot be cleared. */
  reconcileActDelivery(incidentId: string): boolean;
}

const MAX_CODE_BYTES = 32 * 1024;
const codeModeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: { type: "string", maxLength: MAX_CODE_BYTES },
    language: { type: "string", enum: ["javascript", "typescript"], default: "javascript" },
  },
};
const knownActionKinds = new Set(["click", "type", "setValue", "scroll", "keypress", "hotkey", "drag"]);

function runCodeDescription(maxCalls: number, maxInspectBytes: number): string {
  return `Run one isolated async JavaScript or erasable TypeScript program when next steps depend on runtime data, filtering, conditions, loops, or compacting intermediate results. If direct observe/act tools are exposed and only a few actions are already known, use those tools; one act call can batch the fixed steps. Use only desk.observe, desk.act, and inspect, following the exact host parameter guides below. The host call budget is maxCalls=${maxCalls} total calls to desk.observe and desk.act combined for this program, not that many of each; budget both reads and actions. The inspect output budget is maxInspectBytes=${maxInspectBytes} UTF-8 bytes total per program. Inspect small, meaningful progress before either budget runs out; keep only facts needed for the decision, such as a match count, selected names, sourceUrl, or nextCursor. For one known control, prefer an exact selector. A data-dependent loop over related items may need one scoped collection by the relevant role or container. If compact output clips needed rows and the host advertises projection, use projection:{mode:"full"} and filter inside the program. Do not inspect a whole observation or serialize a whole result. Report only conclusions and coverage supported by the returned data; do not imply global completeness without complete evidence. If more results remain, continue from the returned source, query, or cursor; do not repeat the same read unless you have new data or a changed query. Values returned by the program are ignored. desk.observe returns a frame (controls or document); desk.act returns a receipt (status, steps). A completed run_code status means the program ended, not that the task is complete. A dispatched action confirms delivery only, and verified confirms only its declared expect. Observations inside code contain text and controls, not screenshots. If screenshot-authorized observe is separately exposed and layout matters, you may inspect one frame outside the program first, then use its labels as a guide and confirm targets with fresh desk.observe results; code itself cannot read pixels. A preflight schema, capability, or focus rejection means no step was dispatched; use atStep when present to correct only that step and keep sibling steps as separate flat objects. Honor every receipt: after unknown or partial delivery, stop and do not replay; after a denied approval or revocation, stop. Recover from a targeting failure only when the receipt confirms no dispatch, using one fresh scoped observation. Navigation or activation loops are allowed only when the host act guide advertises them. Use inspect for the smallest facts the model needs; never use console.log, timer APIs, or a full observation as output.`;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("invalid_code_mode_budget");
  return value;
}

function readProgram(input: unknown): CodeProgram | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "code" && key !== "language")) return;
  const { code, language = "javascript" } = input as Record<string, unknown>;
  if (typeof code !== "string" || !code.trim() || Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES
    || (language !== "javascript" && language !== "typescript")) return;
  return { code, language };
}

function incidentCopy(value: CodeModeReconciliationIncident | undefined): CodeModeReconciliationIncident | undefined {
  return value ? { id: value.id, code: value.code } : undefined;
}

function requestedStepReceipts(input: unknown, status: "not_dispatched" | "unknown", code: string) {
  const steps = input && typeof input === "object" && !Array.isArray(input)
    && Array.isArray((input as Record<string, unknown>).steps)
    ? ((input as Record<string, unknown>).steps as unknown[]).slice(0, 512) : [];
  return steps.map((step, index) => ({
    index: index + 1,
    ...(step && typeof step === "object" && !Array.isArray(step) && typeof (step as Record<string, unknown>).kind === "string"
      && knownActionKinds.has((step as Record<string, unknown>).kind as string)
      ? { kind: (step as Record<string, unknown>).kind as string } : {}),
    status,
    code,
  }));
}

function blockedActResult(input: unknown, code: string, incident?: CodeModeReconciliationIncident) {
  return {
    status: "stopped",
    code,
    steps: requestedStepReceipts(input, "not_dispatched", code),
    ...(incident ? { reconciliationIncident: incidentCopy(incident) } : {}),
  };
}

function uncertainActResult(input: unknown, incident: CodeModeReconciliationIncident) {
  return {
    status: "stopped",
    code: "act_result_unconfirmed",
    steps: requestedStepReceipts(input, "unknown", "act_result_unconfirmed"),
    reconciliationIncident: incidentCopy(incident),
  };
}

function isKnownPreDispatchError(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { beforeDispatch?: unknown }).beforeDispatch === true;
}

function actionInputShape(input: unknown): { readonly steps: readonly unknown[] } {
  const steps = input && typeof input === "object" && !Array.isArray(input)
    && Array.isArray((input as Record<string, unknown>).steps)
    ? (input as Record<string, unknown>).steps as unknown[] : [];
  return { steps: Array.from({ length: Math.min(steps.length, 512) }, () => undefined) };
}

interface PendingApprovalAction {
  readonly input: { readonly steps: readonly unknown[] };
  readonly scopeToken?: string;
}

/** Opt into a third tool for a single host. No model, agent loop, or backend-specific actions are introduced. */
export function createDeskCodeMode(source: DeskToolSource, options: CodeModeOptions = {}): DeskCodeModeHost {
  const host = resolveDeskToolHost(source);
  if (host.tools.some(tool => tool.name === "run_code")) throw new Error("code_mode_already_enabled");
  const limits: CodeModeLimits = {
    timeoutMs: bounded(options.timeoutMs, 30_000, 100, 60_000),
    memoryBytes: bounded(options.memoryBytes, 8 * 1024 * 1024, 1 * 1024 * 1024, 32 * 1024 * 1024),
    maxCalls: bounded(options.maxCalls, CODE_MODE_MAX_CALLS_DEFAULT, CODE_MODE_MAX_CALLS_MIN, CODE_MODE_MAX_CALLS_MAX),
    maxInspectBytes: bounded(options.maxInspectBytes, 8 * 1024, 32, 16 * 1024),
    toolWaitTimeoutMs: bounded(options.toolWaitTimeoutMs, 120_000, 100, 300_000),
    overallTimeoutMs: bounded(options.overallTimeoutMs, 180_000, 1_000, 600_000),
  };
  const endpoints = new Map(host.tools.map(endpoint => [endpoint.name, endpoint]));
  let active: { controller: AbortController; run: RunningCode; evaluationDone: Promise<void> } | undefined;
  let directCalls = 0;
  let directActInFlight = false;
  let inFlightActCalls = 0;
  let currentIncident: CodeModeReconciliationIncident | undefined;
  const pendingApprovalActions = new Map<string, PendingApprovalAction>();
  const terminalApprovalResults = new Map<string, unknown>();
  const actScopeContext = new AsyncLocalStorage<string>();
  const liveActScopeTokens = new Set<string>();
  const liveActionTokens = new Set<string>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function latchIncident(): CodeModeReconciliationIncident {
    currentIncident ??= { id: randomUUID(), code: "act_delivery_unconfirmed" };
    return currentIncident;
  }

  function appendCurrentIncident<T extends object>(value: T): T & { readonly reconciliationIncident?: CodeModeReconciliationIncident } {
    const incident = incidentCopy(currentIncident);
    return incident ? { ...value, reconciliationIncident: incident } : value;
  }

  function appendApprovalIncident(value: unknown): unknown {
    const incident = incidentCopy(currentIncident);
    if (!incident) return value;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return { ...(value as Record<string, unknown>), reconciliationIncident: incident };
    }
    return { status: "stopped", code: "act_delivery_unconfirmed", steps: [], reconciliationIncident: incident };
  }

  async function invokeActEndpoint(endpoint: ToolEndpoint, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (currentIncident) return blockedActResult(input, "act_reconciliation_required", currentIncident);
    let endpointStarted = false;
    inFlightActCalls += 1;
    const scopeToken = actScopeContext.getStore() ?? randomUUID();
    liveActionTokens.add(scopeToken);
    try {
      signal?.throwIfAborted();
      endpointStarted = true;
      const value = await actScopeContext.run(scopeToken, () => endpoint.invoke(input, signal));
      if (actionResultDeliveryUncertain(value, input)) {
        const incident = latchIncident();
        if (actionResultNeedsNormalization(value, input)) return uncertainActResult(input, incident);
        return value !== null && typeof value === "object" && !Array.isArray(value)
          ? { ...(value as Record<string, unknown>), reconciliationIncident: incidentCopy(incident) }
          : uncertainActResult(input, incident);
      }
      if (value && typeof value === "object" && !Array.isArray(value)
        && (value as Record<string, unknown>).code === "approval_required"
        && typeof (value as Record<string, unknown>).requestId === "string") {
        const requestId = (value as Record<string, unknown>).requestId as string;
        pendingApprovalActions.set(requestId, { input: actionInputShape(input), ...(scopeToken ? { scopeToken } : {}) });
        while (pendingApprovalActions.size > 64) pendingApprovalActions.delete(pendingApprovalActions.keys().next().value!);
      }
      return value;
    } catch (error) {
      if (!endpointStarted) throw markBeforeDispatch(error);
      if (isKnownPreDispatchError(error)) throw error;
      const incident = latchIncident();
      return uncertainActResult(input, incident);
    } finally {
      inFlightActCalls -= 1;
      liveActionTokens.delete(scopeToken);
    }
  }

  async function invokeDirectEndpoint(endpoint: ToolEndpoint, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (closed) throw new Error("closed");
    if (active) throw new Error("code_mode_busy");
    if (endpoint.name === "act") {
      if (directActInFlight) return blockedActResult(input, "code_mode_busy");
      signal?.throwIfAborted();
      directActInFlight = true;
      directCalls += 1;
      try { return await invokeActEndpoint(endpoint, input, signal); }
      finally { directCalls -= 1; directActInFlight = false; }
    }
    directCalls += 1;
    try { return await endpoint.invoke(input, signal); }
    finally { directCalls -= 1; }
  }

  function wrappedEndpoint(endpoint: ToolEndpoint): ToolEndpoint {
    return {
      name: endpoint.name,
      get description() { return endpoint.description; },
      get inputSchema() { return endpoint.inputSchema; },
      invoke: (input, signal) => invokeDirectEndpoint(endpoint, input, signal),
    };
  }

  function markBeforeDispatch(error: unknown): Error {
    if (error && typeof error === "object") {
      try { Object.defineProperty(error, "beforeDispatch", { value: true, configurable: true }); return error as Error; }
      catch { /* Preserve safety if a host error is frozen. */ }
    }
    const safe = new Error("act_not_dispatched");
    Object.assign(safe, { code: "act_not_dispatched", beforeDispatch: true });
    return safe;
  }

  function rememberTerminalApproval(requestId: string, value: unknown): void {
    const stored = value !== null && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) } : value;
    if (stored && typeof stored === "object" && !Array.isArray(stored)) delete (stored as Record<string, unknown>).reconciliationIncident;
    terminalApprovalResults.set(requestId, stored);
    while (terminalApprovalResults.size > 64) terminalApprovalResults.delete(terminalApprovalResults.keys().next().value!);
  }

  function refusedApproval(requestId: string, code: string): Record<string, unknown> {
    return {
      requestId,
      status: "stopped",
      code,
      steps: [],
      ...(currentIncident ? { reconciliationIncident: incidentCopy(currentIncident) } : {}),
    };
  }

  async function resolveHostApproval(requestId: string, decision: "approve" | "deny"): Promise<unknown> {
    const resolver = host.resolveApproval;
    if (!resolver) throw new Error("approval_unavailable");
    if (terminalApprovalResults.has(requestId)) return appendApprovalIncident(terminalApprovalResults.get(requestId));
    const pending = pendingApprovalActions.get(requestId);
    const pendingInput = pending?.input;
    const scopeToken = actScopeContext.getStore();
    const boundToScope = Boolean(scopeToken && liveActScopeTokens.has(scopeToken) && pending?.scopeToken === scopeToken);
    const boundInFlight = Boolean(scopeToken && liveActionTokens.has(scopeToken) && inFlightActCalls > 0);
    if (decision === "approve") {
      if (closed || currentIncident) return refusedApproval(requestId, currentIncident ? "act_reconciliation_required" : "closed");
      const busy = Boolean(active || directActInFlight || inFlightActCalls > 0);
      if (busy && !boundToScope && !boundInFlight) return refusedApproval(requestId, "approval_busy");
    }

    const separatelyResumed = decision === "approve" && inFlightActCalls === 0;
    const ownsDirectLock = separatelyResumed && !active;
    if (separatelyResumed) {
      inFlightActCalls += 1;
      if (ownsDirectLock) {
        directActInFlight = true;
        directCalls += 1;
      }
    }
    try {
      const value = await resolver(requestId, decision);
      if (decision !== "approve") {
        pendingApprovalActions.delete(requestId);
        rememberTerminalApproval(requestId, value);
        return appendApprovalIncident(value);
      }
      if (actionResultDeliveryUncertain(value, pendingInput)) {
        pendingApprovalActions.delete(requestId);
        const incident = latchIncident();
        const result = value !== null && typeof value === "object" && !Array.isArray(value)
          ? { ...(value as Record<string, unknown>), reconciliationIncident: incidentCopy(incident) }
          : uncertainActResult(pendingInput, incident);
        rememberTerminalApproval(requestId, result);
        return result;
      }
      if (value && typeof value === "object" && !Array.isArray(value)
        && (value as Record<string, unknown>).code === "approval_required"
        && typeof (value as Record<string, unknown>).requestId === "string") {
        const nextId = (value as Record<string, unknown>).requestId as string;
        if (nextId !== requestId) {
          pendingApprovalActions.delete(requestId);
          if (pending) pendingApprovalActions.set(nextId, pending);
          rememberTerminalApproval(requestId, value);
        } else if (pending) pendingApprovalActions.set(requestId, pending);
        return appendApprovalIncident(value);
      }
      pendingApprovalActions.delete(requestId);
      rememberTerminalApproval(requestId, value);
      return appendApprovalIncident(value);
    } catch (error) {
      if (decision !== "approve" || isKnownPreDispatchError(error)) throw error;
      pendingApprovalActions.delete(requestId);
      const incident = latchIncident();
      rememberTerminalApproval(requestId, uncertainActResult(pendingInput, incident));
      return uncertainActResult(pendingInput, incident);
    } finally {
      if (separatelyResumed) {
        inFlightActCalls -= 1;
        if (ownsDirectLock) {
          directCalls -= 1;
          directActInFlight = false;
        }
      }
    }
  }

  const runCode: DeskCodeModeHost["runCode"] = async (input, signal, actScope) => {
    if (closed) return emptyCodeResult("stopped", "closed");
    if (signal?.aborted) return emptyCodeResult("stopped", "cancelled");
    const program = readProgram(input);
    if (!program) return emptyCodeResult("failed", "invalid_code_program");
    if (active || directCalls > 0) return emptyCodeResult("stopped", "code_mode_busy");
    const controller = new AbortController();
    const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let run: RunningCode;
    try {
      run = startCodeRun(program, limits, (tool, args, toolSignal) => {
        const endpoint = endpoints.get(tool);
        if (!endpoint) {
          if (tool === "observe") return Promise.reject(new Error("observe_unavailable"));
          return Promise.resolve({ status: "rejected", code: "act_not_available", steps: [] });
        }
        const invoke = () => tool === "act" ? invokeActEndpoint(endpoint, args, toolSignal) : endpoint.invoke(args, toolSignal);
        if (tool === "act" && actScope) {
          let invoked = false;
          const scopedInvoke = () => { invoked = true; return invoke(); };
          const scopeToken = randomUUID();
          liveActScopeTokens.add(scopeToken);
          let scoped: Promise<unknown>;
          try { scoped = Promise.resolve(actScopeContext.run(scopeToken, () => actScope(scopedInvoke, toolSignal))); }
          catch (error) {
            liveActScopeTokens.delete(scopeToken);
            return Promise.reject(invoked ? error : markBeforeDispatch(error));
          }
          return scoped.catch(error => { throw invoked ? error : markBeforeDispatch(error); })
            .finally(() => { liveActScopeTokens.delete(scopeToken); });
        }
        return invoke();
      }, runSignal, {
        evaluation: options.onEvaluation !== undefined,
        onUncertainAction: () => { latchIncident(); },
      });
    } catch {
      return emptyCodeResult("failed", "sandbox_failed");
    }
    let evaluationDone = Promise.resolve();
    if (options.onEvaluation) {
      evaluationDone = run.evaluation.then(async evaluation => {
        try { await options.onEvaluation?.(evaluation); }
        catch { /* Evaluation sinks must never change execution semantics. */ }
      }, () => undefined);
    }
    const state = { controller, run, evaluationDone };
    active = state;
    const clear = () => { if (active === state) active = undefined; };
    // Preserve the default product path's existing drain timing.  Evaluation
    // hosts additionally wait for their sink before another run can arm.
    if (options.onEvaluation) void run.drained.then(() => evaluationDone).then(clear);
    else void run.drained.then(clear);
    return run.result.then(result => appendCurrentIncident(result));
  };

  const tools: ToolEndpoint[] = host.tools.map(endpoint => wrappedEndpoint(endpoint));
  tools.push({
    name: "run_code",
    get description() {
      const guideTools = host.activeTools ?? host.tools;
      const observe = guideTools.find(tool => tool.name === "observe");
      const act = guideTools.find(tool => tool.name === "act");
      const observations = describeObserveParameters(observe?.inputSchema);
      const parameters = describeActParameters(act?.inputSchema, { codeStyle: true });
      const outerObserve = endpoints.get("observe");
      const outerAct = endpoints.get("act");
      const hostGuidance = host.activeTools?.length === 0
        ? ` Host guidance: ${[outerObserve?.description, outerAct?.description].filter(Boolean).join(" ")}`
        : "";
      return `${runCodeDescription(limits.maxCalls, limits.maxInspectBytes)}${observations ? ` Exact observe parameter guide: ${observations}.` : " No active observe endpoint is advertised; inventory and activate first."}${parameters ? ` Exact act parameter guide: ${parameters}.` : " No active act endpoint is advertised; inventory and activate first."}${hostGuidance}`;
    },
    inputSchema: codeModeSchema,
    invoke: (input, signal) => runCode(input, signal),
  });
  return {
    tools: Object.freeze(tools),
    get activeTools() { return host.activeTools?.map(endpoint => wrappedEndpoint(endpoint)); },
    runCode,
    getReconciliationIncident() { return incidentCopy(currentIncident); },
    reconcileActDelivery(incidentId) {
      if (typeof incidentId !== "string" || !currentIncident || currentIncident.id !== incidentId
        || inFlightActCalls > 0 || directActInFlight || active) return false;
      currentIncident = undefined;
      return true;
    },
    ...(host.resolveApproval && { resolveApproval: resolveHostApproval }),
    cancel(reason) {
      active?.controller.abort(reason);
      host.cancel?.(reason);
    },
    close() {
      if (closing) return closing;
      closed = true;
      const running = active;
      running?.controller.abort("closed");
      return closing = Promise.resolve().then(async () => {
        try { await host.close(); } finally {
          if (running) await Promise.all([running.run.childClosed, running.evaluationDone]);
        }
      });
    },
  };
}
