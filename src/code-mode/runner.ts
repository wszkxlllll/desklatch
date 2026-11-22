import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ACT_EXPECTATION_FAILURE_HINT,
  ACT_POINT_CLICK_EVIDENCE_HINT,
  sanitizeActValidationDiagnostic,
  type ActRecoveryHint,
  type ActResult,
  type ActValidationDiagnostic,
  type StepReceipt,
} from "../core/session-types.js";
import { observationWithoutPixels } from "../integrations/shared.js";
import { codeModeResultHint, type CodeModeHint } from "./result-hints.js";
import {
  MAX_INSPECTIONS, MAX_TOOL_INPUT_BYTES, MAX_TOOL_REPLY_BYTES, MAX_TRACE_BYTES,
  type CodeModeControlFlow, type CodeModeLimits, type CodeProgram, type CodeTool,
  type ReplyMessage, type StartMessage,
} from "./protocol.js";

export interface CodeActionReceipt {
  readonly call: number;
  readonly status: ActResult["status"] | "unknown";
  readonly code?: string;
  readonly atStep?: number;
  readonly validation?: ActValidationDiagnostic;
  readonly requestId?: string;
  readonly recoveryHint?: ActRecoveryHint;
  readonly steps: readonly StepReceipt[];
  readonly candidates?: readonly unknown[];
  readonly observationId?: string;
}

export interface CodeModeReconciliationIncident {
  /** Opaque host-generated ID for the currently unresolved act delivery. */
  readonly id: string;
  readonly code: "act_delivery_unconfirmed";
}

interface Terminal {
  readonly status: "completed" | "stopped" | "failed";
  readonly code?: string;
}

export interface CodeModeResult extends Terminal {
  readonly calls: Readonly<Record<CodeTool, number>>;
  readonly inspections: readonly unknown[];
  readonly actions: readonly CodeActionReceipt[];
  /** Current host-only reconciliation handle; never authorizes a retry. */
  readonly reconciliationIncident?: CodeModeReconciliationIncident;
  readonly hint?: CodeModeHint;
  /** Last verified app activation guide, emitted once at run completion. */
  readonly lastVerifiedActivation?: CodeModeActivation;
}

export interface CodeModeActivation {
  readonly applicationId: string;
  readonly actionParameters: string;
}

/** Host-only evidence passed to an explicitly configured evaluation sink. */
export interface CodeModeEvaluation {
  readonly source: CodeProgram;
  readonly result: CodeModeResult;
  readonly controlFlow: CodeModeControlFlow;
}

interface PendingTool {
  readonly call: number;
  readonly tool: CodeTool;
  readonly done: Promise<void>;
}

export interface RunningCode {
  readonly result: Promise<CodeModeResult>;
  /** Never included in the public `run_code` reply. */
  readonly evaluation: Promise<CodeModeEvaluation>;
  readonly childClosed: Promise<void>;
  /** Kept pending while a native tool call may still be in flight. */
  readonly drained: Promise<void>;
}

const MAX_RECEIPT_STEPS = 512;
const MAX_PUBLIC_ACTION_PARAMETERS = 4_096;
const RECEIPT_GRACE_MS = 250;
const DEFAULT_TOOL_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 180_000;
const recoverableGroundingCodes = new Set([
  "stale_observation", "stale_reference", "observation_not_found", "target_not_found", "target_ambiguous", "observation_incomplete",
  "focus_changed", "focus_unavailable",
]);
const guestCodes = new Set([
  "code_error", "code_syntax_error", "code_timeout", "code_budget_exceeded", "inspect_budget_exceeded",
  "tool_input_too_large", "concurrent_tool_call", "sandbox_failed", "code_stalled",
  "unawaited_tool_call", "invalid_inspection", "invalid_tool_input",
]);
const stepStates = new Set(["verified", "dispatched", "partial", "unknown", "not_dispatched"]);
const actionKinds = new Set(["click", "type", "setValue", "scroll", "keypress", "hotkey", "drag"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_:-]{0,79}$/i.test(value) ? value : undefined;
}

