import { createHash, randomUUID } from "node:crypto";
import { canonicalRole } from "../../grounding.js";
import { isWindowPointGesture, sameWindowPointBounds } from "../../core/window-point.js";
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
import { loadWindowsOwnedDialogInspector, type WindowsOwnedDialog, type WindowsOwnedDialogInspector } from "./dialogs.js";
import {
  backendError,
  type WindowsDesktopAuthorization,
  type WindowsDesktopBackend,
  type WindowsDesktopBackendOptions,
  type WindowsDispatchTarget,
  type WindowsPhysicalEvidence,
  type WindowsFocusEvidence,
  type WindowsPhysicalInspector,
  type WindowsForegroundActivator,
  type WindowsResolvedControl,
  type WindowsTransport,
  type WindowsGridEditContext,
  type WindowsGridEditQuery,
  type WindowsGridCommitProof,
  type WindowsGridItemAnchor,
  type WindowsGridItemIdentity,
  type WindowsGridItemQuery,
  type WindowsPointerSurface,
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
 * require both allowForegroundInput and allowDesktopCapture; keyboard chords
 * require allowForegroundInput plus fresh native focus/foreground evidence.
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
  const ownedDialogInspector = options.ownedDialogInspector ?? options.dialogInspector ?? await loadWindowsOwnedDialogInspector();
  try {
    await transport.open?.();
  } catch (error) {
    await transport.close?.().catch(() => undefined);
    throw error;
  }
  const backend = new WindowsDesktopSession(authorization, transport, inspector, options.activateForeground, ownedDialogInspector);
  return backend;
}

/** Public factory alias matching the other backend modules. */
export const createWindowsDesktopBackend = openWindowsDesktopBackend;

/**
 * Adapt an exact-window transport and read-only inspector into the reusable
 * host callback accepted by `WindowsDesktopBackendOptions.activateForeground`.
 * The callback activates only the supplied enrolled HWND/PID and reports
 * refusal when the immediate user32 sample does not identify that same pair
 * as foreground. It never discovers a replacement window.
 */
export function createWindowsForegroundActivator(
  transport: Pick<WindowsTransport, "bringToFront">,
  inspector: WindowsPhysicalInspector,
): WindowsForegroundActivator {
  if (typeof transport.bringToFront !== "function" || !inspector || typeof inspector.read !== "function") {
    throw backendError("foreground_activation_unavailable");
  }
  return async (target, options) => {
    const before = await inspector.read(target, undefined, options.signal);
    if (foregroundMatches(before, target)) return { status: "dispatched" };
    const activation = await transport.bringToFront!(target, options);
    if (activation.status === "refused") return activation;
    const evidence = await inspector.read(target, undefined, options.signal);
    if (foregroundMatches(evidence, target)) return { status: "dispatched" };
    return activation.status === "dispatched" ? { status: "refused", code: "foreground_not_confirmed" } : activation;
  };
}

export type {
  WindowsCuaDriver,
  WindowsDesktopAuthorization,
  WindowsDesktopBackend,
  WindowsDesktopBackendOptions,
  WindowsDesktopImage,
  WindowsBackgroundSource,
  WindowsDispatchTarget,
  WindowsPhysicalEvidence,
  WindowsFocusEvidence,
  WindowsGridEditContext,
  WindowsGridEditQuery,
  WindowsGridCommitPolicyEvidence,
  WindowsGridCommitProof,
  WindowsGridItemAnchor,
  WindowsGridItemIdentity,
  WindowsGridItemQuery,
  WindowsPointerSurface,
  WindowsPhysicalInspector,
  WindowsForegroundActivator,
  WindowsResolvedControl,
  WindowsToolResult,
  WindowsTransport,
  WindowsTransportDelivery,
  WindowsWindowElement,
  WindowsWindowSnapshot,
  WindowsWindowTarget,
  WindowsWindowTargetInput,
} from "./types.js";
export type { NativeUiAutomationWorker, NativeUiAutomationWindowsTransportOptions } from "./dialog-transport.js";
export type {
  WindowsOwnedDialog,
  WindowsOwnedDialogInspector,
  WindowsOwnedDialogNativeApi,
} from "./dialogs.js";
export { CuaWindowsTransport } from "./cua.js";
export { NativeUiAutomationWindowsTransport, PowerShellNativeUiAutomationWorker, createNativeUiAutomationWindowsTransport } from "./dialog-transport.js";
export { loadWindowsPhysicalInspector } from "./native.js";
export { createWindowsOwnedDialogInspector, loadWindowsOwnedDialogInspector } from "./dialogs.js";
export { backendError, isWindowsBackendError } from "./types.js";

interface InternalControl extends WindowsResolvedControl {
  readonly key: string;
  readonly windowKey: string;
  readonly windowTitle?: string;
  readonly parentKey?: string;
  /**
   * Native UIA exposes editable document/grid surfaces without an Invoke
   * pattern even though a primary click legitimately focuses/selects them.
   * This is host-private evidence; it is never a substitute for the physical
   * point/owner/cover checks at hit-test and dispatch time.
   */
  readonly pointerFocus?: "document" | "grid";
}

interface PointerFocusSurface {
  readonly kind: "document" | "grid";
}

interface InternalFrame {
  readonly frame: Frame;
  readonly controls: ReadonlyMap<string, InternalControl>;
  readonly canvasControls: ReadonlyMap<string, InternalControl>;
  readonly targetByWindowKey: ReadonlyMap<string, WindowsWindowTarget>;
  readonly targetBounds: ReadonlyMap<string, Rect>;
  readonly complete: boolean;
}

interface GridEditHandoff {
  readonly controlId: string;
  readonly point: Point;
  readonly window: WindowsWindowTarget;
  readonly windowScope: string;
  readonly signal: AbortSignal;
  readonly abortListener: () => void;
  readonly selectedItem: WindowsGridItemIdentity;
  readonly anchor: WindowsGridItemAnchor;
  readonly context: WindowsGridEditContext;
  readonly policyEvidence: WindowsGridCommitProof;
}

interface FocusHandoffCapture {
  readonly focusId: string;
  readonly focusBinding?: string;
  readonly hostEvidence?: WindowsGridCommitProof;
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
  readonly #activateForeground?: WindowsForegroundActivator;
  readonly #ownedDialogInspector?: WindowsOwnedDialogInspector;
  readonly #scopePrefix: string;
  #current?: InternalFrame;
  readonly #knownFrames = new WeakMap<Frame, InternalFrame>();
  readonly #gridEditHandoffs = new Map<string, GridEditHandoff>();
  #closed = false;
  #tail: Promise<void> = Promise.resolve();
  #closing?: Promise<void>;

  constructor(
    authorization: NormalizedAuthorization,
    transport: WindowsTransport,
    inspector?: WindowsPhysicalInspector,
    activateForeground?: WindowsForegroundActivator,
    ownedDialogInspector?: WindowsOwnedDialogInspector,
  ) {
    this.#authorization = authorization;
    this.#transport = transport;
    this.#inspector = inspector;
    this.#activateForeground = activateForeground;
    this.#ownedDialogInspector = ownedDialogInspector;
    this.#scopePrefix = scopeForAuthorization(authorization);
    this.capabilities = capabilitiesFor(authorization, transport, inspector);
    this.authorizationScope = this.#scopePrefix;
  }

