import { createDeskSession, type DeskSession } from "../session.js";
import { createWorkspace, createOnDemandWorkspaceApplication, type OnDemandWorkspaceApplication, type Workspace, type WorkspaceOpenedApplication } from "../workspace.js";
import { createRiskPolicy } from "../policy.js";
import type { Capability, DesktopBackend, Dispatch, Delivery, Frame, ObserveOptions, Rect, RiskInput, RiskPolicy } from "../contracts.js";
import type { ActResult, ApprovalHandler, ApprovalResolution, DeskObserveOptions, DeskObservation, DeskSessionActOptions } from "../core/session-types.js";
import { createWindowsOcrProvider, windowsOcrRegion } from "./windows-ocr.js";
import type { RapidOcrCpuRunnerOptions } from "../evidence/rapidocr.js";
import type { RapidOcrV5MobileRunner } from "../evidence/ocr.js";
import { readWindowsProductGrants as readPersistedWindowsProductGrants } from "./windows-grants.js";
import type { WindowsProductGrants } from "./windows-grants.js";
import {
  listWindowsAppWindows as listNativeWindowsAppWindows,
  restoreMinimizedWindowsAppWindow,
  verifyWindowsAppWindow as verifyNativeWindowsAppWindow,
} from "./windows-inventory.js";
import type { WindowsAppWindow } from "./windows-inventory.js";
import {
  createWindowsDesktopBackend,
  createWindowsForegroundActivator,
  CuaWindowsTransport,
  loadWindowsPhysicalInspector,
  windowsCuaCapabilities,
  type WindowsBackgroundSource,
  type WindowsCuaDriver,
  type WindowsDesktopAuthorization,
  type WindowsForegroundActivator,
  type WindowsPhysicalInspector,
  type WindowsTransport,
  type WindowsWindowTarget,
} from "../backends/windows/index.js";

/** Product-level grant file schema. App IDs, rather than window handles, are
 * the durable authorization unit. */
export type { WindowsProductGrants } from "./windows-grants.js";

/** Inventory identity supplied by the trusted Windows host. */
export type { WindowsAppWindow } from "./windows-inventory.js";

export interface WindowsProductHostTestSeams {
  readonly readWindowsProductGrants?: (file: string) => Promise<WindowsProductGrants>;
  readonly listWindowsAppWindows?: typeof listNativeWindowsAppWindows;
  readonly verifyWindowsAppWindow?: (window: WindowsAppWindow) => Promise<boolean>;
  readonly restoreMinimizedWindow?: typeof restoreMinimizedWindowsAppWindow;
  readonly transportFactory?: (context: {
    readonly app: { readonly id: string; readonly name: string };
    readonly windows: readonly WindowsAppWindow[];
    readonly grants: WindowsProductGrants;
  }) => Promise<{
    readonly transport: WindowsTransport;
    readonly inspector?: WindowsPhysicalInspector;
  }>;
  readonly policy?: RiskPolicy;
  /** Deterministic local runner seam; production uses `options.ocr`. */
  readonly ocrRunner?: RapidOcrV5MobileRunner;
}

export interface WindowsProductHostOptions {
  readonly authorizationFile: string;
  readonly onApprovalRequested?: ApprovalHandler;
  /** Explicit opt-in for local PP-OCRv5 mobile evidence. */
  readonly ocr?: RapidOcrCpuRunnerOptions;
  /** Host-owned adapter descriptors (for example, cloud-backed entries). */
  readonly extraApplications?: readonly OnDemandWorkspaceApplication[];
  /** Narrow deterministic seams; production uses the packaged grant/inventory modules. */
  readonly test?: WindowsProductHostTestSeams;
}

interface OpenedProductApplication extends WorkspaceOpenedApplication {
  readonly closeProduct?: () => Promise<void>;
}

interface ProductRuntime {
  readonly session: DeskSession;
  readonly grants: WindowsProductGrants;
  readonly windows: readonly WindowsAppWindow[];
  readonly inspector: WindowsPhysicalInspector;
  readonly foregroundActivator?: WindowsForegroundActivator;
  readonly close: () => Promise<void>;
}

const WINDOWS_BACKGROUND_SOURCE: WindowsBackgroundSource = "cua-uia-0.54";
const conditionalImport: (specifier: string) => Promise<Record<string, unknown>> =
  new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;

