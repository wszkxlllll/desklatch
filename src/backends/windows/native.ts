import type { Point, Rect } from "../../contracts.js";
import { PowerShellNativeUiAutomationWorker, type NativeUiAutomationWorker } from "./dialog-transport.js";
import type { WindowsFocusEvidence, WindowsPhysicalEvidence, WindowsPhysicalInspector, WindowsWindowTarget } from "./types.js";

type DynamicImport = (specifier: string) => Promise<Record<string, unknown>>;
type NativeFunction = (...args: any[]) => any;

const dynamicImport: DynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;
const GW_HWNDPREV = 3;
const GA_ROOT = 2;

/**
 * Build a read-only user32 inspector. Koffi is intentionally loaded only on
 * Windows and only when the backend is opened; importing the DeskLatch package
 * on another platform must not load a Windows DLL or native worker.
 */
export async function loadWindowsPhysicalInspector(): Promise<WindowsPhysicalInspector | undefined> {
  if (process.platform !== "win32" || process.arch !== "x64") return undefined;
  try {
    const module = await dynamicImport("koffi");
    const koffi = module.default ?? module;
    if (!koffi || typeof (koffi as { load?: unknown }).load !== "function") return undefined;
    const user32 = (koffi as { load(path: string): { func(signature: string): NativeFunction } }).load("C:\\Windows\\System32\\user32.dll");
    const isWindow = user32.func("int __stdcall IsWindow(uintptr_t hwnd)");
    const isWindowVisible = user32.func("int __stdcall IsWindowVisible(uintptr_t hwnd)");
    const isIconic = user32.func("int __stdcall IsIconic(uintptr_t hwnd)");
    const getForegroundWindow = user32.func("uintptr_t __stdcall GetForegroundWindow()");
    const getWindowThreadProcessId = user32.func("uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, void *pid)");
    const getWindowRect = user32.func("int __stdcall GetWindowRect(uintptr_t hwnd, void *rect)");
    const getWindow = user32.func("uintptr_t __stdcall GetWindow(uintptr_t hwnd, uint32_t command)");
    const getAncestor = user32.func("uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint32_t flags)");
    return new User32Inspector({
      isWindow,
      isWindowVisible,
      isIconic,
      getForegroundWindow,
      getWindowThreadProcessId,
      getWindowRect,
      getWindow,
      getAncestor,
    }, new PowerShellNativeUiAutomationWorker());
  } catch {
    // Native evidence is a hard pre-dispatch requirement. Returning undefined
    // lets the adapter honestly refuse input instead of guessing ownership.
    return undefined;
  }
}

interface User32Api {
  readonly isWindow: NativeFunction;
  readonly isWindowVisible: NativeFunction;
  readonly isIconic: NativeFunction;
  readonly getForegroundWindow: NativeFunction;
  readonly getWindowThreadProcessId: NativeFunction;
  readonly getWindowRect: NativeFunction;
  readonly getWindow: NativeFunction;
  readonly getAncestor: NativeFunction;
}

class User32Inspector implements WindowsPhysicalInspector {
  readonly #api: User32Api;
  readonly #focusWorker?: NativeUiAutomationWorker;

  constructor(api: User32Api, focusWorker?: NativeUiAutomationWorker) {
    this.#api = api;
    this.#focusWorker = focusWorker;
  }

