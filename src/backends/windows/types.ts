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
  /** Explicitly permits foreground input for future coordinate-only actions. */
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
  readonly token?: string;
  /** Host-private binding to the material data shown in an enrolled dialog. */
  readonly approvalContext?: Control["approvalContext"];
  /** Desktop/global physical coordinates when supplied as `frame`. */
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
  /** Top-level HWND at the tested point, if a native point check was made. */
  readonly occludingHwnd?: bigint;
  readonly code?: string;
}

export interface WindowsPhysicalInspector {
  read(target: WindowsWindowTarget, point?: Point, signal?: AbortSignal): Promise<WindowsPhysicalEvidence | undefined>;
  close?(): Promise<void>;
}

export interface WindowsDispatchTarget {
  readonly window: WindowsWindowTarget;
  readonly control?: WindowsResolvedControl;
  /** Desktop-space point. The transport maps it to the native window space. */
  readonly point?: Point;
  /** Physical desktop bounds used for the foreground coordinate projection. */
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

export interface WindowsTransport {
  /** Delivery/source identity; arbitrary transports cannot claim native background trust. */
  readonly source?: WindowsBackgroundSource;
  open?(signal?: AbortSignal): Promise<void>;
  observeWindow(target: WindowsWindowTarget, options: { readonly signal?: AbortSignal }): Promise<WindowsWindowSnapshot>;
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
  readonly session?: string;
}

export interface WindowsDesktopBackend extends DesktopBackend {
  readonly authorizationScope: string;
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
