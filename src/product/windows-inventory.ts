import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface WindowsAppWindow {
  readonly id: string;
  readonly appId: string;
  readonly appName: string;
  readonly title: string;
  readonly pid: number;
  readonly hwnd: bigint;
  readonly processStartedAt: string;
  readonly ownerHwnd?: bigint;
  readonly minimized?: boolean;
}

interface ProcessIdentity {
  readonly image: string;
  readonly startedAt: string;
}

let windowsApi: ReturnType<typeof loadWindowsApi> | undefined;
const registrySurface = /^DeskLatch\s+(?:自动化授权|授权|审批|安装|Authorization|Approval|Setup)/iu;
const shellClasses = new Set(["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"]);
const sharedOrControlImages = new Set(["applicationframehost.exe", "deepseek harness.exe", "consent.exe", "credentialuibroker.exe"]);
const SW_RESTORE = 9;

async function loadWindowsApi() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("windows_inventory_unavailable");
  const { default: koffi } = await import("koffi");
  const system = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const user32 = koffi.load(win32.join(system, "user32.dll"));
  const kernel32 = koffi.load(win32.join(system, "kernel32.dll"));
  const dwmapi = koffi.load(win32.join(system, "dwmapi.dll"));
  const enumeration = koffi.proto("__stdcall", "DeskLatchEnumTopLevelWindow", "int", ["uintptr_t", "intptr_t"]);
  return {
    enumerate: user32.func("__stdcall", "EnumWindows", "int", [koffi.pointer(enumeration), "intptr_t"]),
    isWindow: user32.func("int __stdcall IsWindow(uintptr_t hwnd)"),
    isVisible: user32.func("int __stdcall IsWindowVisible(uintptr_t hwnd)"),
    isMinimized: user32.func("int __stdcall IsIconic(uintptr_t hwnd)"),
    showWindowAsync: user32.func("int __stdcall ShowWindowAsync(uintptr_t hwnd, int command)"),
    getWindow: user32.func("uintptr_t __stdcall GetWindow(uintptr_t hwnd, uint32_t command)"),
    getStyle: user32.func("intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)"),
    getPid: user32.func("uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, void *pid)"),
    getTitle: user32.func("int __stdcall GetWindowTextW(uintptr_t hwnd, void *text, int capacity)"),
    getClass: user32.func("int __stdcall GetClassNameW(uintptr_t hwnd, void *text, int capacity)"),
    getCloak: dwmapi.func("int32_t __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32_t attribute, void *value, uint32_t size)"),
    openProcess: kernel32.func("uintptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)"),
    getImage: kernel32.func("int __stdcall QueryFullProcessImageNameW(uintptr_t process, uint32_t flags, void *text, void *capacity)"),
    getTimes: kernel32.func("int __stdcall GetProcessTimes(uintptr_t process, void *created, void *exited, void *kernel, void *user)"),
    closeProcess: kernel32.func("int __stdcall CloseHandle(uintptr_t handle)"),
  };
}

type WindowsApi = Awaited<ReturnType<typeof loadWindowsApi>>;

function api(): ReturnType<typeof loadWindowsApi> {
  return windowsApi ??= loadWindowsApi();
}

