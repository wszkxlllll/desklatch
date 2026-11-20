import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ActResult, StepReceipt } from "../core/session-types.js";
import { observationWithoutPixels } from "../integrations/shared.js";
import {
  MAX_INSPECTIONS, MAX_TOOL_INPUT_BYTES, MAX_TOOL_REPLY_BYTES,
  type CodeModeLimits, type CodeProgram, type CodeTool, type ReplyMessage, type StartMessage,
} from "./protocol.js";

export interface CodeActionReceipt {
  readonly call: number;
  readonly status: ActResult["status"] | "unknown";
  readonly code?: string;
  readonly atStep?: number;
  readonly requestId?: string;
  readonly steps: readonly StepReceipt[];
}

interface Terminal {
  readonly status: "completed" | "stopped" | "failed";
  readonly code?: string;
}

export interface CodeModeResult extends Terminal {
  readonly calls: Readonly<Record<CodeTool, number>>;
  readonly inspections: readonly unknown[];
  readonly actions: readonly CodeActionReceipt[];
}

interface PendingTool {
  readonly call: number;
  readonly tool: CodeTool;
  readonly done: Promise<void>;
}

export interface RunningCode {
  readonly result: Promise<CodeModeResult>;
  readonly childClosed: Promise<void>;
  /** Kept pending while a native tool call may still be in flight. */
  readonly drained: Promise<void>;
}

const MAX_RECEIPT_STEPS = 512;
const RECEIPT_GRACE_MS = 250;
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
  return {
    call,
    status: value.status,
    steps,
    ...(code && { code }),
    ...(typeof value.atStep === "number" && Number.isSafeInteger(value.atStep) && { atStep: value.atStep }),
    ...(typeof value.requestId === "string" && /^[\w:-]{1,160}$/.test(value.requestId) && { requestId: value.requestId }),
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
  let inspectBytes = 0;
  let received = 0;
  let pending: PendingTool | undefined;
  let terminal: Terminal | undefined;
  let settle!: (value: Terminal) => void;
  const completion = new Promise<Terminal>(resolve => { settle = resolve; });
  const deadline = setTimeout(() => finish("stopped", "code_timeout", true), limits.timeoutMs);

  function finish(status: Terminal["status"], code?: string, abortTool = false): void {
    if (terminal) return;
    terminal = { status, ...(code && { code }) };
    clearTimeout(deadline);
    signal.removeEventListener("abort", cancel);
    if (abortTool) work.abort(code);
    child.kill();
    settle(terminal);
  }
  const cancel = () => finish("stopped", "cancelled", true);

  function send(message: StartMessage | ReplyMessage): void {
    if (terminal) return;
    child.send(message, error => {
      if (error) finish("failed", "sandbox_failed", true);
    });
  }

  async function handleTool(tool: CodeTool, id: number, input: Record<string, unknown>): Promise<void> {
    try {
      toolSignal.throwIfAborted();
      const value = await invoke(tool, input, toolSignal);
      if (tool === "act") {
        const receipt = actionReceipt(id, value);
        actions.push(receipt);
        if (receipt.status !== "completed" || receipt.steps.some(step => step.status === "unknown"
          || step.status === "partial" || step.status === "not_dispatched")) {
          finish("stopped", receipt.code ?? "act_stopped");
          return;
        }
      }
      if (tool === "observe" && record(value) && (value.status === "stopped" || value.status === "rejected")) {
        finish("stopped", safeCode(value.code) ?? "observe_failed");
        return;
      }
      if (terminal) return;
      const payload = JSON.stringify(tool === "observe" ? observationWithoutPixels(value).value : value);
      if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > MAX_TOOL_REPLY_BYTES) {
        finish("stopped", "tool_result_too_large");
        return;
      }
      send({ type: "reply", id, json: payload });
    } catch {
      if (tool === "act" && !actions.some(action => action.call === id)) actions.push(unknownAction(id));
      finish("stopped", tool === "act" ? "act_result_unconfirmed" : "observe_failed");
    }
  }

  child.on("message", (message: unknown) => {
    if (terminal) return;
    if (!record(message)) return finish("failed", "sandbox_protocol_error", true);
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
  else send({ type: "start", ...program, ...limits });

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
      receipts.push(unknownAction(outstanding.call));
    }
    await childClosed;
    return { ...value, calls: { ...calls }, inspections: [...inspections], actions: receipts };
  });
  return { result, childClosed, drained };
}