  async findOwnedDialogs(
    target: WindowsWindowTarget,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly WindowsOwnedDialog[]> {
    return this.enqueue(async () => {
      this.assertOpen();
      options.signal?.throwIfAborted();
      if (!this.#ownedDialogInspector || !this.#authorization.targets.some(candidate => sameWindow(candidate, target))) return [];
      const dialogs = await this.#ownedDialogInspector.findOwnedDialogs(target, options);
      // Keep the inspector a source of evidence, not an authorization grant:
      // a custom host inspector cannot widen the parent/PID boundary by
      // returning an unrelated HWND.
      return Object.freeze((Array.isArray(dialogs) ? dialogs : []).filter(dialog => isOwnedDialogEvidence(dialog, target)));
    });
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
      const snapshots: Array<{ target: WindowsWindowTarget; snapshot?: WindowsWindowSnapshot; evidence?: WindowsPhysicalEvidence; focus?: WindowsFocusEvidence }> = [];
      // Preserve private hit-test geometry on image-only observations when
      // the host permits points. The model still receives only the screenshot.
      const includeGeometry = view !== "image" || this.foregroundPointAllowed();
      if (includeGeometry) {
        const deadline = AbortSignal.timeout(6_000);
        const scanSignal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
        const within = normalize(options.where?.within);
        const exactWindow = view === "controls" && /^hwnd:\d+:\d+$/u.test(within);
        const targets = exactWindow ? this.#authorization.targets.filter(target => windowKey(target) === within) : this.#authorization.targets;
        const nameQueryAllowed = !!options.where?.role || this.#transport.source === "cua-uia-0.54";
        const query = view === "controls" && nameQueryAllowed && options.where?.name && (!within || exactWindow)
          ? { ...(options.where.role ? { role: options.where.role } : {}), name: options.where.name } : undefined;
        for (const target of targets) {
          options.signal?.throwIfAborted();
          if (deadline.aborted) {
            snapshots.push({ target });
            continue;
          }
          const evidence = await this.readPhysical(target, undefined, scanSignal);
          let focus: WindowsFocusEvidence | undefined;
          if (view !== "image" && this.#authorization.allowForegroundInput === true) {
            try {
              focus = await this.readFocused(target, scanSignal);
            } catch (error) {
              if (options.signal?.aborted) throw error;
              focus = undefined;
            }
          }
          try {
            const snapshot = await this.#transport.observeWindow(target, {
              signal: scanSignal,
              ...(query ? { where: query } : {}),
              ...(this.#transport.source === "cua-uia-0.54" && this.foregroundPointAllowed() ? { includeScreenshot: true } : {}),
            });
            snapshots.push({ target, snapshot, ...(evidence ? { evidence } : {}), ...(focus ? { focus } : {}) });
          } catch {
            // A window can disappear between the host grant and the read. Keep
            // the frame honest and preserve other authorized windows.
            snapshots.push({ target, ...(evidence ? { evidence } : {}), ...(focus ? { focus } : {}) });
          }
        }
        options.signal?.throwIfAborted();
      }
      const built = includeGeometry ? buildControlsFrame(
        snapshots,
        options.where,
        this.#transport.source === "native-uia-v1",
        this.#transport.source === "cua-uia-0.54",
        this.#transport.source === "cua-uia-0.54" && !this.foregroundPointAllowed(),
      ) : emptyFrame();
      const controlsInFrame = await this.removeOwnedDialogCopies(built.internal, options.signal);
      let image = undefined;
      let complete = built.complete;
      let pointWindow = (view !== "controls" || options.where === undefined)
        && this.foregroundPointAllowed() && this.#transport.source === "cua-uia-0.54"
        && this.#inspector?.dispatchWindowPoint
        ? await this.foregroundPointWindow(snapshots, options.signal)
        : undefined;
      if (view === "image" || view === "both") {
        image = await this.#transport.observeDesktopImage?.({ signal: options.signal });
        complete = image !== undefined && (view === "image" || built.complete);
        if (pointWindow) {
          const after = await this.readPhysical(pointWindow.target, undefined, options.signal);
          if (!foregroundPointWindowMatches(after, pointWindow.target, pointWindow.bounds)) pointWindow = undefined;
        }
      }
      const frame: Frame = Object.freeze({
        scope: frameScope,
        controls: Object.freeze(view === "image" ? [] : controlsInFrame.map(item => item.control)),
        complete,
        ...(image ? { image } : {}),
      });
      const controls = new Map<string, InternalControl>();
      for (const control of controlsInFrame) controls.set(control.control.id, control);
      const canvasControls = makeCanvasControls(frameScope, snapshots, built.targetBounds, this.foregroundPointAllowed(), pointWindow);
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

  private async foregroundPointWindow(
    snapshots: readonly { target: WindowsWindowTarget }[],
    signal?: AbortSignal,
  ): Promise<WindowsPhysicalEvidence | undefined> {
    for (const { target } of snapshots) {
      const live = await this.readPhysical(target, undefined, signal);
      if (foregroundPointWindowMatches(live, target, live?.bounds)) return live;
    }
    return undefined;
  }

  private async removeOwnedDialogCopies(controls: readonly InternalControl[], signal?: AbortSignal): Promise<readonly InternalControl[]> {
    const inspector = this.#ownedDialogInspector;
    if (this.#transport.source !== "cua-uia-0.54" || !inspector || this.#authorization.targets.length < 2) return controls;

    const matching = new Map<string, InternalControl[]>();
    for (const item of controls) {
      const { role, name, rect, actions } = item.control;
      if (actions.length === 0) continue;
      // A token is scoped to its CUA snapshot and cannot identify the same
      // native control across the parent and owned-dialog reads. A provider
      // runtime ID can. Keep the geometry path unchanged, and add a separate
      // identity-only group for geometry-less controls only when that native
      // identity is present.
      const runtimeId = item.source.runtimeId;
      if (!rect && (typeof runtimeId !== "string" || runtimeId.length === 0)) continue;
      const key = rect
        ? JSON.stringify(["geometry", item.window.pid, role, name, rect.x, rect.y, rect.width, rect.height, actions])
        : JSON.stringify(["runtime", item.window.pid, role, name, actions, runtimeId]);
      const group = matching.get(key);
      if (group) group.push(item);
      else matching.set(key, [item]);
    }

    const dialogsByOwner = new Map<bigint, readonly WindowsOwnedDialog[]>();
    const duplicates = new Set<string>();
    for (const group of matching.values()) {
      if (new Set(group.map(item => item.window.hwnd)).size < 2) continue;
      const geometryGroup = group[0].control.rect !== undefined;
      if (!geometryGroup) {
        // No physical point is available here. Require a single shared native
        // identity; semantic role/name/action equality alone is insufficient
        // because two independently authored controls may look identical.
        const runtimeIds = new Set(group.map(item => item.source.runtimeId));
        if (runtimeIds.size !== 1 || !group[0].source.runtimeId) continue;
        for (const item of group) {
          let owned = dialogsByOwner.get(item.window.hwnd);
          if (!owned) {
            owned = await inspector.findOwnedDialogs(item.window, { signal, strict: true }).catch(() => []);
            signal?.throwIfAborted();
            dialogsByOwner.set(item.window.hwnd, owned);
          }
          const popup = group.find(other => other !== item
            && owned.some(dialog => dialog.hwnd === other.window.hwnd && isOwnedDialogEvidence(dialog, item.window)));
          if (popup) duplicates.add(item.key);
        }
        continue;
      }
      const point = center(group[0].control.rect!);
      for (const item of group) {
        const evidence = await this.readPhysical(item.window, point, signal);
        if (!evidence?.visible || evidence.occludingHwnd === undefined) continue;
        const popup = group.find(other => other !== item && other.window.hwnd === evidence.occludingHwnd);
        if (!popup) continue;
        let owned = dialogsByOwner.get(item.window.hwnd);
        if (!owned) {
          owned = await inspector.findOwnedDialogs(item.window, { signal }).catch(() => []);
          signal?.throwIfAborted();
          dialogsByOwner.set(item.window.hwnd, owned);
        }
        if (owned.some(dialog => dialog.hwnd === popup.window.hwnd && isOwnedDialogEvidence(dialog, item.window))) {
          duplicates.add(item.key);
        }
      }
    }
    return controls.filter(item => !duplicates.has(item.key));
  }

  hitTest(frame: Frame, point: Point, signal?: AbortSignal, kind?: ActionKind): Promise<Control | undefined> {
    return this.enqueue(async () => {
      const snapshot = this.#knownFrames.get(frame);
      if (!snapshot) return undefined;
      signal?.throwIfAborted();
      if (!validPoint(point)) return undefined;
      const hits = [...snapshot.controls.values()].filter(item => item.control.rect !== undefined
        && validRect(item.control.rect)
        && contains(item.control.rect, point));
      if (kind === "type") {
        if (!snapshot.frame.complete) return undefined;
        const writable = hits.filter(item => item.control.rect !== undefined
          && item.control.states.includes("visible")
          && item.control.states.includes("editable")
          && item.control.actions.includes("type")
          && item.control.sensitive !== true
          && item.source.password !== true
          && item.source.role !== "Canvas"
          && typeof item.token === "string"
          && item.token.length > 0);
        if (writable.length !== 1) return undefined;
        const physical = await this.readPhysical(writable[0].window, point, signal);
        if (!usableEvidence(physical, writable[0].window, point)) return undefined;
        return writable[0].control;
      }
      // A scrollable document/grid ancestor is not a competing click target.
      // Treating `click || scroll` as one set made a legitimate cell/document
      // focus ambiguous whenever its containing viewport also advertised
      // ScrollPattern. For an action-specific hit-test, only the requested
      // action is evidence; the no-kind compatibility call prefers a unique
      // pointer candidate before considering a scroll region.
      const clickHits = hits.filter(item => item.control.actions.includes("click") || item.pointerFocus !== undefined);
      const scrollHits = hits.filter(item => item.control.actions.includes("scroll"));
      const actionable = kind === "click"
        ? clickHits
        : kind === "scroll"
          ? scrollHits
          // The no-kind compatibility call is used by read-only evidence
          // helpers. Prefer a unique pointer target over a containing scroll
          // region; only fall back to scroll when no click candidate exists.
          : clickHits.length > 0 ? clickHits : scrollHits;
      if (actionable.length === 1) {
        const pointerSurface = actionable[0].pointerFocus === undefined
          ? undefined : await this.pointerSurfaceProven(actionable[0], point, signal);
        const physical = await this.readPhysical(actionable[0].window, point, signal);
        if (!usableEvidence(physical, actionable[0].window, point)) return undefined;
        return actionable[0].pointerFocus === undefined
          ? actionable[0].control
          : pointerSurface === undefined
            ? withPointClickFallback(actionable[0].control)
          : withPointInteraction(actionable[0].control, actionable[0].window, point, pointerSurface);
      }
      if (actionable.length > 1 || !this.foregroundPointAllowed()) return undefined;
      if (hits.some(item => item.control.sensitive || item.source.password)) return undefined;
      const candidates = [...snapshot.canvasControls.values()].filter(item => item.control.rect !== undefined && contains(item.control.rect, point));
      const foreground = candidates.find(item => item.control.windowPoint === true);
      if (foreground) {
        const live = await this.readPhysical(foreground.window, point, signal);
        return usableEvidence(live, foreground.window, point) && foregroundPointWindowMatches(live, foreground.window, foreground.control.rect)
          ? foreground.control : undefined;
      }
      const owned: InternalControl[] = [];
      for (const candidate of candidates) {
        const physical = await this.readPhysical(candidate.window, point, signal);
        if (!usableEvidence(physical, candidate.window, point)) continue;
        owned.push(candidate);
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
      if (step.kind === "setValue" && "point" in step.target) return refuse("set_value_point_unsupported");
      const foregroundTypeRequested = isForegroundTypeStep(step);
      const coordinateTarget = "point" in step.target;
      // The explicit selector/ref foreground type lane is implemented by the
      // CUA pixel route.  Native UIA intentionally has no equivalent safe
      // foreground text primitive, so a direct backend caller cannot turn the
      // delivery hint into a silent background write on that transport.
      if (foregroundTypeRequested && this.#transport.source !== "cua-uia-0.54") {
        return refuse("foreground_type_unsupported");
      }
      const targetResult = request.target
        ? resolveDispatchControlTarget(step, request.target, current)
        : resolveStepTarget(step.target, step.kind, current, request.frame);
      if (!targetResult.ok) return refuse(targetResult.code);
      const resolved = targetResult.value;
      const target = resolved.window;
      if (request.target?.windowPoint === true) {
        const before = request.origin && this.#knownFrames.get(request.origin);
        const source = before && before.canvasControls.get(request.target.id)?.control;
        const currentTarget = resolved.control?.control;
        const display = before && before.frame.image;
        const bounds = currentTarget?.rect;
        const inspector = this.#inspector;
        if (!this.foregroundPointAllowed() || !inspector?.dispatchWindowPoint || !isWindowPointGesture(step)) {
          return refuse("window_point_gesture_unavailable");
        }
        if (!display || !bounds || !source?.windowPoint || currentTarget?.windowPoint !== true
          || !sameWindowPointBounds(bounds, source.rect)) return refuse("stale_point");
        const point = step.target.point;
        if (point.x < 0 || point.y < 0 || point.x >= display.width || point.y >= display.height || !contains(bounds, point)) {
          return refuse("point_outside_target");
        }
        const live = await this.readPhysical(target, point, request.signal);
        if (!usableEvidence(live, target, point) || !foregroundPointWindowMatches(live, target, bounds)) {
          return refuse(live?.occludingHwnd ? "target_occluded" : "foreground_not_confirmed");
        }
        const code = await this.#transport.authorizeWindowPoint?.(target, { signal: request.signal })
          .catch(() => "window_scope_unverified");
        if (code) return refuse(code);
        if (request.signal?.aborted) return refuse("cancelled_before_dispatch");
        return inspector.dispatchWindowPoint(target, step, bounds, display, request.signal);
      }
      const gridBinding = request.focusBinding;
      let gridHandoff: GridEditHandoff | undefined;
      if (gridBinding !== undefined) {
        if (step.kind !== "keypress" || step.key !== "Enter" || !("focusFromStep" in step.target)) {
          this.deleteGridEditHandoff(gridBinding);
          return refuse("grid_commit_binding_action_mismatch");
        }
        gridHandoff = this.#gridEditHandoffs.get(gridBinding);
        this.deleteGridEditHandoff(gridBinding);
        if (!gridHandoff || gridHandoff.signal !== request.signal || request.signal?.aborted
          || !resolved.control || gridHandoff.controlId !== resolved.control.control.id
          || gridHandoff.windowScope !== windowKey(target) || !sameWindow(gridHandoff.window, target)) {
          return refuse("grid_commit_proof_expired");
        }
      } else {
        this.clearGridEditHandoffs();
      }
      const focusedTarget = "focusFromStep" in step.target;
      if (step.kind === "type" && !coordinateTarget && resolved.control
        && (focusedTarget || resolved.control.control.states.includes("focused"))
        && isWritableTextControl(resolved.control)
        && this.#authorization.allowForegroundInput === true
        && (!foregroundTypeRequested || this.#authorization.allowDesktopCapture === true)
        && this.#inspector?.dispatchFocusedText && this.#transport.authorizeForegroundText) {
        // Use the actual caret or selection. A center click here would collapse
        // the selection made by the previous action (for example, Ctrl+A).
        const focused = await this.readFocused(target, request.signal);
        if (!focused || !focusMatchesControl(focused, resolved.control)) return refuse("keyboard_focus_not_confirmed");
        const code = await this.#transport.authorizeForegroundText(target, { signal: request.signal })
          .catch(() => "focused_type_authorization_failed");
        if (request.signal?.aborted) return refuse("cancelled_before_dispatch");
        if (code) return refuse(code);
        try {
          return await this.#inspector.dispatchFocusedText(target, step.text, focused, request.signal);
        } catch (error) {
          return { status: "unknown", code: errorCode(error) ?? "native_type_delivery_unknown" };
        }
      }
      if (step.kind === "type" && focusedTarget) return refuse("focused_type_unavailable");
      const point = gridHandoff?.point ?? resolved.point
        ?? (resolved.control?.control.rect ? center(resolved.control.control.rect) : undefined);
      const pointerFocus = resolved.control?.pointerFocus;
      if (pointerFocus !== undefined) {
        const syntheticPointerFocus = !hasNativePointerPattern(resolved.control?.source.actions);
        // These surfaces are a narrowly evidenced pointer-focus lane, not a
        // semantic Invoke target. Keep it to the model's one primary click
        // and require the exact point that was grounded by hitTest; a
        // selector/ref must not turn this evidence into an opaque Invoke.
        if (syntheticPointerFocus && step.kind === "click" && ((step.button ?? "left") !== "left" || (step.count ?? 1) !== 1)) {
          return refuse("pointer_focus_primary_only");
        }
        if (syntheticPointerFocus && step.kind === "click" && !coordinateTarget) return refuse("pointer_focus_requires_point");
      }
      if (foregroundTypeRequested && !("point" in step.target)
        && !foregroundTypeControlReady(resolved.control, current.complete, point)) {
        return refuse("foreground_type_target_unavailable");
      }
      if (request.origin && "point" in step.target) {
        const origin = this.#knownFrames.get(request.origin);
        if (!origin) return refuse("stale_origin");
        const originControl = origin.controls.get(request.target?.id ?? "") ?? origin.canvasControls.get(request.target?.id ?? "");
        if (originControl && originControl.window.hwnd !== target.hwnd) return refuse("stale_point");
        if (originControl?.source.role !== "Canvas" && originControl?.control.rect && !contains(originControl.control.rect, step.target.point)) return refuse("stale_point");
      }
      // CUA can surface an owned top-level child in a parent-root tree while
      // retaining only the parent's dispatch target. A geometry-less control
      // has no physical point to bind back to that exact HWND, so do not send
      // its opaque token through the parent when a verified owned dialog is
      // visible. Controls with physical geometry still use the normal
      // physical-point/occlusion check, and an independently enrolled child
      // target remains dispatchable under its own grant.
      if (this.#transport.source === "cua-uia-0.54" && resolved.control && !resolved.control.control.rect) {
        if (!this.#ownedDialogInspector) return refuse("window_scope_unverified");
        let ownedDialogs: readonly WindowsOwnedDialog[];
        try {
          ownedDialogs = await this.#ownedDialogInspector.findOwnedDialogs(target, { signal: request.signal, strict: true });
        } catch {
          return refuse("window_scope_unverified");
        }
        if (ownedDialogs.length > 0) return refuse("window_scope_unverified");
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
      const keyboardPermission = this.#authorization.allowForegroundInput === true;
      const coordinateControl = resolved.control?.source.role === "Canvas";
      const keyboard = step.kind === "keypress" || step.kind === "hotkey";
      // A point-targeted type is the explicit foreground CUA route: the
      // point must already have resolved to one observed writable control,
      // and the physical HWND/occlusion/capture checks below still apply.
      // Keyboard input is always an explicit foreground escalation. A
      // selector/ref is still required to resolve a native control with a
      // runtime identity; a window caption or blind point can never become
      // focus.
      if (keyboard && (!resolved.control || !resolved.control.source.runtimeId)) {
        return refuse("keyboard_focus_not_confirmed");
      }
      const foreground = (keyboard ? keyboardPermission : foregroundPermission)
        && (resolved.control === undefined || coordinateControl || keyboard || pointTarget
          || (step.kind === "type" && (pointTarget || foregroundTypeRequested)) || !background) &&
        (pointTarget || step.kind === "click" || step.kind === "scroll" || keyboard || foregroundTypeRequested);
      // A model-supplied pixel is an explicit physical input request. It may
      // not downgrade to a background token/event route when the foreground
      // grant is absent; refuse before transport rather than risking a click
      // in a stale or different receiver.
      if (pointTarget && (step.kind === "click" || step.kind === "scroll" || step.kind === "type") && !foreground) {
        return refuse("foreground_input_not_authorized");
      }
      // An explicit foreground hint is never allowed to silently downgrade
      // into the ordinary background token route when either host grant is
      // absent or the fresh recipient is otherwise not foreground-eligible.
      if (foregroundTypeRequested && !foreground) return refuse("foreground_input_not_authorized");
      if (!background && !foreground) {
        return refuse(resolved.control ? "background_delivery_not_authorized" : "foreground_input_not_authorized");
      }
      if (!actionAllowed(step, resolved.control?.control, foreground, resolved.control?.pointerFocus !== undefined)) {
        return refuse("windows_action_not_supported");
      }
      if (foreground) {
        if (gridHandoff && (evidence.foregroundHwnd !== target.hwnd || evidence.foregroundPid !== target.pid)) {
          return refuse("grid_commit_foreground_changed");
        }
        if (!gridHandoff && !foregroundMatches(evidence, target)) {
          // Keep the transport receiver bound: CUA's implementation uses
          // private session state when it calls bring_to_front.
          const activate = this.#activateForeground ?? (this.#transport.bringToFront
            ? (targetWindow: WindowsWindowTarget, activationOptions: { readonly signal?: AbortSignal }) =>
              this.#transport.bringToFront!(targetWindow, activationOptions)
            : undefined);
          if (!activate) return refuse("foreground_activation_unavailable");
          const activation = await activate(target, { signal: request.signal }).catch(error => ({ status: "unknown" as const, code: errorCode(error) ?? "foreground_activation_unknown" }));
          if (activation.status !== "dispatched") return activation;
          evidence = await this.readPhysical(target, point, request.signal);
          if (!foregroundMatches(evidence, target)) return refuse("foreground_not_confirmed");
           if (point !== undefined && !usableEvidence(evidence, target, point)) {
             return refuse(evidence?.occludingHwnd ? "target_occluded" : "point_outside_target");
           }
        }
        if (!foregroundMatches(evidence, target)) return refuse("foreground_not_confirmed");
      }
      // Activation can change the leaf/overlay at the same physical point.
      // Re-read the native surface after the final foreground checkpoint;
      // never rely on the pre-activation hit alone.
      if (pointerFocus !== undefined && coordinateTarget && step.kind === "click") {
        const expectedInteraction = (request.target as Control | undefined)?.pointInteraction;
        if (expectedInteraction !== undefined) {
          // A bounded native hit identifies the physical recipient even when
          // the window's unrelated controls exceeded the enumeration limit.
          const pointerSurface = point === undefined
            ? undefined : await this.pointerSurfaceProven(resolved.control!, point, request.signal);
          if (pointerSurface === undefined) return refuse("pointer_focus_unverified");
          if (point === undefined || expectedInteraction.binding !== pointInteractionBinding(target, point, pointerSurface)) {
            return refuse("pointer_focus_changed");
          }
        }
      }
      let focused: WindowsFocusEvidence | undefined;
      if (keyboard) {
        focused = await this.readFocused(target, request.signal);
        if (!focused || !focusMatchesControl(focused, resolved.control!)) return refuse("keyboard_focus_not_confirmed");
        if (gridHandoff && (focused.runtimeId !== gridHandoff.context.focus.runtimeId
          || focused.pid !== target.pid || focused.hwnd !== target.hwnd)) return refuse("grid_commit_focus_changed");
      }
      // CUA/PostMessage hotkeys do not reliably commit Office documents. When
      // the host supplies both the real native inspector and an explicit late
      // transport authorization hook, use its one-batch foreground route for
      // hotkeys only. Missing opt-in retains the legacy transport path; a
      // present hook's partial/unknown result is authoritative and is never
      // replayed through CUA.
      if (step.kind === "hotkey" && foreground && this.#transport.source === "cua-uia-0.54"
        && this.#transport.authorizeForegroundHotkey && this.#inspector?.dispatchHotkey && focused) {
        let authorizationCode: string | undefined;
        try {
          authorizationCode = await this.#transport.authorizeForegroundHotkey(target, { signal: request.signal });
        } catch (error) {
          return { status: "unknown", code: errorCode(error) ?? "foreground_hotkey_authorization_unknown" };
        }
        if (authorizationCode) return { status: "refused", code: authorizationCode };
        try {
          return await this.#inspector.dispatchHotkey(target, step.keys, focused, request.signal);
        } catch (error) {
          return { status: "unknown", code: errorCode(error) ?? "native_hotkey_delivery_unknown" };
        }
      }
      let gridAnchor: WindowsGridItemAnchor | undefined;
      const gridEnterRequested = request.captureFocusForEnter === true && foreground && foregroundTypeRequested
        && resolved.control !== undefined && isGridItemRole(resolved.control.control.role);
      const inspector = this.#inspector;
      const gridProofAttempted = gridEnterRequested && inspector?.readGridItemAnchor !== undefined
        && inspector.readGridEditContext !== undefined && inspector.dispatchGridEnter !== undefined
        && this.#transport.authorizeForegroundGridEnter !== undefined;
      if (gridProofAttempted && resolved.control && inspector?.readGridItemAnchor) {
        const selectedItem = gridItemIdentity(resolved.control);
        if (point && selectedItem) {
          const query: WindowsGridItemQuery = { point, selectedItem };
          try {
            gridAnchor = await inspector.readGridItemAnchor(target, query, request.signal);
          } catch {
            // The existing type action remains valid when the optional proof
            // is unavailable; the same-batch Enter receives no handoff.
            gridAnchor = undefined;
          }
          if (gridAnchor && !gridAnchorMatchesQuery(gridAnchor, query)) gridAnchor = undefined;
        }
      }
      if (gridHandoff) {
        const inspector = this.#inspector;
        if (step.kind !== "keypress" || step.key !== "Enter"
          || !inspector?.dispatchGridEnter || !inspector.readGridEditContext
          || !this.#transport.authorizeForegroundGridEnter) {
          return refuse("grid_commit_proof_unavailable");
        }
        const gridQuery: WindowsGridEditQuery & { readonly expected: WindowsGridEditContext } = {
          point: gridHandoff.point,
          selectedItem: gridHandoff.selectedItem,
          anchor: gridHandoff.anchor,
          expected: gridHandoff.context,
        };
        let authorizationCode: string | undefined;
        try {
          authorizationCode = await this.#transport.authorizeForegroundGridEnter(target, gridQuery, { signal: request.signal });
        } catch (error) {
          return { status: "unknown", code: errorCode(error) ?? "grid_commit_authorization_unknown" };
        }
        if (authorizationCode) return refuse(authorizationCode);
        const delivery = await inspector.dispatchGridEnter(target, {
          ...gridQuery,
        }, request.signal).catch(error => ({
          status: "unknown" as const,
          code: errorCode(error) ?? "native_grid_commit_unknown",
        }));
        return delivery;
      }
      const dispatchedTarget: WindowsDispatchTarget = {
        window: target,
        ...(resolved.control ? { control: resolved.control } : {}),
        ...(resolved.point ? { point: resolved.point } : point ? { point } : {}),
        // A center point is retained for physical evidence on selector/ref
        // actions, but only an explicit model point is allowed to choose the
        // coordinate delivery route. Foreground selector/ref typing is an
        // explicit exception and uses its fresh center point in CUA.
        coordinate: coordinateTarget || (foregroundTypeRequested && step.kind === "type"),
        ...(current.targetBounds.get(windowKey(target)) ? { windowBounds: current.targetBounds.get(windowKey(target)) } : {}),
        foreground,
      };
      try {
        const result = await this.#transport.dispatch(step, dispatchedTarget, { signal: request.signal });
        const captureFocus = request.captureFocus === true;
        if (result.status === "dispatched" && captureFocus && foreground && step.kind === "type" && resolved.control) {
          let handoff: FocusHandoffCapture | undefined;
          if (gridEnterRequested) {
            if (gridProofAttempted && gridAnchor) {
              handoff = await this.captureFocusHandoff(target, resolved.control, point, request.signal, gridAnchor).catch(() => undefined);
            }
          } else {
            // Non-grid editable focus keeps the existing generic handoff.
            handoff = await this.captureFocusHandoff(target, resolved.control, point, request.signal).catch(() => undefined);
          }
          if (handoff) return { ...result, ...handoff };
          return gridEnterRequested ? { ...result, suppressFocusHandoff: true } : result;
        }
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
      this.clearGridEditHandoffs();
      try {
        await this.#transport.close?.();
      } finally {
        await this.#inspector?.close?.();
      }
    });
    return this.#closing;
  }

  clearExecutionState(signal: AbortSignal): void {
    this.clearGridEditHandoffs(signal);
  }

  private deleteGridEditHandoff(binding: string): void {
    const handoff = this.#gridEditHandoffs.get(binding);
    if (!handoff) return;
    this.#gridEditHandoffs.delete(binding);
    handoff.signal.removeEventListener("abort", handoff.abortListener);
  }

  private clearGridEditHandoffs(signal?: AbortSignal): void {
    for (const [binding, handoff] of this.#gridEditHandoffs) {
      if (signal !== undefined && handoff.signal !== signal) continue;
      this.deleteGridEditHandoff(binding);
    }
  }

  private async readPhysical(target: WindowsWindowTarget, point?: Point, signal?: AbortSignal): Promise<WindowsPhysicalEvidence | undefined> {
    signal?.throwIfAborted();
    if (this.#inspector) return this.#inspector.read(target, point, signal);
    return undefined;
  }

  /**
   * A virtualized grid may omit its DataGrid ancestor from the CUA tree. When
   * the native worker is available, bind the point to a fresh GridItemPattern
   * anchor before allowing a pointer-focus click. Structural grid ancestry is
   * still valid evidence for test/native providers that do not expose the
   * optional worker, while fallback rows without that ancestry fail closed.
   */
  private async pointerSurfaceProven(control: InternalControl, point: Point, signal?: AbortSignal): Promise<WindowsPointerSurface | undefined> {
    if (control.pointerFocus === undefined) return undefined;
    const inspector = this.#inspector;
    if (!inspector?.readPointerSurface) return undefined;
    try {
      const surface = await inspector.readPointerSurface(control.window, point, signal);
      return surface !== undefined && pointerSurfaceMatches(control, point, surface) ? surface : undefined;
    } catch {
      return undefined;
    }
  }

  private async readFocused(target: WindowsWindowTarget, signal?: AbortSignal): Promise<WindowsFocusEvidence | undefined> {
    signal?.throwIfAborted();
    if (!this.#inspector?.readFocused) return undefined;
    return this.#inspector.readFocused(target, signal);
  }

  /**
   * Capture a fresh focus binding only for a host-requested type handoff.
   * The native focus probe is authoritative for PID/HWND/runtime identity;
   * the fresh tree is used only to mint the current public control ID.
   */
  private async captureFocusHandoff(
    target: WindowsWindowTarget,
    acted: WindowsResolvedControl,
    point: Point | undefined,
    signal?: AbortSignal,
    gridAnchor?: WindowsGridItemAnchor,
  ): Promise<FocusHandoffCapture | undefined> {
    if (gridAnchor) return this.captureGridEditHandoff(target, acted, point, gridAnchor, signal);
    if (acted.source.password || acted.control.sensitive || !acted.control.actions.includes("type")
      || !acted.control.states.includes("editable")) return undefined;
    const focus = await this.readFocused(target, signal);
    if (!focus?.focused || focus.pid !== target.pid || focus.hwnd !== target.hwnd
      || typeof focus.runtimeId !== "string" || focus.runtimeId.length === 0
      || typeof focus.role !== "string" || !isEditableValuePatternRole(focus.role)
      || !focus.bounds) return undefined;
    const evidence = await this.readPhysical(target, point, signal);
    if (!evidence?.visible || evidence.minimized
      || !foregroundMatches(evidence, target)
      || (point !== undefined && !usableEvidence(evidence, target, point))) return undefined;
    const source = this.#transport.source;
    let snapshot: WindowsWindowSnapshot;
    try {
      snapshot = await this.#transport.observeWindow(target, {
        signal,
        ...(source === "cua-uia-0.54" && this.foregroundPointAllowed() ? { includeScreenshot: true } : {}),
      });
    } catch {
      return undefined;
    }
    if (snapshot.target.pid !== target.pid || snapshot.target.hwnd !== target.hwnd) return undefined;
    const built = buildControlsFrame(
      [{ target, snapshot, evidence, focus }],
      undefined,
      source === "native-uia-v1",
      source === "cua-uia-0.54",
      source === "cua-uia-0.54" && !this.foregroundPointAllowed(),
      acted,
      point,
    );
    const runtimeChanged = acted.source.runtimeId !== focus.runtimeId;
    const candidate = built.internal.find(item =>
      sameWindow(item.window, target)
      && item.control.sensitive !== true
      && isEditableValuePatternRole(item.control.role)
      && item.control.states.includes("focused")
      && item.source.runtimeId === focus.runtimeId
      && (!runtimeChanged || (point !== undefined && acted.control.rect !== undefined
        && item.control.rect !== undefined
        && contains(acted.control.rect, point)
        && contains(item.control.rect, point)
        && rectsOverlap(item.control.rect, acted.control.rect)))
      && (item.control.actions.includes("keypress") || item.control.actions.includes("hotkey")));
    return candidate ? { focusId: candidate.control.id } : undefined;
  }

  /**
   * A grid cell can leave focus on a worksheet Pane while Excel exposes the
   * active edit surface through its child HWND/caret. Bind this exceptional
   * handoff to a pre-type GridItemPattern identity and a fresh native selected
   * cell + focused-child hit proof. The Pane ref remains keyboard-only and is
   * usable for one same-batch Enter after a final synchronous recheck.
   */
  private async captureGridEditHandoff(
    target: WindowsWindowTarget,
    acted: WindowsResolvedControl,
    point: Point | undefined,
    anchor: WindowsGridItemAnchor,
    signal?: AbortSignal,
  ): Promise<FocusHandoffCapture | undefined> {
    const inspector = this.#inspector;
    const selectedItem = gridItemIdentity(acted);
    if (!signal || signal.aborted || !inspector?.readGridEditContext || !selectedItem || !point || acted.source.password
      || acted.control.sensitive || !acted.control.actions.includes("type") || !acted.control.rect
      || !contains(acted.control.rect, point) || !gridAnchorMatchesQuery(anchor, { point, selectedItem })) return undefined;
    if (!this.#authorization.targets.some(candidate => sameWindow(candidate, target))) return undefined;
    const evidence = await this.readPhysical(target, point, signal);
    if (!evidence?.visible || evidence.minimized || evidence.foregroundHwnd !== target.hwnd
      || evidence.foregroundPid !== target.pid || !usableEvidence(evidence, target, point)) return undefined;
    const context = await inspector.readGridEditContext(target, { point, selectedItem, anchor }, signal).catch(() => undefined);
    signal.throwIfAborted();
    if (!context || !gridEditContextMatchesAnchor(context, target, anchor, point)) return undefined;
    let snapshot: WindowsWindowSnapshot;
    try {
      snapshot = await this.#transport.observeWindow(target, {
        signal,
        ...(this.foregroundPointAllowed() ? { includeScreenshot: true } : {}),
      });
    } catch {
      return undefined;
    }
    signal.throwIfAborted();
    if (snapshot.target.pid !== target.pid || snapshot.target.hwnd !== target.hwnd) return undefined;
    const focus = context.focus;
    const built = buildControlsFrame(
      [{ target, snapshot, evidence, focus }],
      undefined,
      this.#transport.source === "native-uia-v1",
      this.#transport.source === "cua-uia-0.54",
      this.#transport.source === "cua-uia-0.54" && !this.foregroundPointAllowed(),
    );
    const candidate = built.internal.find(item => sameWindow(item.window, target)
      && item.control.sensitive !== true
      && item.control.states.includes("focused")
      && item.source.runtimeId === focus.runtimeId
      && item.control.actions.includes("keypress"));
    if (!candidate) return undefined;
    const frozenSelectedItem = Object.freeze({
      ...selectedItem,
      bounds: Object.freeze({ ...selectedItem.bounds }),
    });
    const frozenAnchor = Object.freeze({
      ...anchor,
      selectedItem: Object.freeze({
        ...anchor.selectedItem,
        bounds: Object.freeze({ ...anchor.selectedItem.bounds }),
      }),
      gridPath: Object.freeze([...anchor.gridPath]),
    });
    const frozenContext = Object.freeze({
      selectedItem: Object.freeze({
        ...context.selectedItem,
        bounds: Object.freeze({ ...context.selectedItem.bounds }),
      }),
      editor: Object.freeze({
        ...context.editor,
        bounds: Object.freeze({ ...context.editor.bounds }),
        caret: Object.freeze({ ...context.editor.caret }),
      }),
      focus: Object.freeze({
        ...context.focus,
        target: Object.freeze({ ...context.focus.target }),
        ...(context.focus.bounds ? { bounds: Object.freeze({ ...context.focus.bounds }) } : {}),
      }),
    });
    const focusBinding = randomUUID();
    const windowScope = windowKey(target);
    const policyEvidence: WindowsGridCommitProof = Object.freeze({
      kind: "windows_grid_commit",
      binding: focusBinding,
      sourceControlId: acted.control.id,
      focusControlId: candidate.control.id,
      windowScope,
      point: Object.freeze({ ...point }),
      selectedItem: frozenAnchor.selectedItem,
      anchor: frozenAnchor,
      context: frozenContext,
    });
    const abortListener = () => this.deleteGridEditHandoff(focusBinding);
    const handoff: GridEditHandoff = {
      controlId: candidate.control.id,
      point: Object.freeze({ ...point }),
      window: target,
      windowScope,
      signal,
      abortListener,
      selectedItem: frozenSelectedItem,
      anchor: frozenAnchor,
      context: frozenContext,
      policyEvidence,
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", abortListener);
      return undefined;
    }
    this.#gridEditHandoffs.set(focusBinding, handoff);
    return { focusId: candidate.control.id, focusBinding, hostEvidence: policyEvidence };
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
  if (transport.source === "native-uia-v1") {
    if (!background) return Object.freeze([]);
    return Object.freeze([
      Object.freeze({ kind: "click", targets: ["selector", "ref"] as const, buttons: ["left"] as const, counts: [1] as const }),
      Object.freeze({ kind: "setValue", targets: ["selector", "ref"] as const }),
    ]);
  }
  const foreground = physicalEvidence && authorization.allowForegroundInput === true && authorization.allowDesktopCapture === true;
  const keyboard = physicalEvidence && authorization.allowForegroundInput === true && inspector?.readFocused !== undefined;
  const focusedType = keyboard && inspector?.dispatchFocusedText !== undefined && transport.authorizeForegroundText !== undefined;
  return windowsCuaCapabilities({ background, foreground, keyboard, focusedType });
}

/** Shared by the on-demand product catalog and the live CUA session. */
export function windowsCuaCapabilities({ background, foreground, keyboard, focusedType = false }: {
  readonly background: boolean;
  readonly foreground: boolean;
  readonly keyboard: boolean;
  readonly focusedType?: boolean;
}): readonly Capability[] {
  const targetForms = foreground ? ["selector", "ref", "point"] as const : ["selector", "ref"] as const;
  const capabilities: Capability[] = [];
  if (background || foreground) {
    capabilities.push(Object.freeze({ kind: "click", targets: targetForms, buttons: ["left"] as const, counts: [1] as const }));
    // Alternate mouse gestures stay foreground-point-only. They retain the
    // same fresh capture, exact-HWND physical occlusion, and policy review
    // path as the ordinary click, but are never offered to background UIA.
    if (foreground) {
      capabilities.push(Object.freeze({ kind: "click", targets: ["point"] as const, buttons: ["left"] as const, counts: [2] as const }));
      capabilities.push(Object.freeze({ kind: "click", targets: ["point"] as const, buttons: ["right"] as const, counts: [1] as const }));
    }
    capabilities.push(Object.freeze({ kind: "scroll", targets: targetForms, directions: ["up", "down", "left", "right"] as const, units: ["line", "page"] as const }));
  }
  if (background || foreground || focusedType) capabilities.push(Object.freeze({
    kind: "type",
    targets: [...(background || foreground ? targetForms : []), ...(focusedType ? ["focus"] as const : [])],
    ...(foreground ? { foreground: true as const } : {}),
  }));
  if (background) capabilities.push(Object.freeze({ kind: "setValue", targets: ["selector", "ref"] as const }));
  if (keyboard) {
    const keyboardTargets = ["selector", "ref", "focus"] as const;
    capabilities.push(Object.freeze({
      kind: "keypress",
      targets: keyboardTargets,
      keys: ["F12", "Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"],
    }));
    capabilities.push(Object.freeze({
      kind: "hotkey",
      targets: keyboardTargets,
      keys: ["ctrl", "shift", "a", "s"],
      chords: [["ctrl", "a"], ["ctrl", "s"], ["ctrl", "shift", "s"]],
    }));
  }
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
  snapshots: ReadonlyArray<{ target: WindowsWindowTarget; snapshot?: WindowsWindowSnapshot; evidence?: WindowsPhysicalEvidence; focus?: WindowsFocusEvidence }>,
  where?: Selector,
  nativeUiAutomation = false,
  normalizeCuaGeometry = false,
  allowBackgroundStructuralVisibility = false,
  focusHandoff?: WindowsResolvedControl,
  focusPoint?: Point,
): { internal: InternalControl[]; targetBounds: ReadonlyMap<string, Rect>; complete: boolean } {
  const internal: InternalControl[] = [];
  const targetBounds = new Map<string, Rect>();
  for (const item of snapshots) {
    const key = windowKey(item.target);
    if (item.snapshot) {
      const geometry = normalizeCuaGeometry ? cuaPhysicalGeometry(item) : undefined;
      const bounds = normalizeCuaGeometry
        ? geometry?.physical ?? item.evidence?.bounds
        : item.snapshot.bounds ?? item.evidence?.bounds;
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
    const snapshotGeometry = normalizeCuaGeometry ? cuaPhysicalGeometry(item) : undefined;
    const joinedFocusIndex = !nativeUiAutomation
      ? joinedFocusElementIndex(item, snapshot, snapshotGeometry)
        ?? focusedEditableHandoffIndex(item, snapshot, snapshotGeometry, focusHandoff, focusPoint)
      : undefined;
    for (const element of snapshot.elements) {
      const id = idByIndex.get(element.index);
      if (!id) continue;
      const geometry = snapshotGeometry;
      const projected = geometry && element.rect ? projectCuaRect(element.rect, element.rectIsWindowLocal === true, geometry) : undefined;
      const localRect = normalizeCuaGeometry
        ? projected?.local
        : projected?.local ?? (element.rect && element.rectIsWindowLocal ? element.rect : undefined);
      const desktopRect = normalizeCuaGeometry
        ? projected?.desktop
        : projected?.desktop ?? (element.rect && element.rectIsWindowLocal && (snapshot.bounds ?? item.evidence?.bounds)
          ? translate(element.rect, snapshot.bounds ?? item.evidence!.bounds!)
          : element.rect);
      const parentId = element.parentIndex ? idByIndex.get(element.parentIndex) : undefined;
      // A controls-only CUA read can contain an exact token and UIA frame but
      // no attested same-capture DPI basis. Keep that frame out of the public
      // rectangle/point surface, while retaining bounded structural visibility
      // for background token actions. The exact enrolled HWND/PID evidence,
      // complete tree, token, and frame are all required; dispatch still runs
      // its existing physical visibility/occlusion and scope checks.
      const backgroundVisible = allowBackgroundStructuralVisibility
        && normalizeCuaGeometry
        && projected === undefined
        && snapshot.complete === true
        && item.evidence?.visible === true
        && item.evidence.minimized === false
        && item.evidence.bounds !== undefined
        && element.rect !== undefined
        && typeof element.token === "string"
        && element.token.length > 0;
      const states = statesFor(element, desktopRect, backgroundVisible);
      const sensitive = element.password === true;
      const actions: ActionKind[] = sensitive || element.inWebContent === true ? [] : actionKinds(element.actions, nativeUiAutomation, element.role);
      const pointerFocus = !sensitive && !nativeUiAutomation && normalizeCuaGeometry
        ? pointerFocusSurface(element)
        : undefined;
      // Role-gated CUA set_value is exposed only for generic editable
      // ValuePattern/RangeValuePattern controls. Worksheet DataItems can
      // report a non-durable provider echo, so retain their explicit text
      // fallback without advertising setValue for them.
      if (!nativeUiAutomation && !sensitive && !actions.includes("type")
        && element.actions.some(action => action.toLocaleLowerCase().replace(/[ -]/gu, "_") === "set_value")) {
        actions.push("type");
      }
      const joinedFocus = !nativeUiAutomation && joinedFocusIndex === element.index
        && item.focus?.runtimeId !== undefined;
      // Keyboard commands are meaningful only when UIA identified the
      // focused element. They are foreground-only at dispatch time; this
      // evidence does not grant focus or turn a select-only control into a
      // coordinate action.
      const nativeFocused = !nativeUiAutomation && !sensitive && item.focus?.focused === true
        && item.focus.runtimeId !== undefined
        && (item.focus.runtimeId === element.runtimeId || joinedFocus);
      if (nativeFocused && !states.includes("focused")) states.push("focused");
      if (!nativeFocused) {
        // A provider may advertise a generic keyboard action on every node;
        // keep it out of the model surface unless native UIA focus was
        // observed on this exact runtime identity.
        const keypressIndex = actions.indexOf("keypress");
        if (keypressIndex >= 0) actions.splice(keypressIndex, 1);
        const hotkeyIndex = actions.indexOf("hotkey");
        if (hotkeyIndex >= 0) actions.splice(hotkeyIndex, 1);
      }
      if (nativeFocused) {
        if (!actions.includes("keypress")) actions.push("keypress");
        if (!actions.includes("hotkey")) actions.push("hotkey");
      }
      const control: Control = Object.freeze({
        id,
        role: element.role,
        ...(element.label !== undefined && !sensitive ? { name: element.label } : {}),
        within: parentId ?? (snapshot.title ?? item.target.title ?? key),
        windowScope: key,
        states: Object.freeze(states),
        actions: Object.freeze(actions),
        ...(desktopRect ? { rect: desktopRect } : {}),
        ...(!sensitive && element.value !== undefined ? { value: element.value } : {}),
        ...(sensitive ? { sensitive: true } : {}),
        ...(element.valueDescription ? { labels: Object.freeze([element.valueDescription]) } : {}),
        ...(!sensitive && element.approvalContext ? { approvalContext: element.approvalContext } : {}),
        effect: sensitive ? "sensitive" : actions.includes("click") ? "unknown"
          : actions.includes("type") || actions.includes("setValue") ? "edit" : actions.includes("scroll") || !actions.length ? "read" : "unknown",
      });
      const source = joinedFocus
        ? Object.freeze({ ...element, runtimeId: item.focus!.runtimeId })
        : element;
      const internalControl: InternalControl = {
        control,
        key: id,
        windowKey: key,
        windowTitle: snapshot.title ?? item.target.title,
        parentKey: parentId,
        token: element.token,
        window: item.target,
        ...(localRect ? { localRect } : {}),
        source,
        ...(pointerFocus !== undefined && desktopRect && element.token ? { pointerFocus: pointerFocus.kind } : {}),
      };
      if (!where || matchesSelector(control, where, internalControl)) internal.push(internalControl);
    }
    const focus = item.focus;
    const hasExactFocusElement = !nativeUiAutomation && typeof focus?.runtimeId === "string"
      && snapshot.elements.some(element => element.runtimeId === focus.runtimeId);
    if (!nativeUiAutomation && !hasExactFocusElement && joinedFocusIndex === undefined
      && focus?.focused === true && typeof focus.runtimeId === "string" && focus.runtimeId.length > 0
      && typeof focus.role === "string" && focus.pid === item.target.pid && focus.hwnd === item.target.hwnd) {
      // Some CUA trees omit the focused native row entirely (Excel's edit
      // overlay is one example). Expose a ref backed solely by the live native
      // focus identity. It deliberately has no rectangle or writable action.
      const focusId = `win:${shortHash(`${key}\u0000native-focus\u0000${focus.runtimeId}`)}`;
      const focusControl: Control = Object.freeze({
        id: focusId,
        role: focus.role,
        within: key,
        windowScope: key,
        states: Object.freeze(["focused"] as State[]),
        actions: Object.freeze(["keypress", "hotkey"] as ActionKind[]),
        effect: "unknown",
      });
      const focusSource: WindowsWindowElement = Object.freeze({
        index: "native-focus",
        depth: 0,
        role: focus.role,
        focused: true,
        runtimeId: focus.runtimeId,
        actions: Object.freeze(["keypress", "hotkey"]),
      });
      const focusInternal: InternalControl = {
        control: focusControl,
        key: focusId,
        windowKey: key,
        windowTitle: snapshot.title ?? item.target.title,
        window: item.target,
        source: focusSource,
      };
      if (!where || matchesSelector(focusControl, where, focusInternal)) internal.push(focusInternal);
    }
  }
  return { internal, targetBounds, complete };
}

function makeCanvasControls(
  scope: string,
  snapshots: ReadonlyArray<{ target: WindowsWindowTarget; snapshot?: WindowsWindowSnapshot; evidence?: WindowsPhysicalEvidence }>,
  bounds: ReadonlyMap<string, Rect>,
  enabled: boolean,
  foreground?: WindowsPhysicalEvidence,
): ReadonlyMap<string, InternalControl> {
  if (!enabled) return new Map();
  const controls = new Map<string, InternalControl>();
  for (const item of snapshots) {
    const windowKeyValue = windowKey(item.target);
    const candidate = foreground && sameWindow(foreground.target, item.target) ? foreground : undefined;
    const rect = candidate?.bounds ?? item.evidence?.bounds ?? bounds.get(windowKeyValue);
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
      windowScope: windowKeyValue,
      states: Object.freeze(["visible", "enabled"] as State[]),
      actions: Object.freeze(["click", "scroll"] as ActionKind[]),
      rect,
      effect: "unknown",
      ...(candidate ? { windowPoint: true as const } : {}),
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

function emptyFrame(): { internal: InternalControl[]; targetBounds: ReadonlyMap<string, Rect>; complete: boolean } {
  return { internal: [], targetBounds: new Map(), complete: false };
}

interface CuaPhysicalGeometry {
  readonly logical: Rect;
  readonly physical: Rect;
  readonly scaleX: number;
  readonly scaleY: number;
}

/**
 * CUA's accessibility frames are device-independent while user32 evidence is
 * physical. Keep the mapping target-scoped: the logical root bounds come from
 * the same CUA snapshot and the physical bounds come from the exact enrolled
 * HWND/PID inspector sample. If either side is unavailable or implausible,
 * leave geometry unprojected so the last-mile physical guard fails closed.
 */
function cuaPhysicalGeometry(
  item: { readonly snapshot?: WindowsWindowSnapshot; readonly evidence?: WindowsPhysicalEvidence },
): CuaPhysicalGeometry | undefined {
  const snapshot = item.snapshot;
  if (!snapshot || snapshot.target.pid !== item.evidence?.target.pid || snapshot.target.hwnd !== item.evidence?.target.hwnd) return undefined;
  // CUA's metadata window_bounds may already be in a different desktop space
  // from the element frames. Prefer one top-level Window row; some providers
  // expose that legitimate root at depth 1 with no parent index. When the
  // actionable tree omits the non-actionable Window row entirely, accept the
  // metadata bounds only if a same-capture frame/screenshot pair proves that
  // its origin is the same logical coordinate space.
  const roots = snapshot.elements.filter(element => (element.depth === 0 || element.parentIndex === undefined)
    && canonicalRole(element.role) === "window" && element.rect && !element.rectIsWindowLocal);
  const physical = item.evidence?.bounds;
  let usedScreenshotBasis = false;
  let logical: Rect | undefined = roots.length === 1 ? roots[0].rect : undefined;
  if (!logical && roots.length === 0 && snapshot.screenshotOrigin && snapshot.screenshotWidth && snapshot.screenshotHeight) {
    logical = { x: snapshot.screenshotOrigin.x, y: snapshot.screenshotOrigin.y, width: snapshot.screenshotWidth, height: snapshot.screenshotHeight };
    // A raw window_bounds inset is acceptable only when it is contained by
    // the same physical HWND evidence; it is never used as the logical basis.
    const rawBounds = snapshot.bounds;
    if (!rawBounds || !physical || !containedRect(physical, rawBounds, 16)) logical = undefined;
    else usedScreenshotBasis = true;
  }
  if (!logical) return undefined;
  if (!logical || !physical || logical.width <= 0 || logical.height <= 0 || physical.width <= 0 || physical.height <= 0) return undefined;
  const scaleX = physical.width / logical.width;
  const scaleY = physical.height / logical.height;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0 || scaleX > 10 || scaleY > 10) return undefined;
  if (Math.abs(scaleX - scaleY) > Math.max(0.02, Math.max(scaleX, scaleY) * 0.01)) return undefined;
  if (usedScreenshotBasis && snapshot.screenshotOrigin
    && (Math.abs(snapshot.screenshotOrigin.x * scaleX - physical.x) > Math.max(2, scaleX * 1.5)
      || Math.abs(snapshot.screenshotOrigin.y * scaleY - physical.y) > Math.max(2, scaleY * 1.5))) return undefined;
  return { logical, physical, scaleX, scaleY };
}

function projectCuaRect(rect: Rect, windowLocal: boolean, geometry: CuaPhysicalGeometry): { readonly desktop: Rect; readonly local?: Rect } {
  const desktop = windowLocal
    ? {
      x: geometry.physical.x + rect.x * geometry.scaleX,
      y: geometry.physical.y + rect.y * geometry.scaleY,
      width: rect.width * geometry.scaleX,
      height: rect.height * geometry.scaleY,
    }
    : {
      x: geometry.physical.x + (rect.x - geometry.logical.x) * geometry.scaleX,
      y: geometry.physical.y + (rect.y - geometry.logical.y) * geometry.scaleY,
      width: rect.width * geometry.scaleX,
      height: rect.height * geometry.scaleY,
    };
  return {
    desktop,
    ...(windowLocal ? { local: { x: desktop.x - geometry.physical.x, y: desktop.y - geometry.physical.y, width: desktop.width, height: desktop.height } } : {}),
  };
}

/**
 * Join a native focused RuntimeId to one CUA element only when the provider
 * omitted that RuntimeId from the accessibility row. The join is private
 * evidence: it requires the exact enrolled PID/HWND, canonical role, fresh
 * physical bounds, and one-and-only-one candidate. It is intentionally not a
 * coordinate or writable-target fallback.
 */
function joinedFocusElementIndex(
  item: { readonly target: WindowsWindowTarget; readonly snapshot?: WindowsWindowSnapshot; readonly evidence?: WindowsPhysicalEvidence; readonly focus?: WindowsFocusEvidence },
  snapshot: WindowsWindowSnapshot,
  geometry: CuaPhysicalGeometry | undefined,
): string | undefined {
  const focus = item.focus;
  if (!focus?.focused || typeof focus.runtimeId !== "string" || focus.runtimeId.length === 0
    || typeof focus.role !== "string" || !focus.bounds
    || focus.pid !== item.target.pid || focus.hwnd !== item.target.hwnd || !geometry) return undefined;
  const runtimeId = focus.runtimeId;
  const role = focus.role;
  const bounds = focus.bounds;
  const mappedGeometry = geometry;
  if (snapshot.elements.some(element => element.runtimeId === runtimeId)) return undefined;
  const candidates = snapshot.elements.filter(element => {
    if (element.runtimeId !== undefined || canonicalRole(element.role) !== canonicalRole(role) || !element.rect) return false;
    const projected = projectCuaRect(element.rect, element.rectIsWindowLocal === true, mappedGeometry);
    return rectsApproximatelyEqual(projected.desktop, bounds);
  });
  return candidates.length === 1 ? candidates[0].index : undefined;
}

/**
 * A point-type action may replace a worksheet DataItem with an editable
 * overlay whose native RuntimeId is new and whose UIA row omits that ID.
 * Bind it only when the native focus role, mapped bounds, and the validated
 * acted-cell point identify exactly one non-sensitive editable row.
 */
function focusedEditableHandoffIndex(
  item: { readonly target: WindowsWindowTarget; readonly snapshot?: WindowsWindowSnapshot; readonly evidence?: WindowsPhysicalEvidence; readonly focus?: WindowsFocusEvidence },
  snapshot: WindowsWindowSnapshot,
  geometry: CuaPhysicalGeometry | undefined,
  acted: WindowsResolvedControl | undefined,
  point: Point | undefined,
): string | undefined {
  const focus = item.focus;
  if (!acted || !point || !geometry || !focus?.focused || typeof focus.runtimeId !== "string"
    || typeof focus.role !== "string" || !isEditableValuePatternRole(focus.role)
    || !focus.bounds || acted.control.sensitive === true || acted.source.password
    || !acted.control.states.includes("editable") || !acted.control.rect
    || !contains(acted.control.rect, point)
    || snapshot.elements.some(element => element.runtimeId === focus.runtimeId)) return undefined;
  const candidates = snapshot.elements.filter(element => {
    if (element.password === true || element.runtimeId !== undefined || !element.rect
      || !isEditableValuePatternRole(element.role)
      || (element.editable !== true && !element.actions.some(action =>
        /^(?:text|type|type_text|set_value)$/iu.test(action.replace(/[ -]/gu, "_"))))) return false;
    const projected = projectCuaRect(element.rect, element.rectIsWindowLocal === true, geometry);
    return rectsApproximatelyEqual(projected.desktop, focus.bounds!)
      && contains(projected.desktop, point)
      && rectsOverlap(projected.desktop, acted.control.rect!);
  });
  return candidates.length === 1 ? candidates[0].index : undefined;
}

function isEditableValuePatternRole(role: string | undefined): boolean {
  return typeof role === "string"
    && /^(?:edit|textbox|textfield|combobox|document|searchbox|spinner)$/iu.test(canonicalRole(role));
}

function rectsApproximatelyEqual(left: Rect, right: Rect, tolerance = 4): boolean {
  return Math.abs(left.x - right.x) <= tolerance
    && Math.abs(left.y - right.y) <= tolerance
    && Math.abs(left.width - right.width) <= tolerance
    && Math.abs(left.height - right.height) <= tolerance;
}

function isGridItemRole(role: string | undefined): boolean {
  return typeof role === "string" && /^(?:dataitem|cell|gridcell)$/iu.test(canonicalRole(role).replace(/[ _-]/gu, ""));
}

function gridItemIdentity(acted: WindowsResolvedControl): WindowsGridItemIdentity | undefined {
  const rect = acted.control.rect;
  if (!rect || !isGridItemRole(acted.control.role) || acted.source.password || acted.control.sensitive) return undefined;
  return {
    role: acted.control.role,
    ...(typeof acted.control.name === "string" ? { name: acted.control.name } : {}),
    ...(typeof acted.source.runtimeId === "string" && acted.source.runtimeId.length > 0 ? { runtimeId: acted.source.runtimeId } : {}),
    bounds: rect,
  };
}

function gridAnchorMatchesQuery(anchor: WindowsGridItemAnchor, query: WindowsGridItemQuery): boolean {
  const expected = query.selectedItem;
  const anchored = anchor.selectedItem;
  return isGridItemRole(anchored.role)
    && canonicalRole(anchored.role) === canonicalRole(expected.role)
    && (expected.name === undefined || normalize(anchored.name ?? "") === normalize(expected.name))
    && (expected.runtimeId === undefined || anchored.runtimeId === expected.runtimeId)
    && rectsApproximatelyEqual(anchored.bounds, expected.bounds, 8)
    && contains(expected.bounds, query.point)
    && anchor.gridPath.at(-1) === anchor.gridRuntimeId
    && anchor.gridPath.length >= 2
    && Number.isSafeInteger(anchor.row) && anchor.row >= 0
    && Number.isSafeInteger(anchor.column) && anchor.column >= 0;
}

function gridEditContextMatchesAnchor(
  context: WindowsGridEditContext,
  target: WindowsWindowTarget,
  anchor: WindowsGridItemAnchor,
  point: Point,
): boolean {
  const caretOrigin = { x: context.editor.caret.x, y: context.editor.caret.y };
  return context.selectedItem.selected === true
    && context.selectedItem.runtimeId === anchor.selectedItem.runtimeId
    && canonicalRole(context.selectedItem.role) === canonicalRole(anchor.selectedItem.role)
    && (anchor.selectedItem.name === undefined || normalize(context.selectedItem.name ?? "") === normalize(anchor.selectedItem.name))
    && rectsApproximatelyEqual(context.selectedItem.bounds, anchor.selectedItem.bounds, 2)
    && context.editor.runtimeId === context.focus.runtimeId
    && context.editor.role === context.focus.role
    && context.editor.hwnd !== target.hwnd
    && rectsApproximatelyEqual(context.editor.bounds, context.selectedItem.bounds, 8)
    && contains(context.selectedItem.bounds, point)
    && contains(context.editor.bounds, point)
    && contains(context.selectedItem.bounds, caretOrigin)
    && contains(context.editor.bounds, caretOrigin)
    && context.focus.focused === true
    && context.focus.pid === target.pid
    && context.focus.hwnd === target.hwnd
    && typeof context.focus.runtimeId === "string"
    && context.focus.runtimeId.length > 0;
}

function rectsOverlap(left: Rect, right: Rect): boolean {
  return left.x < right.x + right.width && right.x < left.x + left.width
    && left.y < right.y + right.height && right.y < left.y + left.height;
}

function containedRect(outer: Rect, inner: Rect, tolerance: number): boolean {
  return inner.x >= outer.x - tolerance
    && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance;
}

function statesFor(element: WindowsWindowElement, rect: Rect | undefined, structurallyVisible = false): State[] {
  const states: State[] = [];
  if (rect || structurallyVisible) states.push("visible");
  if (element.enabled === true) states.push("enabled");
  if (element.editable === true || element.actions.some(action => action === "text" || action === "type" || action === "set_value")) states.push("editable");
  if (element.focused === true) states.push("focused");
  if (element.selected === true) states.push("selected");
  return states;
}

function actionKinds(actions: readonly string[], nativeUiAutomation = false, role?: string): ActionKind[] {
  const set = new Set<ActionKind>();
  for (const action of actions) {
    const normalized = action.toLocaleLowerCase().replace(/[ -]/gu, "_");
    if (normalized === "invoke" || normalized === "click" || normalized === "press") set.add("click");
    else if (normalized === "text" || normalized === "type" || normalized === "type_text") set.add("type");
    // The native UIA backend has a verified ValuePattern route. CUA's
    // set_value endpoint may be present in driver metadata, but worksheet
    // DataItems can report a non-durable/provider echo. Keep that transport
    // endpoint available to its strict low-level regression while exposing
    // only the verified text route to models unless native UIA is active.
    else if (normalized === "set_value" && (nativeUiAutomation || isEditableValuePatternRole(role))) set.add("setValue");
    else if (normalized === "scroll") set.add("scroll");
    else if (!nativeUiAutomation && (normalized === "keypress" || normalized === "key_press")) set.add("keypress");
    else if (!nativeUiAutomation && (normalized === "hotkey" || normalized === "shortcut")) set.add("hotkey");
  }
  return [...set];
}

/**
 * Identify only a candidate surface; the candidate is not sufficient to
 * authorize input by itself. `hitTest`/dispatch consume a fresh native point
 * proof for virtualized grid rows when the tree omits its DataGrid ancestor.
 * Role/pattern evidence is deliberately independent of app names and labels.
 */
function pointerFocusSurface(
  element: WindowsWindowElement,
): PointerFocusSurface | undefined {
  if (element.enabled === false || element.password === true || element.inWebContent === true
    || !element.rect || !validRect(element.rect)
    || typeof element.token !== "string" || element.token.length === 0) return undefined;
  const role = canonicalRole(element.role).replace(/[ _-]/gu, "");
  const actions = new Set(element.actions.map(action => action.toLocaleLowerCase().replace(/[ -]/gu, "_")));
  const editable = element.editable === true || actions.has("set_value") || actions.has("value")
    || actions.has("text") || actions.has("type") || actions.has("type_text");
  if (!editable) return undefined;

  if (role === "document" || role === "textbox") {
    // A text/document surface with Invoke/Press is a command-like provider,
    // not the passive editing surface this lane is intended to focus.
    if (actions.has("invoke") || actions.has("click") || actions.has("press")) return undefined;
    return { kind: "document" };
  }

  if (role !== "dataitem" && role !== "cell" && role !== "gridcell") return undefined;
  // The native point proof below establishes the actual GridItem/SelectionItem
  // surface and its raw ancestry. The CUA row only needs the paired editable
  // and selection/invoke signals to enter that bounded proof lane.
  if (!(actions.has("invoke") || actions.has("click") || actions.has("press"))) return undefined;
  return { kind: "grid" };
}

function hasNativePointerPattern(actions: readonly string[] | undefined): boolean {
  return Array.isArray(actions) && actions.some(action => /^(?:invoke|click|press)$/iu.test(action.replace(/[ -]/gu, "_")));
}

function pointerSurfaceMatches(control: InternalControl, point: Point, surface: WindowsPointerSurface): boolean {
  const expectedKind = control.pointerFocus === "grid" ? "grid" : "text";
  if (surface.kind !== expectedKind || !validRect(surface.bounds) || !contains(surface.bounds, point)) return false;
  const expectedRole = canonicalRole(control.control.role);
  const expectedRuntimeId = typeof control.source.runtimeId === "string" && control.source.runtimeId.length > 0
    ? control.source.runtimeId : undefined;
  const identityMatches = (identity: WindowsPointerSurface["container"] | WindowsPointerSurface): boolean => {
    if (!identity || canonicalRole(identity.role) !== expectedRole || !validRect(identity.bounds)
      || !contains(identity.bounds, point)) return false;
    if (expectedRuntimeId !== undefined && identity.runtimeId !== expectedRuntimeId) return false;
    return control.control.rect === undefined || rectsApproximatelyEqual(identity.bounds, control.control.rect, 8);
  };
  // A native point may resolve to an editable leaf while the observed CUA
  // row is its Document container. Match either identity, but never accept a
  // passive container without checking the actual leaf below.
  if (!identityMatches(surface) && !identityMatches(surface.container)) return false;
  if (control.pointerFocus === "grid"
    && control.control.name !== undefined
    && normalize(surface.name ?? "") !== normalize(control.control.name)) return false;
  if (!surface.leaf || !validRect(surface.leaf.bounds) || !contains(surface.leaf.bounds, point)) return false;
  if (surface.container && (!validRect(surface.container.bounds) || !contains(surface.container.bounds, point))) return false;
  return true;
}

function withPointInteraction(control: Control, target: WindowsWindowTarget, point: Point, surface: WindowsPointerSurface): Control {
  const pointInteraction: NonNullable<Control["pointInteraction"]> = Object.freeze({
    kind: surface.kind === "grid" ? "select" : "placeCaret",
    binding: pointInteractionBinding(target, point, surface),
  });
  return Object.freeze({
    ...control,
    actions: control.actions.includes("click") ? control.actions : Object.freeze([...control.actions, "click"] as ActionKind[]),
    pointInteraction,
  } as Control);
}

function withPointClickFallback(control: Control): Control {
  if (control.actions.includes("click")) return control;
  const { filterAction: _filterAction, disclosure: _disclosure, sameDocumentTab: _sameDocumentTab, ...material } = control;
  return Object.freeze({
    ...material,
    effect: fallbackPointEffect(control.effect),
    actions: Object.freeze([...control.actions, "click"] as ActionKind[]),
  });
}

function fallbackPointEffect(effect: Control["effect"]): NonNullable<Control["effect"]> {
  if (effect === "external" || effect === "financial" || effect === "destructive" || effect === "security" || effect === "sensitive") {
    return effect;
  }
  return "unknown";
}

function pointInteractionBinding(target: WindowsWindowTarget, point: Point, surface: WindowsPointerSurface): string {
  return `windows-point-v1.${shortHash(JSON.stringify({
    owner: { pid: target.pid, hwnd: target.hwnd.toString() },
    point: { x: point.x, y: point.y },
    surface: pointerSurfaceIdentityForBinding(surface),
  }))}`;
}

function pointerSurfaceIdentityForBinding(surface: WindowsPointerSurface): unknown {
  const identity = (value: WindowsPointerSurface["container"] | WindowsPointerSurface | undefined): unknown => value === undefined ? undefined : {
    runtimeId: value.runtimeId,
    role: value.role,
    ...(value.name === undefined ? {} : { name: value.name }),
    bounds: { x: value.bounds.x, y: value.bounds.y, width: value.bounds.width, height: value.bounds.height },
  };
  return {
    kind: surface.kind,
    primary: identity(surface),
    leaf: identity(surface.leaf),
    container: identity(surface.container),
  };
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
    if (kind === "setValue") return { ok: false, code: "set_value_point_unsupported" };
    if (requestFrame.scope !== frame.frame.scope) return { ok: false, code: "stale_observation" };
    const hits = [...frame.controls.values()].filter(item => item.control.rect !== undefined
      && validRect(item.control.rect)
      && contains(item.control.rect, target.point));
    const actionable = hits.filter(item => item.token
      && (controlSupportsKind(item.control, kind) || (kind === "click" && item.pointerFocus !== undefined)));
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

function isForegroundTypeStep(step: Step): boolean {
  return step.kind === "type" && step.delivery === "foreground";
}

/**
 * Selector/ref foreground typing is a pixel delivery route, but its point is
 * derived from a fresh, complete control frame rather than supplied by the
 * model.  Keep the recipient tied to the observed writable control and its
 * native token before CUA captures a private window image.
 */
function foregroundTypeControlReady(
  resolved: InternalControl | undefined,
  frameComplete: boolean,
  point: Point | undefined,
): boolean {
  if (!frameComplete || !resolved || !point || !resolved.control.rect) return false;
  if (resolved.source.role === "Canvas" || resolved.source.password === true || resolved.control.sensitive === true) return false;
  if (!resolved.token || !resolved.control.actions.includes("type") || !resolved.control.states.includes("editable")) return false;
  return contains(resolved.control.rect, point) && validRect(resolved.control.rect);
}

function isWritableTextControl(resolved: InternalControl): boolean {
  const { control, source } = resolved;
  return isEditableValuePatternRole(control.role) && !source.password && !control.sensitive
    && source.enabled !== false
    && control.states.includes("editable") && control.actions.includes("type");
}

function actionAllowed(step: Step, control?: Control, foreground = false, pointerFocus = false): boolean {
  if (!control) {
    if (step.kind !== "click" && step.kind !== "scroll") return false;
    if (!foreground || !("point" in step.target)) return false;
    if (step.kind === "scroll") return true;
    return step.kind === "click" && (
      ((step.button ?? "left") === "left" && (step.count ?? 1) === 1)
      || ((step.button ?? "left") === "right" && (step.count ?? 1) === 1)
      || ((step.button ?? "left") === "left" && (step.count ?? 1) === 2)
    );
  }
  if (step.kind === "click") {
    const button = step.button ?? "left";
    const count = step.count ?? 1;
    if (pointerFocus && button === "left" && count === 1 && "point" in step.target) return foreground;
    if (button === "left" && count === 1) return control.actions.includes("click");
    return foreground && "point" in step.target
      && ((button === "right" && count === 1) || (button === "left" && count === 2))
      && control.actions.includes("click");
  }
  if (step.kind === "type") return control.actions.includes("type") && step.text.length > 0;
  if (step.kind === "setValue") return control.actions.includes("setValue");
  if (step.kind === "scroll") return control.actions.includes("scroll") && Number.isSafeInteger(step.amount) && step.amount > 0;
  if (step.kind === "keypress") return foreground && control.actions.includes("keypress") && validKey(step.key);
  if (step.kind === "hotkey") return foreground && control.actions.includes("hotkey") && validHotkey(step.keys);
  return false;
}

function usableEvidence(evidence: WindowsPhysicalEvidence | undefined, target: WindowsWindowTarget, point: Point): boolean {
  if (!evidence || !evidence.visible || evidence.minimized) return false;
  // A custom/native inspector must bind its sample to the exact enrolled
  // HWND/PID. Without this check a stale or foreign sample can make a point
  // appear owned merely because its rectangle overlaps the requested point.
  if (!sameWindow(evidence.target, target)) return false;
  if (evidence.bounds !== undefined && !validRect(evidence.bounds)) return false;
  if (evidence.occludingHwnd !== undefined && evidence.occludingHwnd !== target.hwnd) return false;
  if (evidence.bounds && !contains(evidence.bounds, point)) return false;
  return true;
}

function foregroundMatches(evidence: WindowsPhysicalEvidence | undefined, target: WindowsWindowTarget): boolean {
  if (!evidence || evidence.foregroundHwnd !== target.hwnd) return false;
  // Custom inspectors written before foregroundPid was added remain usable,
  // but the Win32 inspector always supplies both identities. Whenever the PID
  // is present it is a mandatory match so an HWND reuse can never be accepted.
  return evidence.foregroundPid === undefined || evidence.foregroundPid === target.pid;
}

function foregroundPointWindowMatches(
  evidence: WindowsPhysicalEvidence | undefined,
  target: WindowsWindowTarget,
  bounds: Rect | undefined,
): boolean {
  return !!evidence && sameWindow(evidence.target, target) && evidence.visible && !evidence.minimized
    && evidence.foregroundHwnd === target.hwnd && evidence.foregroundPid === target.pid
    && sameWindowPointBounds(evidence.bounds, bounds);
}

function focusMatchesControl(evidence: WindowsFocusEvidence, control: WindowsResolvedControl): boolean {
  if (!evidence.focused || evidence.pid !== control.window.pid || evidence.hwnd !== control.window.hwnd) return false;
  // RuntimeId equality is the native identity check. Role/name/bounds are
  // descriptive evidence only and never substitute for a replaced element.
  return typeof control.source.runtimeId === "string"
    && control.source.runtimeId.length > 0
    && evidence.runtimeId === control.source.runtimeId;
}

function validKey(key: string): boolean {
  return typeof key === "string" && /^(?:F12|Enter|Escape|Tab|(?:Arrow)?(?:Up|Down|Left|Right)|Home|End|Page(?:Up|Down))$/iu.test(key);
}

function validHotkey(keys: readonly string[]): boolean {
  if (!Array.isArray(keys) || keys.length < 2 || keys.length > 3 || new Set(keys).size !== keys.length) return false;
  const normalized = keys.map(key => key.toLocaleLowerCase());
  return (normalized.length === 2 && normalized[0] === "ctrl" && (normalized[1] === "a" || normalized[1] === "s"))
    || (normalized.length === 3 && normalized[0] === "ctrl" && normalized[1] === "shift" && normalized[2] === "s");
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

function validRect(rect: Rect): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

function normalize(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function normalizeText(value: string, max: number): string {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (!normalized || normalized.length > max) throw backendError("invalid_window_scope");
  return normalized;
}

function windowKey(target: WindowsWindowTarget): string {
  return `hwnd:${target.pid}:${target.hwnd.toString()}`;
}

function sameWindow(left: WindowsWindowTarget, right: WindowsWindowTarget): boolean {
  return left.pid === right.pid && left.hwnd === right.hwnd;
}

function isOwnedDialogEvidence(dialog: WindowsOwnedDialog, target: WindowsWindowTarget): boolean {
  return !!dialog
    && !!dialog.target
    && sameWindow(dialog.target, target)
    && typeof dialog.hwnd === "bigint"
    && dialog.hwnd > 0n
    && dialog.hwnd !== target.hwnd
    && dialog.pid === target.pid
    && typeof dialog.ownerHwnd === "bigint"
    && dialog.ownerHwnd > 0n
    && Array.isArray(dialog.ownerChain)
    && dialog.ownerChain.length > 0
    && dialog.ownerChain[0] === dialog.ownerHwnd
    && dialog.ownerChain[dialog.ownerChain.length - 1] === target.hwnd
    && !!dialog.bounds
    && dialog.bounds.width > 0
    && dialog.bounds.height > 0;
}

function scopeForAuthorization(authorization: {
  readonly version?: string;
  readonly targets: readonly WindowsWindowTarget[];
  readonly allowDesktopCapture?: boolean;
  readonly allowForegroundInput?: boolean;
  readonly background?: { readonly source: string };
}): string {
  const payload = [
    authorization.version ?? "",
    authorization.allowDesktopCapture === true ? "image" : "controls",
    authorization.allowForegroundInput === true ? "foreground" : "background",
    authorization.background?.source ?? "no-native-background",
    ...authorization.targets.map(target => `${target.pid}:${target.hwnd.toString()}`),
  ].join("|");
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