function verifiedActivation(input: unknown, value: unknown): CodeModeActivation | undefined {
  if (!record(input) || typeof input.activate !== "string" || !record(value)
    || value.status !== "completed" || (value.code !== "activated" && value.code !== "already_active")) return undefined;
  const applicationId = typeof value.applicationId === "string" && value.applicationId.length > 0
    ? value.applicationId.slice(0, 256) : undefined;
  const actionParameters = typeof value.actionParameters === "string" && value.actionParameters.trim().length > 0
    ? value.actionParameters.slice(0, MAX_PUBLIC_ACTION_PARAMETERS) : undefined;
  return applicationId && actionParameters ? { applicationId, actionParameters } : undefined;
}

function unknownAction(call: number): CodeActionReceipt {
  return { call, status: "unknown", code: "act_result_unconfirmed", steps: [] };
}

function actionReceipt(call: number, value: unknown): CodeActionReceipt {
  if (!record(value) || (value.status !== "completed" && value.status !== "stopped" && value.status !== "rejected")
    || !Array.isArray(value.steps) || value.steps.length > MAX_RECEIPT_STEPS) return unknownAction(call);
  const steps: StepReceipt[] = [];
  for (const step of value.steps) {
    if (!record(step) || typeof step.index !== "number" || !Number.isSafeInteger(step.index)
      || step.index < 1 || typeof step.status !== "string" || !stepStates.has(step.status)) return unknownAction(call);
    const code = safeCode(step.code);
    const kind = typeof step.kind === "string" && actionKinds.has(step.kind) ? step.kind as StepReceipt["kind"] : undefined;
    steps.push({ index: step.index, status: step.status as StepReceipt["status"], ...(kind && { kind }), ...(code && { code }) });
  }
  const code = safeCode(value.code);
  const candidates = Array.isArray(value.candidates) ? value.candidates.slice(0, 8) : undefined;
  const validation = sanitizeActValidationDiagnostic(value.validation);
  return {
    call,
    status: value.status,
    steps,
    ...(code && { code }),
    ...(typeof value.atStep === "number" && Number.isSafeInteger(value.atStep) && { atStep: value.atStep }),
    ...(validation ? { validation } : {}),
    ...(typeof value.requestId === "string" && /^[\w:-]{1,160}$/.test(value.requestId) && { requestId: value.requestId }),
    ...(value.recoveryHint === ACT_EXPECTATION_FAILURE_HINT ? { recoveryHint: ACT_EXPECTATION_FAILURE_HINT } : {}),
    ...(value.recoveryHint === ACT_POINT_CLICK_EVIDENCE_HINT ? { recoveryHint: ACT_POINT_CLICK_EVIDENCE_HINT } : {}),
    ...(candidates && { candidates }),
    ...(typeof value.observationId === "string" && /^[\w:-]{1,200}$/.test(value.observationId) && { observationId: value.observationId }),
  };
}

/** True only when an act receipt leaves delivery uncertain or omits a requested step. */
export function codeActionDeliveryUncertain(receipt: CodeActionReceipt, input?: unknown): boolean {
  if (receipt.status === "unknown" || receipt.code === "act_result_unconfirmed"
    || receipt.steps.some(step => step.status === "unknown" || step.status === "partial")) return true;
  return codeActionReceiptMissingStep(receipt, input);
}

function codeActionReceiptMissingStep(receipt: CodeActionReceipt, input?: unknown): boolean {
  // Core preflight refusals can legitimately omit a rejected step list. An
  // empty or wholly not-dispatched rejection is known unsent; contradictory
  // delivery evidence still needs the normal completeness check below.
  if (receipt.status === "rejected" && (receipt.steps.length === 0
    || receipt.steps.every(step => step.status === "not_dispatched"))) return false;
  const requestedSteps = record(input) && Array.isArray(input.steps) ? input.steps.length : 0;
  if (requestedSteps > 0) {
    const reported = new Set(receipt.steps.map(step => step.index));
    for (let index = 1; index <= requestedSteps; index += 1) if (!reported.has(index)) return true;
  }
  return false;
}

