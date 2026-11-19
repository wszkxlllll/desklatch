import type { Point, Rect } from "../../contracts.js";
import type { WindowsPhysicalEvidence, WindowsPhysicalInspector, WindowsWindowTarget } from "./types.js";

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
    });
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

  constructor(api: User32Api) {
    this.#api = api;
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
      const occludingHwnd = point !== undefined && visible && bounds !== undefined
        ? this.findOccluder(hwnd, point)
        : undefined;
      return {
        target,
        visible,
        minimized,
        ...(bounds ? { bounds } : {}),
        ...(foregroundHwnd !== undefined ? { foregroundHwnd } : {}),
        ...(occludingHwnd !== undefined ? { occludingHwnd } : {}),
        ...(visible ? {} : { code: minimized ? "window_minimized" : "window_not_visible" }),
      };
    } catch {
      return undefined;
    }
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
