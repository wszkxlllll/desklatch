import type { Page } from "playwright-core";
import { canonicalRole } from "../../grounding.js";
import type {
  ActionKind,
  Capability,
  Control,
  Dispatch,
  Frame,
  FrameImage,
  ObserveOptions,
  Selector,
  Step,
  Target,
} from "../../contracts.js";
import {
  area,
  boundedInteger,
  containsPoint,
  createRawCollectionScript,
  hasState,
  isPoint,
  isSearchName,
  MODIFIER_KEYS,
  normalizedName,
  pagePointHit,
  publicControl,
  readApprovalContext,
  SAFE_KEYS,
  selectorFor,
  stableHash,
  toControl,
  visible,
} from "./dom.js";
import {
  BrowserBackendError,
  type BrowserBackend,
  type BrowserBackendOptions,
  type BrowserDelivery,
  type BrowserElementHandleLike,
  type BrowserPageLike,
  type FrameState,
  type InternalControl,
  type RawControl,
  DEFAULT_ACTION_TIMEOUT,
  DEFAULT_OBSERVE_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_TIMEOUT,
  DEFAULT_SETTLE,
  MAX_SCROLL_AMOUNT,
  MAX_STEP_TEXT_LENGTH,
} from "./types.js";

export type { BrowserBackend, BrowserBackendOptions, BrowserDelivery, BrowserPageLike, BrowserRiskSignal } from "./types.js";
export { BrowserBackendError } from "./types.js";
export { createLocalBrowserBackend } from "./local.js";

interface BrowserPrivateState {
  frames: WeakMap<Frame, FrameState>;
}

interface CandidateResult {
  target?: InternalControl;
  candidates: InternalControl[];
  all?: InternalControl[];
  complete?: boolean;
  point?: { x: number; y: number };
  pointOccluded?: boolean;
  handle?: BrowserElementHandleLike;
  bindingMissing?: boolean;
}

function targetOf(step: Step): Target | undefined {
  return step.kind === "drag" ? undefined : step.target;
}

function isSelectorTarget(target: Target | undefined): target is Extract<Target, { role?: string; name?: string }> {
  return Boolean(target && typeof target === "object" && !("ref" in target) && !("point" in target) && !("focusFromStep" in target));
}

function isRefTarget(target: Target | undefined): target is { ref: string } {
  return Boolean(target && typeof target === "object" && "ref" in target);
}

function isPointTarget(target: Target | undefined): target is { point: { x: number; y: number } } {
  return Boolean(target && typeof target === "object" && "point" in target);
}

function isFocusTarget(target: Target | undefined): target is { focusFromStep: number } {
  return Boolean(target && typeof target === "object" && "focusFromStep" in target);
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserBackendError("aborted");
}

function errorCode(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return fallback;
}

function pageUrl(page: BrowserPageLike): string {
  try { return page.url(); } catch { return ""; }
}

function authorizedOrigin(url: string, origins: readonly string[] | undefined, allowBlank: boolean): boolean {
  if (!url || url === "about:blank") return allowBlank;
  if (origins === undefined) return true;
  if (origins.length === 0) return false;
  try {
    const candidate = new URL(url);
    return origins.some((allowed) => {
      try {
        const permitted = new URL(allowed);
        if (candidate.origin === "null" || permitted.origin === "null") return candidate.href === permitted.href;
        return permitted.origin === candidate.origin;
      } catch { return false; }
    });
  } catch {
    return false;
  }
}

function riskFor(step: Step, control: InternalControl): import("./types.js").BrowserRiskSignal {
  if (control.sensitive) {
    return { level: "high", effect: "sensitive", requiresApproval: true, protectedField: true, reason: "protected_field" };
  }
  if (step.kind === "scroll") return { level: "low", effect: "read", requiresApproval: false, reason: "bounded_scroll" };
  if (step.kind === "type" || step.kind === "setValue") return { level: "low", effect: "edit", requiresApproval: false, reason: "public_field_edit" };
  if (control.disclosure && step.kind === "click") return { level: "low", effect: "read", requiresApproval: false, reason: "same_page_disclosure" };
  if (control.filterAction && (step.kind === "click" || (step.kind === "keypress" && step.key === "Enter"))) {
    return { level: "low", effect: "read", requiresApproval: false, reason: "scoped_search_filter" };
  }
  switch (control.effect) {
    case "financial":
    case "destructive":
    case "security":
    case "external":
      return { level: "high", effect: control.effect, requiresApproval: true, reason: `${control.effect}_action` };
    case "navigate":
      return { level: "medium", effect: "navigate", requiresApproval: true, reason: "navigation" };
    case "unknown":
      return { level: "medium", effect: "unknown", requiresApproval: true, reason: "unclassified_action" };
    default:
      return { level: "low", effect: control.effect ?? "unknown", requiresApproval: false, reason: "ordinary_control" };
  }
}

