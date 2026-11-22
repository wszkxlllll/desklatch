import * as nodeModule from "node:module";
import type { QuickJSSyncVariant } from "@jitl/quickjs-ffi-types";
import release from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant, newVariant,
  type QuickJSDeferredPromise, type QuickJSHandle,
} from "quickjs-emscripten-core";
import {
  MAX_INSPECTIONS, MAX_TOOL_INPUT_BYTES, MAX_TOOL_REPLY_BYTES, MAX_TRACE_BYTES,
  type CodeProgram, type CodeTool, type ReplyMessage, type StartMessage,
} from "./protocol.js";
import type { CodeModeInstrumentation } from "./instrument.js";

const WASM_PAGE_BYTES = 65_536;
// The pinned QuickJS release requires 16 MiB of engine memory at instantiation.
const WASM_INITIAL_PAGES = 256;
// The variant shares its CJS declarations with its ESM default export.
const syncVariant = release as unknown as QuickJSSyncVariant;

const bootstrap = `((observe, act, emit) => {
  const encode = JSON.stringify;
  const decode = JSON.parse;
  const AsyncFunction = (async () => {}).constructor;
  function createTrace(metadataJson) {
    const metadata = decode(metadataJson);
    const branches = metadata.branches.map((entry) => ({ ...entry }));
    const loops = metadata.loops.map((entry) => ({ ...entry }));
    const branch = (id, value) => {
      const entry = branches.find((candidate) => candidate.id === id);
      if (entry) {
        entry.evaluations += 1;
        if (Boolean(value)) entry.taken += 1;
        else entry.notTaken += 1;
      }
      return value;
    };
    const logical = (id, value, operator) => {
      const entry = branches.find((candidate) => candidate.id === id);
      if (entry) {
        entry.evaluations += 1;
        const taken = operator === "??" ? value !== null && value !== undefined : Boolean(value);
        if (taken) entry.taken += 1;
        else entry.notTaken += 1;
      }
      return value;
    };
    const loop = (id) => {
      const entry = loops.find((candidate) => candidate.id === id);
      if (entry) entry.iterations += 1;
    };
    const switchCase = (id) => {
      const entry = branches.find((candidate) => candidate.id === id);
      if (entry) {
        entry.evaluations += 1;
        entry.taken += 1;
      }
    };
    const snapshot = () => ({
      status: metadata.status,
      transformer: metadata.transformer,
      branches: branches.map((entry) => ({ ...entry })),
      loops: loops.map((entry) => ({ ...entry })),
      unsupported: [...metadata.unsupported],
      fixedWrapper: metadata.fixedWrapper,
    });
    return Object.freeze({ branch, logical, loop, switchCase, snapshot });
  }
  return {
    desk: Object.freeze({
      async observe(input = {}) { return decode(await observe(encode(input))); },
      async act(input) { return decode(await act(encode(input))); },
    }),
    inspect(value) { emit(encode(value) ?? "null"); },
    createTrace,
    compile(source, traceName) {
      if (!traceName) return new AsyncFunction("desk", "inspect", '"use strict";\\n' + source);
      // Keep the established AsyncFunction isolation.  The randomized third
      // parameter is a pure counter object; it has no bootstrap closure and
      // no access to observe/act/inspect bridges beyond the supplied SDK.
      return new AsyncFunction("desk", "inspect", traceName, '"use strict";\\n' + source);
    },
  };
})`;

const { stripTypeScriptTypes } = nodeModule as typeof nodeModule & {
  stripTypeScriptTypes(code: string, options: { mode: "strip" }): string;
};

function javascript(program: CodeProgram): string {
  if (program.language === "javascript") return program.code;
  // Strip types as a function body so TypeScript supports await and early return.
  const prefix = "async function program(desk, inspect) {\n";
  const suffix = "\n}";
  const stripped = stripTypeScriptTypes(`${prefix}${program.code}${suffix}`, { mode: "strip" });
  return stripped.slice(prefix.length, -suffix.length);
}

function send(message: object): void {
  if (process.connected) process.send?.(message);
}

