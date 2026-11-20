import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ActionKind,
  Capability,
  Control,
  Dispatch,
  Delivery,
  DesktopBackend,
  Frame,
  ObserveOptions,
  Point,
  Rect,
  Selector,
  State,
} from "../../contracts.js";

/** The small, host-owned surface of an E2B Desktop sandbox used by this adapter. */
export interface E2BDesktopSurface {
  screenshot?(format?: "bytes"): Promise<Uint8Array>;
  getCurrentWindowId?(): Promise<string>;
  getApplicationWindows?(application: string): Promise<string[]>;
  getWindowTitle?(windowId: string): Promise<string>;
  getScreenSize?(): Promise<{ width: number; height: number }>;
  leftClick?(x?: number, y?: number): Promise<void>;
  write?(text: string, options?: { chunkSize: number; delayInMs: number }): Promise<void>;
  press?(key: string | string[]): Promise<void>;
  /** Optional host wrapper. The adapter never accepts a command from the model. */
  activateWindow?(windowId: string): Promise<void>;
  /** Optional fixed X11 recipient probe for screenshot-only point actions. */
  verifyPointOwnership?(windowId: string, point: Point, signal?: AbortSignal): Promise<boolean>;
  commands?: {
    run(command: string, options?: {
      timeoutMs?: number;
      requestTimeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
  };
}

/** An exact X11 window grant chosen by the trusted host. */
export interface E2BWindowGrant {
  /** The xdotool window id. It is never supplied by the model. */
  readonly windowId: string;
  /** The exact X11 application class used to verify the window. */
  readonly application: string;
  /** Optional host-proven _NET_WM_PID. The packaged worker proves it when omitted. */
  readonly processId?: number;
  /** Optional exact title expected at each observation. */
  readonly title?: string;
}

export interface E2BAtSpiWorker {
  request(request: Readonly<Record<string, unknown>>, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
  close?(): Promise<void>;
}

export interface E2BX11Recipient {
  verify(request: Readonly<{ windowId: string; processId: number; application: string; point: Point }>, options?: { readonly signal?: AbortSignal }): Promise<boolean>;
  click(request: Readonly<{ windowId: string; processId: number; application: string; point: Point }>, options?: { readonly signal?: AbortSignal }): Promise<boolean>;
  close?(): Promise<void>;
}

/** A separate host grant for focused-window text/Ctrl+S delivery. */
export interface E2BX11KeyboardRecipient {
  verifyFocus(request: Readonly<{ windowId: string; processId: number; application: string }>, options?: { readonly signal?: AbortSignal }): Promise<boolean>;
  typeText?(request: Readonly<{ windowId: string; processId: number; application: string; text: string }>, options?: { readonly signal?: AbortSignal }): Promise<Delivery>;
  close?(): Promise<void>;
}

export interface E2BDesktopActivationEvent {
  readonly fromWindowId?: string;
  readonly windowId: string;
  readonly application: string;
  readonly title?: string;
  readonly source: "model-act";
  readonly controlId: string;
}

export interface E2BDesktopBackendOptions {
  /** Host-approved windows. At least one exact window id is required. */
  readonly windows: readonly E2BWindowGrant[];
  /** Optional host-only refresh for newly opened same-app dialogs (for example Save As). */
  readonly discoverWindows?: (options?: { readonly signal?: AbortSignal }) => Promise<readonly E2BWindowGrant[]>;
  /** Test seam or a host-owned AT-SPI worker. The packaged worker is used otherwise. */
  readonly worker?: E2BAtSpiWorker;
  /** Fixed X11 recipient proof/click worker for real cloud point delivery. */
  readonly recipient?: E2BX11Recipient;
  /** Explicitly opt into focused-window text/Ctrl+S delivery for one grant. */
  readonly allowKeyboardInput?: boolean;
  readonly keyboardRecipient?: E2BX11KeyboardRecipient;
  /** Permit a temporary, unoccupied X11 clipboard for Unicode input on a private desktop. */
  readonly allowTemporaryClipboard?: boolean;
  /** Let the model receive screenshots only when the host explicitly grants them. */
  readonly allowScreenshot?: boolean;
  /** Explicitly opt into screenshot/point-only Window controls when AT-SPI is unavailable. */
  readonly allowDegradedScreenshot?: boolean;
  /** Expose only non-sensitive AT-SPI values when explicitly enabled. */
  readonly includeValues?: boolean;
  /** Permit point clicks after hit testing a screenshot frame. Disabled by default. */
  readonly allowPointActions?: boolean;
  readonly maxElements?: number;
  readonly maxTextLength?: number;
  readonly timeoutMs?: number;
  readonly maxImageBytes?: number;
  readonly onWindowActivated?: (event: E2BDesktopActivationEvent) => void | Promise<void>;
}

interface RawControl {
  id?: unknown;
  token?: unknown;
  role?: unknown;
  name?: unknown;
  states?: unknown;
  actions?: unknown;
  rect?: unknown;
  value?: unknown;
  sensitive?: unknown;
  editable?: unknown;
  labels?: unknown;
  effect?: unknown;
}

interface RawWindow {
  windowId?: unknown;
  window_id?: unknown;
  title?: unknown;
  processId?: unknown;
  process_id?: unknown;
  appClass?: unknown;
  app_class?: unknown;
  bounds?: unknown;
  controls?: unknown;
  complete?: unknown;
  truncated?: unknown;
}

interface InternalControl {
  readonly control: Control;
  readonly windowId: string;
  readonly window: E2BWindowGrant;
}

interface InternalFrame {
  readonly frame: Frame;
  readonly controls: ReadonlyMap<string, InternalControl>;
  readonly degraded: boolean;
}

const MAX_WINDOWS = 16;
const MAX_ELEMENTS = 512;
const MAX_TEXT_LENGTH = 16_384;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const SAFE_WINDOW_ID = /^(?:0x[0-9a-f]+|[0-9]+)$/iu;
const SAFE_APPLICATION = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/u;
const SAFE_TEXT = /^[^\u0000\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]*$/u;
const VALID_STATES = new Set<State>(["visible", "enabled", "editable", "focused", "checked", "selected", "expanded"]);
const VALID_ACTIONS = new Set<ActionKind>(["click", "type", "setValue", "keypress", "hotkey"]);
const VALID_EFFECTS = new Set<NonNullable<Control["effect"]>>(["read", "navigate", "edit", "external", "financial", "destructive", "security", "sensitive", "unknown"]);
const ALLOWED_KEYS = new Set([
  "backspace", "delete", "enter", "escape", "esc", "tab", "space", "left", "right", "up", "down", "home", "end", "page_up", "page_down", "insert",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
const ALLOWED_CHORDS = new Set([
  "ctrl+a", "control+a", "ctrl+c", "control+c", "ctrl+v", "control+v", "ctrl+x", "control+x", "ctrl+s", "control+s", "ctrl+shift+s", "control+shift+s", "ctrl+l", "control+l",
]);
const SAVE_CHORDS = new Set(["ctrl+s", "control+s"]);

function desktopError(code: string, detail?: string): Error & { code: string } {
  const error = new Error(detail ? `${code}:${detail}` : code) as Error & { code: string };
  error.code = code;
  return error;
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw desktopError(code);
  return value;
}

function validString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function windowId(value: unknown): string | undefined {
  if (typeof value !== "string" || !SAFE_WINDOW_ID.test(value)) return undefined;
  if (value.toLocaleLowerCase().startsWith("0x")) {
    try { return BigInt(value).toString(10); } catch { return undefined; }
  }
  return value.replace(/^0+(?=\d)/u, "");
}

function normalizeWindowGrant(value: E2BWindowGrant): E2BWindowGrant {
  const id = windowId(value?.windowId);
  if (!id) throw desktopError("e2b_desktop_window_id_invalid");
  if (!validString(value?.application, 128) || !SAFE_APPLICATION.test(value.application)) throw desktopError("e2b_desktop_application_invalid");
  if (value.title !== undefined && !validString(value.title, 512)) throw desktopError("e2b_desktop_window_title_invalid");
  if (value.processId !== undefined && (!Number.isSafeInteger(value.processId) || value.processId <= 0 || value.processId > 0x7fffffff)) throw desktopError("e2b_desktop_process_id_invalid");
  return Object.freeze({ windowId: id, application: value.application, ...(value.processId === undefined ? {} : { processId: value.processId }), ...(value.title === undefined ? {} : { title: value.title }) });
}

function rect(value: unknown): Rect | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const x = item.x;
  const y = item.y;
  const width = item.width ?? item.w;
  const height = item.height ?? item.h;
  if (![x, y, width, height].every((entry) => typeof entry === "number" && Number.isFinite(entry))) return undefined;
  if ((width as number) <= 0 || (height as number) <= 0) return undefined;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

function pointInRect(point: Point, target: Rect): boolean {
  return point.x >= target.x && point.y >= target.y && point.x < target.x + target.width && point.y < target.y + target.height;
}

function normalizeActions(value: unknown, editable: boolean, sensitive: boolean): ActionKind[] {
  if (sensitive) return [];
  const actions = new Set<ActionKind>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") continue;
      const normalized = item.toLocaleLowerCase().replace(/[ _-]/gu, "");
      if (["invoke", "press", "click", "activate"].includes(normalized)) actions.add("click");
      else if (["setvalue", "value", "text", "type", "edit"].includes(normalized)) actions.add("setValue");
      else if (normalized === "scroll") actions.add("scroll");
      else if (normalized === "keypress" || normalized === "key") actions.add("keypress");
    }
  }
  if (editable) {
    actions.add("type");
    actions.add("setValue");
  }
  return [...actions].filter((action) => VALID_ACTIONS.has(action));
}

function normalizeStates(value: unknown, editable: boolean, focused: boolean): State[] {
  const states = new Set<State>(["visible", "enabled"]);
  if (Array.isArray(value)) {
    for (const item of value) if (typeof item === "string" && VALID_STATES.has(item as State)) states.add(item as State);
  }
  if (editable) states.add("editable");
  if (focused) states.add("focused");
  return [...states];
}

function normalizeEffect(value: unknown): Control["effect"] {
  return typeof value === "string" && VALID_EFFECTS.has(value as NonNullable<Control["effect"]>)
    ? value as Control["effect"] : undefined;
}

function normalizeTitle(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 512 && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value) ? value : undefined;
}

function normalizeImage(value: Uint8Array, maxBytes: number): { mimeType: string; dataBase64: string; width: number; height: number } {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maxBytes) throw desktopError("e2b_desktop_image_invalid");
  let width = 1;
  let height = 1;
  if (value.byteLength >= 24 && value[0] === 0x89 && value[1] === 0x50 && value[2] === 0x4e && value[3] === 0x47) {
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    width = view.getUint32(16);
    height = view.getUint32(20);
  }
  return { mimeType: "image/png", dataBase64: Buffer.from(value).toString("base64"), width, height };
}

function sameMaterial(left: Control, right: Control): boolean {
  return left.id === right.id && left.role === right.role && left.name === right.name && left.within === right.within && left.sensitive === right.sensitive && left.effect === right.effect
    && JSON.stringify([...left.actions].sort()) === JSON.stringify([...right.actions].sort());
}

function sameWindowGrant(left: E2BWindowGrant, right: E2BWindowGrant): boolean {
  return left.windowId === right.windowId && left.processId === right.processId && left.application === right.application;
}

function selectorMatches(control: Control, selector?: Selector): boolean {
  if (!selector) return true;
  if (selector.role !== undefined && control.role !== selector.role) return false;
  if (selector.name !== undefined && control.name !== selector.name) return false;
  if (selector.within !== undefined && control.within !== selector.within) return false;
  if (selector.state !== undefined && !control.states.includes(selector.state)) return false;
  return true;
}

function actionCapabilities(allowPointActions: boolean, pointOwnershipProof: boolean, keyboardMode: "full" | "restricted" | "none"): Capability[] {
  const capabilities: Capability[] = [
    { kind: "click", targets: ["selector", "ref"], buttons: ["left"], counts: [1] },
  ];
  if (keyboardMode === "restricted") {
    capabilities.push(
      { kind: "type", targets: ["selector", "ref"] },
      { kind: "hotkey", targets: ["selector", "ref"], chords: [["ctrl", "s"], ["Control", "s"]] },
    );
  } else if (keyboardMode === "full") {
    capabilities.push(
      { kind: "type", targets: ["selector", "ref"] },
      { kind: "setValue", targets: ["selector", "ref"] },
      { kind: "keypress", targets: ["selector", "ref"], keys: [...ALLOWED_KEYS] },
      { kind: "hotkey", targets: ["selector", "ref"], chords: [...[...ALLOWED_CHORDS].map((item) => item.split("+") as string[])] },
    );
  }
  if (allowPointActions && pointOwnershipProof) capabilities.push({ kind: "click", targets: ["point"], buttons: ["left"], counts: [1] });
  return capabilities;
}

function supportedKey(value: string): boolean {
  return ALLOWED_KEYS.has(value.toLocaleLowerCase());
}

function supportedChord(value: readonly string[]): boolean {
  return ALLOWED_CHORDS.has(value.map((part) => part.toLocaleLowerCase()).join("+"));
}

function packagedWorkerCommand(source: string, request: Readonly<Record<string, unknown>>): string {
  const script = Buffer.from(source, "utf8").toString("base64");
  const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  return `python3 -u -c "import base64,io,sys;sys.stdin=io.StringIO(base64.b64decode('${payload}').decode('utf-8'));exec(base64.b64decode('${script}'))"`;
}

function safeInput(text: string, maximum: number): boolean {
  return text.length <= maximum && SAFE_TEXT.test(text);
}

/**
 * A bounded E2B X11 desktop backend. The model sees only AT-SPI controls and
 * optionally one screenshot; shell commands, app launch, and file access stay
 * host-only. Window activation is rechecked against the exact host grant before
 * every physical action.
 */
export async function createE2BDesktopBackend(
  desktop: E2BDesktopSurface,
  options: E2BDesktopBackendOptions,
): Promise<DesktopBackend & { readonly hitTestSnapshot: boolean; readonly activationEvents: readonly E2BDesktopActivationEvent[]; readonly capabilityMode: "atspi" | "screenshot-point-degraded" }> {
  if (!desktop || typeof desktop !== "object") throw desktopError("e2b_desktop_surface_required");
  if (!Array.isArray(options?.windows) || options.windows.length === 0 || options.windows.length > MAX_WINDOWS) throw desktopError("e2b_desktop_windows_required");
  let grants = Object.freeze(options.windows.map(normalizeWindowGrant));
  let ids = new Set(grants.map((grant) => grant.windowId));
  if (ids.size !== grants.length) throw desktopError("e2b_desktop_duplicate_window");
  const maxElements = boundedInteger(options.maxElements ?? MAX_ELEMENTS, 1, MAX_ELEMENTS, "e2b_desktop_max_elements");
  const maxTextLength = boundedInteger(options.maxTextLength ?? MAX_TEXT_LENGTH, 1, MAX_TEXT_LENGTH, "e2b_desktop_max_text");
  const timeoutMs = boundedInteger(options.timeoutMs ?? 5_000, 250, MAX_TIMEOUT_MS, "e2b_desktop_timeout");
  const maxImageBytes = boundedInteger(options.maxImageBytes ?? MAX_IMAGE_BYTES, 1024, MAX_IMAGE_BYTES, "e2b_desktop_image_limit");
  const allowScreenshot = options.allowScreenshot === true;
  const allowDegradedScreenshot = options.allowDegradedScreenshot === true;
  const allowPointActions = options.allowPointActions === true;
  const worker = options.worker ?? new E2BAtSpiCommandWorker(desktop, { timeoutMs, maxElements });
  const recipient = options.recipient;
  const keyboardRecipient = options.keyboardRecipient;
  const keyboardEnabled = options.allowKeyboardInput === true && keyboardRecipient !== undefined
    && grants.length === 1 && grants[0].processId !== undefined;
  if (options.allowKeyboardInput === true && !keyboardEnabled) throw desktopError("e2b_desktop_keyboard_grant_invalid");
  const keyboardGrant = keyboardEnabled ? grants[0] : undefined;
  const pointOwnershipProof = Boolean(recipient && grants.every((grant) => grant.processId !== undefined)) || typeof desktop.verifyPointOwnership === "function";
  const keyboardMode: "full" | "restricted" | "none" = keyboardEnabled ? "restricted" : allowDegradedScreenshot ? "none" : "full";
  const scope = `e2b-desktop-${randomUUID()}`;
  const knownFrames = new WeakMap<Frame, InternalFrame>();
  const activationEvents: E2BDesktopActivationEvent[] = [];
  let closed = false;
  let capabilityMode: "atspi" | "screenshot-point-degraded" = "atspi";
  let tail: Promise<unknown> = Promise.resolve();

  async function currentTopLevelWindowId(signal?: AbortSignal): Promise<string | undefined> {
    if (desktop.commands) {
      try {
        const result = await desktop.commands.run("xprop -root _NET_ACTIVE_WINDOW", { timeoutMs, requestTimeoutMs: timeoutMs, signal });
        const match = /(?:window id #\s*)?(0x[0-9a-f]+|\d+)/iu.exec(result.stdout ?? "");
        const id = windowId(match?.[1]);
        if (id) return id;
      } catch { /* fall through to the SDK focus probe */ }
    }
    return desktop.getCurrentWindowId ? windowId(await desktop.getCurrentWindowId()) : undefined;
  }

  async function verifyPointOwnership(target: InternalControl, point: Point, signal?: AbortSignal): Promise<boolean> {
    if (recipient) {
      if (target.window.processId === undefined) return false;
      try {
        return await recipient.verify({ windowId: target.windowId, processId: target.window.processId, application: target.window.application, point: { x: Math.round(point.x), y: Math.round(point.y) } }, signal ? { signal } : undefined);
      } catch { return false; }
    }
    if (desktop.verifyPointOwnership) return desktop.verifyPointOwnership(target.windowId, point, signal);
    return false;
  }

  async function verifyKeyboardFocus(target: InternalControl, signal?: AbortSignal): Promise<boolean> {
    if (!keyboardEnabled || !keyboardRecipient || target.window.processId === undefined) return false;
    try {
      return await keyboardRecipient.verifyFocus({ windowId: target.windowId, processId: target.window.processId, application: target.window.application }, signal ? { signal } : undefined);
    } catch {
      return false;
    }
  }

  async function clickPoint(target: InternalControl, point: Point, signal?: AbortSignal): Promise<Delivery | undefined> {
    if (recipient && target.window.processId !== undefined) {
      try {
        const clicked = await recipient.click({ windowId: target.windowId, processId: target.window.processId, application: target.window.application, point: { x: Math.round(point.x), y: Math.round(point.y) } }, signal ? { signal } : undefined);
        if (!clicked) return { status: "refused", code: "e2b_desktop_point_not_owned" };
        return undefined;
      } catch (error) {
        if (signal?.aborted) throw error;
        const code = errorCode(error);
        if (code && code.startsWith("e2b_x11_recipient_") && code !== "e2b_x11_recipient_delivery_unknown") {
          return { status: "refused", code };
        }
        return { status: "unknown", code: code ?? "e2b_desktop_point_delivery_unknown" };
      }
    }
    if (!(await verifyPointOwnership(target, point, signal))) {
      return { status: "refused", code: "e2b_desktop_point_not_owned" };
    }
    if (!desktop.leftClick) return { status: "refused", code: "e2b_desktop_pointer_unavailable" };
    await desktop.leftClick(Math.round(point.x), Math.round(point.y));
    return undefined;
  }

  async function verifyGrant(grant: E2BWindowGrant): Promise<{ live: boolean; title?: string }> {
    if (desktop.getApplicationWindows) {
      let found: string[];
      try { found = await desktop.getApplicationWindows(grant.application); } catch { return { live: false }; }
      if (!found.some((item) => windowId(item) === grant.windowId)) return { live: false };
    }
    let title = grant.title;
    if (desktop.getWindowTitle) {
      try { title = await desktop.getWindowTitle(grant.windowId); } catch { return { live: false }; }
      if (grant.title !== undefined && title !== grant.title) return { live: false, title };
    }
    if (grant.processId !== undefined && desktop.commands) {
      try {
        const identity = await desktop.commands.run(`xprop -id ${grant.windowId} _NET_WM_PID`, { timeoutMs, requestTimeoutMs: timeoutMs });
        const match = /_NET_WM_PID[^=]*=\s*(\d+)/u.exec(identity.stdout ?? "");
        if (!match || Number(match[1]) !== grant.processId) return { live: false, ...(title === undefined ? {} : { title }) };
      } catch { return { live: false, ...(title === undefined ? {} : { title }) }; }
    }
    return { live: true, ...(title === undefined ? {} : { title }) };
  }

  async function refreshGrants(signal?: AbortSignal): Promise<void> {
    if (!options.discoverWindows) return;
    signal?.throwIfAborted();
    let discovered: readonly E2BWindowGrant[];
    try { discovered = await options.discoverWindows({ signal }); }
    catch (error) { throw desktopError("e2b_desktop_window_discovery_failed", error instanceof Error ? error.message : String(error)); }
    if (!Array.isArray(discovered) || discovered.length === 0 || discovered.length > MAX_WINDOWS) throw desktopError("e2b_desktop_window_discovery_invalid");
    const normalized = Object.freeze(discovered.map(normalizeWindowGrant));
    const nextIds = new Set(normalized.map((grant) => grant.windowId));
    if (nextIds.size !== normalized.length) throw desktopError("e2b_desktop_duplicate_window");
    if (keyboardGrant && (normalized.length !== 1 || !sameWindowGrant(normalized[0], keyboardGrant))) {
      throw desktopError("e2b_desktop_keyboard_grant_changed");
    }
    grants = normalized;
    ids = nextIds;
  }

  async function fallbackWindowBounds(id: string, signal?: AbortSignal): Promise<Rect | undefined> {
    signal?.throwIfAborted();
    if (desktop.commands) {
      try {
        const result = await desktop.commands.run(`xdotool getwindowgeometry --shell ${id}`, { timeoutMs, requestTimeoutMs: timeoutMs, signal });
        const values: Record<string, number> = {};
        for (const line of (result.stdout ?? "").split(/\r?\n/u)) {
          const match = /^(X|Y|WIDTH|HEIGHT)=(-?\d+)$/u.exec(line.trim());
          if (match) values[match[1]] = Number(match[2]);
        }
        if ([values.X, values.Y, values.WIDTH, values.HEIGHT].every((value) => Number.isFinite(value)) && values.WIDTH > 0 && values.HEIGHT > 0) {
          return { x: values.X, y: values.Y, width: values.WIDTH, height: values.HEIGHT };
        }
      } catch { /* use screen bounds only when the fixed geometry probe is unavailable */ }
    }
    return undefined;
  }

  type LiveWindows = readonly { grant: E2BWindowGrant; status: Awaited<ReturnType<typeof verifyGrant>> }[];
  async function readDegradedWindows(live: LiveWindows, signal?: AbortSignal): Promise<{ windows: RawWindow[]; complete: boolean; degraded: boolean }> {
    const windows: RawWindow[] = [];
    for (const { grant, status } of live) {
      signal?.throwIfAborted();
      if (!status.live) continue;
      // verifyGrant already read the live _NET_WM_PID for this observation.
      if (grant.processId === undefined || !desktop.commands) throw desktopError("e2b_desktop_window_identity_unproven");
      const bounds = await fallbackWindowBounds(grant.windowId, signal);
      windows.push({ window_id: grant.windowId, title: status.title ?? grant.title, bounds, controls: [], complete: false });
    }
    if (windows.length !== grants.length) throw desktopError("e2b_desktop_atspi_unavailable");
    capabilityMode = "screenshot-point-degraded";
    // A screenshot fallback has no semantic control tree. Even with verified
    // window geometry it is necessarily incomplete for controls/gestures.
    return { windows, complete: false, degraded: true };
  }

  function errorCode(error: unknown): string | undefined {
    return error && typeof error === "object" && typeof (error as Record<string, unknown>).code === "string"
      ? (error as Record<string, string>).code : undefined;
  }

  function atspiUnavailable(code: string | undefined): boolean {
    return code === "e2b_atspi_unavailable" || code === "e2b_desktop_atspi_unavailable" || code?.endsWith("_atspi_unavailable") === true;
  }

  async function readWorker(live: LiveWindows, signal?: AbortSignal): Promise<{ windows: RawWindow[]; complete: boolean; degraded: boolean }> {
    signal?.throwIfAborted();
    const request = {
      op: "observe",
      max_elements: maxElements,
      windows: grants.map((grant) => ({
        window_id: grant.windowId,
        application: grant.application,
        ...(grant.processId === undefined ? {} : { process_id: grant.processId }),
        ...(grant.title === undefined ? {} : { title: grant.title }),
      })),
    };
    let result: unknown;
    try {
      result = await worker.request(request, signal ? { signal } : undefined);
    } catch (error) {
      if (allowDegradedScreenshot && atspiUnavailable(errorCode(error))) return readDegradedWindows(live, signal);
      throw error;
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) throw desktopError("e2b_desktop_atspi_invalid");
    const raw = result as Record<string, unknown>;
    if (raw.ok === false) {
      const code = typeof raw.code === "string" ? raw.code : "e2b_desktop_atspi_failed";
      if (allowDegradedScreenshot && atspiUnavailable(code)) return readDegradedWindows(live, signal);
      throw desktopError(code);
    }
    const rawWindows = Array.isArray(raw.windows) ? raw.windows : [];
    if (allowDegradedScreenshot && Array.isArray(raw.windows) && rawWindows.length === 0 && raw.complete === false) {
      return readDegradedWindows(live, signal);
    }
    const windows: RawWindow[] = [];
    let complete = raw.complete !== false && raw.truncated !== true;
    for (const value of rawWindows) {
      if (!value || typeof value !== "object" || Array.isArray(value)) { complete = false; continue; }
      const item = value as RawWindow;
      const id = windowId(item.windowId ?? item.window_id);
      if (!id || !ids.has(id)) { complete = false; continue; }
      const grant = grants.find((candidate) => candidate.windowId === id)!;
      const rawProcessId = item.processId ?? item.process_id;
      const processId = typeof rawProcessId === "number" && Number.isSafeInteger(rawProcessId)
        ? rawProcessId
        : typeof rawProcessId === "string" && /^\d+$/u.test(rawProcessId) ? Number(rawProcessId) : undefined;
      if (grant.processId !== undefined && processId !== grant.processId) { complete = false; continue; }
      const appClass = item.appClass ?? item.app_class;
      if (typeof appClass === "string" && appClass.length > 0 && !appClass.toLocaleLowerCase().includes(grant.application.toLocaleLowerCase())) { complete = false; continue; }
      windows.push(item);
      if (item.complete === false || item.truncated === true) complete = false;
    }
    return { windows, complete, degraded: false };
  }

  async function capture(view: ObserveOptions["view"]): Promise<Frame["image"] | undefined> {
    if (view !== "image" && view !== "both") return undefined;
    if (!allowScreenshot || typeof desktop.screenshot !== "function") throw desktopError("e2b_desktop_image_not_authorized");
    return normalizeImage(await desktop.screenshot("bytes"), maxImageBytes);
  }

  async function observe(optionsForObserve: ObserveOptions): Promise<Frame> {
    if (closed) throw desktopError("e2b_desktop_closed");
    optionsForObserve.signal?.throwIfAborted();
    await refreshGrants(optionsForObserve.signal);
    if (!["controls", "image", "both"].includes(optionsForObserve.view)) throw desktopError("e2b_desktop_invalid_view");
    if (optionsForObserve.view === "image" && !allowPointActions) {
      const image = await capture(optionsForObserve.view);
      const frame: Frame = Object.freeze({ scope, controls: Object.freeze([]), complete: false, ...(image ? { image } : {}) });
      knownFrames.set(frame, { frame, controls: new Map(), degraded: false });
      return frame;
    }
    const live = await Promise.all(grants.map(async (grant) => ({ grant, status: await verifyGrant(grant) })));
    const inspected = await readWorker(live, optionsForObserve.signal);
    const byWindow = new Map(inspected.windows.map((item) => [windowId(item.windowId ?? item.window_id)!, item] as const));
    const controls: InternalControl[] = [];
    let complete = inspected.complete;
    const degraded = inspected.degraded;
    for (const { grant, status } of live) {
      if (!status.live) { complete = false; continue; }
      const snapshot = byWindow.get(grant.windowId);
      if (!snapshot) { complete = false; continue; }
      const title = status.title ?? normalizeTitle(snapshot.title) ?? grant.title;
      const windowBounds = rect(snapshot.bounds);
      const windowControl: Control = {
        id: `e2b-window:${grant.windowId}`,
        role: "Window",
        ...(title === undefined ? {} : { name: title }),
        within: grant.application,
        states: ["visible", "enabled"],
        // A degraded screenshot only proves an enrolled window, not a
        // semantic document/editor target. Keep activation discoverable but
        // never advertise arbitrary typing or key gestures.
        actions: degraded && keyboardEnabled ? ["click", "type", "hotkey"] : ["click"],
        ...(windowBounds ? { rect: windowBounds } : {}),
        effect: "unknown",
      };
      controls.push({ control: windowControl, windowId: grant.windowId, window: grant });
      const rawControls = Array.isArray(snapshot.controls) ? snapshot.controls : [];
      if (!Array.isArray(snapshot.controls)) complete = false;
      for (let index = 0; index < rawControls.length && controls.length < maxElements; index += 1) {
        const raw = rawControls[index];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) { complete = false; continue; }
        const item = raw as RawControl;
        const role = typeof item.role === "string" && item.role.length <= 128 ? item.role : undefined;
        if (!role) { complete = false; continue; }
        const sensitive = item.sensitive === true;
        const editable = item.editable === true;
        const focused = Array.isArray(item.states) && item.states.includes("focused");
        const actions = normalizeActions(item.actions, editable, sensitive);
        if (!sensitive && editable) actions.push("keypress", "hotkey");
        const token = validString(item.token, 256) ? item.token : validString(item.id, 256) ? item.id : String(index);
        const controlRect = rect(item.rect);
        const control: Control = {
          id: `e2b-atspi:${grant.windowId}:${token}`,
          role,
          ...(validString(item.name, 512) ? { name: item.name } : {}),
          within: `${grant.application}:${title ?? grant.windowId}`,
          states: normalizeStates(item.states, editable, focused),
          actions,
          ...(controlRect ? { rect: controlRect } : {}),
          ...(options.includeValues === true && !sensitive && typeof item.value === "string" && item.value.length <= maxTextLength && SAFE_TEXT.test(item.value)
            ? { value: item.value } : {}),
          ...(sensitive ? { sensitive: true } : {}),
          ...(Array.isArray(item.labels) ? { labels: Object.freeze(item.labels.filter((label): label is string => typeof label === "string" && label.length <= 256).slice(0, 16)) } : {}),
          ...(normalizeEffect(item.effect) ? { effect: normalizeEffect(item.effect) } : {}),
        };
        controls.push({ control, windowId: grant.windowId, window: grant });
      }
      if (rawControls.length + controls.length > maxElements) complete = false;
    }
    const filtered = optionsForObserve.view === "image" ? [] : controls.filter((item) => selectorMatches(item.control, optionsForObserve.where));
    const image = await capture(optionsForObserve.view);
    const frame: Frame = Object.freeze({ scope, controls: Object.freeze(filtered.map((item) => item.control)), complete: optionsForObserve.view !== "image" && !degraded && complete && filtered.length <= maxElements, ...(image ? { image } : {}) });
    knownFrames.set(frame, { frame, controls: new Map(controls.map((item) => [item.control.id, item])), degraded });
    return frame;
  }

  async function activate(target: InternalControl, controlId: string, signal?: AbortSignal, allowSwitch = false): Promise<Delivery | undefined> {
    signal?.throwIfAborted();
    const grant = target.window;
    const verified = await verifyGrant(grant);
    if (!verified.live) return { status: "refused", code: "e2b_desktop_window_unavailable" };
    const current = await currentTopLevelWindowId(signal);
    if (current === grant.windowId) return undefined;
    if (!allowSwitch) return { status: "refused", code: "e2b_desktop_window_not_active" };
    try {
      if (desktop.activateWindow) await desktop.activateWindow(grant.windowId);
      else if (desktop.commands) {
        const result = await desktop.commands.run(`xdotool windowactivate --sync ${grant.windowId}`, { timeoutMs, requestTimeoutMs: timeoutMs, signal });
        if (typeof result.exitCode === "number" && result.exitCode !== 0) return { status: "refused", code: "e2b_desktop_activation_failed" };
      } else return { status: "refused", code: "e2b_desktop_activation_unavailable" };
      const after = await currentTopLevelWindowId(signal);
      if (after === undefined) return { status: "unknown", code: "e2b_desktop_activation_unconfirmed" };
      if (after !== grant.windowId) return { status: "unknown", code: "e2b_desktop_activation_unconfirmed" };
      const event: E2BDesktopActivationEvent = {
        ...(current === undefined ? {} : { fromWindowId: current }),
        windowId: grant.windowId,
        application: grant.application,
        ...(verified.title === undefined ? {} : { title: verified.title }),
        source: "model-act",
        controlId,
      };
      activationEvents.push(event);
      await options.onWindowActivated?.(event);
      return undefined;
    } catch (error) {
      if (signal?.aborted) throw error;
      return { status: "unknown", code: "e2b_desktop_activation_unknown" };
    }
  }

  async function centerClick(target: InternalControl, signal?: AbortSignal): Promise<Delivery | undefined> {
    const control = target.control;
    if (!control.rect) return { status: "refused", code: "e2b_desktop_control_geometry_missing" };
    signal?.throwIfAborted();
    return clickPoint(target, { x: control.rect.x + control.rect.width / 2, y: control.rect.y + control.rect.height / 2 }, signal);
  }

  async function dispatch(request: Dispatch): Promise<Delivery> {
    if (closed) return { status: "refused", code: "e2b_desktop_closed" };
    if (request.signal?.aborted) return { status: "refused", code: "cancelled_before_dispatch" };
    const stored = knownFrames.get(request.frame);
    if (!stored || request.frame.scope !== scope) return { status: "refused", code: "e2b_desktop_stale_observation" };
    if (request.origin && request.origin.scope !== scope) return { status: "refused", code: "e2b_desktop_stale_origin" };
    const latest = await observe({ view: "controls", signal: request.signal });
    const latestInternal = knownFrames.get(latest)!;
    const current = latestInternal.controls.get(request.target.id);
    const original = stored.controls.get(request.target.id);
    if (!current || !original || !sameMaterial(original.control, current.control)) return { status: "refused", code: "e2b_desktop_target_stale" };
    if (!sameWindowGrant(original.window, current.window)) return { status: "refused", code: "e2b_desktop_window_grant_changed" };
    const step = request.step;
    if (step.kind === "click") {
      if ((step.button ?? "left") !== "left" || (step.count ?? 1) !== 1) return { status: "refused", code: "e2b_desktop_click_unsupported" };
      const pointTarget = "point" in step.target ? step.target.point : undefined;
      if (pointTarget && (!Number.isFinite(pointTarget.x) || !Number.isFinite(pointTarget.y) || !current.control.rect || !pointInRect(pointTarget, current.control.rect))) {
        return { status: "refused", code: "e2b_desktop_point_outside_target" };
      }
      const switched = await activate(current, current.control.id, request.signal, current.control.role === "Window" && !pointTarget);
      if (switched) return switched;
      if (pointTarget) {
        const clicked = await clickPoint(current, pointTarget, request.signal);
        if (clicked) return clicked;
        return { status: "dispatched", focusId: current.control.id };
      }
      if (current.control.role === "Window") return { status: "dispatched", code: "window_activated", focusId: current.control.id };
      const clicked = await centerClick(current, request.signal);
      if (clicked) return clicked;
      return { status: "dispatched", focusId: current.control.id };
    }
    if (step.kind === "type" || step.kind === "setValue") {
      const text = step.kind === "type" ? step.text : step.value;
      if (!safeInput(text, maxTextLength)) return { status: "refused", code: "e2b_desktop_text_invalid" };
      if (!current.control.actions.includes(step.kind) && !current.control.actions.includes("setValue")) return { status: "refused", code: "e2b_desktop_control_not_editable" };
      if (/[^\u0000-\u007f]/u.test(text)) {
        if (step.kind !== "type" || !keyboardGrant?.processId || options.allowTemporaryClipboard !== true || !keyboardRecipient?.typeText) {
          return { status: "refused", code: "e2b_desktop_unicode_input_unavailable" };
        }
        if (current.control.role !== "Window" && !current.control.states.includes("focused")) return { status: "refused", code: "e2b_desktop_control_not_focused" };
        const delivery = await keyboardRecipient.typeText({ windowId: keyboardGrant.windowId, processId: keyboardGrant.processId, application: keyboardGrant.application, text }, { signal: request.signal });
        return delivery.status === "dispatched" ? { ...delivery, focusId: current.control.id } : delivery;
      }
      if (!desktop.write) return { status: "refused", code: "e2b_desktop_text_input_unavailable" };
      if (latestInternal.degraded) {
        if (current.control.role !== "Window" || !(await verifyKeyboardFocus(current, request.signal))) return { status: "refused", code: "e2b_desktop_keyboard_focus_unproven" };
        if (step.kind === "setValue") {
          if (!desktop.press) return { status: "refused", code: "e2b_desktop_key_input_unavailable" };
          await desktop.press(["ctrl", "a"]);
        }
        await desktop.write(step.kind === "type" ? step.text : step.value, { chunkSize: 64, delayInMs: 4 });
        return { status: "dispatched", focusId: current.control.id };
      }
      const switched = await activate(current, current.control.id, request.signal);
      if (switched) return switched;
      const clicked = await centerClick(current, request.signal);
      if (clicked) return clicked;
      if (step.kind === "setValue") {
        if (!desktop.press) return { status: "refused", code: "e2b_desktop_key_input_unavailable" };
        await desktop.press(["ctrl", "a"]);
      }
      await desktop.write(step.kind === "type" ? step.text : step.value, { chunkSize: 64, delayInMs: 4 });
      return { status: "dispatched", focusId: current.control.id };
    }
    if (step.kind === "keypress") {
      if (!desktop.press || !supportedKey(step.key)) return { status: "refused", code: "e2b_desktop_key_unsupported" };
      if (current.control.role !== "Window" && !current.control.states.includes("focused")) return { status: "refused", code: "e2b_desktop_control_not_focused" };
      const switched = await activate(current, current.control.id, request.signal);
      if (switched) return switched;
      await desktop.press(step.key);
      return { status: "dispatched", focusId: current.control.id };
    }
    if (step.kind === "hotkey") {
      if (!desktop.press || !supportedChord(step.keys)) return { status: "refused", code: "e2b_desktop_chord_unsupported" };
      if (latestInternal.degraded) {
        const chord = step.keys.map((part) => part.toLocaleLowerCase()).join("+");
        if (current.control.role !== "Window" || !SAVE_CHORDS.has(chord)) return { status: "refused", code: "e2b_desktop_chord_unsupported" };
        if (!(await verifyKeyboardFocus(current, request.signal))) return { status: "refused", code: "e2b_desktop_keyboard_focus_unproven" };
        await desktop.press(step.keys);
        return { status: "dispatched", focusId: current.control.id };
      }
      if (current.control.role !== "Window" && !current.control.states.includes("focused")) return { status: "refused", code: "e2b_desktop_control_not_focused" };
      const switched = await activate(current, current.control.id, request.signal);
      if (switched) return switched;
      await desktop.press(step.keys);
      return { status: "dispatched", focusId: current.control.id };
    }
    return { status: "refused", code: "e2b_desktop_action_unsupported" };
  }

  async function hitTest(frame: Frame, point: Point, signal?: AbortSignal): Promise<Control | undefined> {
    if (!allowPointActions || !knownFrames.has(frame)) return undefined;
    signal?.throwIfAborted();
    const internal = knownFrames.get(frame)!;
    const candidates = [...internal.controls.values()].filter((item) => (internal.degraded || item.control.role !== "Window")
      && item.control.rect && pointInRect(point, item.control.rect) && item.control.actions.includes("click"));
    if (candidates.length !== 1) return undefined;
    if (!(await verifyPointOwnership(candidates[0], point, signal))) return undefined;
    return candidates[0].control;
  }

  const backend: DesktopBackend & { readonly hitTestSnapshot: boolean; readonly activationEvents: readonly E2BDesktopActivationEvent[]; readonly capabilityMode: "atspi" | "screenshot-point-degraded" } = {
    // The live ownership probe is not evidence of which object owned a point
    // when an earlier incomplete screenshot was captured. Keep coordinates out
    // of the public session in degraded mode; host-only dispatch may still use
    // hitTest after its own final ownership check.
    capabilities: Object.freeze(actionCapabilities(allowPointActions && !allowDegradedScreenshot, pointOwnershipProof, keyboardMode)),
    allowDocumentText: false,
    hitTestSnapshot: !allowDegradedScreenshot,
    observe: (input) => enqueue(() => observe(input)),
    hitTest: (frame, point, signal) => enqueue(() => hitTest(frame, point, signal)),
    dispatch: (request) => enqueue(() => dispatch(request)),
    close: async () => {
      if (closed) return;
      closed = true;
      await worker.close?.();
      await recipient?.close?.();
      if (keyboardRecipient && (keyboardRecipient as unknown) !== (recipient as unknown)) await keyboardRecipient.close?.();
    },
    activationEvents,
    get capabilityMode() { return capabilityMode; },
  };
  return backend;

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Fixed packaged AT-SPI worker; it accepts only the bounded observe request. */
export class E2BAtSpiCommandWorker implements E2BAtSpiWorker {
  readonly #desktop: E2BDesktopSurface;
  readonly #timeoutMs: number;
  readonly #maxElements: number;
  readonly #maxOutputBytes: number;
  #source?: Promise<string>;

  constructor(desktop: E2BDesktopSurface, options: { readonly timeoutMs?: number; readonly maxElements?: number; readonly maxOutputBytes?: number } = {}) {
    if (!desktop.commands) throw desktopError("e2b_desktop_worker_unavailable");
    this.#desktop = desktop;
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 5_000, 250, MAX_TIMEOUT_MS, "e2b_desktop_timeout");
    this.#maxElements = boundedInteger(options.maxElements ?? MAX_ELEMENTS, 1, MAX_ELEMENTS, "e2b_desktop_max_elements");
    this.#maxOutputBytes = boundedInteger(options.maxOutputBytes ?? 4 * 1024 * 1024, 1024, 8 * 1024 * 1024, "e2b_desktop_worker_output_limit");
  }

  async request(request: Readonly<Record<string, unknown>>, options: { readonly signal?: AbortSignal } = {}): Promise<unknown> {
    options.signal?.throwIfAborted();
    if (request.op !== "observe" || !Array.isArray(request.windows) || request.windows.length === 0 || request.windows.length > MAX_WINDOWS) throw desktopError("e2b_desktop_worker_request_invalid");
    this.#source ??= readFile(new URL("./atspi_worker.py", import.meta.url), "utf8");
    const command = packagedWorkerCommand(await this.#source, { op: "observe", max_elements: this.#maxElements, windows: request.windows });
    let result: { stdout?: string; stderr?: string; exitCode?: number };
    result = await this.#desktop.commands!.run(command, { timeoutMs: this.#timeoutMs, requestTimeoutMs: this.#timeoutMs, signal: options.signal });
    if (typeof result.exitCode === "number" && result.exitCode !== 0) throw desktopError("e2b_desktop_worker_failed");
    const output = result.stdout ?? "";
    if (Buffer.byteLength(output, "utf8") > this.#maxOutputBytes) throw desktopError("e2b_desktop_worker_output_limit");
    if (output.includes("\uFFFD")) throw desktopError("e2b_desktop_worker_encoding");
    try { return JSON.parse(output.trim()) as unknown; }
    catch { throw desktopError("e2b_desktop_worker_invalid_json"); }
  }

  async close(): Promise<void> {
    // Each request is a short-lived fixed worker process.
  }
}

/** Fixed libX11/libXtst recipient proof worker for real screenshot-point delivery. */
export class E2BX11RecipientProcess implements E2BX11Recipient {
  readonly #desktop: E2BDesktopSurface;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  #source?: Promise<string>;

  constructor(desktop: E2BDesktopSurface, options: { readonly timeoutMs?: number; readonly maxOutputBytes?: number } = {}) {
    if (!desktop.commands) throw desktopError("e2b_x11_recipient_worker_unavailable");
    this.#desktop = desktop;
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 5_000, 250, MAX_TIMEOUT_MS, "e2b_x11_recipient_timeout");
    this.#maxOutputBytes = boundedInteger(options.maxOutputBytes ?? 512 * 1024, 1024, 2 * 1024 * 1024, "e2b_x11_recipient_output_limit");
  }

  async verify(request: Readonly<{ windowId: string; processId: number; application: string; point: Point }>, options: { readonly signal?: AbortSignal } = {}): Promise<boolean> {
    return this.request({ op: "verify", ...request }, options);
  }

  async click(request: Readonly<{ windowId: string; processId: number; application: string; point: Point }>, options: { readonly signal?: AbortSignal } = {}): Promise<boolean> {
    return this.request({ op: "click", ...request }, options);
  }

  async verifyFocus(request: Readonly<{ windowId: string; processId: number; application: string }>, options: { readonly signal?: AbortSignal } = {}): Promise<boolean> {
    return this.request({ op: "keyboard_focus", ...request }, options);
  }

  async typeText(request: Readonly<{ windowId: string; processId: number; application: string; text: string }>, options: { readonly signal?: AbortSignal } = {}): Promise<Delivery> {
    try {
      await this.request({ op: "type_text", ...request }, options);
      return { status: "dispatched" };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
      if (["x11_recipient_clipboard_busy", "x11_recipient_text_invalid", "x11_recipient_focus_foreign",
        "x11_recipient_foreign_modal", "x11_recipient_modal_blocked", "x11_recipient_modal_unproven",
        "x11_recipient_window_not_active", "x11_recipient_pid_mismatch", "x11_recipient_application_mismatch"].includes(code)) {
        return { status: "refused", code };
      }
      return { status: "unknown", code: "e2b_desktop_text_delivery_unknown" };
    }
  }

  async close(): Promise<void> {
    // Each request is a bounded, short-lived fixed worker process.
  }

  private async request(request: Readonly<Record<string, unknown>>, options: { readonly signal?: AbortSignal }): Promise<boolean> {
    options.signal?.throwIfAborted();
    const payloadValue: Record<string, unknown> = {
      op: request.op,
      window_id: request.windowId,
      process_id: request.processId,
      application: request.application,
    };
    if (request.point !== undefined) payloadValue.point = request.point;
    if (request.op === "type_text") payloadValue.text = request.text;
    this.#source ??= readFile(new URL("./x11-recipient.py", import.meta.url), "utf8");
    const command = packagedWorkerCommand(await this.#source, payloadValue);
    const result = await this.#desktop.commands!.run(command, { timeoutMs: this.#timeoutMs, requestTimeoutMs: this.#timeoutMs, signal: options.signal });
    const output = result.stdout ?? "";
    if (Buffer.byteLength(output, "utf8") > this.#maxOutputBytes || output.includes("\uFFFD")) throw desktopError("e2b_x11_recipient_output_invalid");
    let parsed: unknown;
    try { parsed = JSON.parse(output.trim()) as unknown; } catch { throw desktopError("e2b_x11_recipient_invalid_json"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw desktopError("e2b_x11_recipient_invalid_reply");
    const value = parsed as Record<string, unknown>;
    if (value.ok !== true) throw desktopError(typeof value.code === "string" ? value.code : "e2b_x11_recipient_refused");
    if (request.op === "type_text" && value.delivered !== true) throw desktopError("e2b_desktop_text_delivery_unknown");
    return true;
  }
}
