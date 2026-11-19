import type { Rect } from "../../contracts.js";
import type { WindowsWindowTarget } from "./types.js";

type DynamicImport = (specifier: string) => Promise<Record<string, unknown>>;
type NativeFunction = (...args: any[]) => any;

const dynamicImport: DynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;
const GW_OWNER = 4;
const GWL_STYLE = -16;
const WS_CHILD = 0x40000000n;

/**
 * A top-level window enumerator and the read-only user32 facts needed to
 * establish ownership. The production loader below supplies this from
 * EnumWindows/GetWindow/GetWindowRect; the interface also keeps deterministic
 * tests and host-owned native workers independent of Koffi.
 */
export interface WindowsOwnedDialogNativeApi {
  /** Must enumerate real top-level HWNDs (EnumWindows, not EnumChildWindows). */
  readonly enumerateTopLevelWindows: (visit: (hwnd: bigint) => boolean) => boolean;
  readonly isWindow: (hwnd: bigint) => boolean;
  readonly isWindowVisible: (hwnd: bigint) => boolean;
  readonly isIconic: (hwnd: bigint) => boolean;
  readonly processId: (hwnd: bigint) => number | undefined;
  /** Return the owner from GetWindow(hwnd, GW_OWNER), not a child parent. */
  readonly owner: (hwnd: bigint) => bigint | undefined;
  readonly bounds: (hwnd: bigint) => Rect | undefined;
  /** Optional WS_CHILD check for defensive filtering of a malformed enumerator. */
  readonly style?: (hwnd: bigint) => bigint | number | undefined;
}

export interface WindowsOwnedDialog {
  /** The exact host-authorized parent target used for the ownership proof. */
  readonly target: WindowsWindowTarget;
  /** A visible, bounded, real top-level HWND owned by target.hwnd. */
  readonly hwnd: bigint;
  readonly pid: number;
  /** The direct owner and the complete owner chain ending at target.hwnd. */
  readonly ownerHwnd: bigint;
  readonly ownerChain: readonly bigint[];
  readonly bounds: Rect;
}

export interface WindowsOwnedDialogInspector {
  /**
   * Discover only visible top-level windows in target.pid whose GW_OWNER chain
   * reaches target.hwnd. This never widens the backend authorization grant.
   */
  findOwnedDialogs(
    target: WindowsWindowTarget,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly WindowsOwnedDialog[]>;
}

/** Build the read-only owned-dialog inspector around a host/native API. */
export function createWindowsOwnedDialogInspector(api: WindowsOwnedDialogNativeApi): WindowsOwnedDialogInspector {
  return new User32OwnedDialogInspector(api);
}

/**
 * Load the optional user32 owned-dialog inspector. This module is intentionally
 * lazy: non-Windows hosts and callers that do not need dialog discovery never
 * load a native DLL or enumerate desktop windows.
 */
export async function loadWindowsOwnedDialogInspector(): Promise<WindowsOwnedDialogInspector | undefined> {
  if (process.platform !== "win32" || process.arch !== "x64") return undefined;
  try {
    const module = await dynamicImport("koffi");
    const koffi = module.default ?? module;
    if (!koffi || typeof (koffi as { load?: unknown }).load !== "function") return undefined;
    const native = koffi as {
      load(path: string): { func: (...args: any[]) => NativeFunction };
      opaque(): unknown;
      pointer(...args: unknown[]): unknown;
      proto(convention: string, name: string, result: string, args: readonly unknown[]): unknown;
    };
    const user32 = native.load("C:\\Windows\\System32\\user32.dll");
    const hwndType = native.pointer("HWND", native.opaque());
    const enumWindowsProc = native.proto("__stdcall", "EnumWindowsProc", "bool", [hwndType, "intptr_t"]);
    const enumWindows = user32.func("__stdcall", "EnumWindows", "int", [native.pointer(enumWindowsProc), "intptr_t"]);
    const isWindow = user32.func("int __stdcall IsWindow(uintptr_t hwnd)");
    const isWindowVisible = user32.func("int __stdcall IsWindowVisible(uintptr_t hwnd)");
    const isIconic = user32.func("int __stdcall IsIconic(uintptr_t hwnd)");
    const getWindowThreadProcessId = user32.func("uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, void *pid)");
    const getWindow = user32.func("uintptr_t __stdcall GetWindow(uintptr_t hwnd, uint32_t command)");
    const getWindowRect = user32.func("int __stdcall GetWindowRect(uintptr_t hwnd, void *rect)");
    const getWindowLongPtr = user32.func("intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)");

    return createWindowsOwnedDialogInspector({
      enumerateTopLevelWindows(visit) {
        const result = Number(enumWindows((hwnd: unknown) => visit(toBigInt(hwnd) ?? 0n), 0));
        return result !== 0;
      },
      isWindow(hwnd) {
        return Number(isWindow(hwnd)) !== 0;
      },
      isWindowVisible(hwnd) {
        return Number(isWindowVisible(hwnd)) !== 0;
      },
      isIconic(hwnd) {
        return Number(isIconic(hwnd)) !== 0;
      },
      processId(hwnd) {
        const pid = Buffer.alloc(4);
        if (Number(getWindowThreadProcessId(hwnd, pid)) === 0) return undefined;
        const value = pid.readUInt32LE(0);
        return value > 0 ? value : undefined;
      },
      owner(hwnd) {
        return toBigInt(getWindow(hwnd, GW_OWNER));
      },
      bounds(hwnd) {
        const rect = Buffer.alloc(16);
        if (Number(getWindowRect(hwnd, rect)) === 0) return undefined;
        const left = rect.readInt32LE(0);
        const top = rect.readInt32LE(4);
        const right = rect.readInt32LE(8);
        const bottom = rect.readInt32LE(12);
        if (right <= left || bottom <= top) return undefined;
        return { x: left, y: top, width: right - left, height: bottom - top };
      },
      style(hwnd) {
        return getWindowLongPtr(hwnd, GWL_STYLE);
      },
    });
  } catch {
    return undefined;
  }
}

class User32OwnedDialogInspector implements WindowsOwnedDialogInspector {
  readonly #api: WindowsOwnedDialogNativeApi;