/**
 * Create the product Windows host. Only granted application IDs are enrolled
 * in Workspace. Each app session binds every currently verified window owned by
 * that app, including owned child dialogs, without exposing child handles as
 * separate product grants.
 */
export async function createWindowsProductHost(options: WindowsProductHostOptions): Promise<Workspace> {
  if (!options || typeof options.authorizationFile !== "string" || options.authorizationFile.trim().length === 0) {
    throw new TypeError("invalid_windows_authorization_file");
  }
  const initial = await readGrants(options, options.authorizationFile);
  const extras = Object.freeze([...(options.extraApplications ?? [])]);
  const windowsIds = new Set(initial.apps.map(app => app.id));
  if (extras.some(application => windowsIds.has(application.id))) throw productError("duplicate_workspace_application");
  const entryById = new Map<string, OnDemandWorkspaceApplication>();
  let currentGrants = initial;
  const entryFor = (app: { readonly id: string; readonly name: string }): OnDemandWorkspaceApplication => {
    const existing = entryById.get(app.id);
    if (existing) return existing;
    const entry = createOnDemandWorkspaceApplication(Object.freeze({
      id: app.id,
      name: app.name,
      get capabilities() { return productCapabilities(currentGrants); },
      get allowModelImages() { return currentGrants.allowDesktopCapture; },
      open: (signal?: AbortSignal) => openGrantedApplication(options, app, signal),
    }));
    entryById.set(app.id, entry);
    return entry;
  };
  for (const app of initial.apps) entryFor(app);
  return createWorkspace({
    applications: [...entryById.values(), ...extras],
    canAutomate: application => extras.some(extra => extra.id === application.id)
      || currentGrants.apps.some(app => app.id === application.id),
    discover: async () => {
      currentGrants = await readGrants(options, options.authorizationFile);
      return [...currentGrants.apps.map(entryFor), ...extras];
    },
  });
}

async function openGrantedApplication(
  options: WindowsProductHostOptions,
  app: { readonly id: string; readonly name: string },
  signal?: AbortSignal,
): Promise<OpenedProductApplication> {
  const grants = await readGrants(options, options.authorizationFile);
  const granted = grants.apps.find(candidate => candidate.id === app.id);
  if (!granted) throw productError("application_automation_blocked");
  // An on-demand application is opened only by an explicit activation.
  const windows = await windowsForActivation(options, app.id, grants, signal);
  if (windows.length === 0) throw productError("application_window_unavailable");
  signal?.throwIfAborted();

  let runtime = await openProductRuntime(options, granted, grants, windows, signal);
  const ensureRuntime = async (ensureSignal?: AbortSignal, activating = false): Promise<{ readonly grants: WindowsProductGrants; readonly live: readonly WindowsAppWindow[] }> => {
    const currentGrants = await readGrants(options, options.authorizationFile);
    if (!currentGrants.apps.some(candidate => candidate.id === app.id)) throw productError("application_automation_blocked");
    const live = activating
      ? await windowsForActivation(options, app.id, currentGrants, ensureSignal)
      : await verifiedAppWindows(options, app.id);
    if (live.length === 0) throw productError("application_window_unavailable");
    // A disappearing sibling is not, by itself, a reason to invalidate an
    // action aimed at another still-verified window. Rebind when a new or
    // replaced window appears (so newly opened owned dialogs become usable),
    // and let the dispatch guard verify only the exact recipient.
    if (hasNewOrReplacedWindow(live, runtime.windows)
      || runtime.grants.allowDesktopCapture !== currentGrants.allowDesktopCapture
      || allowsLocalWindowEvidence(runtime.grants) !== allowsLocalWindowEvidence(currentGrants)
      || runtime.grants.allowForegroundInput !== currentGrants.allowForegroundInput) {
      ensureSignal?.throwIfAborted();
      const replacement = await openProductRuntime(options, currentGrants.apps.find(candidate => candidate.id === app.id)!, currentGrants, live, ensureSignal);
      const previous = runtime;
      runtime = replacement;
      await previous.close();
    }
    return { grants: currentGrants, live };
  };

  const verifyFront = async (): Promise<boolean> => {
    try {
      const { grants: currentGrants, live } = await ensureRuntime();
      if (!currentGrants.allowForegroundInput) return live.length > 0;
      const verify = options.test?.verifyWindowsAppWindow ?? verifyNativeWindowsAppWindow;
      for (const window of live) {
        const latest = await readGrants(options, options.authorizationFile);
        if (!latest.apps.some(candidate => candidate.id === app.id)
          || latest.allowForegroundInput !== runtime.grants.allowForegroundInput
          || !(await verify(window))) return false;
        const evidence = await runtime.inspector.read(toWindowTarget(window));
        if (evidence?.visible && !evidence.minimized && evidence.foregroundHwnd === window.hwnd
          && (evidence.foregroundPid === undefined || evidence.foregroundPid === window.pid)) return true;
      }
    } catch {
      return false;
    }
    return false;
  };

  const activate = async (context: { readonly signal?: AbortSignal }): Promise<unknown> => {
    const { grants: currentGrants, live } = await ensureRuntime(context.signal, true);
    if (!currentGrants.allowForegroundInput) return true;
    if (!runtime.foregroundActivator) return false;
    const target = live.find(window => window.ownerHwnd === undefined) ?? live[0];
    const verify = options.test?.verifyWindowsAppWindow ?? verifyNativeWindowsAppWindow;
    const latest = await readGrants(options, options.authorizationFile);
    if (!latest.apps.some(candidate => candidate.id === app.id) || !latest.allowForegroundInput
      || !(await verify(target))) return false;
    const result = await runtime.foregroundActivator(toWindowTarget(target), { signal: context.signal });
    return result.status === "dispatched";
  };

  return {
    session: wrapProductSession(() => runtime.session, options, app.id, () => runtime.close(), async signal => { await ensureRuntime(signal); }),
    activate,
    verifyFront,
    reactivateOnFocusLoss: true,
    closeProduct: () => runtime.close(),
  };
}

