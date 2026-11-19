import path from "node:path";

import type { CuaWindowTarget, IdentifyWindow } from "./types.js";

type NativeFunction = (...args: any[]) => any;
type DynamicModule = Record<string, unknown>;

const dynamicImport: (specifier: string) => Promise<DynamicModule> = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<DynamicModule>;

/**
 * Build a read-only user32 probe only when this opt-in backend is opened on a
 * Windows x64 host. Importing DeskLatch elsewhere never loads a DLL.
 */
async function loadWindowsProbe(): Promise<IdentifyWindow | undefined> {
  if (process.platform !== "win32" || process.arch !== "x64") return undefined;
  try {
    const module = await dynamicImport("koffi");
    const koffi = module.default ?? module;
    if (!koffi || typeof (koffi as { load?: unknown }).load !== "function") return undefined;
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const user32 = (koffi as { load(path: string): { func(signature: string): NativeFunction } }).load(
      path.join(systemRoot, "System32", "user32.dll"),
    );
    const owner = user32.func("uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, void *pid)");
    const className = user32.func("int __stdcall GetClassNameW(uintptr_t hwnd, void *buffer, int capacity)");
    const isWindow = user32.func("int __stdcall IsWindow(uintptr_t hwnd)");

    return async (target: CuaWindowTarget): Promise<string | undefined> => {
      try {
        if (Number(isWindow(target.windowId)) === 0) return undefined;
        const pid = Buffer.alloc(4);
        if (Number(owner(target.windowId, pid)) === 0 || pid.readUInt32LE(0) !== target.pid) return undefined;
        const buffer = Buffer.alloc(512);
        const length = Number(className(target.windowId, buffer, buffer.length / 2));
        if (!Number.isSafeInteger(length) || length <= 0 || length >= buffer.length / 2 - 1) return undefined;
        const windowClass = buffer.toString("utf16le", 0, length * 2);
        // WPF top-level windows use HwndWrapper[...] classes. Include the
        // exact PID/HWND in the opaque evidence so a reused handle cannot
        // silently inherit a previous authorization.
        if (!/^HwndWrapper\[[^\]]+\]$/u.test(windowClass)) return undefined;
        return `wpf:${target.pid}:${target.windowId.toString()}:${windowClass}`;
      } catch {
        return undefined;
      }
    };
  } catch {
    return undefined;
  }
}

let nativeProbe: Promise<IdentifyWindow | undefined> | undefined;

/** Check the actual HWND owner and WPF class fingerprint, never a title/name. */
export const identifyWindow: IdentifyWindow = async (target) => {
  nativeProbe ??= loadWindowsProbe();
  const probe = await nativeProbe;
  return probe?.(target);
};
