import { createHash, randomUUID } from "node:crypto";
import { canonicalRole } from "../../grounding.js";

import {
  EndSessionInput,
  StartSessionInput,
  type ToolResult,
} from "@trycua/cua-driver";

import type {
  ActionKind,
  Capability,
  Control,
  Delivery,
  Dispatch,
  Frame,
  FrameImage,
  ObserveOptions,
  Point,
  Rect,
  Selector,
  State,
} from "../../contracts.js";
import { identifyWindow } from "./profile.js";
import {
  CuaBackgroundError,
  cuaBackgroundError,
  type CuaBackgroundBackend,
  type CuaBackgroundBackendOptions,
  type CuaWindowDriver,
  type CuaWindowTarget,
  type CuaWindowTargetInput,
  type IdentifyWindow,
} from "./types.js";

export const CUA_DRIVER_VERSION = "0.54.0";

/**
 * The narrow native surface intentionally excludes every foreground or broad
 * gesture route. The host/session may intersect these capabilities further.
 */
const CAPABILITIES: readonly Capability[] = Object.freeze([
  Object.freeze({ kind: "click", targets: ["selector", "ref", "point"] as const, buttons: ["left"] as const, counts: [1] as const }),
  Object.freeze({ kind: "type", targets: ["selector", "ref"] as const }),
  Object.freeze({ kind: "scroll", targets: ["selector", "ref"] as const, directions: ["up", "down"] as const, units: ["line"] as const }),
]);

/** Exact behavior of this leaf for controls-only observations. */
export const CUA_BACKGROUND_PROFILE = Object.freeze({
  profile: "windows-x64-wpf",
  controlsObservation: "no-screenshot",
} as const);

const PREDISPATCH_REFUSALS = new Set([
  "background_unavailable",
  "background_occluded",
  "background_uipi_blocked",
  "background_target_unavailable",
  "stale_snapshot",
  "capture_id_expired",
  "invalid_arguments",
]);
const EXCLUDED_CONTAINERS = new Set(["TitleBar", "MenuBar", "Menu", "MenuItem", "ScrollBar", "Document", "Custom"]);
const SAFE_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const DEFAULT_MAX_SCROLL_AMOUNT = 100;
const DEFAULT_MAX_TEXT_LENGTH = 16_384;

interface RawElement {
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
  readonly checked?: boolean;
  readonly password?: boolean;
  readonly inWebContent?: boolean;
  readonly actions: readonly string[];
  readonly parentIndex?: string;
  readonly token?: string;
  readonly rect?: Rect;
}

interface BoundFrame {
  readonly frame: Frame;
  readonly tokens: ReadonlyMap<string, string>;
  readonly parents: ReadonlyMap<string, string>;
  readonly disabled: ReadonlySet<string>;
  readonly captureId?: string;
}

interface PointCapture {
  readonly scope: string;
  readonly point: Point;
  readonly captureId: string;
  readonly width: number;
  readonly height: number;
  readonly controlId: string;
}