async function openProductRuntime(
  options: WindowsProductHostOptions,
  app: { readonly id: string; readonly name: string },
  grants: WindowsProductGrants,
  windows: readonly WindowsAppWindow[],
  signal?: AbortSignal,
): Promise<ProductRuntime> {
  let driver: WindowsCuaDriver | undefined;
  let transport: WindowsTransport;
  let inspector: WindowsPhysicalInspector | undefined;
  let captureDriver: WindowsCuaDriver | undefined;
  let captureTransport: WindowsTransport | undefined;
  if (options.test?.transportFactory) {
    const created = await options.test.transportFactory({ app, windows, grants });
    transport = created.transport;
    inspector = created.inspector;
  } else {
    driver = await createCuaDriver();
    const opened = await CuaWindowsTransport.open(driver, `desklatch-product-${safeId(app.id)}`, signal);
    transport = opened;
    inspector = await loadWindowsPhysicalInspector();
    if (options.ocr !== undefined && allowsLocalWindowEvidence(grants)) {
      try {
        captureDriver = await createCuaDriver();
        captureTransport = await CuaWindowsTransport.open(captureDriver, `desklatch-product-${safeId(app.id)}-ocr`, signal);
      } catch {
        await captureTransport?.close?.().catch(() => undefined);
        await (captureDriver as (WindowsCuaDriver & { shutdown?: () => Promise<void> }) | undefined)?.shutdown?.().catch(() => undefined);
        captureTransport = undefined;
        captureDriver = undefined;
      }
    }
  }
  if (!inspector) {
    await transport.close?.().catch(() => undefined);
    await (driver as (WindowsCuaDriver & { shutdown?: () => Promise<void> }) | undefined)?.shutdown?.().catch(() => undefined);
    throw productError("windows_physical_inspector_unavailable");
  }

  const authorization: WindowsDesktopAuthorization = {
    targets: windows.map(toWindowTarget),
    allowDesktopCapture: grants.allowDesktopCapture,
    allowForegroundInput: grants.allowForegroundInput,
    background: { source: WINDOWS_BACKGROUND_SOURCE },
    version: grants.version.toString(),
  };
  const guardedTransport = createGrantGuardedTransport(transport, options, app.id, windows, grants, inspector.captureDesktopImage?.bind(inspector));
  const guardedCaptureTransport = captureTransport !== undefined && captureTransport !== transport
    ? createGrantGuardedTransport(captureTransport, options, app.id, windows, grants)
    : options.test?.transportFactory
      ? guardedTransport
      : {};
  const foregroundActivator: WindowsForegroundActivator | undefined = grants.allowForegroundInput
    ? createWindowsForegroundActivator(guardedTransport, inspector)
    : undefined;
  let session: DeskSession;
  try {
    const backend = await createWindowsDesktopBackend({
      transport: guardedTransport,
      inspector,
      authorization,
      ...(foregroundActivator ? { activateForeground: foregroundActivator } : {}),
    });
    const guardedBackend = createGrantGuardedBackend(backend, options, app.id, grants);
    const useLocalOcr = options.ocr !== undefined && allowsLocalWindowEvidence(grants);
    const isOfficeEditor = /^(?:winword|excel)$/iu.test(app.name);
    const policy = options.test?.policy ?? (useLocalOcr || isOfficeEditor ? createRiskPolicy({
      ...(isOfficeEditor ? { hostRules: { requireApproval: officeSaveApproval } } : {}),
      ...(useLocalOcr && options.ocr ? { ocr: createWindowsOcrProvider({
        rapidOcr: options.ocr,
        transport: guardedCaptureTransport,
        regionForInput: windowsOcrRegion,
        targetForInput: input => selectOcrTarget(options, windows, inspector!, input),
        ...(options.test?.ocrRunner === undefined ? {} : { runner: options.test.ocrRunner }),
      }),
      ocrRegion: windowsOcrRegion,
      timeoutMs: (options.ocr.timeoutMs ?? 8_000) + 2_000,
      } : {}),
    }) : undefined);
    session = createDeskSession(guardedBackend, {
      allowModelImages: grants.allowDesktopCapture,
      maxPublicControls: 128,
      onApprovalRequested: options.onApprovalRequested,
      ...(policy ? { policy } : {}),
    });
  } catch (error) {
    await transport.close?.().catch(() => undefined);
    if (captureTransport !== undefined && captureTransport !== transport) await captureTransport.close?.().catch(() => undefined);
    await (driver as (WindowsCuaDriver & { shutdown?: () => Promise<void> }) | undefined)?.shutdown?.().catch(() => undefined);
    await (captureDriver as (WindowsCuaDriver & { shutdown?: () => Promise<void> }) | undefined)?.shutdown?.().catch(() => undefined);
    throw error;
  }
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await session.close().catch(() => undefined);
    if (captureTransport !== undefined && captureTransport !== transport) await captureTransport.close?.().catch(() => undefined);
    const ownedDriver = driver as (WindowsCuaDriver & { shutdown?: () => Promise<void>; uniffiDestroy?: () => void }) | undefined;
    await ownedDriver?.shutdown?.().catch(() => undefined);
    ownedDriver?.uniffiDestroy?.();
    const ownedCaptureDriver = captureDriver as (WindowsCuaDriver & { shutdown?: () => Promise<void>; uniffiDestroy?: () => void }) | undefined;
    await ownedCaptureDriver?.shutdown?.().catch(() => undefined);
    ownedCaptureDriver?.uniffiDestroy?.();
  };
  return { session, grants, windows, inspector, foregroundActivator, close };
}

