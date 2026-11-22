import type { FrameImage, Point, Rect } from "../../contracts.js";
import { isWindowPointGesture, sameWindowPointBounds, type WindowPointGesture } from "../../core/window-point.js";
import { PowerShellNativeUiAutomationWorker, type NativeUiAutomationWorker } from "./dialog-transport.js";
import type {
  WindowsDesktopImage,
  WindowsFocusEvidence,
  WindowsGridEditContext,
  WindowsGridEditQuery,
  WindowsGridItemAnchor,
  WindowsGridItemQuery,
  WindowsPhysicalEvidence,
  WindowsPhysicalInspector,
  WindowsPointerSurface,
  WindowsPointerSurfaceIdentity,
  WindowsTransportDelivery,
  WindowsWindowTarget,
} from "./types.js";

type DynamicImport = (specifier: string) => Promise<Record<string, unknown>>;
type NativeFunction = (...args: any[]) => any;

const dynamicImport: DynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;
const GW_HWNDPREV = 3;
const GA_ROOT = 2;
const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x20n;
const WS_EX_LAYERED = 0x80000n;
const INPUT_KEYBOARD = 1;
const MOUSE_MOVE_ABSOLUTE = 0x8001;
const MOUSE_LEFT_DOWN = 0x0002;
const MOUSE_LEFT_UP = 0x0004;
const MOUSE_WHEEL = 0x0800;
const MOUSE_HORIZONTAL_WHEEL = 0x1000;
const WHEEL_DELTA = 120;
const KEYEVENTF_KEYUP = 0x0002;
const INPUT_SIZE_X64 = 40;
// Keep the x64 buffer generously sized for Koffi's ABI marshalling. The
// documented fields used here remain cbSize=0, hwndActive=8, hwndFocus=16;
// the extra tail bytes avoid provider-specific struct-size rejection.
const GUITHREADINFO_SIZE_X64 = 72;
const VK_CONTROL = 0x11;
const VK_SHIFT = 0x10;
const VK_MENU = 0x12;
const VK_LWIN = 0x5B;
const VK_RWIN = 0x5C;
// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2. Win32 returns window
// rectangles in the calling thread's coordinate space; use the documented
// context rather than applying a machine-specific scale factor.
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4n;

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
    const koffiApi = koffi as {
      load(path: string): { func(signature: string): NativeFunction; func(convention: string, name: string, result: unknown, args: readonly unknown[]): NativeFunction };
      struct(definition: Record<string, string>): unknown;
    };
    const user32 = koffiApi.load("C:\\Windows\\System32\\user32.dll");
    const isWindow = user32.func("int __stdcall IsWindow(uintptr_t hwnd)");
    const isWindowVisible = user32.func("int __stdcall IsWindowVisible(uintptr_t hwnd)");
    const isIconic = user32.func("int __stdcall IsIconic(uintptr_t hwnd)");
    const isWindowEnabled = user32.func("int __stdcall IsWindowEnabled(uintptr_t hwnd)");
    const getForegroundWindow = user32.func("uintptr_t __stdcall GetForegroundWindow()");
    const getWindowThreadProcessId = user32.func("uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, void *pid)");
    const getWindowRect = user32.func("int __stdcall GetWindowRect(uintptr_t hwnd, void *rect)");
    const getClientRect = user32.func("int __stdcall GetClientRect(uintptr_t hwnd, void *rect)");
    const clientToScreen = user32.func("int __stdcall ClientToScreen(uintptr_t hwnd, void *point)");
    const getWindowLongPtr = user32.func("intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)");
    const getWindow = user32.func("uintptr_t __stdcall GetWindow(uintptr_t hwnd, uint32_t command)");
    const getAncestor = user32.func("uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint32_t flags)");
    const getGuiThreadInfo = user32.func("int __stdcall GetGUIThreadInfo(uint32_t threadId, void *guiThreadInfo)");
    const getAsyncKeyState = user32.func("int16_t __stdcall GetAsyncKeyState(int virtualKey)");
    const sendInput = user32.func("uint32_t __stdcall SendInput(uint32_t count, void *inputs, int inputSize)");
    const nativePoint = koffiApi.struct({ x: "int32_t", y: "int32_t" });
    const windowFromPoint = user32.func("__stdcall", "WindowFromPoint", "uintptr_t", [nativePoint]);
    const getSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int index)");
    const setThreadDpiAwarenessContext = user32.func("intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)");
    return new User32Inspector({
      isWindow,
      isWindowVisible,
      isIconic,
      isWindowEnabled,
      getForegroundWindow,
      getWindowThreadProcessId,
      getWindowRect,
      getClientRect,
      clientToScreen,
      getWindowLongPtr,
      getWindow,
      getAncestor,
      getGuiThreadInfo,
      getAsyncKeyState,
      sendInput,
      windowFromPoint,
      getSystemMetrics,
      setThreadDpiAwarenessContext,
    }, new PowerShellNativeUiAutomationWorker(), new PowerShellNativeUiAutomationWorker({ maxOutputBytes: 8 * 1024 * 1024 }));
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
  readonly isWindowEnabled: NativeFunction;
  readonly getForegroundWindow: NativeFunction;
  readonly getWindowThreadProcessId: NativeFunction;
  readonly getWindowRect: NativeFunction;
  readonly getClientRect: NativeFunction;
  readonly clientToScreen: NativeFunction;
  readonly getWindowLongPtr: NativeFunction;
  readonly getWindow: NativeFunction;
  readonly getAncestor: NativeFunction;
  readonly getGuiThreadInfo: NativeFunction;
  readonly getAsyncKeyState: NativeFunction;
  readonly sendInput: NativeFunction;
  readonly windowFromPoint: NativeFunction;
  readonly getSystemMetrics: NativeFunction;
  readonly setThreadDpiAwarenessContext: NativeFunction;
}

export class User32Inspector implements WindowsPhysicalInspector {
  readonly #api: User32Api;
  readonly #focusWorker?: NativeUiAutomationWorker;
  readonly #captureWorker?: NativeUiAutomationWorker;