function asHandle(value: unknown): bigint | undefined {
  if (typeof value === "bigint" && value > 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  return undefined;
}

function visiblePid(native: WindowsApi, hwnd: bigint): number | undefined {
  if (!native.isWindow(hwnd) || !native.isVisible(hwnd)) return undefined;
  const cloaked = Buffer.alloc(4);
  if (native.getCloak(hwnd, 14, cloaked, cloaked.length) === 0 && cloaked.readUInt32LE(0) !== 0) return undefined;
  const pid = Buffer.alloc(4);
  return native.getPid(hwnd, pid) ? pid.readUInt32LE(0) || undefined : undefined;
}

function processIdentity(native: WindowsApi, pid: number): ProcessIdentity | undefined {
  if (pid === process.pid) return undefined;
  const handle = asHandle(native.openProcess(0x1000, 0, pid));
  if (handle === undefined) return undefined;
  try {
    const image = Buffer.alloc(32768 * 2);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(image.length / 2);
    const created = Buffer.alloc(8);
    if (!native.getImage(handle, 0, image, size) ||
        !native.getTimes(handle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) return undefined;
    const fileName = image.toString("utf16le", 0, size.readUInt32LE(0) * 2);
    if (!win32.isAbsolute(fileName)) return undefined;
    const canonical = realpathSync.native(fileName);
    if (sharedOrControlImages.has(basename(canonical).toLowerCase())) return undefined;
    return { image: canonical, startedAt: created.readBigUInt64LE(0).toString() };
  } catch {
    return undefined;
  } finally {
    native.closeProcess(handle);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function readText(fn: WindowsApi["getTitle"], hwnd: bigint, capacity: number): string {
  const text = Buffer.alloc(capacity * 2);
  const count = fn(hwnd, text, capacity);
  return count > 0 ? text.toString("utf16le", 0, count * 2).replace(/[\u0000-\u001f]/gu, "").trim() : "";
}

function readWindow(native: WindowsApi, hwnd: bigint, contexts: Map<number, ProcessIdentity | undefined>, includeMinimized = false): WindowsAppWindow | undefined {
  const pid = visiblePid(native, hwnd);
  if (pid === undefined) return undefined;
  const minimized = native.isMinimized(hwnd) !== 0;
  if (minimized && !includeMinimized) return undefined;
  if (shellClasses.has(readText(native.getClass, hwnd, 128))) return undefined;
  const ownerHwnd = asHandle(native.getWindow(hwnd, 4));
  const style = BigInt(native.getStyle(hwnd, -20));
  if (ownerHwnd === undefined && (style & 0x80n) !== 0n) return undefined;
  const title = readText(native.getTitle, hwnd, 256);
  if ((!title && ownerHwnd === undefined) || registrySurface.test(title)) return undefined;
  if (!contexts.has(pid)) contexts.set(pid, processIdentity(native, pid));
  const processInfo = contexts.get(pid);
  if (!processInfo) return undefined;
  const appId = "app-" + hash(processInfo.image.toLowerCase());
  const appName = basename(processInfo.image, win32.extname(processInfo.image));
  return {
    id: "win-" + hash([appId, pid, hwnd, processInfo.startedAt].join(":")),
    appId, appName, title: title || appName, pid, hwnd,
    processStartedAt: processInfo.startedAt,
    ...(minimized ? { minimized: true } : {}),
    ...(ownerHwnd !== undefined ? { ownerHwnd } : {}),
  };
}

function hasPrimaryOwner(window: WindowsAppWindow, windows: ReadonlyMap<bigint, WindowsAppWindow>): boolean {
  const visited = new Set<bigint>();
  let parent = window;
  while (parent.ownerHwnd !== undefined) {
    if (visited.has(parent.hwnd)) return false;
    visited.add(parent.hwnd);
    const owner = windows.get(parent.ownerHwnd);
    if (!owner || owner.pid !== window.pid || owner.appId !== window.appId) return false;
    parent = owner;
  }
  return true;
}

/** Top-level application windows plus their verified same-process owned dialogs. */
export async function listWindowsAppWindows(options: { readonly includeMinimized?: boolean } = {}): Promise<readonly WindowsAppWindow[]> {
  const native = await api();
  const contexts = new Map<number, ProcessIdentity | undefined>();
  const windows = new Map<bigint, WindowsAppWindow>();
  native.enumerate((value: unknown) => {
    const hwnd = asHandle(value);
    if (hwnd !== undefined) {
      try {
        const window = readWindow(native, hwnd, contexts, options.includeMinimized);
        if (window) windows.set(hwnd, window);
      } catch { /* A window can disappear during enumeration. */ }
    }
    return 1;
  }, 0);
  return [...windows.values()].filter(window => hasPrimaryOwner(window, windows));
}

/** A granted app does not authorize an old HWND once its process has exited. */
export async function verifyWindowsAppWindow(window: WindowsAppWindow): Promise<boolean> {
  const native = await api();
  const current = readWindow(native, window.hwnd, new Map());
  if (current?.id !== window.id || current.ownerHwnd !== window.ownerHwnd) return false;
  if (current.ownerHwnd === undefined) return true;
  // Rebuild the chain for owned dialogs only. A top-level modal with a
  // different owner must not take over a saved application window ID.
  const inventory = await listWindowsAppWindows();
  return inventory.some(candidate => candidate.id === current.id && candidate.ownerHwnd === current.ownerHwnd);
}

/** Restore an exact, host-selected top-level recipient. Foreground proof is separate. */
export async function restoreMinimizedWindowsAppWindow(window: WindowsAppWindow, signal?: AbortSignal): Promise<boolean> {
  if (window.minimized !== true || window.ownerHwnd !== undefined) return false;
  const native = await api();
  signal?.throwIfAborted();
  const current = readWindow(native, window.hwnd, new Map(), true);
  if (current?.id !== window.id || current.ownerHwnd !== undefined) return false;
  if (!current.minimized) return true;
  if (!native.showWindowAsync(window.hwnd, SW_RESTORE)) return false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(75, undefined, { signal });
    const fresh = readWindow(native, window.hwnd, new Map(), true);
    if (fresh?.id !== window.id || fresh.ownerHwnd !== undefined) return false;
    if (!fresh.minimized) return true;
  }
  return false;
}