interface PreparedAction {
  readonly tool: "click" | "type_text" | "scroll";
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Open the opt-in CUA 0.54 WPF background leaf as a DeskLatch
 * `DesktopBackend`. The host must provide the already-connected driver and an
 * exact PID/HWND pair; no desktop/window discovery is performed here.
 */
export function createCuaBackgroundBackend(options: CuaBackgroundBackendOptions): Promise<CuaBackgroundBackend>;
export function createCuaBackgroundBackend(
  driver: CuaWindowDriver,
  target: CuaWindowTargetInput,
  options?: Omit<CuaBackgroundBackendOptions, "driver" | "target">,
): Promise<CuaBackgroundBackend>;
export async function createCuaBackgroundBackend(
  optionsOrDriver: CuaBackgroundBackendOptions | CuaWindowDriver,
  targetArgument?: CuaWindowTargetInput,
  legacyOptions?: Omit<CuaBackgroundBackendOptions, "driver" | "target">,
): Promise<CuaBackgroundBackend> {
  const options: CuaBackgroundBackendOptions = targetArgument === undefined
    ? optionsOrDriver as CuaBackgroundBackendOptions
    : { ...(legacyOptions ?? {}), driver: optionsOrDriver as CuaWindowDriver, target: targetArgument };
  const driver = options?.driver;
  if (!driver || typeof driver.metadata !== "function" || typeof driver.startSession !== "function"
    || typeof driver.endSession !== "function" || typeof driver.callTool !== "function") {
    throw cuaBackgroundError("cua_driver_missing");
  }
  const target = normalizeTarget(options.target);
  const maxScrollAmount = normalizeScrollLimit(options.maxScrollAmount);
  const metadata = await driver.metadata();
  if (!metadata || metadata.driverVersion !== CUA_DRIVER_VERSION) {
    throw cuaBackgroundError(
      "cua_driver_version",
      `CUA native driver ${CUA_DRIVER_VERSION} required; received ${metadata?.driverVersion ?? "unknown"}`,
    );
  }
  const identify = options.identifyWindow ?? identifyWindow;
  const identity = await identify(target);
  if (!identity) throw cuaBackgroundError("background_profile_unverified");
  const session = normalizeSession(options.session ?? `desklatch-cua-background-${randomUUID()}`);
  try {
    const started = await driver.startSession(StartSessionInput.new({ session }));
    if (!started || started.active !== true) throw cuaBackgroundError("cua_session_inactive");
    return new CuaBackgroundSession(driver, target, session, identify, identity, maxScrollAmount);
  } catch (error) {
    await driver.endSession(EndSessionInput.new({ session })).catch(() => undefined);
    throw error;
  }
}

export type {
  CuaBackgroundBackend,
  CuaBackgroundBackendOptions,
  CuaBackgroundProfile,
  CuaWindowDriver,
  CuaWindowTarget,
  CuaWindowTargetInput,
  IdentifyWindow,
} from "./types.js";
export { CuaBackgroundError, cuaBackgroundError, isCuaBackgroundError } from "./types.js";

class CuaBackgroundSession implements CuaBackgroundBackend {
  readonly capabilities = CAPABILITIES;
  readonly authorizationScope: string;

  readonly #driver: CuaWindowDriver;
  readonly #target: CuaWindowTarget;
  readonly #session: string;
  readonly #identify: IdentifyWindow;
  readonly #identity: string;
  readonly #maxScrollAmount: number;
  readonly #scopePrefix: string;
  #current?: BoundFrame;
  #pointCapture?: PointCapture;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #closing?: Promise<void>;

  constructor(
    driver: CuaWindowDriver,
    target: CuaWindowTarget,
    session: string,
    identify: IdentifyWindow,
    identity: string,
    maxScrollAmount: number,
  ) {
    this.#driver = driver;
    this.#target = target;
    this.#session = session;
    this.#identify = identify;
    this.#identity = identity;
    this.#maxScrollAmount = maxScrollAmount;
    this.#scopePrefix = `cua-background:${shortHash(`${target.pid}:${target.windowId.toString()}:${identity}`)}`;
    this.authorizationScope = this.#scopePrefix;
  }

  observe(options: ObserveOptions): Promise<Frame> {
    return this.#enqueue(async () => {
      this.#assertOpen();
      options.signal?.throwIfAborted();
      if (!(await this.#sameWindow())) throw cuaBackgroundError("window_profile_changed");
      const view = options.view;
      if (view !== "controls" && view !== "image" && view !== "both") throw cuaBackgroundError("invalid_view");
      this.#current = undefined;
      this.#pointCapture = undefined;
      const bound = await readBoundFrame(this.#driver, this.#session, this.#target, this.#scopePrefix, view, options.where, options.signal);
      this.#current = bound;
      return bound.frame;
    });
  }

  hitTest(frame: Frame, point: Point, signal?: AbortSignal): Promise<Control | undefined> {
    return this.#enqueue(async () => {
      this.#assertOpen();
      signal?.throwIfAborted();
      const current = this.#current;
      if (!current || current.frame.scope !== frame.scope || !validPoint(point)) return undefined;
      const hits = current.frame.controls.filter((control) => control.rect && contains(control.rect, point));
      const buttons = hits.filter((control) => control.actions.includes("click") && !current.disabled.has(control.id));
      if (buttons.length !== 1) return undefined;
      const button = buttons[0];
      const ancestors = new Set<string>();
      let parent = current.parents.get(button.id);
      while (parent && !ancestors.has(parent)) {
        ancestors.add(parent);
        parent = current.parents.get(parent);
      }
      if (hits.some((control) => control.id !== button.id && !ancestors.has(control.id))) return undefined;
      const capture = await capturePoint(this.#driver, this.#session, this.#target, point, signal);
      if (!capture) return undefined;
      this.#pointCapture = { ...capture, scope: frame.scope, controlId: button.id };
      return button;
    });
  }

