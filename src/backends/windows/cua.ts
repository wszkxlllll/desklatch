import { randomUUID } from "node:crypto";
import type { Point, Rect, Selector, Step } from "../../contracts.js";
import {
  backendError,
  type WindowsCuaDriver,
  type WindowsDesktopImage,
  type WindowsDispatchTarget,
  type WindowsToolResult,
  type WindowsTransport,
  type WindowsTransportDelivery,
  type WindowsWindowElement,
  type WindowsWindowSnapshot,
  type WindowsWindowTarget,
} from "./types.js";

const REQUIRED_DRIVER_VERSION = "0.54.0";

/**
 * Generic-tool transport for CUA 0.54. The import is structural so the
 * backend remains conditionally loadable when the native CUA package is not
 * installed on a non-Windows host.
 */
export class CuaWindowsTransport implements WindowsTransport {
  readonly source = "cua-uia-0.54" as const;
  readonly authorizeForegroundGridEnter?: WindowsTransport["authorizeForegroundGridEnter"];
  readonly #driver: WindowsCuaDriver;
  readonly #session: string;
  #opened = false;
  #closed = false;

  private constructor(driver: WindowsCuaDriver, session: string) {
    this.#driver = driver;
    this.#session = session;
    if (driver.authorizeForegroundGridEnter) {
      this.authorizeForegroundGridEnter = async (target, query, options) => {
        this.assertOpen();
        options.signal?.throwIfAborted();
        try {
          windowAddress(target);
          const context = query.expected;
          if (!Number.isFinite(query.point?.x) || !Number.isFinite(query.point?.y)
            || context.focus.focused !== true || context.focus.pid !== target.pid || context.focus.hwnd !== target.hwnd
            || !context.selectedItem.selected || !context.selectedItem.runtimeId
            || !context.editor.runtimeId || context.editor.runtimeId !== context.focus.runtimeId
            || context.editor.hwnd === target.hwnd) return "grid_commit_proof_invalid";
          return driver.authorizeForegroundGridEnter!(target, query, options);
        } catch {
          return "invalid_window_identity";
        }
      };
    }
  }

  static async open(driver: WindowsCuaDriver, session = "desklatch-windows-" + randomUUID(), signal?: AbortSignal): Promise<CuaWindowsTransport> {
    if (!driver || typeof driver.callTool !== "function") throw backendError("cua_driver_missing");
    signal?.throwIfAborted();
    if (typeof driver.metadata !== "function") throw backendError("cua_driver_version_unknown");
    const metadata = signal === undefined ? await driver.metadata() : await driver.metadata({ signal });
    const driverVersion = stringField(metadata, "driverVersion", "driver_version");
    if (driverVersion !== REQUIRED_DRIVER_VERSION) {
      throw backendError("cua_driver_version", `CUA native driver ${REQUIRED_DRIVER_VERSION} required; received ${driverVersion}`);
    }
    const transport = new CuaWindowsTransport(driver, session);
    try {
      await transport.start(signal);
      return transport;
    } catch (error) {
      await transport.endSession().catch(() => undefined);
      throw error;
    }
  }

