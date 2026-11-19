import { createHash } from "node:crypto";
import { canonicalRole } from "../../grounding.js";
import type {
  ActionKind,
  Capability,
  Control,
  Dispatch,
  Delivery,
  Frame,
  ObserveOptions,
  Point,
  Rect,
  Selector,
  State,
  Step,
  Target,
} from "../../contracts.js";
import { loadWindowsPhysicalInspector } from "./native.js";
import { CuaWindowsTransport } from "./cua.js";
import {
  backendError,
  type WindowsDesktopAuthorization,
  type WindowsDesktopBackend,
  type WindowsDesktopBackendOptions,
  type WindowsDispatchTarget,
  type WindowsPhysicalEvidence,
  type WindowsPhysicalInspector,
  type WindowsResolvedControl,
  type WindowsTransport,
  type WindowsWindowElement,
  type WindowsWindowSnapshot,
  type WindowsWindowTarget,
  type WindowsWindowTargetInput,
} from "./types.js";

/**
 * Open a real Windows full-desktop backend. The host must provide an exact
 * visible HWND/PID allow-list; the model cannot discover or widen that scope.
 * Background UIA delivery is disabled unless authorization.background.source
 * exactly matches this transport's verified source. Foreground point actions
 * additionally require both allowForegroundInput and allowDesktopCapture.
 *
 * `transport` is useful for a native UIA worker and for deterministic tests.
 * When omitted, CUA 0.54 is loaded through the supplied driver and all CUA
 * calls remain lazy/conditional on opening this backend.
 */
export async function openWindowsDesktopBackend(options: WindowsDesktopBackendOptions): Promise<WindowsDesktopBackend> {
  const authorization = normalizeAuthorization(options.authorization);
  if (!options.transport && !options.driver) throw backendError("windows_transport_required");
  if (process.platform !== "win32" && !options.transport) throw backendError("windows_backend_unavailable");
  const transport = options.transport ?? await CuaWindowsTransport.open(options.driver!, options.session);
  const inspector = options.inspector ?? await loadWindowsPhysicalInspector();
  try {
    await transport.open?.();
  } catch (error) {
    await transport.close?.().catch(() => undefined);
    throw error;
  }
  const backend = new WindowsDesktopSession(authorization, transport, inspector);
  return backend;
}

/** Public factory alias matching the other backend modules. */
export const createWindowsDesktopBackend = openWindowsDesktopBackend;

export type {
  WindowsCuaDriver,
  WindowsDesktopAuthorization,
  WindowsDesktopBackend,
  WindowsDesktopBackendOptions,
  WindowsDesktopImage,
  WindowsBackgroundSource,
  WindowsDispatchTarget,
  WindowsPhysicalEvidence,
  WindowsPhysicalInspector,
  WindowsResolvedControl,
  WindowsToolResult,
  WindowsTransport,
  WindowsTransportDelivery,
  WindowsWindowElement,
  WindowsWindowSnapshot,
  WindowsWindowTarget,
  WindowsWindowTargetInput,
} from "./types.js";
export { CuaWindowsTransport } from "./cua.js";
export { loadWindowsPhysicalInspector } from "./native.js";
export { backendError, isWindowsBackendError } from "./types.js";

interface InternalControl extends WindowsResolvedControl {
  readonly key: string;
  readonly windowKey: string;
  readonly windowTitle?: string;
  readonly parentKey?: string;
}

interface InternalFrame {
  readonly frame: Frame;
  readonly controls: ReadonlyMap<string, InternalControl>;
  readonly canvasControls: ReadonlyMap<string, InternalControl>;
  readonly targetByWindowKey: ReadonlyMap<string, WindowsWindowTarget>;
  readonly targetBounds: ReadonlyMap<string, Rect>;
  readonly complete: boolean;
}

interface NormalizedAuthorization extends WindowsDesktopAuthorization {
  readonly targets: readonly WindowsWindowTarget[];
}

class WindowsDesktopSession implements WindowsDesktopBackend {
  readonly capabilities: readonly Capability[];
  readonly hitTestSnapshot = true;
  readonly authorizationScope: string;
  readonly #authorization: NormalizedAuthorization;
  readonly #transport: WindowsTransport;
  readonly #inspector?: WindowsPhysicalInspector;
  readonly #scopePrefix: string;
  #current?: InternalFrame;
  readonly #knownFrames = new WeakMap<Frame, InternalFrame>();
  #closed = false;
  #tail: Promise<void> = Promise.resolve();
  #closing?: Promise<void>;