function createGrantGuardedTransport(
  transport: WindowsTransport,
  options: WindowsProductHostOptions,
  appId: string,
  windows: readonly WindowsAppWindow[],
  expectedGrants: WindowsProductGrants,
  captureDesktopImage?: WindowsPhysicalInspector["captureDesktopImage"],
): WindowsTransport {
  const authorizationLive = async (requireForeground = false, capture?: "desktop" | "window"): Promise<string | undefined> => {
    try {
      const grants = await readGrants(options, options.authorizationFile);
      if (!grants.apps.some(app => app.id === appId)) return "application_automation_blocked";
      if (capture === "desktop" && !grants.allowDesktopCapture) return "desktop_image_not_authorized";
      if (capture === "window" && !allowsLocalWindowEvidence(grants)) return "window_evidence_not_authorized";
      if (grants.allowDesktopCapture !== expectedGrants.allowDesktopCapture
        || grants.allowForegroundInput !== expectedGrants.allowForegroundInput) return "window_scope_changed";
      if (requireForeground && !grants.allowForegroundInput) return "foreground_input_not_authorized";
      return undefined;
    } catch {
      return "application_automation_blocked";
    }
  };
  const verify = options.test?.verifyWindowsAppWindow ?? verifyNativeWindowsAppWindow;
  const verifyTarget = async (target: WindowsWindowTarget): Promise<boolean> => {
    const candidate = windows.find(window => window.pid === target.pid && window.hwnd === target.hwnd);
    return candidate !== undefined && await verify(candidate);
  };
  return {
    source: transport.source,
    open: transport.open ? signal => transport.open!(signal) : undefined,
    observeWindow: async (target, callOptions) => {
      const code = await authorizationLive();
      if (code) throw productError(code);
      if (!(await verifyTarget(target))) throw productError("window_scope_changed");
      return transport.observeWindow(target, callOptions);
    },
    observeWindowImage: transport.observeWindowImage ? async (target, callOptions) => {
      const code = await authorizationLive(false, "window");
      if (code) throw productError(code);
      if (!(await verifyTarget(target))) throw productError("window_scope_changed");
      return transport.observeWindowImage!(target, callOptions);
    } : undefined,
    observeDesktopImage: captureDesktopImage || transport.observeDesktopImage ? async callOptions => {
      const code = await authorizationLive(false, "desktop");
      if (code) throw productError(code);
      return captureDesktopImage ? captureDesktopImage(callOptions.signal) : transport.observeDesktopImage!(callOptions);
    } : undefined,
    dispatch: async (step, target, callOptions) => {
      const code = await authorizationLive(target.foreground);
      if (code) return { status: "refused", code };
      if (!(await verifyTarget(target.window))) return { status: "refused", code: "window_scope_changed" };
      return transport.dispatch(step, target, callOptions);
    },
    bringToFront: transport.bringToFront ? async (target, callOptions) => {
      const code = await authorizationLive(true);
      if (code) return { status: "refused", code };
      if (!(await verifyTarget(target))) return { status: "refused", code: "window_scope_changed" };
      return transport.bringToFront!(target, callOptions);
    } : undefined,
    close: transport.close ? () => transport.close!() : undefined,
  };
}