  async open(signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw backendError("session_closed");
    if (!this.#opened) await this.start(signal);
  }

  async observeWindow(target: WindowsWindowTarget, options: { readonly signal?: AbortSignal; readonly where?: Selector; readonly includeScreenshot?: boolean }): Promise<WindowsWindowSnapshot> {
    this.assertOpen();
    options.signal?.throwIfAborted();
    const query = cuaQuery(options.where);
    const result = await this.call("get_window_state", {
      pid: target.pid,
      window_id: rawBigInt(target.hwnd),
      session: this.#session,
      ...(query ? { query } : {}),
      include_accessibility_tree: true,
      include_screenshot: options.includeScreenshot === true,
      tree_format: "elements",
      full_output: true,
      max_elements: 512,
      max_depth: 32,
    }, options.signal);
    const raw = structuredRecord(result);
    if (!raw) throw backendError(result.errorCode ?? "window_observation_invalid");
    if (result.isError) throw backendError(result.errorCode ?? stringField(raw, "code") ?? "window_observation_failed");
    const returnedPid = positiveInteger(raw.pid);
    const returnedHwnd = parseBigInt(raw.window_id ?? raw.windowId);
    if (returnedPid !== target.pid || returnedHwnd !== target.hwnd) {
      throw backendError("window_observation_identity_mismatch");
    }
    const elementsRaw = Array.isArray(raw.elements) ? raw.elements : [];
    const elements: WindowsWindowElement[] = [];
    for (const value of elementsRaw) {
      const element = parseElement(value);
      if (element !== undefined) elements.push(element);
    }
    const bounds = parseRect(raw.window_bounds ?? raw.windowBounds ?? raw.bounds);
    const complete = raw.elements_complete === true || raw.elementsComplete === true;
    const degraded = raw.degraded === true || result.degraded === true || raw.truncated === true;
    const screenshotWidth = positiveInteger(raw.screenshot_width ?? raw.screenshotWidth);
    const screenshotHeight = positiveInteger(raw.screenshot_height ?? raw.screenshotHeight);
    const origins: Point[] = [];
    if (screenshotWidth !== undefined && screenshotHeight !== undefined) {
      for (const element of elements) {
        if (!element.rect || !element.screenshotRect || element.rect.width !== element.screenshotRect.width || element.rect.height !== element.screenshotRect.height) continue;
        const origin = { x: element.rect.x - element.screenshotRect.x, y: element.rect.y - element.screenshotRect.y };
        if (!origins.some(candidate => candidate.x === origin.x && candidate.y === origin.y)) origins.push(origin);
      }
    }
    return {
      target,
      ...(stringField(raw, "window_title", "windowTitle", "title") ? { title: stringField(raw, "window_title", "windowTitle", "title") } : {}),
      ...(bounds ? { bounds } : {}),
      elements: Object.freeze(elements),
      complete: complete && !degraded,
      ...(screenshotWidth !== undefined ? { screenshotWidth } : {}),
      ...(screenshotHeight !== undefined ? { screenshotHeight } : {}),
      ...(origins.length === 1 ? { screenshotOrigin: origins[0] } : {}),
      ...(degraded ? { degraded: true } : {}),
      ...(stringField(raw, "snapshot_id", "snapshotId") ? { snapshotId: stringField(raw, "snapshot_id", "snapshotId") } : {}),
    };
  }

  /**
   * Capture pixels for one exact enrolled window without touching the action
   * snapshot. CUA reports UIA frame coordinates in a logical desktop space,
   * while the returned PNG is window-local. Matching `frame` and
   * `screenshot_frame` pairs establish the logical origin; without that proof
   * the image is refused rather than OCRing a DPI-shifted crop.
   */
  async observeWindowImage(target: WindowsWindowTarget, options: { readonly signal?: AbortSignal }): Promise<WindowsDesktopImage | undefined> {
    this.assertOpen();
    options.signal?.throwIfAborted();
    const result = await this.call("get_window_state", {
      pid: target.pid,
      window_id: rawBigInt(target.hwnd),
      session: this.#session,
      include_accessibility_tree: true,
      include_screenshot: true,
      tree_format: "elements",
      full_output: true,
      max_elements: 512,
      max_depth: 32,
    }, options.signal);
    const raw = structuredRecord(result);
    if (!raw) throw backendError(result.errorCode ?? "window_image_invalid");
    if (result.isError) throw backendError(result.errorCode ?? stringField(raw, "code") ?? "window_image_failed");
    if (positiveInteger(raw.pid) !== target.pid || parseBigInt(raw.window_id ?? raw.windowId) !== target.hwnd) {
      throw backendError("window_image_identity_mismatch");
    }
    if (raw.screenshot_frame_valid === false) throw backendError("window_image_frame_invalid");
    const image = result.images?.[0];
    if (!image || typeof image.mimeType !== "string" || typeof image.dataBase64 !== "string" || image.dataBase64.length === 0) return undefined;
    const dimensions = imageDimensions(image.mimeType, image.dataBase64, raw);
    if (dimensions === undefined) throw backendError("window_image_dimensions_unknown");
    const origin = inferScreenshotOrigin(raw, dimensions.width, dimensions.height);
    if (origin === undefined) throw backendError("window_image_origin_unproven");
    return Object.freeze({
      mimeType: image.mimeType,
      dataBase64: image.dataBase64,
      width: dimensions.width,
      height: dimensions.height,
      origin,
    });
  }

  async observeDesktopImage(options: { readonly signal?: AbortSignal }): Promise<WindowsDesktopImage | undefined> {
    this.assertOpen();
    options.signal?.throwIfAborted();
    const result = await this.call("get_desktop_state", { session: this.#session }, options.signal);
    if (result.isError) throw backendError(result.errorCode ?? "desktop_observation_failed");
    const image = result.images?.[0];
    if (!image || typeof image.mimeType !== "string" || typeof image.dataBase64 !== "string" || image.dataBase64.length === 0) return undefined;
    const raw = structuredRecord(result);
    const width = positiveInteger(raw?.width ?? raw?.screenshot_width ?? raw?.screenshotWidth);
    const height = positiveInteger(raw?.height ?? raw?.screenshot_height ?? raw?.screenshotHeight);
    if (width === undefined || height === undefined) return undefined;
    return Object.freeze({ mimeType: image.mimeType, dataBase64: image.dataBase64, width, height });
  }

  async dispatch(step: Step, target: WindowsDispatchTarget, options: { readonly signal?: AbortSignal }): Promise<WindowsTransportDelivery> {
    this.assertOpen();
    options.signal?.throwIfAborted();
    // The delivery hint is intentionally explicit.  A transport caller must
    // never turn `type(delivery:"foreground")` into a background token write
    // merely because a point was not attached by its trusted backend.
    if (step.kind === "type" && step.delivery === "foreground" && (!target.foreground || target.point === undefined)) {
      return { status: "refused", code: "foreground_type_target_unavailable" };
    }
    const args: Record<string, unknown> = {
      session: this.#session,
      target: windowAddress(target.window),
      delivery_mode: target.foreground ? "foreground" : "background",
    };
    // `coordinate:false` marks the private center point used only for a
    // selector/ref physical check. Every other supplied point is a genuine
    // coordinate target and must remain the delivery position, even when a
    // matching UIA token is also present. This keeps the last-mile recipient
    // grounded to the point that was hit-tested.
    const coordinateDispatch = target.point !== undefined && target.coordinate !== false;
    if (coordinateDispatch && !target.foreground
      && (step.kind === "click" || step.kind === "scroll" || step.kind === "type")) {
      return { status: "refused", code: "foreground_input_required" };
    }
    let localPoint = coordinateDispatch && target.point !== undefined
      ? localPointForTarget(target.point, target.windowBounds)
      : undefined;
    if (coordinateDispatch && target.foreground && target.point && (step.kind === "click" || step.kind === "scroll" || step.kind === "type")) {
      if (!target.windowBounds) return { status: "refused", code: "foreground_bounds_unavailable" };
      const capture = await this.foregroundCapture(target.window, target.windowBounds, options.signal);
      options.signal?.throwIfAborted();
      if (capture === null) return { status: "refused", code: "foreground_capture_stale" };
      if (capture === undefined) return { status: "refused", code: "foreground_capture_unavailable" };
      // `type_text`/foreground click coordinates are pixels in the fresh
      // window capture.  The UIA frame and user32 HWND evidence can use
      // different DPI spaces (Excel commonly reports a 1280x745 capture for
      // a 1920x1117 physical window), so map from the exact enrolled physical
      // outer rect to the capture dimensions instead of subtracting the CUA
      // logical screenshot origin directly from a physical desktop point.
      const scaleX = target.windowBounds.width / capture.width;
      const scaleY = target.windowBounds.height / capture.height;
      if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0
        || Math.abs(scaleX - scaleY) > Math.max(0.02, Math.max(scaleX, scaleY) * 0.01)) {
        return { status: "refused", code: "foreground_capture_geometry_unverified" };
      }
      localPoint = {
        x: Math.round((target.point.x - target.windowBounds.x) / scaleX),
        y: Math.round((target.point.y - target.windowBounds.y) / scaleY),
      };
      if (localPoint.x < 0 || localPoint.y < 0 || localPoint.x >= capture.width || localPoint.y >= capture.height) {
        return { status: "refused", code: "point_outside_window_capture" };
      }
      if (target.control?.control.rect) {
        const mappedPhysical = {
          x: target.windowBounds.x + localPoint.x * scaleX,
          y: target.windowBounds.y + localPoint.y * scaleY,
        };
        if (!contains(target.control.control.rect, mappedPhysical)) {
          return { status: "refused", code: "foreground_point_recipient_changed" };
        }
      }
      // Click accepts capture_id so the driver can bind the pixel to this
      // immutable capture. Scroll has no capture_id field in the installed
      // CUA schema; keep its fresh capture private as geometry/occlusion
      // evidence while retaining the exact window-local coordinates.
      if (step.kind === "click") args.capture_id = capture.id;
    }
    switch (step.kind) {
      case "click": {
        if (coordinateDispatch && !target.windowBounds) return { status: "refused", code: "point_geometry_unverified" };
        if (!coordinateDispatch && target.control?.token) args.element_token = target.control.token;
        else if (localPoint) {
          args.x = localPoint.x;
          args.y = localPoint.y;
        } else return { status: "refused", code: "click_target_unavailable" };
        args.button = step.button ?? "left";
        args.count = step.count ?? 1;
        return this.runAction("click", args, target.foreground, options.signal);
      }
      case "type": {
        if (step.text.length === 0 || hasControlCharacters(step.text)) return { status: "refused", code: "invalid_text" };
        if (coordinateDispatch && localPoint) {
          // Foreground point typing is an explicit, host-authorized pixel
          // route. The CUA driver clicks this exact window-local point to
          // establish renderer focus, then types; do not also send a stale
          // UIA token from the pre-click snapshot.
          args.x = localPoint.x;
          args.y = localPoint.y;
        } else if (!coordinateDispatch && target.control?.token) {
          args.element_token = target.control.token;
        } else return { status: "refused", code: "type_target_unavailable" };
        args.text = step.text;
        return this.runAction("type_text", args, target.foreground, options.signal);
      }
      case "setValue": {
        if (!target.control?.token) return { status: "refused", code: "set_value_target_unavailable" };
        if (!isEditableValuePatternRole(target.control.control.role)) return { status: "refused", code: "set_value_pattern_unavailable" };
        if (hasControlCharacters(step.value)) return { status: "refused", code: "invalid_text" };
        // CUA's set_value schema is intentionally narrower than the other
        // action tools: it accepts the token/value/session/delivery fields
        // (and an exact pid), but rejects the generic `target` envelope.
        // Keep the window identity bound by the observed token and pid.
        return this.runAction("set_value", {
          session: this.#session,
          pid: target.window.pid,
          element_token: target.control.token,
          delivery_mode: target.foreground ? "foreground" : "background",
          value: step.value,
        }, target.foreground, options.signal);
      }
      case "scroll": {
        if (coordinateDispatch && !target.windowBounds) return { status: "refused", code: "point_geometry_unverified" };
        if (!coordinateDispatch && target.control?.token) args.element_token = target.control.token;
        else if (localPoint) {
          args.x = localPoint.x;
          args.y = localPoint.y;
        } else return { status: "refused", code: "scroll_target_unavailable" };
        if (!Number.isSafeInteger(step.amount) || step.amount < 1) return { status: "refused", code: "invalid_scroll_amount" };
        args.direction = step.direction;
        args.by = step.by ?? "line";
        args.amount = step.amount;
        return this.runAction("scroll", args, target.foreground, options.signal);
      }
      case "keypress": {
        if (!target.foreground || !validKey(step.key)) return { status: "refused", code: "cua_keyboard_target_unavailable" };
        // CUA receives the exact enrolled window target above. The backend
        // activates and re-verifies that HWND/PID before this call, so the
        // key cannot land in a neighboring process or modal.
        delete args.delivery_mode;
        args.key = nativeKey(step.key);
        return this.runAction("press_key", args, true, options.signal, true);
      }
      case "hotkey": {
        if (!target.foreground || !validHotkey(step.keys)) return { status: "refused", code: "cua_hotkey_target_unavailable" };
        delete args.delivery_mode;
        args.keys = [...step.keys];
        return this.runAction("hotkey", args, true, options.signal, true);
      }
      default:
        return { status: "refused", code: "windows_action_not_supported" };
    }
  }

  /**
   * Late checkpoint seam used by the Windows backend before its host-owned
   * native SendInput chord. Product hosts wrap this method with their live
   * grant and enrolled-window checks; the direct CUA transport already has
   * the immutable exact-window identity supplied by the backend.
   */
  async authorizeForegroundHotkey(target: WindowsWindowTarget, options: { readonly signal?: AbortSignal }): Promise<string | undefined> {
    this.assertOpen();
    options.signal?.throwIfAborted();
    try {
      windowAddress(target);
      return undefined;
    } catch {
      return "invalid_window_identity";
    }
  }

  async bringToFront(target: WindowsWindowTarget, options: { readonly signal?: AbortSignal }): Promise<WindowsTransportDelivery> {
    this.assertOpen();
    options.signal?.throwIfAborted();
    try {
      return this.actionResult(await this.call("bring_to_front", {
      pid: target.pid,
      window_id: rawBigInt(target.hwnd),
      session: this.#session,
      }, options.signal), true, "activation");
    } catch (error) {
      return classifyActionError(error);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.endSession();
  }

  private async start(signal?: AbortSignal): Promise<void> {
    if (this.#opened) return;
    signal?.throwIfAborted();
    if (typeof this.#driver.startSession === "function") {
      const input = await generatedInput("StartSessionInput", { session: this.#session });
      const started = signal === undefined
        ? await this.#driver.startSession(input)
        : await this.#driver.startSession(input, { signal });
      const record = structuredRecord(started);
      if (record && record.active === false) throw backendError("cua_session_inactive");
    } else {
      const result = await this.call("start_session", { session: this.#session }, signal);
      if (result.isError) throw backendError(result.errorCode ?? "cua_session_start_failed");
    }
    this.#opened = true;
  }

  private async endSession(): Promise<void> {
    if (!this.#opened) return;
    this.#opened = false;
    if (typeof this.#driver.endSession === "function") {
      const input = await generatedInput("EndSessionInput", { session: this.#session });
      await this.#driver.endSession(input);
    } else {
      await this.call("end_session", { session: this.#session }).catch(() => undefined);
    }
  }

  private async call(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<WindowsToolResult> {
    signal?.throwIfAborted();
    try {
      return signal === undefined
        ? await this.#driver.callTool(name, stringifyNative(input))
        : await this.#driver.callTool(name, stringifyNative(input), { signal });
    } catch (error) {
      throw backendError(errorCode(error) ?? "cua_transport_failed", error instanceof Error ? error.message : String(error));
    }
  }

  private actionResult(result: WindowsToolResult, foreground: boolean, purpose?: "keyboard" | "activation"): WindowsTransportDelivery {
    const action = actionRecord(result);
    const code = result.errorCode ?? stringField(action, "code", "error_code") ?? stringField(action?.error, "code");
    if (result.isError) {
      const delivered = positiveInteger(action?.delivery?.delivered_count ?? action?.delivery?.deliveredCount) ?? 0;
      return delivered > 0
        ? { status: "unknown", code: code ?? "input_delivery_unknown" }
        : { status: "refused", code: code ?? "driver_refused" };
    }
    const effect = enumName(action?.effect, ["confirmed", "partial", "unverifiable", "suspected_noop", "refused"]);
    const route = enumName(action?.route, ["accessibility", "synthetic_events", "global_input", "system_api", "dom", "trusted_input"]);
    const mode = enumName(action?.delivery?.mode, ["background", "foreground", "not_applicable", "unknown"]);
    if (effect === "partial") return { status: "partial", ...(code ? { code } : {}) };
    if (effect === "refused") return { status: "refused", code: code ?? "driver_refused" };
    if (effect === "suspected_noop") return { status: "unknown", code: code ?? "driver_suspected_noop" };
    // The installed Windows driver reports target-bound keyboard dispatch
    // (notably Ctrl+A in Excel) as effect=unverifiable, route=synthetic_events,
    // delivery.mode=unknown.  This is an acknowledged dispatch with no
    // application-state proof: preserve that distinction for the caller, but
    // never upgrade it to verified and never accept the same mode for pointer
    // or background delivery.
    const targetBoundKeyboardSend = purpose === "keyboard"
      && foreground
      && effect === "unverifiable"
      && route === "synthetic_events"
      && mode === "unknown";
    if (targetBoundKeyboardSend) return { status: "dispatched", code: code ?? "effect_unverifiable" };
    const acceptsMode = (purpose !== undefined && mode === "not_applicable") || (purpose === "keyboard" && mode === "background");
    if (mode !== undefined && mode !== (foreground ? "foreground" : "background") && !acceptsMode) {
      return { status: "unknown", code: code ?? "delivery_mode_mismatch" };
    }
    if (!foreground && route === "global_input") return { status: "unknown", code: code ?? "background_used_global_input" };
    if (purpose === "activation" && route === "global_input") return { status: "unknown", code: "activation_used_global_input" };
    if (effect === "confirmed" || effect === "unverifiable") {
      return { status: "dispatched", ...(code ? { code } : {}) };
    }
    return { status: "unknown", code: code ?? "driver_outcome_unknown" };
  }

  private async runAction(name: string, args: Record<string, unknown>, foreground: boolean, signal?: AbortSignal, allowKeyboardMode = false): Promise<WindowsTransportDelivery> {
    try {
      return this.actionResult(await this.call(name, args, signal), foreground, allowKeyboardMode ? "keyboard" : undefined);
    } catch (error) {
      return classifyActionError(error);
    }
  }

  /**
   * Capture a fresh exact-window screenshot for a foreground coordinate action.
   * The returned id is intentionally kept private and sent only to CUA; it is
   * not part of DeskLatch's model-visible frame. A changed window identity
   * or geometry invalidates the proposed coordinates.
   */
  private async foregroundCapture(target: WindowsWindowTarget, expectedBounds: Rect, signal?: AbortSignal):
    Promise<{ readonly id: string; readonly origin: Point; readonly width: number; readonly height: number } | null | undefined> {
    const result = await this.call("get_window_state", {
      pid: target.pid,
      window_id: rawBigInt(target.hwnd),
      session: this.#session,
      full_output: true,
      include_accessibility_tree: true,
      tree_format: "elements",
      include_screenshot: true,
      max_elements: 256,
      max_depth: 16,
    }, signal).catch(() => undefined);
    if (!result || result.isError || !result.images?.[0]) return undefined;
    const raw = structuredRecord(result);
    if (!raw || positiveInteger(raw.pid) !== target.pid || parseBigInt(raw.window_id ?? raw.windowId) !== target.hwnd) return null;
    // Some CUA builds mark the frame invalid when their reported
    // `window_bounds` omits the native non-client inset. Keep the capture
    // private and require the independent identity, bounded-inset, finite
    // image, and unique frame/screenshot-origin proofs below instead of
    // treating that metadata warning as a coordinate grant.
    const capturedBounds = parseRect(raw.window_bounds ?? raw.windowBounds ?? raw.bounds);
    if (capturedBounds === undefined || !captureBoundsMatch(capturedBounds, expectedBounds)) return null;
    const image = result.images[0];
    const dimensions = imageDimensions(image.mimeType, image.dataBase64, raw);
    const id = stringField(raw, "capture_id", "captureId");
    if (!id || id.length > 256 || !dimensions) return undefined;
    const origin = inferScreenshotOrigin(raw, dimensions.width, dimensions.height);
    if (origin === undefined) return undefined;
    const scaleX = expectedBounds.width / dimensions.width;
    const scaleY = expectedBounds.height / dimensions.height;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0
      || Math.abs(scaleX - scaleY) > Math.max(0.02, Math.max(scaleX, scaleY) * 0.01)
      || Math.abs(origin.x * scaleX - expectedBounds.x) > Math.max(2, scaleX * 1.5)
      || Math.abs(origin.y * scaleY - expectedBounds.y) > Math.max(2, scaleY * 1.5)) return null;
    return { id, origin, ...dimensions };
  }

  private assertOpen(): void {
    if (!this.#opened || this.#closed) throw backendError("session_closed");
  }
}

/**
 * CUA's native query is a bounded, case-insensitive substring filter. Keep
 * selector uniqueness and role checks in DeskLatch; forwarding only the
 * observed name (or role when no name exists) reduces the native walk without
 * turning a fuzzy CUA query into an authorization decision.
 */
function cuaQuery(where?: Selector): string | undefined {
  if (typeof where?.name === "string" && where.name.trim().length > 0) return where.name.trim();
  // Role-only catalogs need the top-level Window row for the target-scoped
  // logical-to-physical geometry proof. CUA's substring projection keeps
  // actionable ancestors but drops non-actionable Window roots, so leave
  // role-only reads unprojected and filter them in DeskLatch.
  return undefined;
}

function parseElement(value: unknown): WindowsWindowElement | undefined {
  const item = record(value);
  if (!item) return undefined;
  const role = stringField(item, "role");
  const index = integerString(item.element_index ?? item.elementIndex);
  const depth = nonNegativeInteger(item.depth);
  if (!role || index === undefined || depth === undefined) return undefined;
  const screenshotFrame = parseRect(item.screenshot_frame ?? item.screenshotFrame);
  const frame = parseRect(item.frame ?? item.bounding_rect ?? item.boundingRect);
  const actions = Array.isArray(item.actions) ? item.actions.filter((action): action is string => typeof action === "string") : [];
  return {
    role,
    index,
    depth,
    ...(stringField(item, "label", "name", "title") ? { label: stringField(item, "label", "name", "title") } : {}),
    ...(stringField(item, "value") !== undefined ? { value: stringField(item, "value") } : {}),
    ...(stringField(item, "value_description", "valueDescription") ? { valueDescription: stringField(item, "value_description", "valueDescription") } : {}),
    ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
    ...(typeof item.editable === "boolean" ? { editable: item.editable } : {}),
    ...(typeof item.selected === "boolean" ? { selected: item.selected } : {}),
    ...(typeof item.focused === "boolean" ? { focused: item.focused } : {}),
    ...(typeof item.is_password === "boolean" ? { password: item.is_password } : typeof item.isPassword === "boolean" ? { password: item.isPassword } : {}),
    ...(typeof item.in_web_content === "boolean" ? { inWebContent: item.in_web_content } : typeof item.inWebContent === "boolean" ? { inWebContent: item.inWebContent } : {}),
    actions: Object.freeze(actions),
    ...(integerString(item.parent_index ?? item.parentIndex) !== undefined ? { parentIndex: integerString(item.parent_index ?? item.parentIndex) } : {}),
    ...(runtimeIdField(item) ? { runtimeId: runtimeIdField(item) } : {}),
    ...(frame ? { rect: frame } : screenshotFrame ? { rect: screenshotFrame, rectIsWindowLocal: true } : {}),
    ...(frame && screenshotFrame ? { screenshotRect: screenshotFrame } : {}),
    ...(stringField(item, "element_token", "elementToken") ? { token: stringField(item, "element_token", "elementToken") } : {}),
  };
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

function inferScreenshotOrigin(raw: Record<string, unknown>, imageWidth: number, imageHeight: number): Point | undefined {
  const elements = Array.isArray(raw.elements) ? raw.elements : [];
  const origins: Point[] = [];
  for (const value of elements) {
    const item = record(value);
    if (!item) continue;
    const frame = parseRect(item.frame ?? item.bounding_rect ?? item.boundingRect);
    const screenshot = parseRect(item.screenshot_frame ?? item.screenshotFrame);
    if (!frame || !screenshot || frame.width !== screenshot.width || frame.height !== screenshot.height) continue;
    if (screenshot.x < 0 || screenshot.y < 0
      || screenshot.x + screenshot.width > imageWidth
      || screenshot.y + screenshot.height > imageHeight) continue;
    const origin = { x: frame.x - screenshot.x, y: frame.y - screenshot.y };
    if (!origins.some(candidate => candidate.x === origin.x && candidate.y === origin.y)) origins.push(origin);
  }
  return origins.length === 1 ? origins[0] : undefined;
}

function imageDimensions(mimeType: string, dataBase64: string, raw: Record<string, unknown>): { readonly width: number; readonly height: number } | undefined {
  const prefix = Buffer.from(dataBase64.replace(/^data:[^;,]+;base64,/iu, "").slice(0, 512), "base64");
  if (mimeType.toLocaleLowerCase() === "image/png" && prefix.length >= 24
    && prefix.readUInt32BE(0) === 0x89504e47 && prefix.readUInt32BE(4) === 0x0d0a1a0a) {
    const width = prefix.readUInt32BE(16);
    const height = prefix.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height };
  }
  if (mimeType.toLocaleLowerCase() === "image/jpeg") {
    const jpeg = jpegDimensions(prefix);
    if (jpeg) return jpeg;
  }
  const width = positiveInteger(raw.width ?? raw.screenshot_width ?? raw.screenshotWidth);
  const height = positiveInteger(raw.height ?? raw.screenshot_height ?? raw.screenshotHeight);
  return width !== undefined && height !== undefined ? { width, height } : undefined;
}

function jpegDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (sof && length >= 7) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (width > 0 && height > 0) return { width, height };
    }
    offset += length;
  }
  return undefined;
}

function sameRect(left: Rect, right: Rect): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

/**
 * CUA may report the client/content bounds inset by a small non-client frame
 * while user32 reports the exact enrolled outer HWND bounds. Accept only a
 * small contained inset with a near-one area/extent ratio; a materially
 * smaller child or contradictory origin remains stale and fails closed.
 */
function captureBoundsMatch(captured: Rect, expected: Rect): boolean {
  if (sameRect(captured, expected)) return true;
  const maxInset = Math.max(16, Math.min(64, Math.ceil(Math.min(expected.width, expected.height) * 0.05)));
  if (!containedRect(expected, captured, 0)) return false;
  const insetLeft = captured.x - expected.x;
  const insetTop = captured.y - expected.y;
  const insetRight = expected.x + expected.width - (captured.x + captured.width);
  const insetBottom = expected.y + expected.height - (captured.y + captured.height);
  if ([insetLeft, insetTop, insetRight, insetBottom].some(value => value < 0 || value > maxInset)) return false;
  const widthRatio = captured.width / expected.width;
  const heightRatio = captured.height / expected.height;
  return widthRatio >= 0.9 && heightRatio >= 0.9
    && Math.abs(widthRatio - heightRatio) <= Math.max(0.02, Math.max(widthRatio, heightRatio) * 0.01);
}

function containedRect(outer: Rect, inner: Rect, tolerance: number): boolean {
  return inner.x >= outer.x - tolerance
    && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance;
}

function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y
    && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}

function localPointForTarget(point: Point, bounds: Rect | undefined): Point | undefined {
  if (bounds) return { x: Math.round(point.x - bounds.x), y: Math.round(point.y - bounds.y) };
  return undefined;
}

function windowAddress(target: WindowsWindowTarget): Record<string, unknown> {
  return { kind: "window", pid: target.pid, window_id: rawBigInt(target.hwnd) };
}

function rawBigInt(value: bigint): unknown {
  const nativeJson = JSON as typeof JSON & { rawJSON?: (value: string) => object };
  return nativeJson.rawJSON ? nativeJson.rawJSON(value.toString()) : value;
}

function stringifyNative(value: unknown): string {
  const marker = `__desklatch_bigint_${randomUUID()}__`;
  const encoded = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `${marker}${item.toString()}` : item);
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return encoded.replace(new RegExp(`"${escapedMarker}(\\d+)"`, "gu"), "$1");
}

async function generatedInput(name: string, fallback: Record<string, unknown>): Promise<unknown> {
  try {
    const module = await dynamicImport("@trycua/cua-driver");
    const factory = module[name] as { new?: (value: Record<string, unknown>) => unknown } | undefined;
    return factory?.new ? factory.new(fallback) : fallback;
  } catch {
    return fallback;
  }
}

const dynamicImport: (specifier: string) => Promise<Record<string, unknown>> = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;

function structuredRecord(result: WindowsToolResult | unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null || typeof result !== "object") return undefined;
  const item = result as Record<string, unknown>;
  const structured = item.structuredJson;
  if (typeof structured === "string") {
    try {
      const parsed = JSON.parse(structured) as unknown;
      if (record(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return record(item.structuredContent) ?? ("pid" in item || "elements" in item ? item : undefined);
}

function actionRecord(result: WindowsToolResult): Record<string, any> | undefined {
  if (record(result.action)) return result.action as Record<string, any>;
  const raw = structuredRecord(result);
  if (!raw) return undefined;
  return record(raw.action) ?? ("effect" in raw || "route" in raw || "delivery" in raw ? raw as Record<string, any> : undefined);
}

function record(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function stringField(value: unknown, ...keys: string[]): string | undefined {
  const item = record(value);
  if (!item) return undefined;
  for (const key of keys) if (typeof item[key] === "string") return item[key] as string;
  return undefined;
}

function runtimeIdField(value: unknown): string | undefined {
  const item = record(value);
  if (!item) return undefined;
  const raw = item.runtime_id ?? item.runtimeId ?? item.runtime_identity ?? item.runtimeIdentity;
  if (typeof raw === "string" && raw.length > 0 && raw.length <= 1024) return raw;
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  if (Array.isArray(raw) && raw.length > 0 && raw.length <= 64 && raw.every(entry => Number.isSafeInteger(entry))) {
    return raw.join(".");
  }
  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : typeof value === "string" && /^\d+$/u.test(value) && Number(value) > 0 && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : typeof value === "string" && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerString(value: unknown): string | undefined {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) return value;
  return undefined;
}

function parseBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    try { return BigInt(value); } catch { return undefined; }
  }
  return undefined;
}

function enumName(value: unknown, names: readonly string[]): string | undefined {
  if (typeof value === "string") return value.toLocaleLowerCase().replace(/[ -]/gu, "_");
  if (typeof value === "number" && Number.isSafeInteger(value)) return names[value];
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const item = error as Record<string, unknown>;
  if (typeof item.code === "string") return item.code;
  if (typeof item.errorCode === "string") return item.errorCode;
  if (typeof item.error_code === "string") return item.error_code;
  const inner = record(item.inner);
  if (typeof inner?.code === "string") return inner.code;
  if (typeof inner?.errorCode === "string") return inner.errorCode;
  return typeof inner?.error_code === "string" ? inner.error_code : undefined;
}

function classifyActionError(error: unknown): WindowsTransportDelivery {
  const code = errorCode(error) ?? "driver_outcome_unknown";
  const preDispatch = new Set([
    "background_unavailable", "background_occluded", "background_uipi_blocked",
    "background_target_unavailable", "window_target_unavailable", "window_not_found",
    "stale_snapshot", "capture_id_expired", "invalid_arguments", "foreground_unavailable",
  ]);
  return { status: preDispatch.has(code) ? "refused" : "unknown", code };
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
}

function validKey(key: string): boolean {
  return /^(?:F12|Enter|Escape|Tab|(?:Arrow)?(?:Up|Down|Left|Right)|Home|End|Page(?:Up|Down))$/iu.test(key);
}

function nativeKey(key: string): string {
  switch (key.toLocaleLowerCase()) {
    case "arrowup": case "up": return "up";
    case "arrowdown": case "down": return "down";
    case "arrowleft": case "left": return "left";
    case "arrowright": case "right": return "right";
    case "pageup": return "pageup";
    case "pagedown": return "pagedown";
    default: return key;
  }
}

function isEditableValuePatternRole(role: string | undefined): boolean {
  return typeof role === "string"
    && /^(?:edit|textbox|textfield|combobox|document|searchbox|spinner)$/iu.test(role.replace(/[ _-]/gu, "").toLocaleLowerCase());
}

function validHotkey(keys: readonly string[]): boolean {
  if (!Array.isArray(keys) || keys.length < 2 || keys.length > 3 || new Set(keys).size !== keys.length) return false;
  const normalized = keys.map(key => key.toLocaleLowerCase());
  return (normalized.length === 2 && normalized[0] === "ctrl" && (normalized[1] === "a" || normalized[1] === "s"))
    || (normalized.length === 3 && normalized[0] === "ctrl" && normalized[1] === "shift" && normalized[2] === "s");
}