export function codeActionReceiptNeedsNormalization(receipt: CodeActionReceipt, input?: unknown): boolean {
  if (!codeActionDeliveryUncertain(receipt, input)) return false;
  if (receipt.status === "completed" || receipt.code === "act_result_unconfirmed"
    || codeActionReceiptMissingStep(receipt, input)) return true;
  return receipt.status === "rejected" && receipt.steps.some(step => step.status === "unknown" || step.status === "partial");
}

export function actionResultDeliveryUncertain(value: unknown, input?: unknown): boolean {
  return codeActionDeliveryUncertain(actionReceipt(0, value), input);
}

export function actionResultNeedsNormalization(value: unknown, input?: unknown): boolean {
  return codeActionReceiptNeedsNormalization(actionReceipt(0, value), input);
}

function notDispatchedAction(call: number, input: unknown, code = "act_not_dispatched"): CodeActionReceipt {
  const requested = record(input) && Array.isArray(input.steps) ? input.steps.slice(0, MAX_RECEIPT_STEPS) : [];
  return {
    call,
    status: "stopped",
    code,
    steps: requested.map((step, index) => ({
      index: index + 1,
      status: "not_dispatched" as const,
      code,
      ...(record(step) && typeof step.kind === "string" && actionKinds.has(step.kind) ? { kind: step.kind as StepReceipt["kind"] } : {}),
    })),
  };
}

const branchKinds = new Set(["if", "conditional", "loop_condition", "logical", "switch_case"]);
const loopKinds = new Set(["for", "for_of", "for_in", "while", "do"]);

function safeCounter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function controlFlow(value: unknown): CodeModeControlFlow | undefined {
  if (!record(value) || (value.status !== "instrumented" && value.status !== "fallback")
    || (value.transformer !== "typescript-ast" && value.transformer !== "none")
    || !Array.isArray(value.branches) || !Array.isArray(value.loops) || !Array.isArray(value.unsupported)
    || typeof value.fixedWrapper !== "boolean") return undefined;
  const branches: CodeModeControlFlow["branches"][number][] = [];
  for (const branch of value.branches.slice(0, 4096)) {
    if (!record(branch) || typeof branch.id !== "number" || !Number.isSafeInteger(branch.id) || branch.id < 1
      || typeof branch.kind !== "string" || !branchKinds.has(branch.kind)
      || typeof branch.line !== "number" || !Number.isSafeInteger(branch.line) || branch.line < 1
      || typeof branch.column !== "number" || !Number.isSafeInteger(branch.column) || branch.column < 1) continue;
    const operator = branch.operator === "&&" || branch.operator === "||" || branch.operator === "??"
      ? branch.operator : undefined;
    branches.push({ id: branch.id, kind: branch.kind as CodeModeControlFlow["branches"][number]["kind"],
      ...(operator ? { operator } : {}), line: branch.line, column: branch.column,
      evaluations: safeCounter(branch.evaluations), taken: safeCounter(branch.taken), notTaken: safeCounter(branch.notTaken) });
  }
  const loops: CodeModeControlFlow["loops"][number][] = [];
  for (const loop of value.loops.slice(0, 4096)) {
    if (!record(loop) || typeof loop.id !== "number" || !Number.isSafeInteger(loop.id) || loop.id < 1
      || typeof loop.kind !== "string" || !loopKinds.has(loop.kind)
      || typeof loop.line !== "number" || !Number.isSafeInteger(loop.line) || loop.line < 1
      || typeof loop.column !== "number" || !Number.isSafeInteger(loop.column) || loop.column < 1) continue;
    loops.push({ id: loop.id, kind: loop.kind as CodeModeControlFlow["loops"][number]["kind"],
      line: loop.line, column: loop.column, iterations: safeCounter(loop.iterations) });
  }
  const unsupported = value.unsupported.filter((entry): entry is string => typeof entry === "string").slice(0, 32);
  return {
    status: value.status,
    transformer: value.transformer,
    branches,
    loops,
    unsupported,
    fixedWrapper: value.fixedWrapper,
  };
}

