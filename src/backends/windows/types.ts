import type {
  Capability,
  Control,
  DesktopBackend,
  Frame,
  FrameImage,
  HostPolicyEvidence,
  Point,
  Rect,
  Selector,
  Step,
  Target,
} from "../../contracts.js";
import type { WindowPointGesture } from "../../core/window-point.js";
import type { WindowsOwnedDialog, WindowsOwnedDialogInspector } from "./dialogs.js";

/**
 * The host, not the model, chooses the exact native windows that are in scope.
 * `hwnd` is intentionally a bigint: Windows handles are pointer-sized and the
 * JSON tool channel must never round them through a JavaScript number.
 */
export interface WindowsWindowTarget {
  readonly pid: number;
  readonly hwnd: bigint;
  /** Optional host evidence used only for diagnostics and selector scoping. */
  readonly title?: string;
}

export type WindowsWindowTargetInput = WindowsWindowTarget | {
  readonly pid: number;
  readonly hwnd?: bigint | number | string;
  readonly windowId?: bigint | number | string;
  readonly window_id?: bigint | number | string;
  readonly title?: string;
};

/** A delivery source is host-granted independently from the input route. */
export type WindowsBackgroundSource = "cua-uia-0.54" | "native-uia-v1";

export interface WindowsDesktopAuthorization {
  /** Exact visible HWND/PID pairs. An empty list is rejected. */
  readonly targets: readonly WindowsWindowTargetInput[];
  /** A host-owned generation. Changing it invalidates all prior frame refs. */
  readonly version?: string;
  /** Separate host grant required before a whole-desktop image is captured.
   * This capture can include windows outside `targets`; it is never implied by
   * the HWND/PID list and should only be enabled for an explicitly authorized
   * image recipient. */
  readonly allowDesktopCapture?: boolean;
  /** Explicitly permits foreground pointer or keyboard input after re-checks. */
  readonly allowForegroundInput?: boolean;
  /** Explicit opt-in for a verified native background delivery source. */
  readonly background?: { readonly source: WindowsBackgroundSource };
}

export interface WindowsToolResult {
  readonly isError?: boolean;
  readonly errorCode?: string;
  readonly text?: string;
  readonly structuredJson?: string;
  readonly structuredContent?: unknown;
  readonly images?: readonly WindowsImage[];
  readonly action?: unknown;
  readonly degraded?: boolean;
}

export interface WindowsImage {
  readonly mimeType: string;
  readonly dataBase64: string;
}