  dispatch(request: Dispatch): Promise<Delivery> {
    return this.#enqueue(async () => {
      this.#assertOpen();
      const refuse = (code: string): Delivery => ({ status: "refused", code });
      if (request.signal?.aborted) return refuse("cancelled_before_dispatch");
      const current = this.#current;
      if (!current || current.frame.scope !== request.frame.scope) return refuse("stale_observation");
      if (!(await this.#sameWindow())) return refuse("window_profile_changed");
      let dispatched = false;
      try {
        const prepared = await this.#prepareAction(request, current);
        if (!(await this.#sameWindow())) return refuse("window_profile_changed");
        request.signal?.throwIfAborted();
        this.#current = undefined;
        this.#pointCapture = undefined;
        const args = JSON.stringify({
          target: { kind: "window", ...windowAddress(this.#target) },
          session: this.#session,
          delivery_mode: "background",
          ...prepared.fields,
        }, (_key, value) => typeof value === "bigint" ? rawBigInt(value) : value);
        dispatched = true;
        const result = await this.#driver.callTool(prepared.tool, args, request.signal ? { signal: request.signal } : undefined);
        return receiptFor(result);
      } catch (error) {
        if (!dispatched) {
          if (error instanceof CuaBackgroundError) return refuse(error.code);
          return refuse(request.signal?.aborted ? "cancelled_before_dispatch" : "background_preflight_failed");
        }
        const code = errorCode(error);
        if (code && PREDISPATCH_REFUSALS.has(code)) return refuse(code);
        return { status: "unknown", code: code ?? "driver_outcome_unknown" };
      }
    });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = this.#enqueue(async () => {
      if (this.#closed) return;
      this.#closed = true;
      this.#current = undefined;
      this.#pointCapture = undefined;
      await this.#driver.endSession(EndSessionInput.new({ session: this.#session }));
    });
    return this.#closing;
  }

  async #prepareAction(request: Dispatch, current: BoundFrame): Promise<PreparedAction> {
    const { step, target } = request;
    if (step.kind !== "click" && step.kind !== "type" && step.kind !== "scroll") {
      throw cuaBackgroundError("background_action_not_verified");
    }
    const control = current.frame.controls.find((item) => item.id === target.id);
    if (!control) throw cuaBackgroundError("control_ref_expired");
    if (current.disabled.has(control.id)) throw cuaBackgroundError("control_disabled");
    if (!control.actions.includes(step.kind)) throw cuaBackgroundError("background_control_not_verified");
    const token = current.tokens.get(control.id);

    if (step.kind === "click") {
      if ("focusFromStep" in step.target) throw cuaBackgroundError("background_target_not_verified");
      if ((step.button ?? "left") !== "left" || (step.count ?? 1) !== 1) {
        throw cuaBackgroundError("background_action_not_verified");
      }
      if ("point" in step.target) {
        if (!validPoint(step.target.point)) throw cuaBackgroundError("invalid_window_point");
        const cached = this.#pointCapture;
        const samePoint = cached && cached.scope === current.frame.scope && cached.controlId === control.id
          && cached.point.x === step.target.point.x && cached.point.y === step.target.point.y;
        const capture = samePoint ? cached : await capturePoint(this.#driver, this.#session, this.#target, step.target.point, request.signal);
        if (!capture) throw cuaBackgroundError("capture_id_unavailable");
        if (capture.point.x < 0 || capture.point.y < 0 || capture.point.x >= capture.width || capture.point.y >= capture.height) {
          throw cuaBackgroundError("invalid_window_point");
        }
        if (!control.rect || !contains(control.rect, capture.point)) throw cuaBackgroundError("background_point_not_verified");
        return {
          tool: "click",
          fields: { x: capture.point.x, y: capture.point.y, capture_id: capture.captureId, button: "left", count: 1 },
        };
      }
      if (!token) throw cuaBackgroundError("control_ref_expired");
      return { tool: "click", fields: { element_token: token, button: "left", count: 1 } };
    }

    if (!token) throw cuaBackgroundError("control_ref_expired");

    if (step.kind === "type") {
      if ("point" in step.target || "focusFromStep" in step.target) throw cuaBackgroundError("background_target_not_verified");
      if (step.text.length === 0 || step.text.length > DEFAULT_MAX_TEXT_LENGTH || SAFE_SINGLE_LINE.test(step.text)) {
        throw cuaBackgroundError("background_text_not_verified");
      }
      return { tool: "type_text", fields: { element_token: token, text: step.text } };
    }

    if ("point" in step.target || "focusFromStep" in step.target || (step.by ?? "line") !== "line" || (step.direction !== "up" && step.direction !== "down")
      || !Number.isSafeInteger(step.amount) || step.amount < 1 || step.amount > this.#maxScrollAmount) {
      throw cuaBackgroundError("background_scroll_not_verified");
    }
    return {
      tool: "scroll",
      fields: { element_token: token, direction: step.direction, amount: step.amount, by: "line" },
    };
  }

  async #sameWindow(): Promise<boolean> {
    try {
      const identity = await this.#identify(this.#target);
      return identity === this.#identity;
    } catch {
      return false;
    }
  }

  #assertOpen(): void {
    if (this.#closed || this.#closing) throw cuaBackgroundError("session_closed");
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

async function readBoundFrame(
  driver: CuaWindowDriver,
  session: string,
  target: CuaWindowTarget,
  scope: string,
  view: ObserveOptions["view"],
  where: Selector | undefined,
  signal: AbortSignal | undefined,
): Promise<BoundFrame> {
  const includeScreenshot = view !== "controls";
  const reply = await driver.callTool("get_window_state", JSON.stringify({
    ...windowAddress(target),
    session,
    full_output: true,
    include_accessibility_tree: view !== "image",
    include_screenshot: includeScreenshot,
    tree_format: "elements",
    max_elements: 256,
    max_depth: 16,
  }, (_key, value) => typeof value === "bigint" ? rawBigInt(value) : value), signal ? { signal } : undefined);
  if (reply.isError) throw cuaBackgroundError(reply.errorCode ?? "window_observation_failed");
  const raw = parseStructured(reply.structuredJson);
  if (!raw) throw cuaBackgroundError("window_observation_invalid");
  const returnedPid = positiveInteger(raw.pid);
  const returnedWindowId = parseHandle(raw.window_id ?? raw.windowId);
  if (returnedPid !== target.pid || returnedWindowId !== target.windowId) {
    throw cuaBackgroundError("window_observation_identity_mismatch");
  }

  const snapshotId = stringField(raw, "snapshot_id", "snapshotId");
  const rawElements = Array.isArray(raw.elements) ? raw.elements : [];
  const elements = rawElements.map(parseElement).filter((element): element is RawElement => element !== undefined);
  const rows = new Map(elements.map((element) => [element.index, element] as const));
  const tokens = new Map<string, string>();
  const parents = new Map<string, string>();
  const disabled = new Set<string>();
  const controls: Control[] = [];
  const idsByIndex = new Map<string, string>();
  for (const element of elements) {
    idsByIndex.set(
      element.index,
      `cua:${shortHash(`${target.pid}:${target.windowId.toString()}:${ancestryPath(element, rows)}:${element.role}:${element.label ?? ""}`)}`,
    );
  }

  for (const element of elements) {
    const controlId = idsByIndex.get(element.index);
    if (!controlId) continue;
    const parentId = element.parentIndex === undefined ? undefined : idsByIndex.get(element.parentIndex);
    const actions = inClientArea(element, rows)
      ? verifiedActions(element.role, element.actions, element.enabled, element.password)
      : [];
    const sensitive = element.password === true;
    const states = statesFor(element);
    const control: Control = Object.freeze({
      id: controlId,
      role: element.role,
      ...(element.label !== undefined && !sensitive ? { name: element.label } : {}),
      ...(parentId ? { within: parentId } : { within: `window:${target.pid}:${target.windowId.toString()}` }),
      states: Object.freeze(states),
      actions: Object.freeze(actions),
      ...(element.rect ? { rect: element.rect } : {}),
      ...(element.valueDescription && !sensitive ? { labels: Object.freeze([element.valueDescription]) } : {}),
      ...(sensitive ? { sensitive: true } : {}),
      effect: sensitive ? "sensitive" : actions.includes("type") ? "edit" : actions.includes("scroll") ? "read" : actions.length ? "unknown" : "read",
    });
    controls.push(control);
    if (parentId) parents.set(controlId, parentId);
    if (element.enabled === false) disabled.add(controlId);
    if (snapshotId && element.token && element.token.startsWith(`${snapshotId}:`)) tokens.set(controlId, element.token);
  }

  const image = includeScreenshot ? parseImage(reply, raw) : undefined;
  const treeComplete = raw.elements_complete === true && raw.truncated !== true && raw.degraded !== true
    && reply.degraded !== true && elements.length === rawElements.length;
  const complete = view === "image" ? image !== undefined : view === "both" ? treeComplete && image !== undefined : treeComplete;
  if (!image && controls.length === 0) throw cuaBackgroundError("window_observation_empty");
  const filteredControls = where ? controls.filter((control) => matchesSelector(control, where)) : controls;
  const frame: Frame = Object.freeze({
    scope,
    controls: Object.freeze(filteredControls),
    complete,
    ...(image ? { image } : {}),
  });
  return {
    frame,
    tokens,
    parents,
    disabled,
    ...(image && typeof raw.capture_id === "string" && raw.capture_id ? { captureId: raw.capture_id } : {}),
  };
}

async function capturePoint(
  driver: CuaWindowDriver,
  session: string,
  target: CuaWindowTarget,
  point: Point,
  signal?: AbortSignal,
): Promise<Omit<PointCapture, "scope" | "controlId"> | undefined> {
  if (!validPoint(point)) throw cuaBackgroundError("invalid_window_point");
  const reply = await driver.callTool("get_window_state", JSON.stringify({
    ...windowAddress(target),
    session,
    full_output: true,
    include_accessibility_tree: false,
    include_screenshot: true,
    max_elements: 256,
    max_depth: 16,
  }, (_key, value) => typeof value === "bigint" ? rawBigInt(value) : value), signal ? { signal } : undefined);
  if (reply.isError) throw cuaBackgroundError(reply.errorCode ?? "window_capture_failed");
  const raw = parseStructured(reply.structuredJson);
  if (!raw || positiveInteger(raw.pid) !== target.pid || parseHandle(raw.window_id ?? raw.windowId) !== target.windowId) {
    throw cuaBackgroundError("window_observation_identity_mismatch");
  }
  if (raw.screenshot_frame_valid === false) return undefined;
  const captureId = stringField(raw, "capture_id", "captureId");
  const image = parseImage(reply, raw);
  if (!captureId || !image) return undefined;
  if (point.x < 0 || point.y < 0 || point.x >= image.width || point.y >= image.height) {
    throw cuaBackgroundError("invalid_window_point");
  }
  return { point, captureId, width: image.width, height: image.height };
}

function verifiedActions(role: string, patterns: readonly string[], enabled: unknown, password: unknown): ActionKind[] {
  if (enabled === false || password === true) return [];
  const normalized = new Set(patterns.map((pattern) => pattern.toLocaleLowerCase().replace(/[ -]/gu, "_")));
  const lowerRole = role.toLocaleLowerCase();
  if (lowerRole === "button" && (normalized.has("invoke") || normalized.has("click") || normalized.has("press"))) return ["click"];
  if (lowerRole === "edit" && normalized.has("text") && normalized.has("set_value")) return ["type"];
  if (lowerRole === "pane" && normalized.has("scroll")) return ["scroll"];
  return [];
}

function statesFor(element: RawElement): State[] {
  const states: State[] = [];
  if (element.rect) states.push("visible");
  if (element.enabled === true) states.push("enabled");
  if (element.editable === true || element.actions.some((action) => ["text", "type", "set_value"].includes(action.toLocaleLowerCase()))) states.push("editable");
  if (element.focused === true) states.push("focused");
  if (element.checked === true) states.push("checked");
  if (element.selected === true) states.push("selected");
  return states;
}

function inClientArea(element: RawElement, rows: ReadonlyMap<string, RawElement>): boolean {
  const seen = new Set<string>();
  let current: RawElement | undefined = element;
  while (current) {
    if (current.inWebContent === true || EXCLUDED_CONTAINERS.has(current.role) || seen.has(current.index)) return false;
    if (current.parentIndex === undefined) return current.depth === 0 || current.depth === 1;
    seen.add(current.index);
    current = rows.get(current.parentIndex);
  }
  return false;
}

function matchesSelector(control: Control, selector: Selector): boolean {
  if (selector.role !== undefined && canonicalRole(control.role) !== canonicalRole(selector.role)) return false;
  if (selector.name !== undefined && control.name !== selector.name) return false;
  if (selector.state !== undefined && !control.states.includes(selector.state)) return false;
  if (selector.within !== undefined && control.within !== selector.within) return false;
  return true;
}

function ancestryPath(element: RawElement, rows: ReadonlyMap<string, RawElement>): string {
  const path: string[] = [];
  const seen = new Set<string>();
  let current: RawElement | undefined = element;
  while (current && !seen.has(current.index)) {
    seen.add(current.index);
    path.unshift(current.index);
    current = current.parentIndex === undefined ? undefined : rows.get(current.parentIndex);
  }
  return path.join("/");
}

function receiptFor(result: ToolResult): Delivery {
  const action = record(result.action);
  const code = result.errorCode ?? stringField(action, "code") ?? stringField(record(action?.error), "code");
  const effect = enumName(action?.effect, ["confirmed", "partial", "unverifiable", "suspected_noop", "refused"]);
  const route = enumName(action?.route, ["accessibility", "synthetic_events", "global_input", "system_api", "dom", "trusted_input"]);
  const mode = enumName(action?.delivery?.mode, ["background", "foreground", "not_applicable", "unknown"]);
  const deliveredCount = positiveInteger(action?.delivery?.delivered_count ?? action?.delivery?.deliveredCount) ?? 0;
  if (effect === "partial") return { status: "partial", ...(code ? { code } : {}) };
  if ((result.isError || effect === "refused") && deliveredCount > 0) return { status: "unknown", code: code ?? "some_input_may_have_landed" };
  if (effect === "refused" || (result.isError && code && PREDISPATCH_REFUSALS.has(code))) return { status: "refused", ...(code ? { code } : {}) };
  if (result.isError || !action) return { status: "unknown", code: code ?? "driver_outcome_unknown" };
  if (mode !== "background" || route === "global_input") return { status: "unknown", code: code ?? "background_delivery_unconfirmed" };
  if (effect !== "confirmed" && effect !== "unverifiable") return { status: "unknown", code: code ?? "driver_effect_unconfirmed" };
  return { status: "dispatched", ...(code ? { code } : {}) };
}

function parseElement(value: unknown): RawElement | undefined {
  const item = record(value);
  if (!item) return undefined;
  const role = stringField(item, "role");
  const index = integerString(item.element_index ?? item.elementIndex);
  const depth = nonNegativeInteger(item.depth);
  if (!role || index === undefined || depth === undefined) return undefined;
  const screenshotFrame = parseRect(item.screenshot_frame ?? item.screenshotFrame);
  const frame = parseRect(item.frame ?? item.bounding_rect ?? item.boundingRect);
  const actions = Array.isArray(item.actions) ? item.actions.filter((action): action is string => typeof action === "string") : [];
  const parentIndex = integerString(item.parent_index ?? item.parentIndex);
  return {
    index,
    depth,
    role,
    ...(stringField(item, "label", "name", "title") ? { label: stringField(item, "label", "name", "title") } : {}),
    ...(stringField(item, "value") !== undefined ? { value: stringField(item, "value") } : {}),
    ...(stringField(item, "value_description", "valueDescription") ? { valueDescription: stringField(item, "value_description", "valueDescription") } : {}),
    ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
    ...(typeof item.editable === "boolean" ? { editable: item.editable } : {}),
    ...(typeof item.selected === "boolean" ? { selected: item.selected } : {}),
    ...(typeof item.focused === "boolean" ? { focused: item.focused } : {}),
    ...(typeof item.checked === "boolean" ? { checked: item.checked } : {}),
    ...(typeof item.is_password === "boolean" ? { password: item.is_password } : typeof item.isPassword === "boolean" ? { password: item.isPassword } : {}),
    ...(typeof item.in_web_content === "boolean" ? { inWebContent: item.in_web_content } : typeof item.inWebContent === "boolean" ? { inWebContent: item.inWebContent } : {}),
    actions: Object.freeze(actions),
    ...(parentIndex !== undefined ? { parentIndex } : {}),
    ...(frame ? { rect: frame } : screenshotFrame ? { rect: screenshotFrame } : {}),
    ...(stringField(item, "element_token", "elementToken") ? { token: stringField(item, "element_token", "elementToken") } : {}),
  };
}

function parseImage(result: ToolResult, raw: Record<string, unknown>): FrameImage | undefined {
  const image = result.images?.[0];
  const width = positiveInteger(raw.screenshot_width ?? raw.screenshotWidth ?? raw.width);
  const height = positiveInteger(raw.screenshot_height ?? raw.screenshotHeight ?? raw.height);
  if (!image || typeof image.mimeType !== "string" || typeof image.dataBase64 !== "string" || image.dataBase64.length === 0
    || width === undefined || height === undefined) return undefined;
  return Object.freeze({ mimeType: image.mimeType, dataBase64: image.dataBase64, width, height });
}

function parseStructured(source: string | undefined): Record<string, unknown> | undefined {
  if (typeof source !== "string") return undefined;
  try {
    const parsed = JSON.parse(source, (key, value, context?: { source?: string }) => {
      if (key === "window_id" && typeof value === "number" && context?.source && /^\d+$/u.test(context.source)) {
        return BigInt(context.source);
      }
      return value;
    });
    return record(parsed);
  } catch {
    return undefined;
  }
}

function normalizeTarget(input: CuaWindowTargetInput): CuaWindowTarget {
  if (!input || !Number.isSafeInteger(input.pid) || input.pid <= 0 || input.pid > 0xffff_ffff) {
    throw cuaBackgroundError("invalid_window_identity");
  }
  const windowId = parseHandle(input.windowId ?? input.window_id ?? input.hwnd);
  if (windowId === undefined) throw cuaBackgroundError("invalid_window_identity");
  return Object.freeze({ pid: input.pid, windowId });
}

function normalizeSession(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || SAFE_SINGLE_LINE.test(value)) {
    throw cuaBackgroundError("invalid_cua_session");
  }
  return value;
}

function normalizeScrollLimit(value: number | undefined): number {
  const result = value ?? DEFAULT_MAX_SCROLL_AMOUNT;
  if (!Number.isSafeInteger(result) || result < 1 || result > 1000) throw cuaBackgroundError("invalid_scroll_limit");
  return result;
}

function windowAddress(target: CuaWindowTarget): { pid: number; window_id: unknown } {
  return { pid: target.pid, window_id: rawBigInt(target.windowId) };
}

function rawBigInt(value: bigint): unknown {
  const nativeJson = JSON as typeof JSON & { rawJSON?: (source: string) => object };
  return nativeJson.rawJSON ? nativeJson.rawJSON(value.toString()) : value.toString();
}

function parseHandle(value: unknown): bigint | undefined {
  if (typeof value === "bigint" && value > 0n && value <= 0xffff_ffff_ffff_ffffn) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    try {
      const parsed = BigInt(value);
      return parsed > 0n && parsed <= 0xffff_ffff_ffff_ffffn ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
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

function validPoint(point: Point | undefined): point is Point {
  return !!point && Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y);
}

function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}

function record(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function stringField(value: unknown, ...keys: string[]): string | undefined {
  const item = record(value);
  if (!item) return undefined;
  for (const key of keys) if (typeof item[key] === "string") return item[key];
  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function integerString(value: unknown): string | undefined {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) return value;
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  const inner = record(item.inner);
  return typeof inner?.errorCode === "string" ? inner.errorCode : undefined;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}
