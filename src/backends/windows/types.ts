import type {
  Capability,
  Control,
  DesktopBackend,
  Frame,
  FrameImage,
  Point,
  Rect,
  Step,
  Target,
} from "../../contracts.js";
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
}

export interface WindowsWindowSnapshot {
  readonly target: WindowsWindowTarget;
  readonly title?: string;
  readonly bounds?: Rect;
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

export interface WindowsPhysicalInspector {
  read(target: WindowsWindowTarget, point?: Point, signal?: AbortSignal): Promise<WindowsPhysicalEvidence | undefined>;
  /** Optional native UIA focus probe. Keyboard actions require this proof. */
  readFocused?(target: WindowsWindowTarget, signal?: AbortSignal): Promise<WindowsFocusEvidence | undefined>;
  /** Return the primary display in the same coordinate space as read(). */
  captureDesktopImage?(signal?: AbortSignal): Promise<WindowsDesktopImage | undefined>;
  close?(): Promise<void>;
}

export interface WindowsDispatchTarget {
  readonly window: WindowsWindowTarget;
  readonly control?: WindowsResolvedControl;
  /** Desktop-space point. The transport maps it to the native window space. */
  readonly point?: Point;
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
  observeWindow(target: WindowsWindowTarget, options: { readonly signal?: AbortSignal }): Promise<WindowsWindowSnapshot>;
  /** Fresh read-only pixels for one exact authorized HWND/PID. */
  observeWindowImage?(target: WindowsWindowTarget, options: { readonly signal?: AbortSignal }): Promise<WindowsDesktopImage | undefined>;
  observeDesktopImage?(options: { readonly signal?: AbortSignal }): Promise<WindowsDesktopImage | undefined>;
  dispatch(step: Step, target: WindowsDispatchTarget, options: { readonly signal?: AbortSignal }): Promise<WindowsTransportDelivery>;
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
