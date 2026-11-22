import type { Page } from "playwright-core";
import { randomUUID } from "node:crypto";
import { canonicalRole } from "../../grounding.js";
import type {
  ActionKind,
  Capability,
  Control,
  DocumentObservation,
  DocumentRead,
  Dispatch,
  Frame,
  FrameImage,
  ObserveOptions,
  Selector,
  Step,
  Target,
} from "../../contracts.js";
import {
  boundedInteger,
  containsPoint,
  createDocumentTextScript,
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
  type BrowserJavaScriptHandleLike,
  type BrowserLocatorLike,
  type BrowserPageLike,
  type FrameState,
  type InternalControl,
  type RawControl,
  DEFAULT_ACTION_TIMEOUT,
  DEFAULT_DOCUMENT_CHUNK_LIMIT,
  DEFAULT_DOCUMENT_CHUNK_SIZE,
  DEFAULT_DOCUMENT_TEXT_LIMIT,
  DEFAULT_OBSERVE_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_TIMEOUT,
  DEFAULT_SETTLE,
  MAX_SCROLL_AMOUNT,
  MAX_STEP_TEXT_LENGTH,
  MAX_DOCUMENT_CHUNK_LIMIT,
  MAX_DOCUMENT_CHUNK_SIZE,
  MAX_DOCUMENT_TEXT_LIMIT,
  MAX_DOCUMENT_QUERY_LENGTH,
  MAX_DOCUMENT_CURSOR_LENGTH,
  MAX_DOCUMENT_CURSORS,
} from "./types.js";

export type { BrowserBackend, BrowserBackendOptions, BrowserDelivery, BrowserJavaScriptHandleLike, BrowserPageLike, BrowserRiskSignal } from "./types.js";
export { BrowserBackendError } from "./types.js";
export { createLocalBrowserBackend } from "./local.js";
export {
  createPublicBrowserWorkspace,
  isPublicAddress,
  PublicBrowserError,
} from "./public.js";
export type {
  PublicBrowserErrorCode,
  PublicBrowserOptions,
  PublicBrowserWorkspace,
} from "./public.js";
export {
  createWorkspaceNavigator,
  WorkspaceNavigationError,
} from "./workspace-navigation.js";
export type {
  WorkspaceNavigationErrorCode,
  WorkspaceNavigationOptions,
  WorkspaceNavigationResult,
  WorkspaceNavigator,
} from "./workspace-navigation.js";

const MAX_TARGET_SCAN = 20_000;
const MAX_TARGET_RESULTS = 128;
const IDENTITY_COMPARISON_CONCURRENCY = 8;
const HANDLE_RELEASE_CONCURRENCY = 8;
const MAX_NAVIGATION_RECEIPT_WAIT_MS = 2_000;

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

interface PointEvidence {
  href: string;
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  mutationGeneration: number;
  hitFingerprint: string;
  image: FrameImage;
}

interface TargetScan {
  role?: string;
  name?: string;
  within?: string;
  state?: string;
  filterActionOnly?: boolean;
  maxResults: number;
  scanLimit: number;
}

interface DocumentRouteAttestation {
  before: { href: string; baseURI: string; documentToken: string };
  after: { href: string; baseURI: string; documentToken: string };
  sameDocument: boolean;
}

interface DocumentTextEvaluation {
  chunks: string[];
  totalChars: number;
  totalChunks: number;
  truncated: boolean;
  fingerprint: string;
  nextChunk?: number;
  nextOffset?: number;
  matchCount?: number;
  nextMatch?: number;
  nextMatchOffset?: number;
  attestation?: DocumentRouteAttestation;
  routeChanged?: boolean;
}