function createGrantGuardedBackend(
  backend: DesktopBackend,
  options: WindowsProductHostOptions,
  appId: string,
  expectedGrants: WindowsProductGrants,
): DesktopBackend {
  const authorizationLive = async (): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }> => {
    try {
      const grants = await readGrants(options, options.authorizationFile);
      if (!grants.apps.some(app => app.id === appId)) return { ok: false, code: "application_automation_blocked" };
      if (grants.allowDesktopCapture !== expectedGrants.allowDesktopCapture
        || grants.allowForegroundInput !== expectedGrants.allowForegroundInput) {
        return { ok: false, code: "window_scope_changed" };
      }
      return { ok: true };
    } catch {
      return { ok: false, code: "application_automation_blocked" };
    }
  };
  return {
    capabilities: backend.capabilities,
    hitTestSnapshot: backend.hitTestSnapshot,
    observe: async (request: ObserveOptions): Promise<Frame> => {
      const authorization = await authorizationLive();
      if (!authorization.ok) throw productError(authorization.code);
      return backend.observe(request);
    },
    hitTest: backend.hitTest ? (frame, point, signal) => backend.hitTest!(frame, point, signal) : undefined,
    dispatch: async (request: Dispatch): Promise<Delivery> => {
      const authorization = await authorizationLive();
      if (!authorization.ok) return { status: "refused", code: authorization.code };
      return backend.dispatch(request);
    },
    close: () => backend.close(),
  };
}