  constructor(authorization: NormalizedAuthorization, transport: WindowsTransport, inspector?: WindowsPhysicalInspector) {
    this.#authorization = authorization;
    this.#transport = transport;
    this.#inspector = inspector;
    this.#scopePrefix = scopeForAuthorization(authorization);
    this.capabilities = capabilitiesFor(authorization, transport, inspector);
    this.authorizationScope = this.#scopePrefix;
  }

  observe(options: ObserveOptions): Promise<Frame> {
    return this.enqueue(async () => {
      this.assertOpen();
      options.signal?.throwIfAborted();
      const view = options.view;
      if (view !== "controls" && view !== "image" && view !== "both") throw backendError("invalid_view");
      if ((view === "image" || view === "both") && this.#authorization.allowDesktopCapture !== true) {
        throw backendError("desktop_image_not_authorized");
      }
      // The scope is the host authorization plus exact HWND/PID identities. A
      // routine re-observation does not widen or replace that grant, so it
      // must not mint a new scope merely because a snapshot was refreshed.
      const frameScope = this.#scopePrefix;
      const snapshots: Array<{ target: WindowsWindowTarget; snapshot?: WindowsWindowSnapshot; evidence?: WindowsPhysicalEvidence }> = [];
      if (view !== "image") {
        for (const target of this.#authorization.targets) {
          options.signal?.throwIfAborted();
          const evidence = await this.readPhysical(target, undefined, options.signal);
          try {
            const snapshot = await this.#transport.observeWindow(target, { signal: options.signal });
            snapshots.push({ target, snapshot, ...(evidence ? { evidence } : {}) });
          } catch {
            // A window can disappear between the host grant and the read. Keep
            // the frame honest and preserve other authorized windows.
            snapshots.push({ target, ...(evidence ? { evidence } : {}) });
          }
        }
      }
      const built = view === "image" ? emptyFrame() : buildControlsFrame(snapshots, options.where);
      let image = undefined;
      let complete = built.complete;
      if (view === "image" || view === "both") {
        image = await this.#transport.observeDesktopImage?.({ signal: options.signal });
        complete = image !== undefined && (view === "image" || built.complete);
      }
      const frame: Frame = Object.freeze({
        scope: frameScope,
        controls: Object.freeze(built.controls),
        complete,
        ...(image ? { image } : {}),
      });
      const controls = new Map<string, InternalControl>();
      for (const control of built.internal) controls.set(control.control.id, control);
      const canvasControls = makeCanvasControls(frameScope, snapshots, built.targetBounds, this.foregroundPointAllowed());
      const internalFrame: InternalFrame = {
        frame,
        controls,
        canvasControls,
        targetByWindowKey: new Map(snapshots.map(({ target }) => [windowKey(target), target] as const)),
        targetBounds: built.targetBounds,
        complete: built.complete,
      };
      this.#knownFrames.set(frame, internalFrame);
      this.#current = internalFrame;
      return frame;
    });
  }

  hitTest(frame: Frame, point: Point, signal?: AbortSignal): Promise<Control | undefined> {
    return this.enqueue(async () => {
      const snapshot = this.#knownFrames.get(frame);
      if (!snapshot) return undefined;
      signal?.throwIfAborted();
      if (!validPoint(point)) return undefined;
      const hits = [...snapshot.controls.values()].filter(item => item.control.rect !== undefined && contains(item.control.rect, point));
      const actionable = hits.filter(item => item.control.actions.includes("click") || item.control.actions.includes("scroll"));
      if (actionable.length === 1) {
        const physical = await this.readPhysical(actionable[0].window, point, signal);
        if (!usableEvidence(physical, actionable[0].window, point)) return undefined;
        return actionable[0].control;
      }
      if (actionable.length > 1 || !this.foregroundPointAllowed()) return undefined;
      const candidates = [...snapshot.canvasControls.values()].filter(item => item.control.rect !== undefined && contains(item.control.rect, point));
      const owned: InternalControl[] = [];
      for (const candidate of candidates) {
        const physical = await this.readPhysical(candidate.window, point, signal);
        if (usableEvidence(physical, candidate.window, point)) owned.push(candidate);
      }
      return owned.length === 1 ? owned[0].control : undefined;
    });
  }