function fallbackControlFlow(): CodeModeControlFlow {
  return {
    status: "fallback",
    transformer: "none",
    branches: [],
    loops: [],
    unsupported: ["trace_unavailable"],
    fixedWrapper: false,
  };
}

export function emptyCodeResult(status: Terminal["status"], code: string): CodeModeResult {
  return { status, code, calls: { observe: 0, act: 0 }, inspections: [], actions: [] };
}

/** Trusted controller. The guest is only a source of bounded requests to the supplied endpoints. */
export function startCodeRun(
  program: CodeProgram,
  limits: CodeModeLimits,
  invoke: (tool: CodeTool, input: unknown, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
  options: {
    readonly evaluation?: boolean;
    readonly onUncertainAction?: (receipt: CodeActionReceipt) => void;
  } = {},
): RunningCode {
  const env: NodeJS.ProcessEnv = {};
  if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  const guestPath = fileURLToPath(new URL("./guest.js", import.meta.url));
  const child = spawn(process.execPath, ["--max-old-space-size=64", guestPath], {
    env,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const childClosed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const work = new AbortController();
  const toolSignal = AbortSignal.any([work.signal, signal]);
  const calls: Record<CodeTool, number> = { observe: 0, act: 0 };
  const actions: CodeActionReceipt[] = [];
  const inspections: unknown[] = [];
  let lastVerifiedActivation: CodeModeActivation | undefined;
  let traceEvidence: CodeModeControlFlow | undefined;
  let inspectBytes = 0;
  let oversizedObserveReply = false;
  let received = 0;
  let pending: PendingTool | undefined;
  let terminal: Terminal | undefined;
  let recovery: "available" | "needs_observation" | "used" = "available";
  let toolWaitTimer: ReturnType<typeof setTimeout> | undefined;
  const toolWaitTimeoutMs = limits.toolWaitTimeoutMs ?? DEFAULT_TOOL_WAIT_TIMEOUT_MS;
  const overallTimeoutMs = limits.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  let settle!: (value: Terminal) => void;
  const completion = new Promise<Terminal>(resolve => { settle = resolve; });
  const overallDeadline = setTimeout(() => finish("stopped", "code_timeout", true), overallTimeoutMs);

  function finish(status: Terminal["status"], code?: string, abortTool = false): void {
    if (terminal) return;
    terminal = { status, ...(code && { code }) };
    clearTimeout(overallDeadline);
    if (toolWaitTimer) clearTimeout(toolWaitTimer);
    signal.removeEventListener("abort", cancel);
    if (abortTool) work.abort(code);
    child.kill();
    settle(terminal);
  }
  const cancel = () => finish("stopped", "cancelled", true);

  function armToolWait(tool: CodeTool, call: number): void {
    if (toolWaitTimer) clearTimeout(toolWaitTimer);
    toolWaitTimer = setTimeout(() => {
      if (terminal || !pending || pending.call !== call) return;
      finish("stopped", tool === "act" ? "act_result_unconfirmed" : "tool_timeout", true);
    }, toolWaitTimeoutMs);
  }

  function clearToolWait(): void {
    if (toolWaitTimer) clearTimeout(toolWaitTimer);
    toolWaitTimer = undefined;
  }

  function send(message: StartMessage | ReplyMessage): void {
    if (terminal) return;
    child.send(message, error => {
      if (error) finish("failed", "sandbox_failed", true);
    });
  }

  async function handleTool(tool: CodeTool, id: number, input: Record<string, unknown>): Promise<void> {
    armToolWait(tool, id);
    let invokeStarted = false;
    try {
      toolSignal.throwIfAborted();
      invokeStarted = true;
      const value = await invoke(tool, input, toolSignal);
      if (tool === "act") {
        if (record(input) && typeof input.activate === "string") {
          lastVerifiedActivation = verifiedActivation(input, value);
        }
        const parsedReceipt = actionReceipt(id, value);
        const deliveryUncertain = codeActionDeliveryUncertain(parsedReceipt, input);
        const receipt = codeActionReceiptNeedsNormalization(parsedReceipt, input)
          ? { ...parsedReceipt, status: "unknown" as const, code: parsedReceipt.code ?? "act_result_unconfirmed" }
          : parsedReceipt;
        actions.push(receipt);
        if (deliveryUncertain) {
          try { options.onUncertainAction?.(receipt); } catch { /* Safety notifications cannot change receipts. */ }
        }
        if (terminal) return;
        if (receipt.status !== "completed" || deliveryUncertain || receipt.steps.some(step => step.status === "not_dispatched")) {
          const steps = Array.isArray(input.steps) ? input.steps.length : 0;
          const recoverable = recovery === "available" && receipt.status === "stopped" && steps > 0
            && recoverableGroundingCodes.has(receipt.code ?? "") && receipt.steps.length === steps
            && receipt.steps.every((step, index) => step.index === index + 1 && step.status === "not_dispatched");
          if (!recoverable) {
            finish("stopped", receipt.code ?? (deliveryUncertain ? "act_result_unconfirmed" : "act_stopped"));
            return;
          }
          recovery = "needs_observation";
        }
      }
      if (tool === "observe" && record(value) && (value.status === "stopped" || value.status === "rejected")) {
        finish("stopped", safeCode(value.code) ?? "observe_failed");
        return;
      }
      if (terminal) return;
      if (recovery === "needs_observation" && tool === "observe" && record(value)
        && typeof value.observationId === "string" && Array.isArray(value.controls)) recovery = "used";
      const payload = JSON.stringify(tool === "observe" ? observationWithoutPixels(value).value : value);
      const observeReplyTooLarge = tool === "observe" && typeof payload === "string"
        && Buffer.byteLength(payload, "utf8") > MAX_TOOL_REPLY_BYTES;
      if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > MAX_TOOL_REPLY_BYTES) {
        if (observeReplyTooLarge) oversizedObserveReply = true;
        finish("stopped", "tool_result_too_large");
        return;
      }
      send({ type: "reply", id, json: payload });
    } catch (error) {
      if (tool === "act" && !actions.some(action => action.call === id)) {
        const beforeDispatch = record(error) && error.beforeDispatch === true;
        const knownNotDispatched = !invokeStarted || beforeDispatch;
        const code = knownNotDispatched ? safeCode(record(error) ? error.code : undefined) ?? "act_not_dispatched" : "act_result_unconfirmed";
        const receipt = knownNotDispatched ? notDispatchedAction(id, input, code) : unknownAction(id);
        actions.push(receipt);
        if (!knownNotDispatched) {
          try { options.onUncertainAction?.(receipt); } catch { /* Safety notifications cannot change receipts. */ }
        }
      }
      const beforeDispatch = record(error) && error.beforeDispatch === true;
      const knownNotDispatched = tool === "act" && (!invokeStarted || beforeDispatch);
      const errorCode = safeCode(record(error) ? error.code : undefined);
      finish("stopped", tool === "act" ? knownNotDispatched ? errorCode ?? "act_not_dispatched" : "act_result_unconfirmed" : "observe_failed");
    } finally {
      clearToolWait();
    }
  }

  child.on("message", (message: unknown) => {
    if (terminal) return;
    if (!record(message)) return finish("failed", "sandbox_protocol_error", true);
    if (message.type === "trace") {
      if (typeof message.json !== "string" || Buffer.byteLength(message.json, "utf8") > MAX_TRACE_BYTES) return;
      try { traceEvidence = controlFlow(JSON.parse(message.json)) ?? traceEvidence; }
      catch { /* Evidence is best-effort and must not affect runtime semantics. */ }
      return;
    }
    if (message.type === "done") {
      const status = message.status;
      if (status === "completed") return pending ? finish("stopped", "unawaited_tool_call", true) : finish("completed");
      if ((status === "stopped" || status === "failed") && typeof message.code === "string" && guestCodes.has(message.code)) {
        return finish(status, message.code, pending !== undefined);
      }
      return finish("failed", "sandbox_protocol_error", true);
    }
    if (message.type === "inspect") {
      if (typeof message.json !== "string") return finish("failed", "invalid_inspection", true);
      inspectBytes += Buffer.byteLength(message.json, "utf8");
      if (inspectBytes > limits.maxInspectBytes || inspections.length >= MAX_INSPECTIONS) {
        return finish("stopped", "inspect_budget_exceeded", true);
      }
      try { inspections.push(JSON.parse(message.json)); }
      catch { finish("failed", "invalid_inspection", true); }
      return;
    }
    if (message.type !== "tool" || (message.tool !== "observe" && message.tool !== "act")
      || message.id !== received + 1 || typeof message.json !== "string") {
      return finish("failed", "sandbox_protocol_error", true);
    }
    if (pending) return finish("stopped", "concurrent_tool_call", true);
    if (received >= limits.maxCalls) return finish("stopped", "code_budget_exceeded", true);
    if (Buffer.byteLength(message.json, "utf8") > MAX_TOOL_INPUT_BYTES) return finish("stopped", "tool_input_too_large", true);
    let input: unknown;
    try { input = JSON.parse(message.json); } catch { return finish("failed", "invalid_tool_input", true); }
    if (!record(input)) return finish("failed", "invalid_tool_input", true);
    if (message.tool === "observe" && (input.view === "image" || input.view === "both")) {
      return finish("stopped", "code_images_not_supported", true);
    }
    if (message.tool === "act" && recovery === "needs_observation") {
      return finish("stopped", "recovery_requires_observation", true);
    }
    const tool = message.tool;
    const id = ++received;
    calls[tool] += 1;
    const done = Promise.resolve().then(() => handleTool(tool, id, input)).finally(() => { pending = undefined; });
    pending = { call: id, tool, done };
  });
  child.once("error", () => finish("failed", "sandbox_failed", true));
  child.once("exit", () => finish("failed", "sandbox_failed", true));
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  else send({ type: "start", ...program, ...limits, ...(options.evaluation ? { evaluation: true } : {}) });

  const drained = completion.then(async () => { await Promise.all([childClosed, pending?.done]); });
  const result = completion.then(async value => {
    const outstanding = pending;
    if (outstanding) {
      let grace: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([outstanding.done, new Promise<void>(resolve => { grace = setTimeout(resolve, RECEIPT_GRACE_MS); })]);
      } finally { clearTimeout(grace); }
    }
    const receipts = [...actions];
    if (outstanding?.tool === "act" && !receipts.some(action => action.call === outstanding.call)) {
      const receipt = unknownAction(outstanding.call);
      receipts.push(receipt);
      try { options.onUncertainAction?.(receipt); } catch { /* Safety notifications cannot change receipts. */ }
    }
    await childClosed;
    const publicResult: CodeModeResult = {
      ...value,
      calls: { ...calls },
      inspections: [...inspections],
      actions: receipts,
      ...(lastVerifiedActivation ? { lastVerifiedActivation } : {}),
    };
    const hint = codeModeResultHint(publicResult, oversizedObserveReply);
    return hint ? { ...publicResult, hint } : publicResult;
  });
  const evaluation = result.then(value => ({
    source: { code: program.code, language: program.language },
    result: value,
    controlFlow: traceEvidence ?? fallbackControlFlow(),
  }));
  return { result, evaluation, childClosed, drained };
}
