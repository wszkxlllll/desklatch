import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Step, Rect } from "../../contracts.js";
import {
  backendError,
  type WindowsDispatchTarget,
  type WindowsFocusEvidence,
  type WindowsResolvedControl,
  type WindowsTransport,
  type WindowsTransportDelivery,
  type WindowsWindowElement,
  type WindowsWindowSnapshot,
  type WindowsWindowTarget,
} from "./types.js";

/**
 * The fixed worker protocol deliberately carries only an exact PID/HWND and
 * an opaque UIA identity. It does not accept captions, paths, or executable
 * code, so a host can reuse this transport for any explicitly enrolled native
 * dialog without teaching the model app-specific click rules.
 */
export interface NativeUiAutomationWorker {
  request(request: Readonly<Record<string, unknown>>, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
  close?(): Promise<void>;
}

export interface NativeUiAutomationWindowsTransportOptions {
  /** Test seam or a host-owned worker implementation. */
  readonly worker?: NativeUiAutomationWorker;
  readonly maxElements?: number;
  readonly maxDepth?: number;
  readonly timeoutMs?: number;
}

const SOURCE = "native-uia-v1" as const;
const DEFAULT_MAX_ELEMENTS = 512;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_ELEMENTS_LIMIT = 512;
const MAX_DEPTH_LIMIT = 32;
const MAX_TEXT_LENGTH = 16_384;
const MAX_TOKEN_LENGTH = 4_096;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$/u;

/**
 * Optional Windows UI Automation transport for native dialogs.
 *
 * This transport is intentionally background-only. It reads an exact HWND
 * through `AutomationElement.FromHandle`, exposes only controls that report
 * the relevant UIA patterns, and asks the worker to re-resolve the same
 * runtime identity immediately before each action. The surrounding Windows
 * desktop backend remains responsible for authorization, physical evidence,
 * approval, and stale-frame checks.
 */
export class NativeUiAutomationWindowsTransport implements WindowsTransport {
  readonly source = SOURCE;
  readonly #worker: NativeUiAutomationWorker;
  readonly #maxElements: number;
  readonly #maxDepth: number;
  #opened = false;
  #closed = false;

  constructor(options: NativeUiAutomationWindowsTransportOptions = {}) {
    this.#worker = options.worker ?? new PowerShellNativeUiAutomationWorker({ timeoutMs: options.timeoutMs });
    this.#maxElements = boundedInteger(options.maxElements ?? DEFAULT_MAX_ELEMENTS, 1, MAX_ELEMENTS_LIMIT, "native_uia_max_elements");
    this.#maxDepth = boundedInteger(options.maxDepth ?? DEFAULT_MAX_DEPTH, 1, MAX_DEPTH_LIMIT, "native_uia_max_depth");
  }