function wrapProductSession(
  getSession: () => DeskSession,
  options: WindowsProductHostOptions,
  appId: string,
  closeProduct: () => Promise<void>,
  beforeOperation?: (signal?: AbortSignal) => Promise<void>,
): DeskSession {
  const pendingApprovals = new Map<string, { session: DeskSession; steps: ActResult["steps"] }>();
  const grantLive = async (): Promise<boolean> => {
    try {
      const grants = await readGrants(options, options.authorizationFile);
      return grants.apps.some(app => app.id === appId);
    } catch {
      return false;
    }
  };
  return {
    get capabilities() { return getSession().capabilities; },
    get allowModelImages() { return getSession().allowModelImages; },
    get allowModelDocumentText() { return getSession().allowModelDocumentText; },
    get limits() { return getSession().limits; },
    observe: async (input?: DeskObserveOptions): Promise<DeskObservation> => {
      if (!(await grantLive())) throw productError("application_automation_blocked");
      await beforeOperation?.(input?.signal);
      return getSession().observe(input);
    },
    act: async (input: unknown, signal?: AbortSignal, actOptions?: DeskSessionActOptions): Promise<ActResult> => {
      if (!(await grantLive())) {
        for (const requestId of pendingApprovals.keys()) await denyPendingApproval(requestId);
        return { status: "stopped", code: "application_automation_blocked", steps: stepsForInput(input) };
      }
      await beforeOperation?.(signal);
      const session = getSession();
      const result = await session.act(input, signal, actOptions);
      if (result.requestId && result.code === "approval_required") pendingApprovals.set(result.requestId, { session, steps: result.steps });
      return result;
    },
    resolveApproval: async (requestId: string, decision: "approve" | "deny"): Promise<ApprovalResolution> => {
      if (!(await grantLive())) {
        return denyPendingApproval(requestId);
      }
      const pending = pendingApprovals.get(requestId);
      pendingApprovals.delete(requestId);
      const session = pending?.session ?? getSession();
      const result = await session.resolveApproval(requestId, decision);
      const preserved = result.steps.length || !pending ? result : { ...result, steps: pending.steps };
      if (result.requestId && result.code === "approval_required") pendingApprovals.set(result.requestId, { session, steps: preserved.steps });
      return preserved;
    },
    correct: (reason?: string) => getSession().correct(reason),
    cancel: (reason?: string) => getSession().cancel(reason),
    close: closeProduct,
  };

  async function denyPendingApproval(requestId: string): Promise<ApprovalResolution> {
    const pending = pendingApprovals.get(requestId);
    pendingApprovals.delete(requestId);
    const denied = await (pending?.session ?? getSession()).resolveApproval(requestId, "deny").catch(() => undefined);
    return {
      requestId, status: "stopped", code: "application_automation_blocked",
      steps: denied?.steps.length ? denied.steps : pending?.steps ?? [],
    };
  }
}

function productCapabilities(grants: WindowsProductGrants): readonly Capability[] {
  return windowsCuaCapabilities({
    background: true,
    foreground: grants.allowForegroundInput && grants.allowDesktopCapture,
    keyboard: grants.allowForegroundInput,
  });
}

function allowsLocalWindowEvidence(grants: WindowsProductGrants): boolean {
  return grants.allowLocalWindowEvidence ?? grants.allowDesktopCapture;
}

function officeSaveApproval({ step, target }: RiskInput): { match: true; code: string } | false {
  const caption = target.name?.trim() ?? "";
  const saveButton = step.kind === "click" && /^(?:button|menuitem|menu item)$/iu.test(target.role)
    && /^(?:save|save as|保存|另存为)(?:\s*…|\s*\.\.\.)?$/iu.test(caption);
  const saveShortcut = step.kind === "hotkey" && target.states.includes("focused")
    && /^(?:document|edit|textbox|pane|dataitem|cell)$/iu.test(target.role)
    && /^(?:ctrl\+s|ctrl\+s\+shift)$/u.test(step.keys.map(key => key.toLowerCase().replace(/^control$/u, "ctrl")).sort().join("+"));
  return saveButton || saveShortcut ? { match: true, code: "office_document_save" } : false;
}

async function readGrants(options: WindowsProductHostOptions, file: string): Promise<WindowsProductGrants> {
  const reader = options.test?.readWindowsProductGrants ?? readPersistedWindowsProductGrants;
  return reader(file);
}

async function verifiedAppWindows(options: WindowsProductHostOptions, appId: string): Promise<readonly WindowsAppWindow[]> {
  const verify = options.test?.verifyWindowsAppWindow ?? verifyNativeWindowsAppWindow;
  const list = options.test?.listWindowsAppWindows ?? listNativeWindowsAppWindows;
  const windows = (await list())
    .filter(window => window.appId === appId && !window.minimized)
    .sort((left, right) => left.id.localeCompare(right.id));
  const verified: WindowsAppWindow[] = [];
  for (const window of windows) {
    if (await verify(window)) verified.push(window);
  }
  return verified;
}