/** Minimal structural surface implemented by CUA 0.54's native driver. */
export interface WindowsCuaDriver {
  callTool(name: string, argumentsJson: string, options?: { readonly signal?: AbortSignal }): Promise<WindowsToolResult>;
  /** Host-only opt-in for the one-shot native grid Enter route. */
  authorizeForegroundGridEnter?(
    target: WindowsWindowTarget,
    query: WindowsGridEditQuery & { readonly expected: WindowsGridEditContext },
    options: { readonly signal?: AbortSignal },
  ): Promise<string | undefined>;
  metadata?(options?: { readonly signal?: AbortSignal }): Promise<unknown>;
  startSession?(input: unknown, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
  endSession?(input: unknown, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
}

export interface WindowsWindowElement {
  readonly index: string;
  readonly depth: number;
  readonly role: string;
  readonly label?: string;
  readonly value?: string;
  readonly valueDescription?: string;
  readonly enabled?: boolean;
  readonly editable?: boolean;
  readonly selected?: boolean;
  readonly focused?: boolean;
  readonly password?: boolean;
  readonly inWebContent?: boolean;
  readonly actions: readonly string[];
  readonly parentIndex?: string;
  /** Optional native UIA RuntimeId, when the provider exposes one. */
  readonly runtimeId?: string;
  readonly token?: string;
  /** Host-private binding to the material data shown in an enrolled dialog. */
  readonly approvalContext?: Control["approvalContext"];
  /** Desktop coordinates in the UIA coordinate space when supplied as `frame`. */
  readonly rect?: Rect;
  /** True when `rect` came from the older window-local screenshot_frame field. */
  readonly rectIsWindowLocal?: boolean;
  /** Original screenshot-local frame retained for CUA geometry validation. */
  readonly screenshotRect?: Rect;
}

export interface WindowsWindowSnapshot {
  readonly target: WindowsWindowTarget;
  readonly title?: string;
  readonly bounds?: Rect;
  /** Screenshot-space basis from the same CUA snapshot, when exposed. */
  readonly screenshotWidth?: number;
  readonly screenshotHeight?: number;
  readonly screenshotOrigin?: Point;
  readonly elements: readonly WindowsWindowElement[];
  readonly complete: boolean;
  readonly degraded?: boolean;
  readonly snapshotId?: string;
}

export interface WindowsDesktopImage extends FrameImage {
  readonly origin?: Point;
}

export interface WindowsPhysicalEvidence {
  readonly target: WindowsWindowTarget;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly bounds?: Rect;
  readonly foregroundHwnd?: bigint;
  /** PID associated with `foregroundHwnd`, read in the same user32 sample. */
  readonly foregroundPid?: number;
  /** Top-level HWND at the tested point, if a native point check was made. */
  readonly occludingHwnd?: bigint;
  readonly code?: string;
}

/** Capture-free proof of the actual UIA focused element under an enrolled root. */
export interface WindowsFocusEvidence {
  readonly target: WindowsWindowTarget;
  readonly focused: boolean;
  readonly pid?: number;
  /** Root HWND owning the focused element, never a discovered target. */
  readonly hwnd?: bigint;
  /** Native UIA RuntimeId serialized as a stable bounded string. */
  readonly runtimeId?: string;
  readonly role?: string;
  readonly bounds?: Rect;
  readonly code?: string;
}

/** Native identity captured for one model-selected grid item. Bounds are in physical desktop pixels. */
export interface WindowsGridItemIdentity {
  readonly role: string;
  readonly name?: string;
  readonly runtimeId?: string;
  readonly bounds: Rect;
}

/** Native GridPattern location captured from the exact physical hit before typing. */
export interface WindowsGridItemAnchor {
  readonly selectedItem: WindowsGridItemIdentity & { readonly runtimeId: string };
  readonly gridRuntimeId: string;
  /** RawView runtime identities from the enrolled root to the containing grid. */
  readonly gridPath: readonly string[];
  readonly row: number;
  readonly column: number;
}

/** One live selected grid item and its exact focused native edit surface. */
export interface WindowsGridEditContext {
  readonly selectedItem: WindowsGridItemIdentity & { readonly runtimeId: string; readonly selected: true };
  readonly editor: {
    readonly role: string;
    readonly runtimeId: string;
    readonly bounds: Rect;
    /** Native child HWND at the physical point; must be a child of the enrolled root. */
    readonly hwnd: bigint;
    /** Physical caret sample from GetGUIThreadInfo, contained by the selected item. */
    readonly caret: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  };
  readonly focus: WindowsFocusEvidence;
}

/** Host-private proof carried from a dispatched grid type to its same-batch Enter policy check. */
export interface WindowsGridCommitProof extends HostPolicyEvidence {
  readonly kind: "windows_grid_commit";
  readonly binding: string;
  readonly sourceControlId: string;
  readonly focusControlId: string;
  readonly windowScope: string;
  readonly point: Point;
  readonly selectedItem: WindowsGridItemIdentity & { readonly runtimeId: string };
  readonly anchor: WindowsGridItemAnchor;
  readonly context: WindowsGridEditContext;
}

/** Same-act step linkage is added by the session; this object never reaches the model surface. */
export interface WindowsGridCommitPolicyEvidence extends WindowsGridCommitProof {
  readonly sourceStep: number;
  readonly commitStep: number;
}

export interface WindowsGridItemQuery {
  readonly point: Point;
  readonly selectedItem: WindowsGridItemIdentity;
}

export interface WindowsGridEditQuery extends WindowsGridItemQuery {
  readonly anchor: WindowsGridItemAnchor;
}

/** Host-private identity for a native point surface; never sent to the model. */
export interface WindowsPointerSurfaceIdentity {
  readonly runtimeId: string;
  readonly role: string;
  readonly name?: string;
  readonly bounds: Rect;
}

/**
 * Native UIA proof for classifying one exact physical point. The primary
 * identity is the grounded text/document or grid item; leaf/container are
 * optional identities used by the caller to match its observed tree.
 */
export interface WindowsPointerSurface extends WindowsPointerSurfaceIdentity {
  readonly kind: "text" | "grid";
  readonly leaf?: WindowsPointerSurfaceIdentity;
  readonly container?: WindowsPointerSurfaceIdentity;
}

export interface WindowsPhysicalInspector {
  read(target: WindowsWindowTarget, point?: Point, signal?: AbortSignal): Promise<WindowsPhysicalEvidence | undefined>;
  /** Optional native UIA focus probe. Keyboard actions require this proof. */
  readFocused?(target: WindowsWindowTarget, signal?: AbortSignal): Promise<WindowsFocusEvidence | undefined>;
  /** Optional bounded native UIA proof for a point's text or grid surface. */
  readPointerSurface?(
    target: WindowsWindowTarget,
    point: Point,
    signal?: AbortSignal,
  ): Promise<WindowsPointerSurface | undefined>;
  /**
   * Optional narrow proof for a just-typed grid item. It must bind the exact
   * selected item, one native focused element, and the unique visible editor
   * at the supplied physical point under this enrolled root.
   */
  readGridEditContext?(
    target: WindowsWindowTarget,
    query: WindowsGridEditQuery,
    signal?: AbortSignal,
  ): Promise<WindowsGridEditContext | undefined>;
  /** Capture the exact native grid row/column and RuntimeId before typing. */
  readGridItemAnchor?(
    target: WindowsWindowTarget,
    query: WindowsGridItemQuery,
    signal?: AbortSignal,
  ): Promise<WindowsGridItemAnchor | undefined>;
  /**
   * One-shot native Enter route. The worker must repeat the selection, editor,
   * foreground, and exact focus checks immediately before sending one key
   * batch, and must never retry a partial or unknown delivery.
   */
  dispatchGridEnter?(
    target: WindowsWindowTarget,
    query: WindowsGridEditQuery & { readonly expected: WindowsGridEditContext },
    signal?: AbortSignal,
  ): Promise<WindowsTransportDelivery>;
  /**
   * Optional exact foreground chord route. The implementation must recheck
   * the enrolled HWND/PID and active focus synchronously immediately before
   * its single native key batch, then recheck them after delivery. It is
   * intentionally narrower than generic keyboard input and never replaces
   * the existing keypress path.
   */
  dispatchHotkey?(
    target: WindowsWindowTarget,
    keys: readonly string[],
    focused: WindowsFocusEvidence,
    signal?: AbortSignal,
  ): Promise<WindowsTransportDelivery>;
  /** Deliver text to the same live editor, preserving its caret and selection. */
  dispatchFocusedText?(
    target: WindowsWindowTarget,
    text: string,
    focused: WindowsFocusEvidence,
    signal?: AbortSignal,
  ): Promise<WindowsTransportDelivery>;
  /** Native physical pixel delivery for an already active, authorized window without controls. */
  dispatchWindowPoint?(
    target: WindowsWindowTarget,
    gesture: WindowPointGesture,
    bounds: Rect,
    display: Pick<FrameImage, "width" | "height">,
    signal?: AbortSignal,
  ): Promise<WindowsTransportDelivery>;
  /** Return the primary display in the same coordinate space as read(). */
  captureDesktopImage?(signal?: AbortSignal): Promise<WindowsDesktopImage | undefined>;
  close?(): Promise<void>;
}

export interface WindowsDispatchTarget {
  readonly window: WindowsWindowTarget;
  readonly control?: WindowsResolvedControl;
  /** Desktop-space point. The transport maps it to the native window space. */
  readonly point?: Point;
  /**
   * True when `point` came from the model's coordinate target. A semantic
   * selector/ref may still carry a private center point for physical checks,
   * but must retain its token delivery route. Keeping this bit host-private
   * prevents a selector click from being silently rewritten as a pixel click.
   */
  readonly coordinate?: boolean;
  /** Window bounds from the observation, checked against the fresh capture. */
  readonly windowBounds?: Rect;
  readonly foreground: boolean;
}

export interface WindowsResolvedControl {
  readonly control: Control;
  readonly token?: string;
  readonly window: WindowsWindowTarget;
  readonly localRect?: Rect;
  readonly source: WindowsWindowElement;
}

export interface WindowsTransportDelivery {
  readonly status: "dispatched" | "refused" | "partial" | "unknown";
  readonly code?: string;
  readonly focusId?: string;
  /** Prevents a window-scoped native chord's transitioned child becoming a stale handoff. */
  readonly suppressFocusHandoff?: true;
}

/**
 * Host-owned foreground activation callback. The callback receives only an
 * already enrolled exact HWND/PID pair; it must not discover or choose a
 * window. The backend still re-reads physical evidence after the callback.
 */
export type WindowsForegroundActivator = (
  target: WindowsWindowTarget,
  options: { readonly signal?: AbortSignal },
) => Promise<WindowsTransportDelivery>;

export interface WindowsTransport {
  /** Delivery/source identity; arbitrary transports cannot claim native background trust. */
  readonly source?: WindowsBackgroundSource;
  open?(signal?: AbortSignal): Promise<void>;
  observeWindow(target: WindowsWindowTarget, options: {
    readonly signal?: AbortSignal;
    /** Optional exact role/name for a read-only candidate snapshot of this window. */
    readonly where?: Selector;
    /** Host-private capture proof for a granted foreground point lane. */
    readonly includeScreenshot?: boolean;
  }): Promise<WindowsWindowSnapshot>;
  /** Fresh read-only pixels for one exact authorized HWND/PID. */
  observeWindowImage?(target: WindowsWindowTarget, options: { readonly signal?: AbortSignal }): Promise<WindowsDesktopImage | undefined>;
  observeDesktopImage?(options: { readonly signal?: AbortSignal }): Promise<WindowsDesktopImage | undefined>;
  dispatch(step: Step, target: WindowsDispatchTarget, options: { readonly signal?: AbortSignal }): Promise<WindowsTransportDelivery>;
  /**
   * Optional late authorization checkpoint for the native foreground chord
   * route. A non-empty result is a refusal code; callers must not fall back
   * to another hotkey transport after this hook is present.
   */
  authorizeForegroundHotkey?(
    target: WindowsWindowTarget,
    options: { readonly signal?: AbortSignal },
  ): Promise<string | undefined>;
  /** Recheck live input authority before typing into the exact focused editor. */
  authorizeForegroundText?(
    target: WindowsWindowTarget,
    options: { readonly signal?: AbortSignal },
  ): Promise<string | undefined>;
  /** Recheck live product grants immediately before the native window-point route. */
  authorizeWindowPoint?(
    target: WindowsWindowTarget,
    options: { readonly signal?: AbortSignal },
  ): Promise<string | undefined>;
  /** Late product-grant checkpoint for the one-shot selected-grid Enter route. */
  authorizeForegroundGridEnter?(
    target: WindowsWindowTarget,
    query: WindowsGridEditQuery & { readonly expected: WindowsGridEditContext },
    options: { readonly signal?: AbortSignal },
  ): Promise<string | undefined>;
  /** Optional explicit foreground escalation. Never called for background UIA actions. */
  bringToFront?(target: WindowsWindowTarget, options: { readonly signal?: AbortSignal }): Promise<WindowsTransportDelivery>;
  close?(): Promise<void>;
}

export interface WindowsDesktopBackendOptions {
  readonly authorization: WindowsDesktopAuthorization;
  /** A CUA 0.54-compatible driver. Ignored when `transport` is supplied. */
  readonly driver?: WindowsCuaDriver;
  /** Test seam and optional native UIA worker transport. */
  readonly transport?: WindowsTransport;
  /** Test seam; production defaults to a read-only user32 inspector on Win32. */
  readonly inspector?: WindowsPhysicalInspector;
  /** Optional host callback used to activate an already enrolled target. */
  readonly activateForeground?: WindowsForegroundActivator;
  /** Optional read-only ownership inspector for exact parent-owned dialogs. */
  readonly ownedDialogInspector?: WindowsOwnedDialogInspector;
  /** Alias retained for hosts that call the inspector a dialog inspector. */
  readonly dialogInspector?: WindowsOwnedDialogInspector;
  readonly session?: string;
}

export interface WindowsDesktopBackend extends DesktopBackend {
  readonly authorizationScope: string;
  /**
   * Discover visible top-level dialogs owned by an enrolled parent. Results
   * are evidence only; callers must explicitly enroll a returned HWND before
   * observing or acting on it.
   */
  findOwnedDialogs(
    target: WindowsWindowTarget,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly WindowsOwnedDialog[]>;
}

export interface WindowsBackendError extends Error {
  readonly code: string;
}

export function backendError(code: string, message = code): WindowsBackendError {
  const error = new Error(message) as WindowsBackendError;
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}

export function isWindowsBackendError(error: unknown): error is WindowsBackendError {
  return error instanceof Error && typeof (error as Partial<WindowsBackendError>).code === "string";
}

/** Kept public for hosts that want to build their own option validation. */
export type WindowsBackendCapabilities = readonly Capability[];
export type WindowsBackendFrame = Frame;
export type WindowsBackendTarget = Target;