async function execute(start: StartMessage): Promise<void> {
  let source: string;
  try { source = javascript(start); }
  catch { send({ type: "done", status: "failed", code: "code_syntax_error" }); return; }

  let instrumentation: CodeModeInstrumentation | undefined;
  if (start.evaluation === true) {
    try {
      const { instrumentJavaScript } = await import("./instrument.js");
      instrumentation = await instrumentJavaScript(source);
    } catch { instrumentation = {
      code: source,
      controlFlow: {
        status: "fallback", transformer: "none", branches: [], loops: [],
        unsupported: ["instrumentation_error"], fixedWrapper: false,
      },
    }; }
  }

  let deadline = performance.now() + start.timeoutMs;
  const memory = new WebAssembly.Memory({
    initial: WASM_INITIAL_PAGES,
    maximum: WASM_INITIAL_PAGES + Math.ceil(start.memoryBytes / WASM_PAGE_BYTES),
  });
  const quickjs = await newQuickJSWASMModuleFromVariant(newVariant(syncVariant, { wasmMemory: memory }));
  using vm = quickjs.newContext();
  vm.runtime.setMemoryLimit(start.memoryBytes);
  vm.runtime.setMaxStackSize(Math.min(1024 * 1024, Math.floor(start.memoryBytes / 4)));

  let settle!: () => void;
  const done = new Promise<void>(resolve => { settle = resolve; });
  let ended = false;
  let calls = 0;
  let inspectCount = 0;
  let inspectBytes = 0;
  let pending: { id: number; promise: QuickJSDeferredPromise } | undefined;
  let program: QuickJSHandle | undefined;
  let trace: QuickJSHandle | undefined;
  let traceSent = false;
  let waitingSince: number | undefined;
  const expired = () => waitingSince === undefined && performance.now() >= deadline;
  vm.runtime.setInterruptHandler(() => ended || expired());

  function emitTrace(): void {
    if (traceSent || !trace || !process.connected) return;
    traceSent = true;
    try {
      using snapshot = vm.getProp(trace, "snapshot");
      const value = vm.callFunction(snapshot, trace);
      if (value.error) {
        value.error.dispose();
        return;
      }
      try {
        const json = JSON.stringify(vm.dump(value.value));
        if (typeof json === "string" && Buffer.byteLength(json, "utf8") <= MAX_TRACE_BYTES) {
          send({ type: "trace", json });
        }
      } finally { value.value.dispose(); }
    } catch { /* Trace evidence must never change execution status. */ }
  }

  function finish(status: "completed" | "failed" | "stopped", code?: string): void {
    if (ended) return;
    ended = true;
    try {
      emitTrace();
      send({ type: "done", status, ...(code && { code }) });
    }
    finally { settle(); }
  }

  function runTool(tool: CodeTool, input: QuickJSHandle): QuickJSHandle {
    if (ended) return vm.undefined;
    if (pending) finish("stopped", "concurrent_tool_call");
    else if (calls >= start.maxCalls) finish("stopped", "code_budget_exceeded");
    else if (vm.typeof(input) !== "string") finish("failed", "invalid_tool_input");
    if (ended) return vm.undefined;
    const json = vm.getString(input);
    if (Buffer.byteLength(json, "utf8") > MAX_TOOL_INPUT_BYTES) {
      finish("stopped", "tool_input_too_large");
      return vm.undefined;
    }
    const promise = vm.newPromise();
    pending = { id: ++calls, promise };
    waitingSince = performance.now();
    send({ type: "tool", id: pending.id, tool, json });
    return promise.handle;
  }

  using observe = vm.newFunction("observe", input => runTool("observe", input));
  using act = vm.newFunction("act", input => runTool("act", input));
  using emit = vm.newFunction("inspect", input => {
    if (ended) return vm.undefined;
    const json = vm.getString(input);
    inspectBytes += Buffer.byteLength(json, "utf8");
    if (++inspectCount > MAX_INSPECTIONS || inspectBytes > start.maxInspectBytes) finish("stopped", "inspect_budget_exceeded");
    else send({ type: "inspect", json });
    return vm.undefined;
  });

  function pump(): void {
    if (ended || !program) return;
    const jobs = vm.runtime.executePendingJobs();
    if (ended) { jobs.error?.dispose(); return; }
    if (jobs.error || expired()) {
      jobs.error?.dispose();
      if (expired()) finish("stopped", "code_timeout");
      else finish("failed", "code_error");
      return;
    }
    const state = vm.getPromiseState(program);
    if (state.type === "fulfilled") {
      state.value.dispose();
      if (pending) finish("stopped", "unawaited_tool_call");
      else finish("completed");
    } else if (state.type === "rejected") {
      state.error.dispose();
      finish("failed", "code_error");
    } else if (!pending) finish("failed", "code_stalled");
  }

  function reply(message: ReplyMessage): void {
    if (ended) return;
    if (message?.type !== "reply" || !pending || message.id !== pending.id
      || typeof message.json !== "string" || Buffer.byteLength(message.json, "utf8") > MAX_TOOL_REPLY_BYTES) {
      finish("failed", "sandbox_failed");
      return;
    }
    const { promise } = pending;
    pending = undefined;
    if (waitingSince !== undefined) {
      deadline += performance.now() - waitingSince;
      waitingSince = undefined;
    }
    try {
      vm.newString(message.json).consume(value => promise.resolve(value));
      pump();
    } catch { finish("failed", "sandbox_failed"); }
    finally { promise.dispose(); }
  }

  const disconnected = () => finish("stopped", "sandbox_failed");
  process.on("message", reply);
  process.once("disconnect", disconnected);
  try {
    using init = vm.unwrapResult(vm.evalCode(bootstrap, "sdk.js"));
    using bindings = vm.unwrapResult(vm.callFunction(init, vm.undefined, observe, act, emit));
    if (instrumentation) {
      using createTrace = vm.getProp(bindings, "createTrace");
      using traceMetadata = vm.newString(JSON.stringify(instrumentation.controlFlow));
      const createdTrace = vm.callFunction(createTrace, vm.undefined, traceMetadata);
      if (createdTrace.error) {
        createdTrace.error.dispose();
        // Evaluation instrumentation is best-effort. If its private trace
        // cannot be created, run the untouched source below.
        instrumentation = undefined;
      } else {
        trace = createdTrace.value;
      }
    }
    using compile = vm.getProp(bindings, "compile");
    using code = vm.newString(instrumentation?.code ?? source);
    const traceName = instrumentation?.traceName ? vm.newString(instrumentation.traceName) : undefined;
    let compiled = traceName && trace
      ? vm.callFunction(compile, vm.undefined, code, traceName)
      : vm.callFunction(compile, vm.undefined, code);
    traceName?.dispose();
    if (compiled.error && instrumentation) {
      // A printer/QuickJS mismatch must not turn an evaluation hook into a
      // product behavior change. Retry once with the original source.
      compiled.error.dispose();
      trace?.dispose();
      trace = undefined;
      instrumentation = undefined;
      using rawCode = vm.newString(source);
      compiled = vm.callFunction(compile, vm.undefined, rawCode);
    }
    if (compiled.error) {
      compiled.error.dispose();
      finish("failed", "code_syntax_error");
      return;
    }
    using userFunction = compiled.value;
    using sdk = vm.getProp(bindings, "desk");
    using inspect = vm.getProp(bindings, "inspect");
    const result = trace && instrumentation?.traceName
      ? vm.callFunction(userFunction, vm.undefined, sdk, inspect, trace)
      : vm.callFunction(userFunction, vm.undefined, sdk, inspect);
    if (result.error) {
      result.error.dispose();
      if (expired()) finish("stopped", "code_timeout");
      else finish("failed", "code_error");
      return;
    }
    program = result.value;
    pump();
    await done;
  } finally {
    process.off("message", reply);
    process.off("disconnect", disconnected);
    pending?.promise.dispose();
    program?.dispose();
    trace?.dispose();
  }
}

// Only the parent can send into this process's private IPC channel.
process.once("message", (start: StartMessage) => {
  if (start?.type === "start") {
    void execute(start).catch(() => send({ type: "done", status: "failed", code: "sandbox_failed" }));
  }
});