  async read(target: WindowsWindowTarget, point?: Point, signal?: AbortSignal): Promise<WindowsPhysicalEvidence | undefined> {
    signal?.throwIfAborted();
    try {
      const hwnd = target.hwnd;
      if (!isPositiveHandle(hwnd) || Number(this.#api.isWindow(hwnd)) === 0) {
        return {
          target,
          visible: false,
          minimized: false,
          code: "window_not_found",
        };
      }
      const ownerPid = readOwnerPid(this.#api.getWindowThreadProcessId, hwnd);
      if (ownerPid !== target.pid) {
        return {
          target,
          visible: false,
          minimized: false,
          code: "window_owner_changed",
        };
      }
      const bounds = readRect(this.#api.getWindowRect, hwnd);
      const minimized = Number(this.#api.isIconic(hwnd)) !== 0;
      const visible = Number(this.#api.isWindowVisible(hwnd)) !== 0 && bounds !== undefined &&
        bounds.width > 0 && bounds.height > 0 && !minimized;
      const foregroundHwnd = toBigInt(this.#api.getForegroundWindow());
      const foregroundPid = foregroundHwnd === undefined
        ? undefined
        : readOwnerPid(this.#api.getWindowThreadProcessId, foregroundHwnd);
      const occludingHwnd = point !== undefined && visible && bounds !== undefined
        ? this.findOccluder(hwnd, point)
        : undefined;
      return {
        target,
        visible,
        minimized,
        ...(bounds ? { bounds } : {}),
        ...(foregroundHwnd !== undefined ? { foregroundHwnd } : {}),
        ...(foregroundPid !== undefined ? { foregroundPid } : {}),
        ...(occludingHwnd !== undefined ? { occludingHwnd } : {}),
        ...(visible ? {} : { code: minimized ? "window_minimized" : "window_not_visible" }),
      };
    } catch {
      return undefined;
    }
  }

  async readFocused(target: WindowsWindowTarget, signal?: AbortSignal): Promise<WindowsFocusEvidence | undefined> {
    signal?.throwIfAborted();
    if (!this.#focusWorker) return undefined;
    try {
      if (!isPositiveHandle(target.hwnd) || Number(this.#api.isWindow(target.hwnd)) === 0) {
        return { target, focused: false, code: "window_not_found" };
      }
      const ownerPid = readOwnerPid(this.#api.getWindowThreadProcessId, target.hwnd);
      if (ownerPid !== target.pid) return { target, focused: false, code: "window_owner_changed" };
      const value = await this.#focusWorker.request({ op: "focus", pid: target.pid, hwnd: target.hwnd.toString() }, signal ? { signal } : undefined);
      const raw = record(value);
      if (!raw) return { target, focused: false, code: "native_focus_invalid" };
      const returnedPid = positiveInteger(raw.pid);
      const returnedHwnd = toBigInt(raw.window_id ?? raw.windowId ?? raw.hwnd);
      if (returnedPid !== target.pid || returnedHwnd !== target.hwnd) {
        return { target, focused: false, code: "native_focus_identity_mismatch" };
      }
      return {
        target,
        focused: raw.focused === true && raw.focused_within_target === true,
        pid: returnedPid,
        hwnd: returnedHwnd,
        ...(typeof raw.focused_runtime_id === "string" ? { runtimeId: raw.focused_runtime_id } : {}),
        ...(typeof raw.focused_role === "string" ? { role: raw.focused_role } : {}),
        ...(parseRect(raw.focused_bounds ?? raw.bounds) ? { bounds: parseRect(raw.focused_bounds ?? raw.bounds) } : {}),
        ...(typeof raw.code === "string" ? { code: raw.code } : {}),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { target, focused: false, code: errorCode(error) ?? "native_focus_unavailable" };
    }
  }

  async close(): Promise<void> {
    await this.#focusWorker?.close?.();
  }

  /**
   * Walk the top-level z-order above the exact HWND. This is deliberately a
   * point test rather than a screenshot or a guessed rectangle intersection:
   * a target is accepted only when the native window owning that desktop point
   * is the authorized HWND itself.
   */
  private findOccluder(targetHwnd: bigint, point: Point): bigint | undefined {
    const targetRoot = toBigInt(this.#api.getAncestor(targetHwnd, GA_ROOT)) ?? targetHwnd;
    const targetBounds = readRect(this.#api.getWindowRect, targetHwnd);
    if (targetBounds === undefined || !contains(targetBounds, point)) return targetRoot;
    let candidate = toBigInt(this.#api.getWindow(targetRoot, GW_HWNDPREV));
    let count = 0;
    while (candidate !== undefined && count++ < 128) {
      if (Number(this.#api.isWindow(candidate)) !== 0 && Number(this.#api.isWindowVisible(candidate)) !== 0) {
        const candidateBounds = readRect(this.#api.getWindowRect, candidate);
        if (candidateBounds !== undefined && contains(candidateBounds, point)) return candidate;
      }
      candidate = toBigInt(this.#api.getWindow(candidate, GW_HWNDPREV));
    }
    return undefined;
  }
}

function readOwnerPid(getWindowThreadProcessId: NativeFunction, hwnd: bigint): number | undefined {
  const pid = Buffer.alloc(4);
  const thread = Number(getWindowThreadProcessId(hwnd, pid));
  if (thread === 0) return undefined;
  const value = pid.readUInt32LE(0);
  return value > 0 ? value : undefined;
}

function readRect(getWindowRect: NativeFunction, hwnd: bigint): Rect | undefined {
  const rect = Buffer.alloc(16);
  if (Number(getWindowRect(hwnd, rect)) === 0) return undefined;
  const left = rect.readInt32LE(0);
  const top = rect.readInt32LE(4);
  const right = rect.readInt32LE(8);
  const bottom = rect.readInt32LE(12);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function parseRect(value: unknown): Rect | undefined {
  const item = record(value);
  if (!item) return undefined;
  const x = finiteNumber(item.x);
  const y = finiteNumber(item.y);
  const width = finiteNumber(item.width ?? item.w);
  const height = finiteNumber(item.height ?? item.h);
  if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}

function isPositiveHandle(value: bigint): boolean {
  return value > 0n && value <= 0xffffffffffffffffn;
}

function toBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value > 0n ? value : undefined;
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

function record(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const item = error as Record<string, unknown>;
  return typeof item.code === "string" ? item.code : undefined;
}
