import { resolveDeskToolHost, type DeskToolHost, type DeskToolSource } from "../integrations/shared.js";
import type { ToolEndpoint } from "../tools.js";
import type { CodeModeLimits, CodeProgram } from "./protocol.js";
import { emptyCodeResult, startCodeRun, type CodeModeResult, type RunningCode } from "./runner.js";

export type { CodeModeLimits } from "./protocol.js";
export type { CodeActionReceipt, CodeModeResult } from "./runner.js";
export type CodeModeOptions = Partial<CodeModeLimits>;
/** Host-owned approval integration. The supplied callback executes the original act endpoint. */
export type CodeActScope = (invoke: () => Promise<unknown>, signal: AbortSignal) => Promise<unknown>;

export interface DeskCodeModeHost extends DeskToolHost {
  runCode(input: unknown, signal?: AbortSignal, actScope?: CodeActScope): Promise<CodeModeResult>;
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

/** Opt into a third tool for a single host. No model, agent loop, or backend-specific actions are introduced. */
export function createDeskCodeMode(source: DeskToolSource, options: CodeModeOptions = {}): DeskCodeModeHost {
  const host = resolveDeskToolHost(source);
  if (host.tools.some(tool => tool.name === "run_code")) throw new Error("code_mode_already_enabled");
  const limits: CodeModeLimits = {
    timeoutMs: bounded(options.timeoutMs, 30_000, 100, 60_000),
    memoryBytes: bounded(options.memoryBytes, 8 * 1024 * 1024, 1 * 1024 * 1024, 32 * 1024 * 1024),
    maxCalls: bounded(options.maxCalls, 16, 1, 48),
    maxInspectBytes: bounded(options.maxInspectBytes, 8 * 1024, 32, 16 * 1024),
    toolWaitTimeoutMs: bounded(options.toolWaitTimeoutMs, 120_000, 100, 300_000),
    overallTimeoutMs: bounded(options.overallTimeoutMs, 180_000, 1_000, 600_000),
  };
  const endpoints = new Map(host.tools.map(endpoint => [endpoint.name, endpoint]));
  let active: { controller: AbortController; run: RunningCode } | undefined;
  let directCalls = 0;
  let closed = false;
  let closing: Promise<void> | undefined;

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
        const invoke = () => endpoint.invoke(args, toolSignal);
        return tool === "act" && actScope ? actScope(invoke, toolSignal) : invoke();
      }, runSignal);
    } catch {
      return emptyCodeResult("failed", "sandbox_failed");
    }
    const state = { controller, run };
    active = state;
    void run.drained.then(() => { if (active === state) active = undefined; });
    return run.result;
  };

  const tools: ToolEndpoint[] = host.tools.map(endpoint => ({
    name: endpoint.name,
    get description() { return endpoint.description; },
    get inputSchema() { return endpoint.inputSchema; },
    async invoke(input, signal) {
      if (closed) throw new Error("closed");
      if (active) throw new Error("code_mode_busy");
      directCalls += 1;
      try { return await endpoint.invoke(input, signal); }
      finally { directCalls -= 1; }
    },
  }));
  tools.push({
    name: "run_code",
    description: "Run one isolated async JavaScript or erasable TypeScript function body. Use await desk.observe(args) and await desk.act(args) sequentially, and inspect(value) for selected JSON output. Observations are text and controls only. A grounding failure with every step confirmed not dispatched allows one fresh observe before continuing. A refused, revoked, partial, or uncertain action terminates the program.",
    inputSchema: codeModeSchema,
    invoke: (input, signal) => runCode(input, signal),
  });
  return {
    tools: Object.freeze(tools),
    runCode,
    ...(host.resolveApproval && { resolveApproval: host.resolveApproval }),
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
        try { await host.close(); } finally { await running?.run.childClosed; }
      });
    },
  };
}