  static async open(options: NativeUiAutomationWindowsTransportOptions = {}, signal?: AbortSignal): Promise<NativeUiAutomationWindowsTransport> {
    const transport = new NativeUiAutomationWindowsTransport(options);
    try {
      await transport.open(signal);
      return transport;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async open(signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw backendError("session_closed");
    signal?.throwIfAborted();
    if (process.platform !== "win32" && !(this.#worker instanceof PowerShellNativeUiAutomationWorker)) {
      // Injected workers are useful for deterministic host tests on every
      // platform. The packaged worker itself is Windows-only.
      this.#opened = true;
      return;
    }
    if (process.platform !== "win32") throw backendError("native_uia_unavailable");
    this.#opened = true;
  }

  async observeWindow(target: WindowsWindowTarget, options: { readonly signal?: AbortSignal }): Promise<WindowsWindowSnapshot> {
    this.assertOpen();
    validateTarget(target);
    options.signal?.throwIfAborted();
    const result = await this.request({
      op: "observe",
      pid: target.pid,
      hwnd: target.hwnd.toString(),
      max_elements: this.#maxElements,
      max_depth: this.#maxDepth,
    }, options.signal);
    const raw = objectRecord(result);
    if (!raw) throw backendError("native_uia_observation_invalid");
    if (raw.ok === false) throw backendError(stringField(raw, "code") ?? "native_uia_observation_failed");
    const returnedPid = positiveInteger(raw.pid);
    const returnedHwnd = parseHandle(raw.window_id ?? raw.windowId ?? raw.hwnd);
    if (returnedPid !== target.pid || returnedHwnd !== target.hwnd) {
      throw backendError("native_uia_window_identity_mismatch");
    }
    const elementsRaw = Array.isArray(raw.elements) ? raw.elements : [];
    const elements: WindowsWindowElement[] = [];
    for (const value of elementsRaw) {
      const element = parseElement(value);
      if (element !== undefined) elements.push(element);
    }
    const bounds = parseRect(raw.window_bounds ?? raw.windowBounds ?? raw.bounds);
    const degraded = raw.degraded === true || raw.truncated === true;
    const complete = raw.elements_complete === true || raw.elementsComplete === true;
    return {
      target,
      ...(stringField(raw, "window_title", "windowTitle", "title") ? { title: stringField(raw, "window_title", "windowTitle", "title") } : {}),
      ...(bounds ? { bounds } : {}),
      elements: Object.freeze(elements),
      complete: complete && !degraded,
      ...(degraded ? { degraded: true } : {}),
      ...(stringField(raw, "snapshot_id", "snapshotId") ? { snapshotId: stringField(raw, "snapshot_id", "snapshotId") } : {}),
    };
  }

  /**
   * Read the actual UIA FocusedElement under an exact enrolled root. This is
   * deliberately capture-free and does not activate the window. The worker
   * proves PID/root ownership and returns the native RuntimeId so callers can
   * compare focus with a fresh model binding instead of guessing from role or
   * caption.
   */
  async readFocused(target: WindowsWindowTarget, signal?: AbortSignal): Promise<WindowsFocusEvidence | undefined> {
    this.assertOpen();
    validateTarget(target);
    signal?.throwIfAborted();
    const result = await this.request({
      op: "focus",
      pid: target.pid,
      hwnd: target.hwnd.toString(),
    }, signal);
    const raw = objectRecord(result);
    if (!raw) return undefined;
    const returnedPid = positiveInteger(raw.pid);
    const returnedHwnd = parseHandle(raw.window_id ?? raw.windowId ?? raw.hwnd);
    if (returnedPid !== target.pid || returnedHwnd !== target.hwnd) return undefined;
    const focused = raw.focused === true && raw.focused_within_target === true;
    const runtimeId = stringField(raw, "focused_runtime_id", "runtime_id", "runtimeId");
    const role = stringField(raw, "focused_role", "role");
    const bounds = parseRect(raw.focused_bounds ?? raw.bounds);
    return {
      target,
      focused,
      pid: returnedPid,
      hwnd: returnedHwnd,
      ...(runtimeId ? { runtimeId } : {}),
      ...(role ? { role } : {}),
      ...(bounds ? { bounds } : {}),
      ...(typeof raw.code === "string" ? { code: raw.code } : {}),
    };
  }

  async dispatch(step: Step, target: WindowsDispatchTarget, options: { readonly signal?: AbortSignal }): Promise<WindowsTransportDelivery> {
    this.assertOpen();
    options.signal?.throwIfAborted();
    if (target.foreground) return { status: "refused", code: "native_uia_foreground_unsupported" };
    const control = target.control;
    if (!control || !control.token) return { status: "refused", code: "native_uia_target_unavailable" };
    if (!sameTarget(control.window, target.window)) return { status: "refused", code: "native_uia_window_identity_mismatch" };
    if (control.source.password || control.control.sensitive) return { status: "refused", code: "sensitive_control_not_writable" };
    if (control.token.length > MAX_TOKEN_LENGTH || !/^uia1\.[A-Za-z0-9_-]+$/u.test(control.token)) {
      return { status: "refused", code: "native_uia_token_invalid" };
    }

    const action = nativeAction(step, control);
    if (!action.ok) return { status: "refused", code: action.code };
    const request: Record<string, unknown> = {
      op: "dispatch",
      pid: target.window.pid,
      hwnd: target.window.hwnd.toString(),
      token: control.token,
      action: action.kind,
      // The worker must replay the same bounded tree walk used by the
      // observation. Re-walking at a larger hard-coded scope could create a
      // false material-context mismatch for deliberately bounded dialogs.
      max_elements: this.#maxElements,
      max_depth: this.#maxDepth,
    };
    if (action.kind === "setValue") request.value = action.value;
    try {
      const result = await this.request(request, options.signal);
      return actionDelivery(result);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return { status: "unknown", code: errorCode(error) ?? "native_uia_dispatch_unknown" };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#opened = false;
    await this.#worker.close?.();
  }

  private async request(request: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.#worker.request(request, signal ? { signal } : undefined);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw backendError(errorCode(error) ?? "native_uia_worker_failed", error instanceof Error ? error.message : String(error));
    }
  }

  private assertOpen(): void {
    if (this.#closed) throw backendError("session_closed");
    if (!this.#opened) throw backendError("session_not_open");
  }
}

/** Public factory for hosts that prefer a named constructor. */
export function createNativeUiAutomationWindowsTransport(options: NativeUiAutomationWindowsTransportOptions = {}): NativeUiAutomationWindowsTransport {
  return new NativeUiAutomationWindowsTransport(options);
}

/** Async alias mirroring the CUA transport's open helper. */
export async function openNativeUiAutomationWindowsTransport(
  options: NativeUiAutomationWindowsTransportOptions = {},
  signal?: AbortSignal,
): Promise<NativeUiAutomationWindowsTransport> {
  return NativeUiAutomationWindowsTransport.open(options, signal);
}

/**
 * Fixed, packaged worker launcher. The script is an asset copied into dist by
 * the repository's existing asset packer; no code is interpolated into the
 * PowerShell command line or the script body.
 */
export class PowerShellNativeUiAutomationWorker implements NativeUiAutomationWorker {
  readonly #powershellPath: string;
  readonly #scriptPath: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: { readonly powershellPath?: string; readonly timeoutMs?: number; readonly maxOutputBytes?: number } = {}) {
    this.#powershellPath = options.powershellPath ?? defaultPowerShellPath();
    // Keep the helper path package-owned; callers can inject a worker for
    // tests rather than substituting executable script at runtime.
    this.#scriptPath = fileURLToPath(new URL("./dialog-transport.ps1", import.meta.url));
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 250, 30_000, "native_uia_timeout");
    this.#maxOutputBytes = boundedInteger(options.maxOutputBytes ?? 2 * 1024 * 1024, 1024, 8 * 1024 * 1024, "native_uia_output_limit");
  }

  request(request: Readonly<Record<string, unknown>>, options: { readonly signal?: AbortSignal } = {}): Promise<unknown> {
    if (process.platform !== "win32") return Promise.reject(backendError("native_uia_unavailable"));
    options.signal?.throwIfAborted();
    const child = spawn(this.#powershellPath, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.#scriptPath,
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value);
      };
      const abort = (): void => {
        child.kill();
        finish(backendError("native_uia_cancelled"));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(backendError("native_uia_timeout"));
      }, this.#timeoutMs);
      const append = (part: Buffer, isError: boolean): void => {
        if (settled) return;
        if (isError) stderr = Buffer.concat([stderr, part]);
        else stdout = Buffer.concat([stdout, part]);
        if (stdout.length + stderr.length > this.#maxOutputBytes) {
          child.kill();
          finish(backendError("native_uia_output_limit"));
        }
      };
      child.stdout.on("data", (part: Buffer) => append(part, false));
      child.stderr.on("data", (part: Buffer) => append(part, true));
      child.on("error", error => finish(backendError("native_uia_helper_failed", error.message)));
      child.on("close", code => {
        if (settled) return;
        if (code !== 0) {
          let detail = "";
          try { detail = decodeUtf8(stderr).replace(/\s+/gu, " ").trim().slice(0, 256); } catch { /* classify below */ }
          finish(backendError("native_uia_helper_failed", detail || `helper_exit_${code ?? "unknown"}`));
          return;
        }
        try {
          const text = decodeUtf8(stdout).trim();
          if (!text) throw backendError("native_uia_helper_empty");
          finish(undefined, JSON.parse(text) as unknown);
        } catch (error) {
          finish(error instanceof Error ? error : backendError("native_uia_helper_invalid"));
        }
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stdin.on("error", error => finish(backendError("native_uia_helper_failed", error.message)));
      child.stdin.end(JSON.stringify(request), "utf8");
    });
  }
}

function nativeAction(step: Step, control: WindowsResolvedControl):
  | { readonly ok: true; readonly kind: "click" | "setValue"; readonly value?: string }
  | { readonly ok: false; readonly code: string } {
  const sourceActions = new Set(control.source.actions.map(action => action.toLocaleLowerCase().replace(/[ -]/gu, "_")));
  if (step.kind === "click") {
    if ((step.button ?? "left") !== "left" || (step.count ?? 1) !== 1) return { ok: false, code: "native_uia_action_not_supported" };
    if (!sourceActions.has("invoke") && !sourceActions.has("click") && !sourceActions.has("press")) return { ok: false, code: "native_uia_pattern_unavailable" };
    return { ok: true, kind: "click" };
  }
  if (step.kind === "type") {
    return { ok: false, code: "native_uia_set_value_required" };
  }
  if (step.kind === "setValue") {
    if (step.value.length > MAX_TEXT_LENGTH || !SAFE_TEXT.test(step.value)) return { ok: false, code: "invalid_text" };
    if (!editableRole(control.source.role) || (!sourceActions.has("set_value") && !sourceActions.has("value") && !control.control.actions.includes("setValue"))) {
      return { ok: false, code: "native_uia_pattern_unavailable" };
    }
    return { ok: true, kind: "setValue", value: step.value };
  }
  return { ok: false, code: "native_uia_action_not_supported" };
}

function actionDelivery(value: unknown): WindowsTransportDelivery {
  const raw = objectRecord(value);
  if (!raw) return { status: "unknown", code: "native_uia_worker_invalid" };
  const status = stringField(raw, "status");
  if (status === "dispatched" || status === "refused" || status === "partial" || status === "unknown") {
    return { status, ...(stringField(raw, "code", "error_code") ? { code: stringField(raw, "code", "error_code") } : {}) };
  }
  if (raw.ok === true) return { status: "dispatched" };
  return { status: "refused", code: stringField(raw, "code", "error_code") ?? "native_uia_action_refused" };
}

function parseElement(value: unknown): WindowsWindowElement | undefined {
  const item = objectRecord(value);
  if (!item) return undefined;
  const role = stringField(item, "role");
  const index = integerString(item.element_index ?? item.elementIndex ?? item.index);
  const depth = nonNegativeInteger(item.depth);
  if (!role || index === undefined || depth === undefined) return undefined;
  const password = item.password === true || item.is_password === true || item.isPassword === true;
  const actions = password ? [] : nativeActions(item.actions, role);
  const token = password ? undefined : stringField(item, "element_token", "elementToken", "token");
  const materialContextToken = password ? undefined : stringField(item, "approval_context_token", "approvalContextToken", "material_context_token");
  return {
    index,
    depth,
    role,
    ...(!password && stringField(item, "label", "name", "title") ? { label: stringField(item, "label", "name", "title") } : {}),
    ...(!password && stringField(item, "value") !== undefined ? { value: stringField(item, "value") } : {}),
    ...(!password && stringField(item, "value_description", "valueDescription") ? { valueDescription: stringField(item, "value_description", "valueDescription") } : {}),
    ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
    ...(typeof item.editable === "boolean" || actions.includes("set_value") ? { editable: item.editable === true || actions.includes("set_value") } : {}),
    ...(typeof item.selected === "boolean" ? { selected: item.selected } : {}),
    ...(typeof item.focused === "boolean" ? { focused: item.focused } : {}),
    ...(password ? { password: true } : {}),
    actions: Object.freeze(actions),
    ...(integerString(item.parent_index ?? item.parentIndex) !== undefined ? { parentIndex: integerString(item.parent_index ?? item.parentIndex) } : {}),
    ...(stringField(item, "runtime_id", "runtimeId") ? { runtimeId: stringField(item, "runtime_id", "runtimeId") } : {}),
    ...(parseRect(item.frame ?? item.bounding_rect ?? item.boundingRect) ? { rect: parseRect(item.frame ?? item.bounding_rect ?? item.boundingRect) } : {}),
    ...(token && token.length <= MAX_TOKEN_LENGTH && /^uia1\.[A-Za-z0-9_-]+$/u.test(token) ? { token } : {}),
    ...(materialContextToken && /^uia-material-v1\.[a-f0-9]{64}$/u.test(materialContextToken)
      ? { approvalContext: { token: materialContextToken, summary: "Native UIA context bound" } }
      : {}),
  };
}

function nativeActions(value: unknown, role: string): string[] {
  if (!Array.isArray(value)) return [];
  const actions = new Set<string>();
  for (const action of value) {
    if (typeof action !== "string") continue;
    const normalized = action.toLocaleLowerCase().replace(/[ -]/gu, "_");
    if (normalized === "invoke" || normalized === "click" || normalized === "press") actions.add("invoke");
    else if ((normalized === "set_value" || normalized === "value" || normalized === "text") && editableRole(role)) actions.add("set_value");
    else if (normalized === "scroll") actions.add("scroll");
  }
  return [...actions];
}

function editableRole(role: string): boolean {
  const normalized = role.toLocaleLowerCase().replace(/[ _-]/gu, "");
  return normalized === "edit" || normalized === "textbox" || normalized === "textfield"
    || normalized === "combobox" || normalized === "document" || normalized === "searchbox" || normalized === "spinner";
}

function parseRect(value: unknown): Rect | undefined {
  const item = objectRecord(value);
  if (!item) return undefined;
  const x = finiteNumber(item.x);
  const y = finiteNumber(item.y);
  const width = finiteNumber(item.width ?? item.w);
  const height = finiteNumber(item.height ?? item.h);
  if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function validateTarget(target: WindowsWindowTarget): void {
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || target.pid > 0x7fffffff || target.hwnd <= 0n || target.hwnd > 0xffffffffffffffffn) {
    throw backendError("invalid_window_identity");
  }
}

function sameTarget(left: WindowsWindowTarget, right: WindowsWindowTarget): boolean {
  return left.pid === right.pid && left.hwnd === right.hwnd;
}

function objectRecord(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function stringField(value: unknown, ...keys: string[]): string | undefined {
  const item = objectRecord(value);
  if (!item) return undefined;
  for (const key of keys) if (typeof item[key] === "string") return item[key] as string;
  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function integerString(value: unknown): string | undefined {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) return value;
  return undefined;
}

function parseHandle(value: unknown): bigint | undefined {
  if (typeof value === "bigint" && value > 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    try {
      const parsed = BigInt(value);
      return parsed > 0n ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw backendError(code);
  return value;
}

function defaultPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function decodeUtf8(value: Buffer): string {
  const text = value.toString("utf8");
  if (text.includes("\uFFFD")) throw backendError("native_uia_helper_encoding");
  return text;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const item = error as Record<string, unknown>;
  return typeof item.code === "string" ? item.code : undefined;
}