function supportsAction(kind: ActionKind, control: InternalControl): boolean {
  if (!control.actions.includes(kind)) return false;
  if (kind === "type" || kind === "setValue") return hasState(control, "editable");
  if (kind === "click" || kind === "keypress" || kind === "hotkey") return hasState(control, "visible") && hasState(control, "enabled");
  return true;
}

function supportedHotkey(keys: readonly string[]): boolean {
  const normalized = keys.map((key) => key.toLocaleLowerCase());
  const main = normalized.filter((key) => !MODIFIER_KEYS.has(key));
  const modifiers = normalized.filter((key) => MODIFIER_KEYS.has(key)).sort();
  return main.length === 1 && main[0] === "a" && (modifiers.join("+") === "ctrl" || modifiers.join("+") === "control" || modifiers.join("+") === "meta");
}

function selectorForControl(control: InternalControl): string {
  return selectorFor({ path: control.__path, key: control.__key, tagName: control.__tagName, stableKind: control.__key.startsWith("id:") ? "id" : control.__key.startsWith("testid:") ? "testid" : control.__key.startsWith("name:") ? "name" : "path" });
}

function matchesSelector(control: InternalControl, selector: Selector): boolean {
  if (!visible(control)) return false;
  if (selector.role && canonicalRole(selector.role) !== canonicalRole(control.role)) return false;
  if (selector.name && ![control.name, ...(control.labels ?? [])].some(label => normalizedName(label) === normalizedName(selector.name))) return false;
  if (selector.state && !hasState(control, selector.state)) return false;
  if (selector.within) {
    const wanted = normalizedName(selector.within);
    if (wanted !== normalizedName(control.within) && wanted !== normalizedName(control.__key) && !control.__stableKey.toLocaleLowerCase().includes(wanted)) return false;
  }
  return true;
}

function findCandidates(controls: InternalControl[], selector: Selector): InternalControl[] {
  const exact = controls.filter((control) => matchesSelector(control, selector));
  if (exact.length || !selector.name || !isSearchName(selector.name)) return exact;
  // Alias only a structurally associated filter/search control. A label such
  // as “Search and export” is not a filter authority.
  return controls.filter((control) => control.filterAction && matchesSelector(control, { ...selector, name: undefined }));
}

function pointInControl(frame: FrameState, point: { x: number; y: number }): InternalControl | undefined {
  return Array.from(frame.controls.values())
    .filter((control) => control.rect && containsPoint(control.rect, point))
    .sort((left, right) => area(left.rect) - area(right.rect))[0];
}

function frameHas(privateState: BrowserPrivateState, frame: Frame, scope: string): FrameState {
  const state = privateState.frames.get(frame);
  if (!state || state.scope !== scope || frame.scope !== scope) throw new BrowserBackendError("scope_changed");
  return state;
}