async function windowsForActivation(
  options: WindowsProductHostOptions,
  appId: string,
  grants: WindowsProductGrants,
  signal?: AbortSignal,
): Promise<readonly WindowsAppWindow[]> {
  const windows = await verifiedAppWindows(options, appId);
  if (windows.length > 0 || !grants.allowForegroundInput) return windows;

  const list = options.test?.listWindowsAppWindows ?? listNativeWindowsAppWindows;
  const target = (await list({ includeMinimized: true })).find(window =>
    window.appId === appId && window.minimized === true && window.ownerHwnd === undefined);
  if (!target) return windows;

  const latest = await readGrants(options, options.authorizationFile);
  if (!latest.apps.some(app => app.id === appId)) throw productError("application_automation_blocked");
  if (!latest.allowForegroundInput) throw productError("foreground_input_not_authorized");
  signal?.throwIfAborted();
  const restore = options.test?.restoreMinimizedWindow ?? restoreMinimizedWindowsAppWindow;
  if (!await restore(target, signal)) throw productError("window_restore_failed");
  const live = await verifiedAppWindows(options, appId);
  if (!live.some(window => sameWindowIdentity(window, target))) throw productError("window_scope_changed");
  return live;
}

async function selectOcrTarget(
  options: WindowsProductHostOptions,
  windows: readonly WindowsAppWindow[],
  inspector: WindowsPhysicalInspector,
  input: RiskInput,
): Promise<WindowsWindowTarget | undefined> {
  const region = windowsOcrRegion(input);
  if (region === undefined) return undefined;
  const verify = options.test?.verifyWindowsAppWindow ?? verifyNativeWindowsAppWindow;
  const candidates: WindowsWindowTarget[] = [];
  for (const window of windows) {
    try {
      if (!(await verify(window))) continue;
      const target = toWindowTarget(window);
      const evidence = await inspector.read(target, centerRect(region), input.signal);
      if (!evidence?.visible || evidence.minimized || evidence.bounds === undefined) continue;
      if (!containsRect(evidence.bounds, region)) continue;
      if (evidence.occludingHwnd !== undefined && evidence.occludingHwnd !== target.hwnd) continue;
      candidates.push(target);
    } catch {
      // A disappearing or occluded window is not an OCR candidate.
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function centerRect(rect: Rect): { readonly x: number; readonly y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function createCuaDriver(): Promise<WindowsCuaDriver> {
  const module = await conditionalImport("@trycua/cua-driver");
  const CuaDriver = module.CuaDriver as { readonly create?: (value?: unknown) => WindowsCuaDriver } | undefined;
  if (!CuaDriver?.create) throw productError("cua_driver_unavailable");
  return CuaDriver.create(undefined);
}

function toWindowTarget(window: WindowsAppWindow): WindowsWindowTarget {
  return { pid: window.pid, hwnd: window.hwnd, title: window.title };
}

function hasNewOrReplacedWindow(live: readonly WindowsAppWindow[], bound: readonly WindowsAppWindow[]): boolean {
  return live.some(candidate => {
    const prior = bound.find(window => window.hwnd === candidate.hwnd && window.pid === candidate.pid);
    return prior === undefined || !sameWindowIdentity(candidate, prior);
  });
}

function sameWindowIdentity(left: WindowsAppWindow, right: WindowsAppWindow): boolean {
  return left.id === right.id
    && left.pid === right.pid
    && left.hwnd === right.hwnd
    && left.processStartedAt === right.processStartedAt
    && left.ownerHwnd === right.ownerHwnd;
}

function stepsForInput(input: unknown): readonly { readonly index: number; readonly status: "not_dispatched"; readonly code: string }[] {
  if (!input || typeof input !== "object" || !Array.isArray((input as Record<string, unknown>).steps)) return [];
  return (input as { readonly steps: readonly unknown[] }).steps.map((_step, index) => ({ index: index + 1, status: "not_dispatched" as const, code: "application_automation_blocked" }));
}

function safeId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/gu, "_");
  return normalized.length > 0 ? normalized.slice(0, 80) : "app";
}

function productError(code: string): Error & { readonly code: string } {
  const error = new Error(code) as Error & { readonly code: string };
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}