  dispatch(request: Dispatch): Promise<Delivery> {
    return this.enqueue(async () => {
      this.assertOpen();
      const refuse = (code: string): Delivery => ({ status: "refused", code });
      if (request.signal?.aborted) return refuse("cancelled_before_dispatch");
      let current: InternalFrame;
      try {
        current = this.assertFrame(request.frame);
      } catch (error) {
        return refuse(errorCode(error) ?? "stale_observation");
      }
      if (request.origin && request.origin.scope !== request.frame.scope) return refuse("stale_origin");
      const step = request.step;
      if (step.kind === "drag") return refuse("windows_action_not_supported");
      const targetResult = request.target
        ? resolveDispatchControlTarget(step, request.target, current)
        : resolveStepTarget(step.target, step.kind, current, request.frame);
      if (!targetResult.ok) return refuse(targetResult.code);
      const resolved = targetResult.value;
      const target = resolved.window;
      const point = resolved.point ?? (resolved.control?.control.rect ? center(resolved.control.control.rect) : undefined);
      if (request.origin && "point" in step.target) {
        const origin = this.#knownFrames.get(request.origin);
        if (!origin) return refuse("stale_origin");
        const originControl = origin.controls.get(request.target?.id ?? "") ?? origin.canvasControls.get(request.target?.id ?? "");
        if (originControl && originControl.window.hwnd !== target.hwnd) return refuse("stale_point");
        if (originControl?.source.role !== "Canvas" && originControl?.control.rect && !contains(originControl.control.rect, step.target.point)) return refuse("stale_point");
      }
      let evidence = await this.readPhysical(target, point, request.signal);
      if (!evidence) return refuse("window_evidence_unavailable");
      if (!evidence.visible || evidence.minimized) return refuse(evidence.code ?? "target_unavailable");
      if (point !== undefined && !usableEvidence(evidence, target, point)) return refuse(evidence.occludingHwnd ? "target_occluded" : "point_outside_target");
      if (resolved.control?.source.password) return refuse("sensitive_control_not_writable");
      if (resolved.control && resolved.control.source.role !== "Canvas" && !resolved.control.token && ["click", "type", "setValue", "scroll"].includes(step.kind)) {
        return refuse("control_token_unavailable");
      }
      const pointTarget = "point" in step.target;
      const background = this.backgroundAllowed();
      const foregroundPermission = this.#authorization.allowForegroundInput === true && this.#authorization.allowDesktopCapture === true;
      const coordinateControl = resolved.control?.source.role === "Canvas";
      const foreground = foregroundPermission && (resolved.control === undefined || coordinateControl || !background) &&
        (pointTarget || step.kind === "click" || step.kind === "scroll");
      if (!background && !foreground) {
        return refuse(resolved.control ? "background_delivery_not_authorized" : "foreground_input_not_authorized");
      }
      if (!actionAllowed(step, resolved.control?.control, foreground)) return refuse("windows_action_not_supported");
      if (foreground) {
        if (evidence.foregroundHwnd !== target.hwnd) {
          if (!this.#transport.bringToFront) return refuse("foreground_activation_unavailable");
          const activation = await this.#transport.bringToFront(target, { signal: request.signal }).catch(error => ({ status: "unknown" as const, code: errorCode(error) ?? "foreground_activation_unknown" }));
          if (activation.status !== "dispatched") return activation;
          evidence = await this.readPhysical(target, point, request.signal);
          if (!evidence || evidence.foregroundHwnd !== target.hwnd) return refuse("foreground_not_confirmed");
        }
        if (evidence.foregroundHwnd !== target.hwnd) return refuse("foreground_not_confirmed");
      }
      const dispatchedTarget: WindowsDispatchTarget = {
        window: target,
        ...(resolved.control ? { control: resolved.control } : {}),
        ...(resolved.point ? { point: resolved.point } : point ? { point } : {}),
        ...(current.targetBounds.get(windowKey(target)) ? { windowBounds: current.targetBounds.get(windowKey(target)) } : {}),
        foreground,
      };
      try {
        const result = await this.#transport.dispatch(step, dispatchedTarget, { signal: request.signal });
        return result;
      } catch (error) {
        return { status: "unknown", code: errorCode(error) ?? "windows_dispatch_unknown" };
      }
    });
  }

  close(): Promise<void> {
    this.#closing ??= this.enqueue(async () => {
      this.#closed = true;
      this.#current = undefined;
      try {
        await this.#transport.close?.();
      } finally {
        await this.#inspector?.close?.();
      }
    });
    return this.#closing;
  }

  private async readPhysical(target: WindowsWindowTarget, point?: Point, signal?: AbortSignal): Promise<WindowsPhysicalEvidence | undefined> {
    signal?.throwIfAborted();
    if (this.#inspector) return this.#inspector.read(target, point, signal);
    return undefined;
  }

  private backgroundAllowed(): boolean {
    return this.#authorization.background?.source !== undefined && this.#authorization.background.source === this.#transport.source;
  }

  private foregroundPointAllowed(): boolean {
    return this.#authorization.allowForegroundInput === true && this.#authorization.allowDesktopCapture === true;
  }

  private assertOpen(): void {
    if (this.#closed || this.#closing) throw backendError("session_closed");
  }

  private assertFrame(frame: Frame): InternalFrame {
    const current = this.#current;
    if (!current || current.frame !== frame || current.frame.scope !== frame.scope) throw backendError("stale_observation");
    return current;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

function normalizeAuthorization(input: WindowsDesktopAuthorization): NormalizedAuthorization {
  if (!input || !Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length > 64) throw backendError("invalid_window_scope");
  if (input.background && input.background.source !== "cua-uia-0.54" && input.background.source !== "native-uia-v1") {
    throw backendError("invalid_background_source");
  }
  const seen = new Set<string>();
  const targets: WindowsWindowTarget[] = [];
  for (const item of input.targets) {
    const target = normalizeTarget(item);
    const key = windowKey(target);
    if (seen.has(key)) throw backendError("duplicate_window_scope");
    seen.add(key);
    targets.push(target);
  }
  return Object.freeze({
    targets: Object.freeze(targets),
    ...(input.version ? { version: normalizeText(input.version, 128) } : {}),
    ...(input.allowDesktopCapture === true ? { allowDesktopCapture: true } : {}),
    ...(input.allowForegroundInput === true ? { allowForegroundInput: true } : {}),
    ...(input.background ? { background: { source: input.background.source } } : {}),
  });
}

function capabilitiesFor(authorization: NormalizedAuthorization, transport: WindowsTransport, inspector?: WindowsPhysicalInspector): readonly Capability[] {
  const physicalEvidence = inspector !== undefined;
  const background = physicalEvidence && authorization.background?.source !== undefined && authorization.background.source === transport.source;
  const foreground = physicalEvidence && authorization.allowForegroundInput === true && authorization.allowDesktopCapture === true;
  const targetForms = foreground ? ["selector", "ref", "point"] as const : ["selector", "ref"] as const;
  const capabilities: Capability[] = [];
  if (background || foreground) {
    capabilities.push(Object.freeze({ kind: "click", targets: targetForms, buttons: ["left"] as const, counts: [1] as const }));
    capabilities.push(Object.freeze({ kind: "scroll", targets: targetForms, directions: ["up", "down", "left", "right"] as const, units: ["line", "page"] as const }));
  }
  if (background) capabilities.push(Object.freeze({ kind: "type", targets: ["selector", "ref"] as const }));
  return Object.freeze(capabilities);
}

function normalizeTarget(input: WindowsWindowTargetInput): WindowsWindowTarget {
  if (!input || !Number.isSafeInteger(input.pid) || input.pid <= 0 || input.pid > 0x7fffffff) throw backendError("invalid_window_identity");
  const raw = "hwnd" in input ? input.hwnd : "windowId" in input ? input.windowId : "window_id" in input ? input.window_id : undefined;
  const hwnd = parseHandle(raw);
  if (hwnd === undefined) throw backendError("invalid_window_identity");
  return Object.freeze({ pid: input.pid, hwnd, ...(input.title ? { title: normalizeText(input.title, 256) } : {}) });
}

function parseHandle(value: unknown): bigint | undefined {
  if (typeof value === "bigint" && value > 0n && value <= 0xffffffffffffffffn) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    try {
      const result = BigInt(value);
      return result > 0n && result <= 0xffffffffffffffffn ? result : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

function buildControlsFrame(
  snapshots: ReadonlyArray<{ target: WindowsWindowTarget; snapshot?: WindowsWindowSnapshot; evidence?: WindowsPhysicalEvidence }>,
  where?: Selector,
): { controls: Control[]; internal: InternalControl[]; targetBounds: ReadonlyMap<string, Rect>; complete: boolean } {
  const controls: Control[] = [];
  const internal: InternalControl[] = [];
  const targetBounds = new Map<string, Rect>();
  for (const item of snapshots) {
    const key = windowKey(item.target);
    if (item.snapshot) {
      const bounds = item.snapshot.bounds ?? item.evidence?.bounds;
      if (bounds) targetBounds.set(key, bounds);
    }
  }
  let complete = snapshots.length > 0 && snapshots.every(item => item.snapshot?.complete === true);
  for (const item of snapshots) {
    const snapshot = item.snapshot;
    if (!snapshot) { complete = false; continue; }
    const key = windowKey(item.target);
    const byIndex = new Map(snapshot.elements.map(element => [element.index, element] as const));
    const idByIndex = new Map<string, string>();
    for (const element of snapshot.elements) {
      const path = ancestryPath(element, byIndex);
      const id = `win:${shortHash(`${key}\u0000${path}\u0000${element.role}\u0000${element.label ?? ""}`)}`;
      idByIndex.set(element.index, id);
    }
    for (const element of snapshot.elements) {
      const id = idByIndex.get(element.index);
      if (!id) continue;
      const localRect = element.rect && element.rectIsWindowLocal ? element.rect : undefined;
      const desktopRect = element.rect && element.rectIsWindowLocal && (snapshot.bounds ?? item.evidence?.bounds)
        ? translate(element.rect, snapshot.bounds ?? item.evidence!.bounds!)
        : element.rect;
      const parentId = element.parentIndex ? idByIndex.get(element.parentIndex) : undefined;
      const states = statesFor(element, desktopRect);
      const sensitive = element.password === true;
      const actions: ActionKind[] = sensitive || element.inWebContent === true ? [] : actionKinds(element.actions);
      if (!sensitive && editableRole(element.role) && element.actions.some(action => action.toLocaleLowerCase().replace(/[ -]/gu, "_") === "set_value")) {
        actions.push("type");
      }
      const control: Control = Object.freeze({
        id,
        role: element.role,
        ...(element.label !== undefined && !sensitive ? { name: element.label } : {}),
        within: parentId ?? (snapshot.title ?? item.target.title ?? key),
        states: Object.freeze(states),
        actions: Object.freeze(actions),
        ...(desktopRect ? { rect: desktopRect } : {}),
        ...(!sensitive && element.value !== undefined ? { value: element.value } : {}),
        ...(sensitive ? { sensitive: true } : {}),
        ...(element.valueDescription ? { labels: Object.freeze([element.valueDescription]) } : {}),
        effect: sensitive ? "sensitive" : actions.includes("type") ? "edit" : actions.includes("scroll") ? "read" : actions.length ? "unknown" : "read",
      });
      const internalControl: InternalControl = {
        control,
        key: id,
        windowKey: key,
        windowTitle: snapshot.title ?? item.target.title,
        parentKey: parentId,
        token: element.token,
        window: item.target,
        ...(localRect ? { localRect } : {}),
        source: element,
      };
      if (!where || matchesSelector(control, where, internalControl)) {
        controls.push(control);
        internal.push(internalControl);
      }
    }
  }
  return { controls, internal, targetBounds, complete };
}

function makeCanvasControls(
  scope: string,
  snapshots: ReadonlyArray<{ target: WindowsWindowTarget; snapshot?: WindowsWindowSnapshot }>,
  bounds: ReadonlyMap<string, Rect>,
  enabled: boolean,
): ReadonlyMap<string, InternalControl> {
  if (!enabled) return new Map();
  const controls = new Map<string, InternalControl>();
  for (const item of snapshots) {
    const windowKeyValue = windowKey(item.target);
    const rect = bounds.get(windowKeyValue);
    if (!rect) continue;
    const id = `canvas:${shortHash(`${scope}\u0000${windowKeyValue}`)}`;
    const source: WindowsWindowElement = {
      index: "canvas",
      depth: 0,
      role: "Canvas",
      actions: ["click", "scroll"],
      rect,
    };
    const control: Control = Object.freeze({
      id,
      role: "Canvas",
      within: windowKeyValue,
      states: Object.freeze(["visible", "enabled"] as State[]),
      actions: Object.freeze(["click", "scroll"] as ActionKind[]),
      rect,
      effect: "unknown",
    });
    controls.set(id, {
      control,
      key: id,
      windowKey: windowKeyValue,
      windowTitle: item.snapshot?.title ?? item.target.title,
      window: item.target,
      source,
    });
  }
  return controls;
}

function emptyFrame(): { controls: Control[]; internal: InternalControl[]; targetBounds: ReadonlyMap<string, Rect>; complete: boolean } {
  return { controls: [], internal: [], targetBounds: new Map(), complete: false };
}

function statesFor(element: WindowsWindowElement, rect: Rect | undefined): State[] {
  const states: State[] = [];
  if (rect) states.push("visible");
  if (element.enabled === true) states.push("enabled");
  if (element.editable === true || element.actions.some(action => action === "text" || action === "type" || action === "set_value")) states.push("editable");
  if (element.focused === true) states.push("focused");
  if (element.selected === true) states.push("selected");
  return states;
}

function actionKinds(actions: readonly string[]): ActionKind[] {
  const set = new Set<ActionKind>();
  for (const action of actions) {
    const normalized = action.toLocaleLowerCase().replace(/[ -]/gu, "_");
    if (normalized === "invoke" || normalized === "click" || normalized === "press") set.add("click");
    else if (normalized === "text" || normalized === "type" || normalized === "type_text") set.add("type");
    // CUA exposes the UIA ValuePattern as `set_value`, but 0.54 has no
    // standalone set_value action tool. Treat it as verified editable text
    // only for native edit roles (the caller still chooses `type`).
    else if (normalized === "scroll") set.add("scroll");
  }
  return [...set];
}

function editableRole(role: string): boolean {
  const normalized = normalize(role).replace(/[ _-]/gu, "");
  return normalized === "edit" || normalized === "textbox" || normalized === "textfield" || normalized === "combobox" || normalized === "document";
}

function resolveStepTarget(target: Target, kind: Step["kind"], frame: InternalFrame, requestFrame: Frame):
  | { readonly ok: true; readonly value: { readonly window: WindowsWindowTarget; readonly control?: InternalControl; readonly point?: Point } }
  | { readonly ok: false; readonly code: string } {
  if (!target || typeof target !== "object") return { ok: false, code: "invalid_target" };
  if ("ref" in target) {
    const control = frame.controls.get(target.ref);
    if (!control) return { ok: false, code: "control_ref_expired" };
    return { ok: true, value: { window: control.window, control } };
  }
  if ("focusFromStep" in target) return { ok: false, code: "focus_target_unsupported" };
  if ("point" in target) {
    if (!validPoint(target.point)) return { ok: false, code: "invalid_desktop_point" };
    if (requestFrame.scope !== frame.frame.scope) return { ok: false, code: "stale_observation" };
    const hits = [...frame.controls.values()].filter(item => item.control.rect !== undefined && contains(item.control.rect, target.point));
    const actionable = hits.filter(item => item.token && controlSupportsKind(item.control, kind));
    if (actionable.length === 1) return { ok: true, value: { window: actionable[0].window, control: actionable[0], point: target.point } };
    if (actionable.length > 1) return { ok: false, code: "point_ambiguous" };
    const windows = [...frame.targetByWindowKey.values()].filter(candidate => {
      const bounds = frame.targetBounds.get(windowKey(candidate));
      return bounds !== undefined && contains(bounds, target.point);
    });
    if (windows.length !== 1) return { ok: false, code: windows.length > 1 ? "point_ambiguous" : "point_unverified" };
    return { ok: true, value: { window: windows[0], point: target.point } };
  }
  const selector = target as Selector;
  if (typeof selector.role !== "string" && typeof selector.name !== "string") return { ok: false, code: "invalid_selector" };
  const hits = [...frame.controls.values()].filter(item => matchesSelector(item.control, selector, item));
  if (hits.length === 0) return { ok: false, code: frame.complete ? "control_not_found" : "control_catalog_partial" };
  if (hits.length > 1) return { ok: false, code: "control_ambiguous" };
  return { ok: true, value: { window: hits[0].window, control: hits[0] } };
}

function resolveDispatchControlTarget(step: Step, target: Control, frame: InternalFrame):
  | { readonly ok: true; readonly value: { readonly window: WindowsWindowTarget; readonly control: InternalControl; readonly point?: Point } }
  | { readonly ok: false; readonly code: string } {
  const control = frame.controls.get(target.id) ?? frame.canvasControls.get(target.id);
  if (!control) return { ok: false, code: "control_ref_expired" };
  if (step.kind !== "drag" && "point" in step.target) {
    return { ok: true, value: { window: control.window, control, point: step.target.point } };
  }
  return { ok: true, value: { window: control.window, control } };
}

function matchesSelector(control: Control, selector: Selector, internal: InternalControl): boolean {
  if (selector.role !== undefined && canonicalRole(control.role) !== canonicalRole(selector.role)) return false;
  if (selector.name !== undefined && normalize(control.name) !== normalize(selector.name)) return false;
  if (selector.state !== undefined && !control.states.includes(selector.state)) return false;
  if (selector.within !== undefined) {
    const within = normalize(selector.within);
    if (normalize(control.within) !== within && normalize(internal.windowKey) !== within && normalize(internal.windowTitle) !== within) return false;
  }
  return true;
}

function controlSupportsKind(control: Control, kind: Step["kind"]): boolean {
  if (kind === "click") return control.actions.includes("click");
  if (kind === "type") return control.actions.includes("type");
  if (kind === "setValue") return control.actions.includes("setValue");
  if (kind === "scroll") return control.actions.includes("scroll");
  return false;
}

function actionAllowed(step: Step, control?: Control, foreground = false): boolean {
  if (!control) return foreground && (step.kind === "click" || step.kind === "scroll");
  if (step.kind === "click") return (step.button ?? "left") === "left" && (step.count ?? 1) === 1 && control.actions.includes("click");
  if (step.kind === "type") return control.actions.includes("type") && step.text.length > 0;
  if (step.kind === "setValue") return control.actions.includes("setValue");
  if (step.kind === "scroll") return control.actions.includes("scroll") && Number.isSafeInteger(step.amount) && step.amount > 0;
  return false;
}

function usableEvidence(evidence: WindowsPhysicalEvidence | undefined, target: WindowsWindowTarget, point: Point): boolean {
  if (!evidence || !evidence.visible || evidence.minimized) return false;
  if (evidence.occludingHwnd !== undefined && evidence.occludingHwnd !== target.hwnd) return false;
  if (evidence.bounds && !contains(evidence.bounds, point)) return false;
  return true;
}

function ancestryPath(element: WindowsWindowElement, byIndex: ReadonlyMap<string, WindowsWindowElement>): string {
  const result: string[] = [];
  const seen = new Set<string>();
  let current: WindowsWindowElement | undefined = element;
  while (current && !seen.has(current.index)) {
    seen.add(current.index);
    result.unshift(current.index);
    current = current.parentIndex === undefined ? undefined : byIndex.get(current.parentIndex);
  }
  return result.join("/");
}

function translate(rect: Rect, bounds: Rect): Rect {
  return { x: rect.x + bounds.x, y: rect.y + bounds.y, width: rect.width, height: rect.height };
}

function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}

function center(rect: Rect): Point {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

function validPoint(point: Point): boolean {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

function normalize(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function normalizeText(value: string, max: number): string {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (!normalized || normalized.length > max) throw backendError("invalid_window_scope");
  return normalized;
}

function windowKey(target: WindowsWindowTarget): string {
  return `hwnd:${target.pid}:${target.hwnd.toString()}`;
}

function scopeForAuthorization(authorization: { readonly version?: string; readonly targets: readonly WindowsWindowTarget[]; readonly allowDesktopCapture?: boolean; readonly allowForegroundInput?: boolean; readonly background?: { readonly source: string } }): string {
  const payload = [authorization.version ?? "", authorization.allowDesktopCapture === true ? "image" : "controls", authorization.allowForegroundInput === true ? "foreground" : "background", authorization.background?.source ?? "no-native-background", ...authorization.targets.map(target => `${target.pid}:${target.hwnd.toString()}`)].join("|");
  return `windows:${shortHash(payload)}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const item = error as Record<string, unknown>;
  return typeof item.code === "string" ? item.code : undefined;
}