  constructor(api: User32Api, focusWorker?: NativeUiAutomationWorker, captureWorker?: NativeUiAutomationWorker) {
    this.#api = api;
    this.#focusWorker = focusWorker;
    this.#captureWorker = captureWorker;
  }

  async read(target: WindowsWindowTarget, point?: Point, signal?: AbortSignal): Promise<WindowsPhysicalEvidence | undefined> {
    signal?.throwIfAborted();
    return withPhysicalDpi(this.#api, () => {
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
        ? this.findOccluder(target, point)
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
    });
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

  async readPointerSurface(
    target: WindowsWindowTarget,
    point: Point,
    signal?: AbortSignal,
  ): Promise<WindowsPointerSurface | undefined> {
    signal?.throwIfAborted();
    const worker = this.#focusWorker;
    if (!worker || !validPointerPoint(point)) return undefined;
    try {
      const raw = record(await worker.request({
        op: "pointer_surface",
        pid: target.pid,
        hwnd: target.hwnd.toString(),
        point: { x: Math.round(point.x), y: Math.round(point.y) },
      }, signal ? { signal } : undefined));
      return parsePointerSurface(raw, target);
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  async readGridEditContext(
    target: WindowsWindowTarget,
    query: WindowsGridEditQuery,
    signal?: AbortSignal,
  ): Promise<WindowsGridEditContext | undefined> {
    signal?.throwIfAborted();
    const worker = this.#focusWorker;
    if (!worker || !validGridItemQuery(query) || !validGridItemAnchor(query.anchor)) return undefined;
    try {
      const raw = record(await worker.request({
        op: "grid_edit_context",
        pid: target.pid,
        hwnd: target.hwnd.toString(),
        point: query.point,
        selected_item: gridItemRequest(query.selectedItem),
        anchor: gridAnchorRequest(query.anchor),
      }, signal ? { signal } : undefined));
      return parseGridEditContext(raw, target);
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  async readGridItemAnchor(
    target: WindowsWindowTarget,
    query: WindowsGridItemQuery,
    signal?: AbortSignal,
  ): Promise<WindowsGridItemAnchor | undefined> {
    signal?.throwIfAborted();
    const worker = this.#focusWorker;
    if (!worker || !validGridItemQuery(query)) return undefined;
    try {
      const raw = record(await worker.request({
        op: "grid_item_anchor",
        pid: target.pid,
        hwnd: target.hwnd.toString(),
        point: query.point,
        selected_item: gridItemRequest(query.selectedItem),
      }, signal ? { signal } : undefined));
      return parseGridItemAnchor(raw, target);
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  async dispatchGridEnter(
    target: WindowsWindowTarget,
    query: WindowsGridEditQuery & { readonly expected: WindowsGridEditContext },
    signal?: AbortSignal,
  ): Promise<WindowsTransportDelivery> {
    signal?.throwIfAborted();
    const worker = this.#focusWorker;
    if (!worker || !validGridItemQuery(query) || !validGridItemAnchor(query.anchor) || !validGridEditContext(query.expected, target)) {
      return { status: "refused", code: "native_grid_commit_proof_invalid" };
    }
    const physical = await this.read(target, query.point, signal);
    if (!strictPhysicalForegroundMatches(physical, target)
      || (physical?.occludingHwnd !== undefined && physical.occludingHwnd !== target.hwnd)
      || (physical?.bounds !== undefined && !contains(physical.bounds, query.point))) {
      return { status: "refused", code: physical?.occludingHwnd ? "target_occluded" : "native_grid_commit_target_unavailable" };
    }
    try {
      const raw = record(await worker.request({
        op: "grid_commit_enter",
        pid: target.pid,
        hwnd: target.hwnd.toString(),
        point: query.point,
        selected_item: gridItemRequest(query.selectedItem),
        anchor: gridAnchorRequest(query.anchor),
        expected: gridContextRequest(query.expected),
      }, signal ? { signal } : undefined));
      const delivery = nativeGridDelivery(raw);
      if (delivery.status !== "dispatched") return delivery;
      const after = await this.read(target, query.point, signal).catch(() => undefined);
      const focusAfter = await this.readFocused(target, signal).catch(() => undefined);
      if (!strictPhysicalForegroundMatches(after, target)
        || (after?.occludingHwnd !== undefined && after.occludingHwnd !== target.hwnd)
        || !focusEvidenceMatchesTarget(focusAfter, target)
        || typeof focusAfter.runtimeId !== "string" || focusAfter.runtimeId.length === 0) {
        return { status: "unknown", code: "native_grid_commit_postcheck_unknown" };
      }
      return delivery;
    } catch (error) {
      if (signal?.aborted) throw error;
      return { status: "unknown", code: errorCode(error) ?? "native_grid_commit_unknown" };
    }
  }

  /**
   * Deliver one explicitly authorized foreground chord through Win32
   * SendInput. This route is deliberately separate from CUA/PostMessage
   * hotkeys: it proves the exact foreground/root focus, refuses user-held
   * modifiers, sends one complete key-down/up batch, and never retries a
   * short or ambiguous native result.
   */
  async dispatchHotkey(
    target: WindowsWindowTarget,
    keys: readonly string[],
    focused: WindowsFocusEvidence,
    signal?: AbortSignal,
  ): Promise<WindowsTransportDelivery> {
    signal?.throwIfAborted();
    const plan = nativeHotkeyPlan(keys);
    if (!plan) return { status: "refused", code: "native_hotkey_unsupported" };
    if (!focusEvidenceMatchesTarget(focused, target)) return { status: "refused", code: "native_hotkey_focus_unconfirmed" };

    // These reads are intentionally awaited before the final synchronous
    // guard below. No await occurs between that guard and SendInput.
    const before = await this.read(target, undefined, signal);
    if (!physicalForegroundMatches(before, target)) return { status: "refused", code: "native_hotkey_foreground_unconfirmed" };
    const beforeUiFocus = await this.readFocused(target, signal);
    if (!focusEvidenceMatchesTarget(beforeUiFocus, target)) return { status: "refused", code: "native_hotkey_focus_unconfirmed" };
    // Both scopes are approved against the exact UIA element that was
    // enrolled by the caller.  A window-scoped chord may legitimately move
    // focus as a result of the full chord (for example, Save closing an
    // editor), but it must never start after the receiver changed.
    if (typeof focused.runtimeId !== "string" || focused.runtimeId.length === 0
      || typeof beforeUiFocus.runtimeId !== "string" || beforeUiFocus.runtimeId.length === 0) {
      return { status: "refused", code: "native_hotkey_focus_unconfirmed" };
    }
    if (beforeUiFocus.runtimeId !== focused.runtimeId) {
      return { status: "refused", code: "native_hotkey_focus_changed" };
    }
    const beforeFocus = readGuiThreadFocus(this.#api, target);
    if (!beforeFocus || beforeFocus.active !== target.hwnd || beforeFocus.root !== target.hwnd || beforeFocus.pid !== target.pid
      || (beforeFocus.flags & 0x1e) !== 0) {
      return { status: "refused", code: "native_hotkey_focus_unconfirmed" };
    }
    // Final synchronous ownership/focus/modifier guard immediately before the
    // native call. A held modifier would make the batch's meaning ambiguous.
    if (!syncForegroundMatches(this.#api, target)
      || !syncGuiThreadFocusMatches(this.#api, target, beforeFocus.focus)
      || modifiersHeld(this.#api)) {
      return { status: "refused", code: "native_hotkey_focus_changed" };
    }

    const input = keyboardInputBatch(plan);
    let delivered: number;
    try {
      delivered = Number(this.#api.sendInput(plan.inputCount, input, INPUT_SIZE_X64));
    } catch (error) {
      return { status: "unknown", code: errorCode(error) ?? "native_hotkey_delivery_unknown" };
    }
    if (!Number.isSafeInteger(delivered) || delivered !== plan.inputCount) {
      // SendInput may have delivered a strict prefix. Never replay the chord.
      if (delivered > 0) {
        // Release every key this batch could have depressed. This is cleanup,
        // never a replay; only send it while the same receiver is still
        // synchronously proven, so a user switch cannot receive the cleanup.
        if (syncForegroundMatches(this.#api, target)
          && syncGuiThreadFocusMatches(this.#api, target, beforeFocus.focus)) {
          const release = keyboardReleaseBatch(plan, delivered);
          if (release.count > 0) {
            try { this.#api.sendInput(release.count, release.buffer, INPUT_SIZE_X64); } catch { /* preserve partial */ }
          }
        }
        return { status: "partial", code: "native_hotkey_partial" };
      }
      return { status: "refused", code: "native_hotkey_not_queued" };
    }

    const after = await this.read(target, undefined, signal).catch(() => undefined);
    const afterFocus = await this.readFocused(target, signal).catch(() => undefined);
    const afterNativeFocus = readGuiThreadFocus(this.#api, target);
    if (!physicalForegroundMatches(after, target)
      || !focusEvidenceMatchesTarget(afterFocus, target)
      || (plan.scope === "control" && focused.runtimeId !== undefined && afterFocus?.runtimeId !== focused.runtimeId)
      || !afterNativeFocus
      || afterNativeFocus.active !== target.hwnd
      || afterNativeFocus.root !== target.hwnd
      || afterNativeFocus.pid !== target.pid
      || (afterNativeFocus.flags & 0x1e) !== 0
      // The awaited UIA reads above leave a race before the receipt is
      // returned. Re-read the exact foreground owner synchronously so a
      // receiver switch cannot be reported as delivered.
      || !syncForegroundMatches(this.#api, target)
      || (plan.scope === "control" && afterNativeFocus.focus !== beforeFocus.focus)) {
      return { status: "unknown", code: "native_hotkey_focus_changed" };
    }
    // A window-scoped chord may transition the focused child while retaining
    // the enrolled receiver.  Do not let any later generic focus handoff
    // attach that transitioned child to this action's receipt.
    return plan.scope === "window"
      ? { status: "dispatched", suppressFocusHandoff: true }
      : { status: "dispatched" };
  }

  async dispatchWindowPoint(
    target: WindowsWindowTarget,
    gesture: WindowPointGesture,
    bounds: Rect,
    display: Pick<FrameImage, "width" | "height">,
    signal?: AbortSignal,
  ): Promise<WindowsTransportDelivery> {
    if (!isWindowPointGesture(gesture)) return { status: "refused", code: "window_point_gesture_unavailable" };
    const point = gesture.target.point;
    if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) || !contains(displayRect(display), point)) {
      return { status: "refused", code: "point_outside_target" };
    }
    if (gesture.kind === "scroll" && (!Number.isSafeInteger(gesture.amount) || gesture.amount < 1 || gesture.amount > 100
      || !["up", "down", "left", "right"].includes(gesture.direction))) return { status: "refused", code: "invalid_scroll_amount" };
    let sent = false;
    const delivery = withPhysicalDpi<WindowsTransportDelivery>(this.#api, () => {
      const api = this.#api;
      if (display.width !== Number(api.getSystemMetrics(0)) || display.height !== Number(api.getSystemMetrics(1))) {
        return { status: "refused", code: "window_point_display_changed" };
      }
      if (!syncForegroundMatches(api, target) || Number(api.isWindowVisible(target.hwnd)) === 0
        || Number(api.isIconic(target.hwnd)) !== 0 || Number(api.isWindowEnabled(target.hwnd)) === 0
        || !sameWindowPointBounds(readRect(api.getWindowRect, target.hwnd), bounds)) {
        return { status: "refused", code: "foreground_not_confirmed" };
      }
      const client = readClientRect(api, target.hwnd);
      const hit = toBigInt(api.windowFromPoint(point));
      if (!client || !contains(client, point) || hit === undefined
        || toBigInt(api.getAncestor(hit, GA_ROOT)) !== target.hwnd
        || readOwnerPid(api.getWindowThreadProcessId, hit) !== target.pid
        || this.findOccluder(target, point) !== undefined) return { status: "refused", code: "target_occluded" };
      if (!ordinaryWindowPointerState(api, target) || !syncForegroundMatches(api, target)) {
        return { status: "refused", code: "window_point_input_busy" };
      }
      if (signal?.aborted) return { status: "refused", code: "cancelled_before_dispatch" };
      const batch = windowPointInputBatch(gesture, display);
      sent = true;
      const count = Number(api.sendInput(batch.length / INPUT_SIZE_X64, batch, INPUT_SIZE_X64));
      if (count === batch.length / INPUT_SIZE_X64) {
        return syncForegroundMatches(api, target)
          ? { status: "dispatched", suppressFocusHandoff: true }
          : { status: "unknown", code: "window_point_recipient_changed" };
      }
      if (gesture.kind === "click" && count === 2) {
        // Release the queued mouse-down if the batch ended before its release.
        try { api.sendInput(1, batch.subarray(2 * INPUT_SIZE_X64), INPUT_SIZE_X64); } catch { /* preserve partial */ }
        return { status: "partial", code: "window_point_partial" };
      }
      return count === 0 || count === 1
        ? { status: "refused", code: "window_point_not_queued" }
        : { status: "unknown", code: "window_point_delivery_unknown" };
    });
    return delivery ?? (sent
      ? { status: "unknown", code: "window_point_delivery_unknown" }
      : { status: "refused", code: "window_point_geometry_unavailable" });
  }

  async captureDesktopImage(signal?: AbortSignal): Promise<WindowsDesktopImage | undefined> {
    if (!this.#captureWorker) return undefined;
    signal?.throwIfAborted();
    // The raster and the last-mile window hit test must use the same pixels,
    // including when the embedding Node/Electron process is DPI-unaware.
    const physicalSize = () => withPhysicalDpi(this.#api, () => ({
      width: Number(this.#api.getSystemMetrics(0)),
      height: Number(this.#api.getSystemMetrics(1)),
    }));
    const size = physicalSize();
    if (!size) return undefined;
    const { width, height } = size;
    const result = record(await this.#captureWorker.request({ op: "desktop_image", width, height }, { signal }));
    const current = physicalSize();
    if (result?.ok !== true || result.width !== width || result.height !== height
        || typeof result.data !== "string" || result.data.length === 0
        || current?.width !== width || current.height !== height) return undefined;
    return { mimeType: "image/jpeg", dataBase64: result.data, width, height };
  }

  async close(): Promise<void> {
    await this.#focusWorker?.close?.();
    await this.#captureWorker?.close?.();
  }

  /**
   * Walk the top-level z-order above the exact HWND. This is deliberately a
   * point test rather than a screenshot or a guessed rectangle intersection:
   * a target is accepted only when the native window owning that desktop point
   * is the authorized HWND itself.
   */
  private findOccluder(target: WindowsWindowTarget, point: Point): bigint | undefined {
    const targetHwnd = target.hwnd;
    const targetRoot = toBigInt(this.#api.getAncestor(targetHwnd, GA_ROOT)) ?? targetHwnd;
    const targetBounds = readRect(this.#api.getWindowRect, targetHwnd);
    if (targetBounds === undefined || !contains(targetBounds, point)) return targetRoot;
    let candidate = toBigInt(this.#api.getWindow(targetRoot, GW_HWNDPREV));
    let count = 0;
    while (candidate !== undefined && count++ < 128) {
      if (Number(this.#api.isWindow(candidate)) !== 0 && Number(this.#api.isWindowVisible(candidate)) !== 0) {
        const candidateBounds = readRect(this.#api.getWindowRect, candidate);
        if (candidateBounds !== undefined && contains(candidateBounds, point)) {
          if (targetRoot === targetHwnd && this.layeredCandidatePassesNativeHit(candidate, target, point)) {
            candidate = toBigInt(this.#api.getWindow(candidate, GW_HWNDPREV));
            continue;
          }
          return candidate;
        }
      }
      candidate = toBigInt(this.#api.getWindow(candidate, GW_HWNDPREV));
    }
    return undefined;
  }

  private layeredCandidatePassesNativeHit(candidate: bigint, target: WindowsWindowTarget, point: Point): boolean {
    try {
      if (Number(this.#api.isWindowEnabled(candidate)) === 0) return false;
      const style = toBigInt(this.#api.getWindowLongPtr(candidate, GWL_EXSTYLE));
      if (style === undefined) return false;
      const nativeHit = toBigInt(this.#api.windowFromPoint({ x: Math.round(point.x), y: Math.round(point.y) }));
      if (nativeHit === undefined) return false;
      const nativeRoot = toBigInt(this.#api.getAncestor(nativeHit, GA_ROOT)) ?? nativeHit;
      return shouldIgnoreLayeredOccluder({
        candidateEnabled: true,
        candidateStyle: style,
        targetIsTopLevel: true,
        nativeRoot,
        nativePid: readOwnerPid(this.#api.getWindowThreadProcessId, nativeRoot),
        authorizedRoot: target.hwnd,
        authorizedPid: target.pid,
      });
    } catch {
      return false;
    }
  }
}

/**
 * A rectangle walk can over-report an enabled layered overlay whose pixels at
 * this exact point are transparent. Ignore it only with an independent native
 * WindowFromPoint root/PID proof for an enrolled top-level target. All other
 * candidates remain occluders.
 */
export function shouldIgnoreLayeredOccluder(input: {
  readonly candidateEnabled: boolean;
  readonly candidateStyle: bigint | number | undefined;
  readonly targetIsTopLevel: boolean;
  readonly nativeRoot: bigint | undefined;
  readonly nativePid: number | undefined;
  readonly authorizedRoot: bigint;
  readonly authorizedPid: number;
}): boolean {
  if (!input.candidateEnabled || !input.targetIsTopLevel || input.candidateStyle === undefined) return false;
  const style = toBigInt(input.candidateStyle);
  if (style === undefined || (style & WS_EX_LAYERED) === 0n || (style & WS_EX_TRANSPARENT) !== 0n) return false;
  return input.nativeRoot === input.authorizedRoot && input.nativePid === input.authorizedPid;
}

interface NativeHotkeyPlan {
  readonly scope: "control" | "window";
  readonly modifiers: readonly number[];
  readonly key: number;
  readonly inputCount: number;
}

function nativeHotkeyPlan(keys: readonly string[]): NativeHotkeyPlan | undefined {
  if (!Array.isArray(keys) || (keys.length !== 2 && keys.length !== 3)) return undefined;
  const normalized = keys.map(key => typeof key === "string" ? key.toLocaleLowerCase() : "");
  if (new Set(normalized).size !== normalized.length || normalized[0] !== "ctrl") return undefined;
  if (normalized.length === 2 && normalized[1] === "a") return { scope: "control", modifiers: [VK_CONTROL], key: 0x41, inputCount: 4 };
  if (normalized.length === 2 && normalized[1] === "s") return { scope: "window", modifiers: [VK_CONTROL], key: 0x53, inputCount: 4 };
  if (normalized.length === 3 && normalized[1] === "shift" && normalized[2] === "s") {
    return { scope: "window", modifiers: [VK_CONTROL, VK_SHIFT], key: 0x53, inputCount: 6 };
  }
  return undefined;
}

/** Pure scope extraction used by the guarded native hotkey boundary/tests. */
export function nativeHotkeyScope(keys: readonly string[]): "control" | "window" | undefined {
  return nativeHotkeyPlan(keys)?.scope;
}

function keyboardInputBatch(plan: NativeHotkeyPlan): Buffer {
  const input = Buffer.alloc(plan.inputCount * INPUT_SIZE_X64);
  let index = 0;
  for (const virtualKey of plan.modifiers) writeKeyboardInput(input, index++, virtualKey, 0);
  writeKeyboardInput(input, index++, plan.key, 0);
  writeKeyboardInput(input, index++, plan.key, KEYEVENTF_KEYUP);
  for (let modifierIndex = plan.modifiers.length - 1; modifierIndex >= 0; modifierIndex -= 1) {
    writeKeyboardInput(input, index++, plan.modifiers[modifierIndex], KEYEVENTF_KEYUP);
  }
  return input;
}

function displayRect(display: Pick<FrameImage, "width" | "height">): Rect {
  return { x: 0, y: 0, width: display.width, height: display.height };
}

function windowPointInputBatch(gesture: WindowPointGesture, display: Pick<FrameImage, "width" | "height">): Buffer {
  const { x, y } = gesture.target.point;
  const batch = Buffer.alloc((gesture.kind === "click" ? 3 : 2) * INPUT_SIZE_X64);
  const toAbsolute = (value: number, length: number) => Math.min(65535, Math.floor((value + 0.5) * 65536 / length));
  batch.writeInt32LE(toAbsolute(x, display.width), 8);
  batch.writeInt32LE(toAbsolute(y, display.height), 12);
  batch.writeUInt32LE(MOUSE_MOVE_ABSOLUTE, 20);
  if (gesture.kind === "click") {
    batch.writeUInt32LE(MOUSE_LEFT_DOWN, INPUT_SIZE_X64 + 20);
    batch.writeUInt32LE(MOUSE_LEFT_UP, 2 * INPUT_SIZE_X64 + 20);
  } else {
    const horizontal = gesture.direction === "left" || gesture.direction === "right";
    const delta = gesture.direction === "down" || gesture.direction === "left" ? -WHEEL_DELTA : WHEEL_DELTA;
    batch.writeInt32LE(gesture.amount * delta, INPUT_SIZE_X64 + 16);
    batch.writeUInt32LE(horizontal ? MOUSE_HORIZONTAL_WHEEL : MOUSE_WHEEL, INPUT_SIZE_X64 + 20);
  }
  return batch;
}

function keyboardReleaseBatch(plan: NativeHotkeyPlan, delivered: number): { readonly buffer: Buffer; readonly count: number } {
  const sequence = hotkeyInputSequence(plan);
  const pressed: number[] = [];
  for (const event of sequence.slice(0, Math.min(delivered, sequence.length))) {
    if ((event.flags & KEYEVENTF_KEYUP) !== 0) {
      const index = pressed.lastIndexOf(event.virtualKey);
      if (index >= 0) pressed.splice(index, 1);
    } else if (!pressed.includes(event.virtualKey)) {
      pressed.push(event.virtualKey);
    }
  }
  const input = Buffer.alloc(pressed.length * INPUT_SIZE_X64);
  pressed.reverse().forEach((virtualKey, index) => writeKeyboardInput(input, index, virtualKey, KEYEVENTF_KEYUP));
  return { buffer: input, count: pressed.length };
}

function hotkeyInputSequence(plan: NativeHotkeyPlan): Array<{ readonly virtualKey: number; readonly flags: number }> {
  return [
    ...plan.modifiers.map(virtualKey => ({ virtualKey, flags: 0 })),
    { virtualKey: plan.key, flags: 0 },
    { virtualKey: plan.key, flags: KEYEVENTF_KEYUP },
    ...[...plan.modifiers].reverse().map(virtualKey => ({ virtualKey, flags: KEYEVENTF_KEYUP })),
  ];
}

function writeKeyboardInput(buffer: Buffer, index: number, virtualKey: number, flags: number): void {
  const offset = index * INPUT_SIZE_X64;
  buffer.writeUInt32LE(INPUT_KEYBOARD, offset);
  // x64 INPUT's KEYBDINPUT union begins at byte 8. The remaining fields are
  // already zeroed by Buffer.alloc (scan code, timestamp, extra info).
  buffer.writeUInt16LE(virtualKey, offset + 8);
  buffer.writeUInt32LE(flags, offset + 12);
}

interface NativeGuiFocus {
  readonly active?: bigint;
  readonly focus: bigint;
  readonly root: bigint;
  readonly pid?: number;
  readonly flags: number;
}

function readGuiThreadFocus(api: User32Api, target: WindowsWindowTarget): NativeGuiFocus | undefined {
  try {
    if (!isPositiveHandle(target.hwnd) || Number(api.isWindow(target.hwnd)) === 0) return undefined;
    const thread = Number(api.getWindowThreadProcessId(target.hwnd, Buffer.alloc(4)));
    if (!Number.isSafeInteger(thread) || thread <= 0) return undefined;
    const info = Buffer.alloc(GUITHREADINFO_SIZE_X64);
    info.writeUInt32LE(GUITHREADINFO_SIZE_X64, 0);
    if (Number(api.getGuiThreadInfo(thread, info)) === 0) return undefined;
    const flags = info.readUInt32LE(4);
    const active = toBigInt(info.readBigUInt64LE(8));
    const focus = toBigInt(info.readBigUInt64LE(16));
    if (focus === undefined) return undefined;
    const root = toBigInt(api.getAncestor(focus, GA_ROOT)) ?? focus;
    const pid = readOwnerPid(api.getWindowThreadProcessId, focus);
    return { ...(active !== undefined ? { active } : {}), focus, root, ...(pid !== undefined ? { pid } : {}), flags };
  } catch {
    return undefined;
  }
}

function ordinaryWindowPointerState(api: User32Api, target: WindowsWindowTarget): boolean {
  const thread = Number(api.getWindowThreadProcessId(target.hwnd, Buffer.alloc(4)));
  if (!Number.isSafeInteger(thread) || thread <= 0) return false;
  const info = Buffer.alloc(GUITHREADINFO_SIZE_X64);
  info.writeUInt32LE(GUITHREADINFO_SIZE_X64, 0);
  return Number(api.getGuiThreadInfo(thread, info)) !== 0
    && info.readBigUInt64LE(8) === target.hwnd
    && (info.readUInt32LE(4) & 0x1e) === 0
    && info.readBigUInt64LE(24) === 0n
    && ![1, 2, 4, 5, 6, VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN]
      .some(key => Number(api.getAsyncKeyState(key)) < 0);
}

function syncGuiThreadFocusMatches(api: User32Api, target: WindowsWindowTarget, expectedFocus: bigint): boolean {
  const current = readGuiThreadFocus(api, target);
  return current?.active === target.hwnd
    && current.focus === expectedFocus
    && current.root === target.hwnd
    && current.pid === target.pid
    && (current.flags & 0x1e) === 0;
}

function syncForegroundMatches(api: User32Api, target: WindowsWindowTarget): boolean {
  try {
    if (Number(api.isWindow(target.hwnd)) === 0 || readOwnerPid(api.getWindowThreadProcessId, target.hwnd) !== target.pid) return false;
    const foreground = toBigInt(api.getForegroundWindow());
    return foreground !== undefined
      && foreground === target.hwnd
      && readOwnerPid(api.getWindowThreadProcessId, foreground) === target.pid;
  } catch {
    return false;
  }
}

function modifiersHeld(api: User32Api): boolean {
  try {
    // Refuse both modifiers and the chord's printable keys when physically
    // held by the user; otherwise SendInput could combine with live input.
    return [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN, 0x41, 0x53]
      .some(virtualKey => Number(api.getAsyncKeyState(virtualKey)) < 0);
  } catch {
    // A failed modifier sample cannot prove that the user's keyboard state is
    // neutral, so fail closed before SendInput.
    return true;
  }
}

function physicalForegroundMatches(evidence: WindowsPhysicalEvidence | undefined, target: WindowsWindowTarget): boolean {
  return evidence?.visible === true
    && evidence.minimized === false
    && evidence.foregroundHwnd === target.hwnd
    && (evidence.foregroundPid === undefined || evidence.foregroundPid === target.pid);
}

function strictPhysicalForegroundMatches(evidence: WindowsPhysicalEvidence | undefined, target: WindowsWindowTarget): boolean {
  return evidence?.visible === true
    && evidence.minimized === false
    && evidence.foregroundHwnd === target.hwnd
    && evidence.foregroundPid === target.pid;
}

function focusEvidenceMatchesTarget(evidence: WindowsFocusEvidence | undefined, target: WindowsWindowTarget): evidence is WindowsFocusEvidence {
  return evidence?.focused === true
    && evidence.pid === target.pid
    && evidence.hwnd === target.hwnd;
}

function validPointerPoint(point: { readonly x: number; readonly y: number } | undefined): boolean {
  return point !== undefined
    && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= -2_147_483_648 && point.x <= 2_147_483_647
    && point.y >= -2_147_483_648 && point.y <= 2_147_483_647;
}

function parsePointerSurfaceIdentity(value: unknown): WindowsPointerSurfaceIdentity | undefined {
  const raw = record(value);
  const runtimeId = stringField(raw, "runtime_id", "runtimeId");
  const role = stringField(raw, "role");
  const bounds = parseRect(raw?.bounds);
  if (!runtimeId || runtimeId.length > 1024 || !role || role.length > 256 || !bounds || !isValidRect(bounds)) return undefined;
  const name = stringField(raw, "name", "label");
  if (name !== undefined && name.length > 4096) return undefined;
  return { runtimeId, role, ...(name ? { name } : {}), bounds };
}

function parsePointerSurface(raw: Record<string, any> | undefined, target: WindowsWindowTarget): WindowsPointerSurface | undefined {
  if (raw?.ok !== true || positiveInteger(raw.pid) !== target.pid || parseHandle(raw.window_id ?? raw.windowId ?? raw.hwnd) !== target.hwnd) return undefined;
  if (raw.kind !== "text" && raw.kind !== "grid") return undefined;
  const primary = parsePointerSurfaceIdentity(raw.primary ?? raw);
  if (!primary) return undefined;
  const leaf = raw.leaf === undefined ? undefined : parsePointerSurfaceIdentity(raw.leaf);
  const container = raw.container === undefined ? undefined : parsePointerSurfaceIdentity(raw.container);
  if ((raw.leaf !== undefined && !leaf) || (raw.container !== undefined && !container)) return undefined;
  return { kind: raw.kind, ...primary, ...(leaf ? { leaf } : {}), ...(container ? { container } : {}) };
}

function validGridItemQuery(query: WindowsGridItemQuery): boolean {
  const item = query?.selectedItem;
  const rect = item?.bounds;
  return Number.isFinite(query?.point?.x) && Number.isFinite(query?.point?.y)
    && typeof item?.role === "string" && item.role.length > 0 && item.role.length <= 256
    && isGridItemRole(item.role)
    && (item.name === undefined || (typeof item.name === "string" && item.name.length <= 4096))
    && (item.runtimeId === undefined || (typeof item.runtimeId === "string" && item.runtimeId.length > 0 && item.runtimeId.length <= 1024))
    && rect !== undefined && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0 && contains(rect, query.point);
}

function validGridItemAnchor(anchor: WindowsGridItemAnchor): boolean {
  return typeof anchor?.selectedItem?.runtimeId === "string" && anchor.selectedItem.runtimeId.length > 0
    && isGridItemRole(anchor.selectedItem.role)
    && isValidRect(anchor.selectedItem.bounds)
    && typeof anchor.gridRuntimeId === "string" && anchor.gridRuntimeId.length > 0 && anchor.gridRuntimeId.length <= 1024
    && Array.isArray(anchor.gridPath) && anchor.gridPath.length >= 2 && anchor.gridPath.length <= 32
    && anchor.gridPath.every(identity => typeof identity === "string" && identity.length > 0 && identity.length <= 1024)
    && anchor.gridPath.at(-1) === anchor.gridRuntimeId
    && Number.isSafeInteger(anchor.row) && anchor.row >= 0
    && Number.isSafeInteger(anchor.column) && anchor.column >= 0;
}

function validGridEditContext(context: WindowsGridEditContext, target: WindowsWindowTarget): boolean {
  const selection = context?.selectedItem;
  const editor = context?.editor;
  const focus = context?.focus;
  return isGridItemRole(selection?.role)
    && typeof selection.runtimeId === "string" && selection.runtimeId.length > 0 && selection.runtimeId.length <= 1024
    && selection.selected === true
    && (selection.name === undefined || (typeof selection.name === "string" && selection.name.length <= 4096))
    && isValidRect(selection.bounds)
    // Excel's active cell surface can be exposed as a native Pane. It is
    // accepted only with exact selected-cell, focus, child-HWND, and hit
    // evidence from the bounded worker operation.
    && typeof editor?.role === "string" && editor.role.length > 0 && editor.role.length <= 256
    && typeof editor.runtimeId === "string" && editor.runtimeId.length > 0 && editor.runtimeId.length <= 1024
    && isValidRect(editor.bounds)
    && typeof editor.hwnd === "bigint" && editor.hwnd > 0n
    && isValidCaret(editor.caret)
    && focusEvidenceMatchesTarget(focus, target)
    && typeof focus.runtimeId === "string" && focus.runtimeId.length > 0 && focus.runtimeId.length <= 1024
    && typeof focus.role === "string" && focus.role.length > 0 && focus.role.length <= 256;
}

function parseGridEditContext(raw: Record<string, any> | undefined, target: WindowsWindowTarget): WindowsGridEditContext | undefined {
  if (raw?.ok !== true || positiveInteger(raw.pid) !== target.pid || parseHandle(raw.window_id ?? raw.windowId ?? raw.hwnd) !== target.hwnd) return undefined;
  const selection = record(raw.selected_item ?? raw.selectedItem);
  const editor = record(raw.editor);
  const focus = record(raw.focus);
  if (!selection || !editor || selection.selected !== true) return undefined;
  const selectionRuntimeId = stringField(selection, "runtime_id", "runtimeId");
  const editorRuntimeId = stringField(editor, "runtime_id", "runtimeId");
  const focusRuntimeId = stringField(focus, "runtime_id", "runtimeId") ?? stringField(raw, "focused_runtime_id", "runtimeId");
  const selectionRole = stringField(selection, "role");
  const editorRole = stringField(editor, "role");
  const focusRole = stringField(focus, "role") ?? stringField(raw, "focused_role", "role");
  const selectionBounds = parseRect(selection?.bounds);
  const editorBounds = parseRect(editor?.bounds);
  const caret = parseCaret(editor?.caret);
  if (!selectionRuntimeId || !editorRuntimeId || !focusRuntimeId || !selectionRole || !editorRole || !focusRole
    || !selectionBounds || !editorBounds || !caret) return undefined;
  const editorHwnd = parseHandle(editor.hwnd ?? editor.window_id ?? editor.windowId);
  const focusPid = positiveInteger(focus?.pid ?? raw.pid);
  const focusHwnd = parseHandle(focus?.window_id ?? focus?.windowId ?? focus?.hwnd ?? raw.window_id ?? raw.windowId ?? raw.hwnd);
  const focused = focus?.focused === true || raw.focused === true;
  if (!focused || !editorHwnd || focusPid !== target.pid || focusHwnd !== target.hwnd) return undefined;
  const focusBounds = parseRect(focus?.bounds ?? raw.focused_bounds);
  const context: WindowsGridEditContext = {
    selectedItem: {
      role: selectionRole,
      runtimeId: selectionRuntimeId,
      selected: true,
      ...(stringField(selection, "name", "label") ? { name: stringField(selection, "name", "label") } : {}),
      bounds: selectionBounds,
    },
    editor: { role: editorRole, runtimeId: editorRuntimeId, bounds: editorBounds, hwnd: editorHwnd, caret },
    focus: {
      target,
      focused: true,
      pid: focusPid,
      hwnd: focusHwnd,
      runtimeId: focusRuntimeId,
      role: focusRole,
      ...(focusBounds ? { bounds: focusBounds } : {}),
    },
  };
  return validGridEditContext(context, target) ? context : undefined;
}

function parseGridItemAnchor(raw: Record<string, any> | undefined, target: WindowsWindowTarget): WindowsGridItemAnchor | undefined {
  if (raw?.ok !== true || positiveInteger(raw.pid) !== target.pid || parseHandle(raw.window_id ?? raw.windowId ?? raw.hwnd) !== target.hwnd) return undefined;
  const item = record(raw.selected_item ?? raw.selectedItem);
  const anchor = record(raw.anchor);
  const runtimeId = stringField(item, "runtime_id", "runtimeId");
  const role = stringField(item, "role");
  const bounds = parseRect(item?.bounds);
  const gridRuntimeId = stringField(anchor, "grid_runtime_id", "gridRuntimeId");
  const rawPath = anchor?.grid_path ?? anchor?.gridPath;
  const gridPath = Array.isArray(rawPath) ? rawPath.filter((value: unknown): value is string => typeof value === "string") : undefined;
  const row = nonNegativeInteger(anchor?.row);
  const column = nonNegativeInteger(anchor?.column);
  if (!runtimeId || !role || !bounds || !gridRuntimeId || !gridPath || row === undefined || column === undefined) return undefined;
  const parsed: WindowsGridItemAnchor = {
    selectedItem: {
      role,
      runtimeId,
      ...(stringField(item, "name", "label") ? { name: stringField(item, "name", "label") } : {}),
      bounds,
    },
    gridRuntimeId,
    gridPath: Object.freeze(gridPath),
    row,
    column,
  };
  return validGridItemAnchor(parsed) ? parsed : undefined;
}

function gridItemRequest(item: WindowsGridItemQuery["selectedItem"]): Record<string, unknown> {
  return {
    role: item.role,
    ...(item.name !== undefined ? { name: item.name } : {}),
    ...(item.runtimeId !== undefined ? { runtime_id: item.runtimeId } : {}),
    bounds: item.bounds,
  };
}

function gridContextRequest(context: WindowsGridEditContext): Record<string, unknown> {
  return {
    selected_item: {
      role: context.selectedItem.role,
      ...(context.selectedItem.name !== undefined ? { name: context.selectedItem.name } : {}),
      runtime_id: context.selectedItem.runtimeId,
      selected: true,
      bounds: context.selectedItem.bounds,
    },
    editor: {
      role: context.editor.role,
      runtime_id: context.editor.runtimeId,
      bounds: context.editor.bounds,
      hwnd: context.editor.hwnd.toString(),
      caret: context.editor.caret,
    },
    focus: {
      focused: true,
      pid: context.focus.pid,
      window_id: context.focus.hwnd?.toString(),
      runtime_id: context.focus.runtimeId,
      role: context.focus.role,
    },
  };
}

function gridAnchorRequest(anchor: WindowsGridItemAnchor): Record<string, unknown> {
  return {
    selected_item: {
      role: anchor.selectedItem.role,
      ...(anchor.selectedItem.name !== undefined ? { name: anchor.selectedItem.name } : {}),
      runtime_id: anchor.selectedItem.runtimeId,
      bounds: anchor.selectedItem.bounds,
    },
    grid_runtime_id: anchor.gridRuntimeId,
    grid_path: anchor.gridPath,
    row: anchor.row,
    column: anchor.column,
  };
}

function isGridItemRole(role: string | undefined): boolean {
  return typeof role === "string" && /^(?:dataitem|cell|gridcell)$/iu.test(role.replace(/[ _-]/gu, ""));
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function nativeGridDelivery(raw: Record<string, any> | undefined): WindowsTransportDelivery {
  if (!raw) return { status: "unknown", code: "native_grid_commit_reply_invalid" };
  if (raw.status === "dispatched" || raw.status === "refused" || raw.status === "partial" || raw.status === "unknown") {
    return { status: raw.status, ...(typeof raw.code === "string" && /^[a-z][a-z0-9_:-]{1,63}$/iu.test(raw.code) ? { code: raw.code } : {}) };
  }
  // A bare worker error may occur after SendInput queued the key. Only an
  // explicit status can prove that delivery did not occur.
  if (raw.ok === false) return { status: "unknown", code: typeof raw.code === "string" ? raw.code : "native_grid_commit_unknown" };
  return { status: "unknown", code: "native_grid_commit_reply_invalid" };
}

function isValidRect(rect: Rect | undefined): rect is Rect {
  return rect !== undefined && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0;
}

function parseCaret(value: unknown): WindowsGridEditContext["editor"]["caret"] | undefined {
  const item = record(value);
  if (!item) return undefined;
  const x = finiteNumber(item.x);
  const y = finiteNumber(item.y);
  const width = finiteNumber(item.width);
  const height = finiteNumber(item.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined
    || width < 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function isValidCaret(caret: WindowsGridEditContext["editor"]["caret"]): boolean {
  return caret !== undefined && [caret.x, caret.y, caret.width, caret.height].every(Number.isFinite)
    && caret.width >= 0 && caret.height > 0;
}

function stringField(value: Record<string, any> | undefined, ...keys: string[]): string | undefined {
  if (!value) return undefined;
  for (const key of keys) if (typeof value[key] === "string" && value[key].length > 0) return value[key];
  return undefined;
}

function parseHandle(value: unknown): bigint | undefined {
  if (typeof value === "bigint" && value > 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    try { const parsed = BigInt(value); return parsed > 0n ? parsed : undefined; } catch { return undefined; }
  }
  return undefined;
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

function readClientRect(api: User32Api, hwnd: bigint): Rect | undefined {
  const client = readRect(api.getClientRect, hwnd);
  const origin = Buffer.alloc(8);
  if (!client || Number(api.clientToScreen(hwnd, origin)) === 0) return undefined;
  return { ...client, x: origin.readInt32LE(0), y: origin.readInt32LE(4) };
}

/**
 * Run synchronous user32 geometry and z-order reads in a per-monitor-aware
 * thread context. The context is restored even when a native call throws;
 * failure to enter or restore it returns no physical evidence rather than
 * mixing virtualized and physical coordinates.
 */
function withPhysicalDpi<T>(api: User32Api, work: () => T): T | undefined {
  let previous: unknown;
  try {
    previous = api.setThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  } catch {
    return undefined;
  }
  if (!validDpiContext(previous)) return undefined;
  let value: T | undefined;
  let failed = false;
  try {
    value = work();
  } catch {
    failed = true;
  }
  let restored = false;
  try {
    restored = validDpiContext(api.setThreadDpiAwarenessContext(previous));
  } catch {
    restored = false;
  }
  return !failed && restored ? value : undefined;
}

function validDpiContext(value: unknown): boolean {
  if (typeof value === "bigint") return value !== 0n;
  return typeof value === "number" && Number.isSafeInteger(value) && value !== 0;
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