export function createBrowserBackend(page: Page, options?: BrowserBackendOptions): BrowserBackend;
export function createBrowserBackend(page: BrowserPageLike, options?: BrowserBackendOptions): BrowserBackend;
export function createBrowserBackend(page: Page | BrowserPageLike, options: BrowserBackendOptions = {}): BrowserBackend {
  const browserPage = page as unknown as BrowserPageLike;
  if (!browserPage || typeof browserPage.evaluate !== "function" || typeof browserPage.locator !== "function" || !browserPage.mouse) {
    throw new TypeError("createBrowserBackend requires a trusted Playwright Page or scoped page adapter");
  }
  const observeLimit = boundedInteger(options.observeLimit, DEFAULT_OBSERVE_LIMIT, 5_000);
  const searchLimit = boundedInteger(options.searchLimit, DEFAULT_SEARCH_LIMIT, 10_000);
  const searchTimeoutMs = boundedInteger(options.searchTimeoutMs, DEFAULT_SEARCH_TIMEOUT, 30_000);
  const settleMs = boundedInteger(options.settleMs, DEFAULT_SETTLE, 2_000);
  const actionTimeoutMs = boundedInteger(options.actionTimeoutMs, DEFAULT_ACTION_TIMEOUT, 30_000);
  const includePublicValues = options.includePublicValues === true && options.publicDataOnly !== false;
  const protectedNames = (options.protectedFieldNames ?? []).map(String);
  const authorizedOrigins = options.authorizedOrigins === undefined ? undefined : Object.freeze([...options.authorizedOrigins]);
  const allowBlank = options.allowBlank !== false;
  const allowImages = options.allowImages === true;
  const rootSelector = options.rootSelector;
  const scopePrefix = options.scope ?? "browser";
  const rawScript = createRawCollectionScript();
  const privateState: BrowserPrivateState = { frames: new WeakMap() };
  const stableIds = new Map<string, string>();
  const usedIds = new Map<string, string>();
  let identitySerial = 0;
  const identityHandles = new Map<string, { id: string; handle: BrowserElementHandleLike }>();
  const handleOwners = new WeakMap<BrowserElementHandleLike, number>();
  const retainedStates: FrameState[] = [];
  let closed = false;
  let serial = 0;
  let currentUrl = pageUrl(browserPage);
  let scope = `${scopePrefix}:${serial}:${stableHash(`${currentUrl}:${Math.random()}`)}`;

  // A pinned observation and the identity cache each own a handle until they retire independently.
  function retainHandle(handle: BrowserElementHandleLike) {
    handleOwners.set(handle, (handleOwners.get(handle) ?? 0) + 1);
  }
  async function releaseHandle(handle: BrowserElementHandleLike) {
    const owners = handleOwners.get(handle);
    if (!owners) return;
    if (owners > 1) { handleOwners.set(handle, owners - 1); return; }
    handleOwners.delete(handle);
    try { await handle.dispose?.(); } catch { /* the page may already be closed */ }
  }

  const rotateScope = () => {
    for (const state of retainedStates.splice(0)) void releaseHandles(state);
    for (const entry of identityHandles.values()) void releaseHandle(entry.handle);
    identityHandles.clear();
    serial += 1;
    stableIds.clear();
    usedIds.clear();
    scope = `${scopePrefix}:${serial}:${stableHash(`${currentUrl}:${Date.now()}:${Math.random()}`)}`;
  };
  const onNavigated = (frame?: unknown) => {
    if (closed) return;
    const main = browserPage.mainFrame?.();
    if (frame !== undefined && main !== undefined && frame !== main) return;
    currentUrl = pageUrl(browserPage);
    rotateScope();
  };
  const onClosed = () => { closed = true; };
  browserPage.on?.("framenavigated", onNavigated);
  browserPage.on?.("close", onClosed);

  function ensureUsable(): void {
    if (closed || browserPage.isClosed?.()) throw new BrowserBackendError("page_closed");
    const url = pageUrl(browserPage);
    if (url !== currentUrl) { currentUrl = url; rotateScope(); }
    if (!authorizedOrigin(url, authorizedOrigins, allowBlank)) throw new BrowserBackendError("unauthorized_origin");
  }

  async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    if (milliseconds <= 0) return;
    if (browserPage.waitForTimeout) await browserPage.waitForTimeout(milliseconds);
    else await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new BrowserBackendError("aborted")); }, { once: true });
    });
    abortIfNeeded(signal);
  }

  async function collect(limit: number, signal?: AbortSignal): Promise<{ controls: InternalControl[]; complete: boolean }> {
    ensureUsable();
    abortIfNeeded(signal);
    let result: { controls: RawControl[]; total: number };
    try {
      result = await browserPage.evaluate(rawScript, { rootSelector, includePublicValues, protectedFieldNames: protectedNames });
    } catch (error) {
      throw new BrowserBackendError(errorCode(error, "dom_observe_failed"));
    }
    const controls: InternalControl[] = [];
    const seen = new Map<string, number>();
    for (const raw of result.controls.slice(0, limit)) {
      const base = `${raw.stableKind}:${raw.key}`;
      const duplicate = seen.get(base) ?? 0;
      seen.set(base, duplicate + 1);
      const stableKey = duplicate ? `${base}:duplicate:${raw.path}` : base;
      let id = stableIds.get(stableKey);
      if (!id) {
        id = `${scope}:control:${stableHash(stableKey)}`;
        if (usedIds.has(id) && usedIds.get(id) !== stableKey) id = `${scope}:control:${stableHash(`${stableKey}:${raw.path}`)}`;
        stableIds.set(stableKey, id);
        usedIds.set(id, stableKey);
      }
      let enrichedRaw = raw;
      if (raw.approvalCandidate) {
        const locator = browserPage.locator(selectorFor({ path: raw.path, key: raw.key, tagName: raw.tagName, stableKind: raw.stableKind }));
        let handle: BrowserElementHandleLike | null | undefined;
        try {
          if (await locator.count() === 1) handle = await locator.elementHandle?.();
          const approvalContext = handle?.evaluate ? await handle.evaluate(readApprovalContext, undefined) : undefined;
          if (approvalContext) enrichedRaw = { ...raw, approvalContext };
        } finally {
          await handle?.dispose?.();
        }
      }
      controls.push(toControl(enrichedRaw, id, stableKey));
    }
    return { controls, complete: result.total <= limit };
  }

  async function locate(selector: Selector, signal?: AbortSignal): Promise<CandidateResult> {
    const deadline = Date.now() + searchTimeoutMs;
    let candidates: InternalControl[] = [];
    let all: InternalControl[] = [];
    let complete = true;
    while (Date.now() <= deadline) {
      const current = await collect(searchLimit, signal);
      all = current.controls;
      complete = current.complete;
      candidates = findCandidates(current.controls, selector);
      if (candidates.length > 1) return { candidates, all, complete };
      if (candidates.length === 1) {
        await wait(Math.min(settleMs, Math.max(0, deadline - Date.now())), signal);
        const settled = await collect(searchLimit, signal);
        all = settled.controls;
        candidates = findCandidates(settled.controls, selector);
        complete = settled.complete;
        if (candidates.length === 1) return { target: candidates[0], candidates, all, complete };
        if (candidates.length > 1) return { candidates, all, complete };
      }
      if (Date.now() >= deadline) break;
      await wait(Math.min(25, deadline - Date.now()), signal);
    }
    return { target: candidates.length === 1 ? candidates[0] : undefined, candidates, all, complete };
  }

  async function refTarget(frame: FrameState, id: string, signal?: AbortSignal): Promise<CandidateResult> {
    const old = frame.controls.get(id);
    if (!old) return { candidates: [] };
    const current = await collect(searchLimit, signal);
    const candidates = current.controls.filter((control) => control.__stableKey === old.__stableKey && visible(control));
    return {
      target: candidates.length === 1 ? candidates[0] : undefined,
      candidates,
      complete: current.complete,
      handle: candidates.length === 1 ? frame.handles.get(id) : undefined,
      bindingMissing: candidates.length === 1 && !frame.handles.has(id),
    };
  }

  async function focused(signal?: AbortSignal): Promise<InternalControl | undefined> {
    const current = await collect(searchLimit, signal);
    const candidates = current.controls.filter((control) => control.states.includes("focused"));
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  async function pointTarget(frame: FrameState, point: { x: number; y: number }, signal?: AbortSignal, originFrame = frame): Promise<CandidateResult> {
    if (!isPoint(point)) return { candidates: [] };
    const origin = pointInControl(originFrame, point);
    const path = await pagePointHit(browserPage, point);
    const current = await collect(searchLimit, signal);
    const hit = path ? current.controls.filter((control) => control.__path === path) : [];
    if (hit.length !== 1 || (origin && hit[0].__stableKey !== origin.__stableKey)) {
      return { candidates: hit, complete: current.complete, point, pointOccluded: Boolean(origin && !path) };
    }
    return { target: hit[0], candidates: hit, complete: current.complete, point, handle: frame.handles.get(hit[0].id), bindingMissing: !frame.handles.has(hit[0].id) };
  }

  async function resolveTarget(dispatch: Dispatch): Promise<CandidateResult> {
    const frame = frameHas(privateState, dispatch.frame, scope);
    const target = targetOf(dispatch.step);
    if (dispatch.target?.id && isPointTarget(target)) {
      const origin = dispatch.origin ? frameHas(privateState, dispatch.origin, scope) : frame;
      const result = await pointTarget(frame, target.point, dispatch.signal, origin);
      if (result.target && result.target.id !== dispatch.target.id) return { ...result, target: undefined, pointOccluded: false };
      return result;
    }
    if (dispatch.target?.id) {
      const bound = frame.controls.get(dispatch.target.id);
      const handle = frame.handles.get(dispatch.target.id);
      if (!bound || !handle) return { candidates: bound ? [bound] : [], bindingMissing: true };
      return { target: bound, candidates: [bound], handle };
    }
    if (dispatch.step.kind === "drag") return { candidates: [] };
    if (isSelectorTarget(target)) {
      const result = await locate(target, dispatch.signal);
      if (result.target) {
        const handle = (await browserPage.locator(selectorForControl(result.target)).elementHandle?.()) ?? undefined;
        return { ...result, handle, bindingMissing: !handle };
      }
      return result;
    }
    if (isRefTarget(target)) return refTarget(frame, target.ref, dispatch.signal);
    if (isFocusTarget(target)) {
      const focusedTarget = await focused(dispatch.signal);
      return { target: focusedTarget, candidates: focusedTarget ? [focusedTarget] : [] };
    }
    if (isPointTarget(target)) return pointTarget(frame, target.point, dispatch.signal);
    return { candidates: [] };
  }

  async function sameDomNode(previous: BrowserElementHandleLike, current: BrowserElementHandleLike): Promise<boolean> {
    try {
      return Boolean(await previous.evaluate?.((oldElement, currentElement) => oldElement === currentElement, current));
    } catch {
      return false;
    }
  }

  async function bindObservedControls(controls: readonly InternalControl[]): Promise<{ controls: InternalControl[]; handles: Map<string, BrowserElementHandleLike> }> {
    const rebound: InternalControl[] = [];
    const handles = new Map<string, BrowserElementHandleLike>();
    try {
      for (const control of controls) {
        if (control.role === "img" && control.actions.length === 0) { rebound.push(control); continue; }
        const locator = browserPage.locator(selectorForControl(control));
        const handle = await locator.elementHandle?.();
        const previous = identityHandles.get(control.__stableKey);
        if (!handle) {
          if (previous) rebound.push(control.id === previous.id ? control : { ...control, id: previous.id });
          else rebound.push(control);
          continue;
        }
        const sameNode = previous ? await sameDomNode(previous.handle, handle) : false;
        const current = identityHandles.get(control.__stableKey);
        const id = sameNode && current === previous
          ? previous!.id
          : `${scope}:control:${stableHash(`${control.__stableKey}:node:${identitySerial++}`)}`;
        if (current?.handle !== handle) retainHandle(handle);
        stableIds.set(control.__stableKey, id);
        usedIds.set(id, control.__stableKey);
        const bound = control.id === id ? control : { ...control, id };
        rebound.push(bound);
        retainHandle(handle);
        handles.set(id, handle);
        identityHandles.delete(control.__stableKey);
        identityHandles.set(control.__stableKey, { id, handle });
        if (current && current.handle !== handle) await releaseHandle(current.handle);
      }
    } catch (error) {
      await Promise.all([...handles.values()].map(releaseHandle));
      throw error;
    }
    while (identityHandles.size > searchLimit) {
      const oldest = identityHandles.keys().next().value as string | undefined;
      if (!oldest) break;
      const entry = identityHandles.get(oldest)!;
      identityHandles.delete(oldest);
      await releaseHandle(entry.handle);
    }
    return { controls: rebound, handles };
  }

  async function releaseHandles(state: FrameState): Promise<void> {
    const handles = [...state.handles.values()];
    state.handles.clear();
    await Promise.all(handles.map(releaseHandle));
  }

  function retainFrameState(state: FrameState): void {
    retainedStates.push(state);
    while (retainedStates.length > 4) {
      const oldest = retainedStates.shift();
      if (oldest) void releaseHandles(oldest);
    }
  }

  async function physicalTarget(handle: BrowserElementHandleLike, control: InternalControl, point?: { x: number; y: number }, signal?: AbortSignal) {
    abortIfNeeded(signal);
    try {
      const result = await handle.evaluate?.((element, requestedPoint) => {
        const target = element as HTMLElement;
        if (!target.isConnected) return { connected: false, actionable: false, inViewport: false, topmost: false, focused: false };
        const rect = target.getBoundingClientRect();
        const style = getComputedStyle(target);
        const actionable = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && !target.hasAttribute("disabled") && target.getAttribute("aria-disabled") !== "true";
        const x = requestedPoint?.x ?? rect.left + rect.width / 2;
        const y = requestedPoint?.y ?? rect.top + rect.height / 2;
        const top = document.elementFromPoint(x, y);
        const topmost = Boolean(top && (top === target || target.contains(top)));
        let inViewport = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
        if (!topmost) {
          for (let parent = target.parentElement; parent && inViewport; parent = parent.parentElement) {
            const clip = parent.getBoundingClientRect();
            const { overflowX, overflowY } = getComputedStyle(parent);
            if ((overflowX !== "visible" && (x < clip.left || x >= clip.right)) ||
              (overflowY !== "visible" && (y < clip.top || y >= clip.bottom))) inViewport = false;
          }
        }
        return { connected: true, actionable, inViewport, topmost, focused: document.activeElement === target };
      }, point);
      if (!result) return undefined;
      if (!control.approvalContext || !handle.evaluate) return { ...result, approvalChanged: false };
      const currentContext = await handle.evaluate(readApprovalContext, undefined);
      return { ...result, approvalChanged: currentContext?.token !== control.approvalContext.token };
    } catch {
      return undefined;
    }
  }

  async function activeId(signal?: AbortSignal): Promise<string | undefined> {
    return (await focused(signal))?.id;
  }

  async function captureImage(signal?: AbortSignal): Promise<FrameImage> {
    abortIfNeeded(signal);
    if (!allowImages) throw new BrowserBackendError("image_not_allowed");
    // A subtree grant must not silently become a full-page snapshot. The
    // host can provide a dedicated cropped Page/adapter when it wants this.
    if (rootSelector) throw new BrowserBackendError("image_scope_unsupported");
    if (!browserPage.screenshot) throw new BrowserBackendError("image_unavailable");
    const viewport = await browserPage.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const bytes = await browserPage.screenshot({ type: "png", fullPage: false });
    abortIfNeeded(signal);
    return {
      mimeType: "image/png",
      dataBase64: Buffer.from(bytes).toString("base64"),
      width: Math.max(0, Math.floor(viewport.width)),
      height: Math.max(0, Math.floor(viewport.height)),
    };
  }

  async function dispatch(request: Dispatch): Promise<BrowserDelivery> {
    let issued = false;
    try {
      ensureUsable();
      abortIfNeeded(request.signal);
      if (request.frame.scope !== scope || !privateState.frames.has(request.frame)) return { status: "refused", code: "scope_changed" };
      const step = request.step;
      if (step.kind === "drag") return { status: "refused", code: "unsupported_action" };
      if (step.kind === "type" && step.text.length > MAX_STEP_TEXT_LENGTH) return { status: "refused", code: "input_too_large" };
      if (step.kind === "setValue" && step.value.length > MAX_STEP_TEXT_LENGTH) return { status: "refused", code: "input_too_large" };
      if (step.kind === "click" && (step.button ?? "left") !== "left") return { status: "refused", code: "unsupported_button" };
      if (step.kind === "click" && (step.count ?? 1) !== 1) return { status: "refused", code: "unsupported_click_count" };
      if (step.kind === "scroll" && (!Number.isInteger(step.amount) || step.amount <= 0 || step.amount > MAX_SCROLL_AMOUNT)) return { status: "refused", code: "invalid_scroll" };
      if (step.kind === "keypress" && !SAFE_KEYS.has(step.key)) return { status: "refused", code: "unsupported_key" };
      if (step.kind === "hotkey") {
        if (step.keys.length < 2 || new Set(step.keys.map((key) => key.toLocaleLowerCase())).size !== step.keys.length) return { status: "refused", code: "invalid_hotkey" };
        if (step.keys.filter((key) => !MODIFIER_KEYS.has(key.toLocaleLowerCase())).length !== 1) return { status: "refused", code: "invalid_hotkey" };
        if (!supportedHotkey(step.keys)) return { status: "refused", code: "unsupported_hotkey" };
      }
      const resolved = await resolveTarget(request);
      if (!resolved.target) {
        if (resolved.candidates.length > 1) return { status: "refused", code: "ambiguous_target", candidates: resolved.candidates.map(publicControl) };
        return { status: "refused", code: resolved.point ? (resolved.pointOccluded ? "point_occluded" : "point_target_changed") : "target_not_found" };
      }
      if (resolved.bindingMissing || !resolved.handle) return { status: "refused", code: "target_binding_unavailable" };
      const target = resolved.target;
      if (!supportsAction(step.kind, target)) return { status: "refused", code: "action_not_supported", risk: riskFor(step, target) };
      const risk = riskFor(step, target);
      let physical = await physicalTarget(resolved.handle, target, resolved.point, request.signal);
      if (!resolved.point && physical?.connected && physical.actionable && !physical.approvalChanged
        && !physical.inViewport && resolved.handle.scrollIntoViewIfNeeded) {
        try { await resolved.handle.scrollIntoViewIfNeeded({ timeout: actionTimeoutMs }); }
        catch (error) {
          return { status: "refused", code: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "target_not_verified", risk };
        }
        physical = await physicalTarget(resolved.handle, target, undefined, request.signal);
      }
      if (!physical) return { status: "refused", code: "target_not_verified", risk };
      if (!physical.connected) return { status: "refused", code: "target_changed", risk };
      if (isFocusTarget(targetOf(step)) && !physical.focused) return { status: "refused", code: "focus_changed", risk };
      if (physical.approvalChanged) return { status: "refused", code: "approval_context_changed", risk };
      if (!physical.actionable) return { status: "refused", code: "target_not_actionable", risk };
      if ((step.kind === "click" || step.kind === "keypress" || step.kind === "hotkey" || step.kind === "type" || step.kind === "setValue") && !physical.topmost) {
        return { status: "refused", code: resolved.point ? "point_occluded" : "occluded", risk };
      }
      abortIfNeeded(request.signal);
      switch (step.kind) {
        case "click":
          if (resolved.point) { issued = true; await browserPage.mouse.click(resolved.point.x, resolved.point.y, { button: "left", clickCount: 1 }); }
          else if (resolved.handle.click) { issued = true; await resolved.handle.click({ button: "left", clickCount: 1, timeout: actionTimeoutMs }); }
          else return { status: "refused", code: "action_unavailable", risk };
          break;
        case "type":
          if (resolved.handle.pressSequentially) { issued = true; await resolved.handle.pressSequentially(step.text, { timeout: actionTimeoutMs }); }
          else if (resolved.handle.type) { issued = true; await resolved.handle.type(step.text, { timeout: actionTimeoutMs }); }
          else return { status: "refused", code: "action_unavailable", risk };
          break;
        case "setValue":
          if (resolved.handle.fill) { issued = true; await resolved.handle.fill(step.value, { timeout: actionTimeoutMs }); }
          else return { status: "refused", code: "action_unavailable", risk };
          break;
        case "keypress":
          if (resolved.handle.press) { issued = true; await resolved.handle.press(step.key, { timeout: actionTimeoutMs }); }
          else return { status: "refused", code: "action_unavailable", risk };
          break;
        case "hotkey": {
          if (!resolved.handle.press) return { status: "refused", code: "action_unavailable", risk };
          const chord = step.keys.map((key) => MODIFIER_KEYS.get(key.toLocaleLowerCase()) ?? key).join("+");
          issued = true;
          await resolved.handle.press(chord, { timeout: actionTimeoutMs });
          break;
        }
        case "scroll": {
          const amount = step.by === "page" ? step.amount * 600 : step.amount * 40;
          const top = step.direction === "up" ? -amount : step.direction === "down" ? amount : 0;
          const left = step.direction === "left" ? -amount : step.direction === "right" ? amount : 0;
          if (!resolved.handle.evaluate) return { status: "refused", code: "action_unavailable", risk };
          issued = true;
          await resolved.handle.evaluate((element, value) => (element as HTMLElement).scrollBy({ left: value.left, top: value.top, behavior: "auto" }), { left, top });
          break;
        }
        default:
          return { status: "refused", code: "unsupported_action", risk };
      }
      const focusId = await activeId(request.signal);
      return { status: "dispatched", ...(scope !== request.frame.scope ? { code: "navigation_started" } : {}), ...(focusId ? { focusId } : {}), risk };
    } catch (error) {
      if (issued) return { status: "unknown", code: errorCode(error, "dispatch_unknown") };
      if (error instanceof BrowserBackendError) return { status: "refused", code: error.code };
      return { status: "unknown", code: errorCode(error, "dispatch_failed") };
    }
  }

  async function observe(request: ObserveOptions): Promise<Frame> {
    ensureUsable();
    abortIfNeeded(request.signal);
    if (request.view !== "controls" && request.view !== "image" && request.view !== "both") throw new BrowserBackendError("invalid_view");
    await wait(settleMs, request.signal);
    let controls: InternalControl[];
    let complete: boolean;
    let handles: Map<string, BrowserElementHandleLike>;
    let scanned: InternalControl[];
    if (request.where) {
      const scoped = await locate(request.where as Selector, request.signal);
      scanned = scoped.all ?? scoped.candidates;
      const bound = await bindObservedControls(scoped.candidates.filter(visible));
      controls = bound.controls;
      handles = bound.handles;
      complete = scoped.complete ?? false;
    } else {
      const collected = await collect(observeLimit, request.signal);
      scanned = collected.controls;
      const bound = await bindObservedControls(collected.controls.filter(visible));
      controls = bound.controls;
      handles = bound.handles;
      complete = collected.complete;
    }
    try {
      const focusedControl = scanned.find(control => control.states.includes("focused"));
      const focusId = focusedControl ? (stableIds.get(focusedControl.__stableKey) ?? focusedControl.id)
        : complete ? undefined : await activeId(request.signal);
      const image = request.view === "controls" ? undefined : await captureImage(request.signal);
      const frame: Frame = { scope, controls: controls.map(publicControl), complete, ...(focusId ? { focusId } : {}), ...(image ? { image } : {}) };
      const state: FrameState = { scope, controls: new Map(controls.map((control) => [control.id, control])), handles };
      privateState.frames.set(frame, state);
      retainFrameState(state);
      return frame;
    } catch (error) {
      await Promise.all([...handles.values()].map(releaseHandle));
      throw error;
    }
  }

  async function hitTest(frame: Frame, point: { x: number; y: number }, signal?: AbortSignal): Promise<Control | undefined> {
    try {
      ensureUsable();
      frameHas(privateState, frame, scope);
      abortIfNeeded(signal);
      if (!isPoint(point)) return undefined;
      const path = await pagePointHit(browserPage, point);
      if (!path) return undefined;
      const current = await collect(searchLimit, signal);
      const hit = current.controls.filter((control) => control.__path === path);
      return hit.length === 1 ? publicControl(hit[0]) : undefined;
    } catch {
      return undefined;
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    browserPage.off?.("framenavigated", onNavigated);
    browserPage.off?.("close", onClosed);
    await Promise.all(retainedStates.splice(0).map((state) => releaseHandles(state)));
    await Promise.all([...identityHandles.values()].map(entry => releaseHandle(entry.handle)));
    identityHandles.clear();
  }

  const capabilities: readonly Capability[] = [
    { kind: "click", targets: allowImages ? ["selector", "ref", "point"] : ["selector", "ref"], buttons: ["left"], counts: [1] },
    { kind: "type", targets: ["selector", "ref", "focus"] },
    { kind: "setValue", targets: ["selector", "ref"] },
    { kind: "scroll", targets: ["selector", "ref"], directions: ["up", "down", "left", "right"], units: ["line", "page"] },
    { kind: "keypress", targets: ["selector", "ref", "focus"], keys: [...SAFE_KEYS] },
    { kind: "hotkey", targets: ["selector", "ref", "focus"], chords: [["ctrl", "a"], ["Control", "a"], ["meta", "a"], ["Meta", "a"]] },
  ];
  return Object.freeze({ capabilities, observe, hitTest, dispatch, close });
}