  constructor(api: WindowsOwnedDialogNativeApi) {
    this.#api = api;
  }

  async findOwnedDialogs(
    target: WindowsWindowTarget,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly WindowsOwnedDialog[]> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    try {
      if (!isPositiveHandle(target.hwnd) || !this.#api.isWindow(target.hwnd)) return [];
      if (this.#api.processId(target.hwnd) !== target.pid) return [];
      const dialogs: WindowsOwnedDialog[] = [];
      const seen = new Set<bigint>();
      this.#api.enumerateTopLevelWindows((hwnd) => {
        if (signal?.aborted) return false;
        if (!isPositiveHandle(hwnd) || seen.has(hwnd)) return true;
        seen.add(hwnd);
        try {
          if (hwnd === target.hwnd || !this.#api.isWindow(hwnd)) return true;
          if (this.#api.processId(hwnd) !== target.pid) return true;
          if (!this.#api.isWindowVisible(hwnd) || this.#api.isIconic(hwnd)) return true;
          if (isChildWindow(this.#api.style?.(hwnd))) return true;
          const bounds = this.#api.bounds(hwnd);
          if (!bounds || bounds.width <= 0 || bounds.height <= 0) return true;
          const ownerChain = findOwnerChain(this.#api, hwnd, target.hwnd);
          if (!ownerChain) return true;
          dialogs.push({
            target,
            hwnd,
            pid: target.pid,
            ownerHwnd: ownerChain[0],
            ownerChain,
            bounds,
          });
        } catch {
          // Windows can disappear while EnumWindows is walking the z-order.
          // A disappearing candidate is not evidence of an owned dialog.
        }
        return true;
      });
      signal?.throwIfAborted();
      return Object.freeze(dialogs.map((dialog) => Object.freeze({
        ...dialog,
        ownerChain: Object.freeze([...dialog.ownerChain]),
      })));
    } catch (error) {
      if (signal?.aborted) throw error;
      return [];
    }
  }
}

function findOwnerChain(
  api: WindowsOwnedDialogNativeApi,
  hwnd: bigint,
  targetHwnd: bigint,
): readonly bigint[] | undefined {
  const chain: bigint[] = [];
  const visited = new Set<bigint>([hwnd]);
  let current = hwnd;
  for (let depth = 0; depth < 64; depth += 1) {
    const owner = api.owner(current);
    if (owner === undefined || !isPositiveHandle(owner) || visited.has(owner)) return undefined;
    chain.push(owner);
    if (owner === targetHwnd) return chain;
    if (!api.isWindow(owner)) return undefined;
    visited.add(owner);
    current = owner;
  }
  return undefined;
}

function isChildWindow(style: bigint | number | undefined): boolean {
  if (style === undefined) return false;
  try {
    const value = typeof style === "bigint" ? BigInt.asUintN(64, style) : BigInt.asUintN(64, BigInt(Math.trunc(style)));
    return (value & WS_CHILD) !== 0n;
  } catch {
    return false;
  }
}

function isPositiveHandle(value: bigint): boolean {
  return value > 0n && value <= 0xffffffffffffffffn;
}

function toBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return isPositiveHandle(value) ? value : undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    try {
      const parsed = BigInt(value);
      return isPositiveHandle(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