interface DocumentCursorState {
  token: string;
  scope: string;
  href: string;
  fingerprint: string;
  query?: string;
  bounds: { maxChars: number; maxChunks: number; chunkSize: number; viewportOnly: boolean };
  nextChunk?: number;
  nextOffset?: number;
  nextMatch?: number;
  nextMatchOffset?: number;
  successor?: string;
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

async function disposeUnownedHandles(handles: readonly BrowserElementHandleLike[]): Promise<void> {
  const unique = new Set(handles);
  await Promise.all([...unique].map(async (handle) => {
    try { await handle.dispose?.(); } catch { /* a detached/closed page is already disposed */ }
  }));
}

/**
 * Acquire an attached locator snapshot without Playwright's strict locator
 * auto-wait. A missing/failed snapshot is intentionally represented as
 * `undefined`; callers must omit the corresponding public binding.
 */
async function snapshotLocatorHandles(locator: BrowserLocatorLike, signal?: AbortSignal): Promise<BrowserElementHandleLike[] | undefined> {
  let handles: BrowserElementHandleLike[] = [];
  try {
    abortIfNeeded(signal);
    if (locator.elementHandles) {
      handles = (await locator.elementHandles()) ?? [];
    } else if (locator.elementHandle) {
      // Legacy scoped adapters may expose only the singular API. Require a
      // unique count first and keep this compatibility path tightly bounded;
      // never call a strict singular lookup for duplicate matches.
      const count = await locator.count();
      abortIfNeeded(signal);
      if (count !== 1) return [];
      const handle = await locator.elementHandle({ timeout: 1 });
      if (handle) handles = [handle];
    }
    abortIfNeeded(signal);
    return handles;
  } catch (error) {
    await disposeUnownedHandles(handles);
    if (signal?.aborted) throw new BrowserBackendError("aborted");
    return undefined;
  }
}

async function snapshotSelectorsLegacy(
  page: BrowserPageLike,
  selectors: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, BrowserElementHandleLike[] | undefined>> {
  const unique = [...new Set(selectors)];
  const results = await Promise.allSettled(unique.map(async (selector) => {
    try {
      return [selector, await snapshotLocatorHandles(page.locator(selector), signal)] as const;
    } catch (error) {
      if (signal?.aborted) throw error;
      return [selector, undefined] as const;
    }
  }));
  const snapshots = new Map<string, BrowserElementHandleLike[] | undefined>();
  for (let index = 0; index < unique.length; index += 1) {
    const result = results[index];
    snapshots.set(unique[index], result?.status === "fulfilled" ? result.value[1] : undefined);
  }
  try {
    abortIfNeeded(signal);
  } catch (error) {
    await disposeUnownedHandles([...snapshots.values()].flatMap((handles) => handles ?? []));
    throw error;
  }
  return snapshots;
}

/**
 * Snapshot all selectors through one native Playwright evaluateHandle call and
 * one root getProperties call. The flattened property keys retain each
 * querySelectorAll multiplicity and order; every ElementHandle therefore
 * remains bound to the exact DOM node that was observed. Unsupported scoped
 * adapters fall back to the locator path above.
 */
async function snapshotSelectorsBatched(
  page: BrowserPageLike,
  selectors: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, BrowserElementHandleLike[]> | undefined> {
  if (typeof page.evaluateHandle !== "function") return undefined;
  const unique = [...new Set(selectors)];
  const snapshots = new Map<string, BrowserElementHandleLike[]>();
  const elements: BrowserElementHandleLike[] = [];
  const javascriptHandles: BrowserJavaScriptHandleLike[] = [];
  const pendingProperties = new Set<BrowserJavaScriptHandleLike>();
  let completed = false;
  try {
    if (unique.length === 0) {
      completed = true;
      return snapshots;
    }
    abortIfNeeded(signal);
    const root = await page.evaluateHandle((values: readonly string[]) => {
      const flattened: Record<string, Element> = Object.create(null) as Record<string, Element>;
      values.forEach((selector, selectorIndex) => {
        const matches = document.querySelectorAll(selector);
        matches.forEach((element, matchIndex) => {
          flattened[`${selectorIndex}:${matchIndex}`] = element;
        });
      });
      return flattened;
    }, unique);
    javascriptHandles.push(root);
    if (typeof root.getProperties !== "function") return undefined;
    const properties = await root.getProperties();
    for (const property of properties.values()) pendingProperties.add(property);
    const flattened = [...properties.entries()]
      .map(([key, property]) => {
        const match = /^(\d+):(\d+)$/u.exec(key);
        return match ? { selectorIndex: Number(match[1]), matchIndex: Number(match[2]), property } : undefined;
      });
    if (flattened.some(entry => entry === undefined)) {
      await Promise.all([...properties.values()].map(async property => {
        try { await property.dispose?.(); } catch { /* page closure already disposed it */ }
      }));
      pendingProperties.clear();
      return undefined;
    }
    const entries = flattened as { selectorIndex: number; matchIndex: number; property: BrowserJavaScriptHandleLike }[];
    entries.sort((left, right) => left.selectorIndex - right.selectorIndex || left.matchIndex - right.matchIndex);
    for (let index = 0; index < unique.length; index += 1) snapshots.set(unique[index], []);
    for (const entry of entries) {
      abortIfNeeded(signal);
      const expected = snapshots.get(unique[entry.selectorIndex]);
      if (!expected || entry.matchIndex !== expected.length) {
        await Promise.all([...properties.values()].map(async property => {
          try { await property.dispose?.(); } catch { /* page closure already disposed it */ }
        }));
        pendingProperties.clear();
        return undefined;
      }
      pendingProperties.delete(entry.property);
      const element = entry.property.asElement?.();
      if (!element) {
        try { await entry.property.dispose?.(); } catch { /* page closure already disposed it */ }
        return undefined;
      }
      expected.push(element);
      elements.push(element);
    }
    abortIfNeeded(signal);
    completed = true;
    return snapshots;
  } catch (error) {
    if (signal?.aborted) throw new BrowserBackendError("aborted");
    return undefined;
  } finally {
    await Promise.all(javascriptHandles.map(async handle => {
      try { await handle.dispose?.(); } catch { /* page closure already disposed it */ }
    }));
    if (!completed) await Promise.all([...pendingProperties].map(async property => {
      try { await property.dispose?.(); } catch { /* page closure already disposed it */ }
    }));
    if (!completed) await disposeUnownedHandles(elements);
  }
}

async function snapshotSelectors(
  page: BrowserPageLike,
  selectors: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, BrowserElementHandleLike[] | undefined>> {
  const batched = await snapshotSelectorsBatched(page, selectors, signal);
  if (batched !== undefined) return batched;
  return snapshotSelectorsLegacy(page, selectors, signal);
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

function navigationRoute(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return value;
  }
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

function publicSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    // Deliberately omit credentials, query parameters, and fragments. The
    // remaining origin/path is a bounded citation hint, not page navigation.
    const result = `${url.origin}${url.pathname || "/"}`;
    return result.slice(0, 2_048);
  } catch {
    return undefined;
  }
}

function documentReadBounds(read: DocumentRead | undefined, defaults: {
  maxChars: number;
  maxChunks: number;
  chunkSize: number;
}): {
  maxChars: number;
  maxChunks: number;
  chunkSize: number;
  viewportOnly: boolean;
  query?: string;
  cursor?: string;
} | undefined {
  if (read === undefined) return undefined;
  const requested = read === "document" ? {} : read;
  if (!requested || (requested.kind !== undefined && requested.kind !== "document")) throw new BrowserBackendError("invalid_document_read");
  const query = requested.query;
  const cursor = requested.cursor;
  if ((query !== undefined && (typeof query !== "string" || query.trim().length === 0 || query.length > MAX_DOCUMENT_QUERY_LENGTH))
    || (cursor !== undefined && (typeof cursor !== "string" || cursor.trim().length === 0 || cursor.length > MAX_DOCUMENT_CURSOR_LENGTH))
    || (query !== undefined && cursor !== undefined)) throw new BrowserBackendError("invalid_document_read");
  const chunkSize = boundedInteger(requested.chunkSize, defaults.chunkSize, MAX_DOCUMENT_CHUNK_SIZE);
  const maxChars = boundedInteger(requested.maxChars, defaults.maxChars, MAX_DOCUMENT_TEXT_LIMIT);
  if (query !== undefined && (query.length > chunkSize || query.length > maxChars)) throw new BrowserBackendError("invalid_document_read");
  return {
    maxChars,
    maxChunks: boundedInteger(requested.maxChunks, defaults.maxChunks, MAX_DOCUMENT_CHUNK_LIMIT),
    chunkSize,
    viewportOnly: requested.viewportOnly === true,
    ...(query === undefined ? {} : { query }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function riskFor(step: Step, control: InternalControl): import("./types.js").BrowserRiskSignal {
  if (control.sensitive) {
    return { level: "high", effect: "sensitive", requiresApproval: true, protectedField: true, reason: "protected_field" };
  }
  if (step.kind === "scroll") return { level: "low", effect: "read", requiresApproval: false, reason: "bounded_scroll" };
  if (step.kind === "type" || step.kind === "setValue") return { level: "low", effect: "edit", requiresApproval: false, reason: "public_field_edit" };
  // Structural benign markers are subordinate to the effect classification.
  // For example, a native submitter may also expose aria-expanded; only a
  // separately evidenced scoped search/filter remains a benign exception.
  const consequentialEffect = control.effect;
  if (consequentialEffect && ["financial", "destructive", "security", "external"].includes(consequentialEffect)) {
    return { level: "high", effect: consequentialEffect, requiresApproval: true, reason: `${consequentialEffect}_action` };
  }
  if (control.disclosure && step.kind === "click") return { level: "low", effect: "read", requiresApproval: false, reason: "same_page_disclosure" };
  if (control.filterAction && (step.kind === "click" || (step.kind === "keypress" && step.key === "Enter"))) {
    return { level: "low", effect: "read", requiresApproval: false, reason: "scoped_search_filter" };
  }
  switch (control.effect) {
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

function pointControls(frame: FrameState, point: { x: number; y: number }): InternalControl[] {
  return Array.from(frame.controls.values()).filter((control) => control.rect && containsPoint(control.rect, point));
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
  const skipPostNavigationFocusRefresh = options.skipPostNavigationFocusRefresh === true;
  const preferMouseNavigationClick = options.preferMouseNavigationClick === true;
  const includePublicValues = options.includePublicValues === true && options.publicDataOnly !== false;
  const protectedNames = (options.protectedFieldNames ?? []).map(String);
  const authorizedOrigins = options.authorizedOrigins === undefined ? undefined : Object.freeze([...options.authorizedOrigins]);
  const allowBlank = options.allowBlank !== false;
  const allowImages = options.allowImages === true;
  const allowDocumentText = options.allowDocumentText === true;
  const documentTextLimit = boundedInteger(options.documentTextLimit, DEFAULT_DOCUMENT_TEXT_LIMIT, MAX_DOCUMENT_TEXT_LIMIT);
  const documentChunkLimit = boundedInteger(options.documentChunkLimit, DEFAULT_DOCUMENT_CHUNK_LIMIT, MAX_DOCUMENT_CHUNK_LIMIT);
  const documentChunkSize = boundedInteger(options.documentChunkSize, DEFAULT_DOCUMENT_CHUNK_SIZE, MAX_DOCUMENT_CHUNK_SIZE);
  const rootSelector = options.rootSelector;
  const scopePrefix = options.scope ?? "browser";
  const rawScript = createRawCollectionScript();
  const documentTextScript = createDocumentTextScript();
  const privateState: BrowserPrivateState = { frames: new WeakMap() };
  const pointEvidence = new WeakMap<FrameState, PointEvidence | null>();
  const documentCursors = new Map<string, DocumentCursorState>();
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
    documentCursors.clear();
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

  async function waitForNavigationStart(beforeScope: string, beforeRoute: string, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + Math.min(actionTimeoutMs, MAX_NAVIGATION_RECEIPT_WAIT_MS);
    while (true) {
      ensureUsable();
      abortIfNeeded(signal);
      if (scope !== beforeScope && navigationRoute(pageUrl(browserPage)) !== beforeRoute) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve, reject) => {
        const delay = Math.min(25, remaining);
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new BrowserBackendError("aborted"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  async function collect(limit: number, signal?: AbortSignal, target?: TargetScan): Promise<{ controls: InternalControl[]; complete: boolean }> {
    ensureUsable();
    abortIfNeeded(signal);
    let result: { controls: RawControl[]; total: number; scanComplete?: boolean };
    try {
      result = await browserPage.evaluate(rawScript, { rootSelector, includePublicValues, protectedFieldNames: protectedNames, ...(target ? { target } : {}) });
    } catch (error) {
      throw new BrowserBackendError(errorCode(error, "dom_observe_failed"));
    }
    const controls: InternalControl[] = [];
    const seen = new Map<string, number>();
    let complete = result.total <= limit && result.scanComplete !== false;
    const boundedRaw = result.controls.slice(0, limit);
    const approvalRaw = boundedRaw.filter((raw) => raw.approvalCandidate);
    const approvalSelectors = approvalRaw.map((raw) => selectorFor({ path: raw.path, key: raw.key, tagName: raw.tagName, stableKind: raw.stableKind }));
    const approvalSnapshots = await snapshotSelectors(browserPage, approvalSelectors, signal);
    const approvalGroups = new Map<string, number>();
    for (const selector of approvalSelectors) approvalGroups.set(selector, (approvalGroups.get(selector) ?? 0) + 1);
    try {
      for (const raw of boundedRaw) {
        abortIfNeeded(signal);
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
          const selector = selectorFor({ path: raw.path, key: raw.key, tagName: raw.tagName, stableKind: raw.stableKind });
          const matches = approvalSnapshots.get(selector);
          let approvalContext: { token: string; summary?: string } | undefined;
          if (approvalGroups.get(selector) === 1 && matches?.length === 1 && matches[0].evaluate) {
            try {
              approvalContext = await matches[0].evaluate(readApprovalContext, undefined);
              abortIfNeeded(signal);
            } catch {
              if (signal?.aborted) throw new BrowserBackendError("aborted");
              approvalContext = undefined;
            }
          }
          // A consequential form control without a unique, material binding is
          // not safe to expose as an actionable ref. Keep the read useful by
          // omitting only this control and reporting an incomplete snapshot.
          if (!approvalContext) {
            complete = false;
            continue;
          }
          enrichedRaw = { ...raw, approvalContext };
        }
        controls.push(toControl(enrichedRaw, id, stableKey));
      }
    } finally {
      await disposeUnownedHandles([...approvalSnapshots.values()].flatMap((handles) => handles ?? []));
    }
    return { controls, complete };
  }

  async function readDocument(read: DocumentRead, signal?: AbortSignal): Promise<DocumentObservation> {
    ensureUsable();
    abortIfNeeded(signal);
    if (!allowDocumentText) throw new BrowserBackendError("document_not_allowed");
    let bounds = documentReadBounds(read, { maxChars: documentTextLimit, maxChunks: documentChunkLimit, chunkSize: documentChunkSize });
    if (!bounds) throw new BrowserBackendError("invalid_document_read");
    const routeBefore = pageUrl(browserPage);
    const scopeBefore = scope;
    if (!authorizedOrigin(routeBefore, authorizedOrigins, allowBlank)) throw new BrowserBackendError("unauthorized_origin");
    const cursor = bounds.cursor ? documentCursors.get(bounds.cursor) : undefined;
    if (bounds.cursor && (!cursor || cursor.scope !== scope || cursor.href !== routeBefore)) throw new BrowserBackendError("document_cursor_stale");
    if (cursor) bounds = { ...cursor.bounds, ...(cursor.query === undefined ? {} : { query: cursor.query }) };
    let result: DocumentTextEvaluation;
    try {
      result = await browserPage.evaluate(documentTextScript, {
        rootSelector, expectedHref: routeBefore,
        maxChars: bounds.maxChars, maxChunks: bounds.maxChunks, chunkSize: bounds.chunkSize, viewportOnly: bounds.viewportOnly,
        ...(bounds.query === undefined ? {} : { query: bounds.query }),
        ...(cursor?.nextChunk === undefined ? {} : { startChunk: cursor.nextChunk, startOffset: cursor.nextOffset ?? 0 }),
        ...(cursor?.nextMatch === undefined ? {} : { startMatch: cursor.nextMatch, startMatchOffset: cursor.nextMatchOffset ?? 0 }),
      });
    } catch (error) {
      throw new BrowserBackendError(errorCode(error, "document_read_failed"));
    }
    abortIfNeeded(signal);
    const routeAfter = pageUrl(browserPage);
    const attestation = result.attestation;
    const routeChanged = result.routeChanged
      || scope !== scopeBefore
      || routeBefore !== routeAfter
      || !attestation
      || !attestation.sameDocument
      || attestation.before.href !== routeBefore
      || attestation.after.href !== routeAfter
      || attestation.before.baseURI !== attestation.after.baseURI
      || attestation.before.documentToken !== attestation.after.documentToken;
    if (routeChanged) {
      // Refresh the backend's generation before refusing so a later caller
      // cannot accidentally reuse this read's stale scope.
      try { ensureUsable(); } catch { /* route rejection below is intentional */ }
      throw new BrowserBackendError("document_route_changed");
    }
    if (cursor && cursor.fingerprint !== result.fingerprint) {
      documentCursors.delete(cursor.token);
      throw new BrowserBackendError("document_cursor_stale");
    }
    if (!authorizedOrigin(routeAfter, authorizedOrigins, allowBlank)) throw new BrowserBackendError("unauthorized_origin");
    const sourceUrl = publicSourceUrl(routeAfter);
    let nextCursor: string | undefined;
    const hasContinuation = result.nextChunk !== undefined || result.nextMatch !== undefined;
    if (hasContinuation) {
      // Cursor records are immutable snapshots. Retrying the same token must
      // reproduce the same page rather than observing a position advanced by
      // another request; every continuation receives a fresh token.
      nextCursor = cursor?.successor && documentCursors.has(cursor.successor) ? cursor.successor : randomUUID();
      if (!documentCursors.has(nextCursor)) documentCursors.set(nextCursor, {
        token: nextCursor, scope, href: routeAfter, fingerprint: result.fingerprint,
        ...(bounds.query === undefined ? {} : { query: bounds.query }),
        bounds: { maxChars: bounds.maxChars, maxChunks: bounds.maxChunks, chunkSize: bounds.chunkSize, viewportOnly: bounds.viewportOnly },
        ...(result.nextChunk === undefined ? {} : { nextChunk: result.nextChunk, nextOffset: result.nextOffset ?? 0 }),
        ...(result.nextMatch === undefined ? {} : { nextMatch: result.nextMatch, nextMatchOffset: result.nextMatchOffset ?? 0 }),
      });
      if (cursor && cursor.successor !== nextCursor) cursor.successor = nextCursor;
      while (documentCursors.size > MAX_DOCUMENT_CURSORS) {
        const oldest = documentCursors.keys().next().value as string | undefined;
        if (!oldest) break;
        documentCursors.delete(oldest);
      }
    }
    return {
      kind: "page_text",
      chunks: result.chunks.map((text, index) => ({ text: text.slice(0, bounds.chunkSize), index })),
      complete: !result.truncated,
      truncated: result.truncated,
      viewportOnly: bounds.viewportOnly,
      totalChars: Math.max(0, Math.floor(result.totalChars)),
      totalChunks: Math.max(0, Math.floor(result.totalChunks)),
      ...(bounds.query === undefined ? {} : { query: bounds.query }),
      ...(result.matchCount === undefined ? {} : { matchCount: Math.max(0, Math.floor(result.matchCount)) }),
      ...(nextCursor ? { nextCursor } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }

  async function collectTargeted(selector: Selector, signal?: AbortSignal): Promise<{ controls: InternalControl[]; complete: boolean }> {
    const maxResults = Math.min(searchLimit, MAX_TARGET_RESULTS);
    const target: TargetScan = {
      ...(selector.role === undefined ? {} : { role: selector.role }),
      ...(selector.name === undefined ? {} : { name: selector.name }),
      ...(selector.within === undefined ? {} : { within: selector.within }),
      ...(selector.state === undefined ? {} : { state: selector.state }),
      maxResults,
      scanLimit: MAX_TARGET_SCAN,
    };
    const exact = await collect(maxResults, signal, target);
    let controls = exact.controls.filter((control) => matchesSelector(control, selector));
    let complete = exact.complete;
    // Search aliases remain restricted to controls that the page itself
    // structurally marked as a filter/search action. They receive the same
    // full bounded scan and never fall back to a first-page prefix.
    if (controls.length === 0 && isSearchName(selector.name)) {
      const alias = await collect(maxResults, signal, {
        ...(selector.role === undefined ? {} : { role: selector.role }),
        ...(selector.within === undefined ? {} : { within: selector.within }),
        ...(selector.state === undefined ? {} : { state: selector.state }),
        filterActionOnly: true,
        maxResults,
        scanLimit: MAX_TARGET_SCAN,
      });
      controls = alias.controls.filter((control) => control.filterAction && matchesSelector(control, { ...selector, name: undefined }));
      complete = alias.complete;
    }
    return { controls, complete };
  }

  async function locate(selector: Selector, signal?: AbortSignal): Promise<CandidateResult> {
    const deadline = Date.now() + searchTimeoutMs;
    let candidates: InternalControl[] = [];
    let all: InternalControl[] = [];
    let complete = true;
    while (Date.now() <= deadline) {
      const current = await collectTargeted(selector, signal);
      all = current.controls;
      complete = current.complete;
      candidates = current.controls;
      if (candidates.length > 1 || (candidates.length === 1 && !complete)) return { candidates, all, complete };
      if (candidates.length === 1 && complete) {
        await wait(Math.min(settleMs, Math.max(0, deadline - Date.now())), signal);
        const settled = await collectTargeted(selector, signal);
        all = settled.controls;
        candidates = settled.controls;
        complete = settled.complete;
        if (candidates.length === 1 && complete) return { target: candidates[0], candidates, all, complete };
        if (candidates.length > 1) return { candidates, all, complete };
      }
      if (Date.now() >= deadline) break;
      await wait(Math.min(25, deadline - Date.now()), signal);
    }
    return { target: candidates.length === 1 && complete ? candidates[0] : undefined, candidates, all, complete };
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

  async function uniqueHandleForSelector(selector: string, signal?: AbortSignal): Promise<BrowserElementHandleLike | undefined> {
    let matches: BrowserElementHandleLike[] | undefined;
    try {
      matches = await snapshotLocatorHandles(browserPage.locator(selector), signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      matches = undefined;
    }
    if (!matches || matches.length !== 1) {
      await disposeUnownedHandles(matches ?? []);
      return undefined;
    }
    return matches[0];
  }

  async function livePointHit(point: { x: number; y: number }, signal?: AbortSignal): Promise<InternalControl | undefined> {
    const path = await pagePointHit(browserPage, point);
    if (!path) return undefined;
    const current = await collect(searchLimit, signal);
    const hit = current.controls.filter((control) => control.__path === path);
    return hit.length === 1 ? hit[0] : undefined;
  }

  async function pointTarget(frame: FrameState, point: { x: number; y: number }, signal?: AbortSignal, originFrame = frame): Promise<CandidateResult> {
    if (!isPoint(point)) return { candidates: [] };
    const originCandidates = pointControls(originFrame, point);
    const hit = await livePointHit(point, signal);
    if (!hit) return { candidates: [], point, pointOccluded: originCandidates.length > 0 };
    const original = originCandidates.find((candidate) => candidate.id === hit.id);
    const evidence = pointEvidence.get(originFrame);
    // A browser image frame is safe for an overlapping point only when the
    // same viewport/page is still showing the byte-identical screenshot. The
    // unique-candidate path stays fast and still requires the live hit to
    // retain the original ID/handle.
    if (!original || !originFrame.handles.has(original.id)) {
      return { candidates: [hit], point, pointOccluded: originCandidates.length > 0 };
    }
    if (originCandidates.length > 1) {
      if (evidence === null || evidence === undefined || !await pointEvidenceMatches(evidence, signal)) {
        return { candidates: [hit], point, pointOccluded: true };
      }
    }
    return { target: hit, candidates: [hit], point, handle: frame.handles.get(hit.id), bindingMissing: !frame.handles.has(hit.id) };
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
        const handle = await uniqueHandleForSelector(selectorForControl(result.target), dispatch.signal);
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

  async function compareIdentityHandles(
    entries: readonly { key: string; previous: BrowserElementHandleLike; current: BrowserElementHandleLike }[],
    signal?: AbortSignal,
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = next++;
        if (index >= entries.length) return;
        const entry = entries[index];
        abortIfNeeded(signal);
        const same = entry.previous === entry.current
          ? true
          : await sameDomNode(entry.previous, entry.current);
        abortIfNeeded(signal);
        results.set(entry.key, same);
      }
    };
    const workerCount = Math.min(IDENTITY_COMPARISON_CONCURRENCY, entries.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  async function releaseHandlesConcurrently(handles: readonly BrowserElementHandleLike[]): Promise<void> {
    const counts = new Map<BrowserElementHandleLike, number>();
    for (const handle of handles) counts.set(handle, (counts.get(handle) ?? 0) + 1);
    const entries = [...counts.entries()];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = next++;
        if (index >= entries.length) return;
        const [handle, count] = entries[index];
        for (let release = 0; release < count; release += 1) await releaseHandle(handle);
      }
    };
    const workerCount = Math.min(HANDLE_RELEASE_CONCURRENCY, entries.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  async function bindObservedControls(
    controls: readonly InternalControl[],
    signal?: AbortSignal,
  ): Promise<{ controls: InternalControl[]; handles: Map<string, BrowserElementHandleLike>; complete: boolean }> {
    const rebound: InternalControl[] = [];
    const handles = new Map<string, BrowserElementHandleLike>();
    let complete = true;
    const selectorControls = new Map<string, InternalControl[]>();
    for (const control of controls) {
      if (control.role === "img" && control.actions.length === 0) continue;
      const selector = selectorForControl(control);
      const grouped = selectorControls.get(selector) ?? [];
      grouped.push(control);
      selectorControls.set(selector, grouped);
    }
    const snapshots = await snapshotSelectors(browserPage, [...selectorControls.keys()], signal);
    const fallbackSelectorByKey = new Map<string, string>();
    const fallbackSelectors = new Set<string>();
    for (const control of controls) {
      if (control.role === "img" && control.actions.length === 0) continue;
      const selector = selectorForControl(control);
      const group = selectorControls.get(selector) ?? [];
      const snapshot = snapshots.get(selector);
      // Stable id/name selectors are the fast path. If a page repeats an id
      // or name (common in hidden responsive navigation), recover this
      // already-observed node through its exact DOM path instead of dropping
      // the control from the pinned frame.
      if ((group.length !== 1 || !snapshot || snapshot.length !== 1) && control.__path) {
        fallbackSelectorByKey.set(control.__stableKey, control.__path);
        fallbackSelectors.add(control.__path);
      }
    }
    let fallbackSnapshots = new Map<string, BrowserElementHandleLike[] | undefined>();
    try {
      if (fallbackSelectors.size > 0) fallbackSnapshots = await snapshotSelectors(browserPage, [...fallbackSelectors], signal);
    } catch (error) {
      await disposeUnownedHandles([...snapshots.values()].flatMap((snapshot) => snapshot ?? []));
      throw error;
    }
    const snapshotFor = (control: InternalControl): BrowserElementHandleLike[] | undefined => {
      const fallbackSelector = fallbackSelectorByKey.get(control.__stableKey);
      return fallbackSelector === undefined
        ? snapshots.get(selectorForControl(control))
        : fallbackSnapshots.get(fallbackSelector);
    };
    const groupFor = (control: InternalControl): InternalControl[] => fallbackSelectorByKey.has(control.__stableKey)
      ? [control]
      : selectorControls.get(selectorForControl(control)) ?? [];
    const consumed = new Set<BrowserElementHandleLike>();
    const pendingIdentityRetains: BrowserElementHandleLike[] = [];
    const missingKeys = new Set<string>();
    const identityComparisons: { key: string; previous: BrowserElementHandleLike; current: BrowserElementHandleLike }[] = [];
    for (const control of controls) {
      if (control.role === "img" && control.actions.length === 0) continue;
      const group = groupFor(control);
      const snapshot = snapshotFor(control);
      const previous = identityHandles.get(control.__stableKey);
      if (group.length === 1 && snapshot?.length === 1 && previous) {
        identityComparisons.push({ key: control.__stableKey, previous: previous.handle, current: snapshot[0] });
      }
    }
    const retiredHandles: BrowserElementHandleLike[] = [];
    try {
      const sameNodes = await compareIdentityHandles(identityComparisons, signal);
      for (const control of controls) {
        abortIfNeeded(signal);
        if (control.role === "img" && control.actions.length === 0) { rebound.push(control); continue; }
        const group = groupFor(control);
        const snapshot = snapshotFor(control);
        // A stable selector and its exact-path fallback both must identify
        // one attached node before it can be pinned.
        if (group.length !== 1 || !snapshot || snapshot.length !== 1) {
          complete = false;
          missingKeys.add(control.__stableKey);
          continue;
        }
        const handle = snapshot[0];
        consumed.add(handle);
        const previous = identityHandles.get(control.__stableKey);
        const sameNode = previous ? (sameNodes.get(control.__stableKey) ?? false) : false;
        abortIfNeeded(signal);
        const current = identityHandles.get(control.__stableKey);
        const id = sameNode && current === previous
          ? previous!.id
          : `${scope}:control:${stableHash(`${control.__stableKey}:node:${identitySerial++}`)}`;
        if (current?.handle !== handle) {
          retainHandle(handle);
          pendingIdentityRetains.push(handle);
        }
        stableIds.set(control.__stableKey, id);
        usedIds.set(id, control.__stableKey);
        const bound = control.id === id ? control : { ...control, id };
        rebound.push(bound);
        retainHandle(handle);
        handles.set(id, handle);
      }
    } catch (error) {
      await Promise.all([...handles.values()].map(releaseHandle));
      await Promise.all(pendingIdentityRetains.map(releaseHandle));
      await releaseHandlesConcurrently(retiredHandles);
      await disposeUnownedHandles([...snapshots.values()].flatMap((snapshot) => (snapshot ?? []).filter((handle) => !consumed.has(handle))));
      await disposeUnownedHandles([...fallbackSnapshots.values()].flatMap((snapshot) => (snapshot ?? []).filter((handle) => !consumed.has(handle))));
      throw error;
    }
    // Commit identity changes only after the whole snapshot has been walked;
    // cancellation cannot leave a partially rebound cache behind.
    for (const control of controls) {
      if (control.role === "img" && control.actions.length === 0) continue;
      const group = groupFor(control);
      const snapshot = snapshotFor(control);
      const previous = identityHandles.get(control.__stableKey);
      if (missingKeys.has(control.__stableKey) || group.length !== 1 || !snapshot || snapshot.length !== 1) {
        if (previous) {
          identityHandles.delete(control.__stableKey);
          retiredHandles.push(previous.handle);
        }
        continue;
      }
      const handle = snapshot[0];
      const bound = rebound.find((candidate) => candidate.__stableKey === control.__stableKey);
      if (!bound) continue;
      identityHandles.delete(control.__stableKey);
      identityHandles.set(control.__stableKey, { id: bound.id, handle });
      if (previous && previous.handle !== handle) retiredHandles.push(previous.handle);
    }
    await releaseHandlesConcurrently(retiredHandles);
    await disposeUnownedHandles([...snapshots.values()].flatMap((snapshot) => (snapshot ?? []).filter((handle) => !consumed.has(handle))));
    await disposeUnownedHandles([...fallbackSnapshots.values()].flatMap((snapshot) => (snapshot ?? []).filter((handle) => !consumed.has(handle))));
    const overflowHandles: BrowserElementHandleLike[] = [];
    while (identityHandles.size > searchLimit) {
      const oldest = identityHandles.keys().next().value as string | undefined;
      if (!oldest) break;
      const entry = identityHandles.get(oldest)!;
      identityHandles.delete(oldest);
      overflowHandles.push(entry.handle);
    }
    await releaseHandlesConcurrently(overflowHandles);
    return { controls: rebound, handles, complete };
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
        return { connected: true, actionable, inViewport, topmost, focused: document.activeElement === target, point: { x, y } };
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

  async function viewportEvidence(signal?: AbortSignal): Promise<Omit<PointEvidence, "image">> {
    abortIfNeeded(signal);
    const state = await browserPage.evaluate(() => ({
      href: window.location.href,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      mutationGeneration: (() => {
        const key = "__desklatchPointEvidenceMutation";
        type MutationState = { document: Document; generation: number; observer: MutationObserver };
        const host = globalThis as typeof globalThis & { [key: string]: MutationState | undefined };
        const relevantMutation = (record: MutationRecord): boolean => record.type === "childList"
          || record.type === "characterData"
          || (record.type === "attributes" && record.attributeName !== "style" && record.attributeName !== "class");
        let current = host[key];
        if (!current || current.document !== document) {
          const next = { document, generation: 0, observer: undefined as unknown as MutationObserver };
          next.observer = new MutationObserver(records => { next.generation += records.filter(relevantMutation).length; });
          next.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          try {
            Object.defineProperty(host, key, { configurable: true, value: next });
          } catch {
            host[key] = next;
          }
          current = next;
        }
        const pending = current.observer.takeRecords();
        current.generation += pending.filter(relevantMutation).length;
        return current.generation;
      })(),
      hitFingerprint: (() => {
        const elements = Array.from(document.querySelectorAll<HTMLElement>("*"));
        const relevant: string[] = [];
        const interactiveTags = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
        for (const [index, element] of elements.entries()) {
          const style = getComputedStyle(element);
          const interactive = Boolean(element.getAttribute("role")) || interactiveTags.has(element.tagName);
          const hitRelevant = interactive
            || style.pointerEvents !== "auto"
            || style.zIndex !== "auto"
            || style.position !== "static"
            || style.opacity !== "1"
            || style.visibility !== "visible"
            || style.display === "none"
            || style.display === "contents";
          if (!hitRelevant) continue;
          const rect = element.getBoundingClientRect();
          relevant.push(`${index}:${element.tagName}:${rect.x},${rect.y},${rect.width},${rect.height}:${style.pointerEvents}:${style.zIndex}:${style.position}:${style.opacity}:${style.visibility}:${style.display}`);
        }
        let hash = 2_166_136_261;
        const text = relevant.join("|");
        for (let index = 0; index < text.length; index += 1) {
          hash ^= text.charCodeAt(index);
          hash = Math.imul(hash, 16_777_619);
        }
        return `${relevant.length}:${(hash >>> 0).toString(16)}`;
      })(),
    }));
    if (!state || typeof state.href !== "string"
      || !Number.isFinite(state.viewportWidth) || !Number.isFinite(state.viewportHeight)
      || !Number.isFinite(state.scrollX) || !Number.isFinite(state.scrollY)
      || !Number.isSafeInteger(state.mutationGeneration)) {
      throw new BrowserBackendError("point_evidence_unavailable");
    }
    return {
      href: state.href,
      viewportWidth: Math.floor(state.viewportWidth),
      viewportHeight: Math.floor(state.viewportHeight),
      scrollX: state.scrollX,
      scrollY: state.scrollY,
      mutationGeneration: state.mutationGeneration,
      hitFingerprint: state.hitFingerprint,
    };
  }

  function sameViewportEvidence(left: Omit<PointEvidence, "image">, right: Omit<PointEvidence, "image">): boolean {
    return left.href === right.href
      && left.viewportWidth === right.viewportWidth
      && left.viewportHeight === right.viewportHeight
      && left.scrollX === right.scrollX
      && left.scrollY === right.scrollY
      && left.mutationGeneration === right.mutationGeneration
      && left.hitFingerprint === right.hitFingerprint;
  }

  async function captureImageWithEvidence(signal?: AbortSignal): Promise<{ image: FrameImage; evidence?: PointEvidence }> {
    abortIfNeeded(signal);
    if (!allowImages) throw new BrowserBackendError("image_not_allowed");
    // A subtree grant must not silently become a full-page snapshot. The
    // host can provide a dedicated cropped Page/adapter when it wants this.
    if (rootSelector) throw new BrowserBackendError("image_scope_unsupported");
    if (!browserPage.screenshot) throw new BrowserBackendError("image_unavailable");
    const before = await viewportEvidence(signal);
    const bytes = await browserPage.screenshot({ type: "png", fullPage: false });
    abortIfNeeded(signal);
    const image = {
      mimeType: "image/png",
      dataBase64: Buffer.from(bytes).toString("base64"),
      width: Math.max(0, before.viewportWidth),
      height: Math.max(0, before.viewportHeight),
    };
    const after = await viewportEvidence(signal);
    return {
      image,
      ...(sameViewportEvidence(before, after) ? { evidence: { ...before, image } } : {}),
    };
  }

  async function pointEvidenceMatches(evidence: PointEvidence, signal?: AbortSignal): Promise<boolean> {
    try {
      const before = await viewportEvidence(signal);
      if (!sameViewportEvidence(before, evidence)) return false;
      if (!browserPage.screenshot) return false;
      const bytes = await browserPage.screenshot({ type: "png", fullPage: false });
      abortIfNeeded(signal);
      const after = await viewportEvidence(signal);
      if (!sameViewportEvidence(before, after)) return false;
      return Buffer.from(bytes).toString("base64") === evidence.image.dataBase64;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
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
      const beforeClickRoute = step.kind === "click" ? navigationRoute(pageUrl(browserPage)) : undefined;
      const navigationClick = skipPostNavigationFocusRefresh
        && step.kind === "click"
        && target.role === "link"
        && target.effect === "navigate"
        && target.sameDocumentTab !== true;
      abortIfNeeded(request.signal);
      switch (step.kind) {
        case "click":
          if (resolved.point) { issued = true; await browserPage.mouse.click(resolved.point.x, resolved.point.y, { button: "left", clickCount: 1 }); }
          else if (preferMouseNavigationClick && navigationClick && physical.point) {
            // Playwright's element click waits on a navigation receipt over
            // E2B CDP and can occupy the whole session deadline after the
            // event has already been physically verified. A point click keeps
            // the same target/material/approval checks above while allowing
            // the existing post-action scope/origin guard to decide whether
            // the receipt is a navigation or an unknown delivery.
            issued = true;
            await browserPage.mouse.click(physical.point.x, physical.point.y, { button: "left", clickCount: 1 });
          }
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
      // A cross-document link click invalidates the old frame scope. On the
      // E2B CDP path, refreshing focus here would scan/bind the entire new
      // page before returning the receipt and can consume the session budget.
      // The physical target and risk checks above already ran against the old
      // page; the next observation is the authoritative new scope.
      if (navigationClick) {
        // Recheck lifecycle/origin and the actual route before omitting the
        // old-scope focus lookup. Hash-only, prevented, download, and no-op
        // clicks stay on the normal focus path. Mouse delivery can return
        // before Chromium emits framenavigated, so wait briefly for the
        // observable scope/route transition without issuing a DOM scan.
        if (beforeClickRoute !== undefined
          && await waitForNavigationStart(request.frame.scope, beforeClickRoute, request.signal)) {
          return { status: "dispatched", code: "navigation_started", risk };
        }
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
    const view = request.view ?? (request.read === "document" && !request.where ? "document" : "controls");
    if (view !== "controls" && view !== "image" && view !== "both" && view !== "document") throw new BrowserBackendError("invalid_view");
    await wait(settleMs, request.signal);
    if (view === "document") {
      if (request.where) throw new BrowserBackendError("document_read_scope");
      const document = await readDocument(request.read ?? "document", request.signal);
      const frame: Frame = { scope, controls: [], complete: true, document };
      const state: FrameState = { scope, controls: new Map(), handles: new Map() };
      privateState.frames.set(frame, state);
      retainFrameState(state);
      return frame;
    }
    let controls: InternalControl[];
    let complete: boolean;
    let handles: Map<string, BrowserElementHandleLike>;
    if (request.where) {
      const scoped = await locate(request.where as Selector, request.signal);
      const bound = await bindObservedControls(scoped.candidates.filter(visible), request.signal);
      controls = bound.controls;
      handles = bound.handles;
      complete = (scoped.complete ?? false) && bound.complete;
    } else {
      const collected = await collect(observeLimit, request.signal);
      const bound = await bindObservedControls(collected.controls.filter(visible), request.signal);
      controls = bound.controls;
      handles = bound.handles;
      complete = collected.complete && bound.complete;
    }
    try {
      // Only publish a focus ref when its control survived unique binding.
      // A vanished/ambiguous focused node must not leak an unpinned ref.
      const focusedControl = controls.find(control => control.states.includes("focused"));
      const focusId = focusedControl ? (stableIds.get(focusedControl.__stableKey) ?? focusedControl.id)
        : complete ? undefined : await activeId(request.signal);
      // Document reads are explicit and never run for a selector-scoped
      // control lookup. This keeps act/expect refreshes prose-free.
      const document = request.read && !request.where ? await readDocument(request.read, request.signal) : undefined;
      const captured = view === "controls" ? undefined : await captureImageWithEvidence(request.signal);
      const image = captured?.image;
      const frame: Frame = { scope, controls: controls.map(publicControl), complete, ...(focusId ? { focusId } : {}), ...(image ? { image } : {}), ...(document ? { document } : {}) };
      const state: FrameState = { scope, controls: new Map(controls.map((control) => [control.id, control])), handles };
      privateState.frames.set(frame, state);
      if (image) pointEvidence.set(state, captured?.evidence ?? null);
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
      const state = frameHas(privateState, frame, scope);
      abortIfNeeded(signal);
      if (!isPoint(point)) return undefined;
      const hit = await livePointHit(point, signal);
      if (!hit) return undefined;
      // TargetResolver uses the same backend method for its fresh live
      // re-grounding. Only an image-bearing frame is an origin snapshot;
      // controls-only frames must not be rejected merely because their live
      // page currently has overlapping rectangles.
      if (frame.image === undefined) return publicControl(hit);
      const originalCandidates = pointControls(state, point);
      const original = originalCandidates.find((candidate) => candidate.id === hit.id);
      if (!original || !state.handles.has(original.id)) return undefined;
      if (originalCandidates.length > 1) {
        const evidence = pointEvidence.get(state);
        if (evidence === null || evidence === undefined || !await pointEvidenceMatches(evidence, signal)) return undefined;
      }
      return publicControl(original);
    } catch {
      return undefined;
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    documentCursors.clear();
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
  return Object.freeze({ allowDocumentText, supportsScopedRefRefresh: true as const, hitTestSnapshot: true as const, capabilities, observe, hitTest, dispatch, close });
}
