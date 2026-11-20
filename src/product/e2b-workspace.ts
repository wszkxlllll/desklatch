import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Capability, DesktopBackend } from "../contracts.js";
import { defaultRiskPolicy } from "../policy.js";
import { createDeskSession, type ApprovalHandler } from "../session.js";
import {
  createBrowserBackend,
  createWorkspaceNavigator,
  type BrowserBackend,
  type BrowserBackendOptions,
  type WorkspaceNavigationResult,
} from "../backends/browser/index.js";
import type { E2BDesktopSurface, E2BGuest, E2BX11KeyboardRecipient, E2BX11Recipient, E2BWindowGrant } from "../backends/e2b/index.js";
import {
  createOnDemandWorkspaceApplication,
  type OnDemandWorkspaceApplication,
  type WorkspaceApplication,
} from "../workspace.js";

const DEFAULT_GUEST_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_GUEST_TIMEOUT_MS = 60 * 60 * 1_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const MAX_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_NAVIGATION_TIMEOUT_MS = 120_000;
const MAX_ORIGINS = 64;
const MAX_METADATA_ITEMS = 32;
const MAX_METADATA_TEXT = 256;
const PRODUCT_APPLICATION_IDS = Object.freeze({ writer: "e2b-writer", browser: "e2b-browser" });
const DEFAULT_BROWSER_ORIGINS = Object.freeze(["https://docs.python.org"]);

const WRITER_CAPABILITIES: readonly Capability[] = Object.freeze([
  Object.freeze({ kind: "click", targets: ["selector", "ref"], buttons: ["left"], counts: [1] } as const),
  Object.freeze({ kind: "type", targets: ["selector", "ref"] } as const),
  Object.freeze({ kind: "hotkey", targets: ["selector", "ref"], chords: [["ctrl", "s"], ["Control", "s"]] } as const),
]);

const BROWSER_CAPABILITIES: readonly Capability[] = Object.freeze([
  Object.freeze({ kind: "click", targets: ["selector", "ref", "point"], buttons: ["left"], counts: [1] } as const),
  Object.freeze({ kind: "type", targets: ["selector", "ref", "focus"] } as const),
  Object.freeze({ kind: "setValue", targets: ["selector", "ref"] } as const),
  Object.freeze({ kind: "scroll", targets: ["selector", "ref"], directions: ["up", "down", "left", "right"], units: ["line", "page"] } as const),
  Object.freeze({ kind: "keypress", targets: ["selector", "ref", "focus"], keys: ["enter", "escape", "tab", "space", "left", "right", "up", "down", "home", "end", "page_up", "page_down"] } as const),
  Object.freeze({ kind: "hotkey", targets: ["selector", "ref", "focus"], chords: [["ctrl", "a"], ["Control", "a"], ["meta", "a"], ["Meta", "a"]] } as const),
]);

export type E2BProductWorkspaceErrorCode =
  | "invalid_installation_root" | "invalid_api_key" | "e2b_sdk_unavailable" | "invalid_browser_origins"
  | "invalid_option" | "workspace_closed" | "guest_start_failed" | "guest_start_timeout" | "guest_closed"
  | "writer_start_failed" | "browser_start_failed" | "window_unavailable" | "window_identity_unavailable"
  | "navigation_failed";

export class E2BProductWorkspaceError extends Error {
  readonly code: E2BProductWorkspaceErrorCode;
  constructor(code: E2BProductWorkspaceErrorCode) {
    super(code);
    this.name = "E2BProductWorkspaceError";
    this.code = code;
  }
}

export interface E2BProductWorkspaceOptions {
  readonly installationRoot: string;
  readonly apiKey: string;
  readonly onApprovalRequested?: ApprovalHandler;
  readonly browserAuthorizedOrigins?: readonly string[];
  readonly browser?: Omit<BrowserBackendOptions, "authorizedOrigins">;
  readonly guestTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly navigationTimeoutMs?: number;
  readonly allowInternetAccess?: boolean;
  readonly network?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface E2BProductWorkspace {
  readonly applications: readonly OnDemandWorkspaceApplication[];
  close(): Promise<void>;
}

interface ProductCommandResult { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number; }
interface ProductCommandOptions {
  readonly background?: boolean;
  readonly stdin?: boolean;
  readonly retainOutput?: boolean;
  readonly user?: string;
  readonly timeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
}
interface ProductGuest {
  readonly commands: { run(command: string, options?: ProductCommandOptions): Promise<ProductCommandResult> };
  readonly files?: { write(path: string, data: string | Uint8Array, options?: { readonly user?: string; readonly requestTimeoutMs?: number; readonly signal?: AbortSignal }): Promise<unknown> };
  readonly sandboxId?: string;
  kill(options?: { readonly requestTimeoutMs?: number }): Promise<boolean>;
  getApplicationWindows?(application: string): Promise<string[]>;
  getWindowTitle?(windowId: string): Promise<string>;
  activateWindow?(windowId: string): Promise<void>;
}
interface ProductSandboxClass { create(options: Record<string, unknown>): Promise<ProductGuest>; }
interface ProductResource { readonly application: WorkspaceApplication; readonly close: () => Promise<void>; }
interface ProductRuntime { readonly guest: ProductGuest; readonly id: string; writer?: ProductResource; browser?: ProductResource; closed?: boolean; }

function productError(code: E2BProductWorkspaceErrorCode): E2BProductWorkspaceError { return new E2BProductWorkspaceError(code); }

function boundedOption(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw productError("invalid_option");
  return value as number;
}

function normalizeOrigins(value: readonly string[] | undefined): readonly string[] {
  const origins = value === undefined ? DEFAULT_BROWSER_ORIGINS : value;
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > MAX_ORIGINS) throw productError("invalid_browser_origins");
  const normalized = new Set<string>();
  for (const raw of origins) {
    if (typeof raw !== "string" || raw.trim() !== raw || raw.length === 0) throw productError("invalid_browser_origins");
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw productError("invalid_browser_origins"); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin === "null" || parsed.username !== "" || parsed.password !== ""
      || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") throw productError("invalid_browser_origins");
    normalized.add(parsed.origin);
  }
  return Object.freeze([...normalized]);
}

function normalizeMetadata(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_ITEMS) throw productError("invalid_option");
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(key) || typeof item !== "string" || item.length === 0 || item.length > MAX_METADATA_TEXT || /[\u0000\r\n]/u.test(item)) throw productError("invalid_option");
    result[key] = item;
  }
  return Object.freeze(result);
}

function validateRoot(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) throw productError("invalid_installation_root");
  return resolvePath(value);
}

function resolveSandboxClass(root: string, apiKey: string): ProductSandboxClass {
  try {
    const consumerRequire = createRequire(join(root, "package.json"));
    const loaded = consumerRequire("@e2b/desktop") as Record<string, unknown>;
    const E2B = loaded.E2B as (new (options: { readonly apiKey: string }) => { readonly Sandbox?: ProductSandboxClass }) | undefined;
    const client = E2B ? new E2B({ apiKey }) : undefined;
    if (client?.Sandbox) return client.Sandbox;
    const Sandbox = loaded.Sandbox as { create(options: Record<string, unknown>): Promise<ProductGuest> } | undefined;
    if (!Sandbox || typeof Sandbox.create !== "function") throw Error("sandbox_unavailable");
    return { create: options => Sandbox.create({ ...options, apiKey }) };
  } catch {
    throw productError("e2b_sdk_unavailable");
  }
}

function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw productError("guest_start_failed"); }

async function waitFor<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(productError("guest_start_timeout")), timeoutMs); });
  const cancellation = signal === undefined ? undefined : new Promise<never>((_resolve, reject) => {
    abort = () => reject(productError("guest_start_failed"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, timeout, ...(cancellation ? [cancellation] : [])]); }
  finally { if (timer !== undefined) clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}

async function killGuest(guest: ProductGuest | undefined): Promise<void> {
  if (guest) await guest.kill({ requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS }).catch(() => undefined);
}

function safeId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9-]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "");
  return normalized.slice(0, 48) || "workspace";
}

async function runFixed(guest: ProductGuest, command: string, options: ProductCommandOptions = {}): Promise<ProductCommandResult> {
  const result = await guest.commands.run(command, { user: "user", timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS, requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS, ...options });
  if (typeof result.exitCode === "number" && result.exitCode !== 0) throw productError("writer_start_failed");
  return result;
}

function normalizeWindowId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:0x[0-9a-f]+|[0-9]+)$/iu.test(value)) return undefined;
  try { return value.toLocaleLowerCase().startsWith("0x") ? BigInt(value).toString(10) : value.replace(/^0+(?=\d)/u, ""); }
  catch { return undefined; }
}

async function readProcessId(guest: ProductGuest, windowId: string, signal?: AbortSignal): Promise<number> {
  const result = await runFixed(guest, `xprop -id ${windowId} _NET_WM_PID`, { signal });
  const match = /_NET_WM_PID[^=]*=\s*(\d+)/u.exec(result.stdout ?? "");
  const processId = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(processId) || processId <= 0) throw productError("window_identity_unavailable");
  return processId;
}

async function activeWindowId(guest: ProductGuest, signal?: AbortSignal): Promise<string | undefined> {
  const result = await runFixed(guest, "xprop -root _NET_ACTIVE_WINDOW", { signal });
  return normalizeWindowId(/(?:window id #\s*)?(0x[0-9a-f]+|\d+)/iu.exec(result.stdout ?? "")?.[1]);
}

async function discoverWindow(
  guest: ProductGuest,
  application: string,
  titlePattern: RegExp,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<E2BWindowGrant> {
  if (!guest.getApplicationWindows || !guest.getWindowTitle) throw productError("window_unavailable");
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    throwIfAborted(signal);
    const matches: E2BWindowGrant[] = [];
    const visible = await guest.getApplicationWindows(application).catch(() => []);
    for (const raw of visible) {
      const windowId = normalizeWindowId(raw);
      if (!windowId) continue;
      try {
        const title = await guest.getWindowTitle(windowId);
        if (!titlePattern.test(title)) continue;
        matches.push({ windowId, application, processId: await readProcessId(guest, windowId, signal) });
      } catch { throwIfAborted(signal); }
    }
    if (matches.length === 1) return Object.freeze(matches[0]);
    await delay(250, undefined, signal ? { signal } : undefined);
  }
  throw productError("window_unavailable");
}

async function activateWindow(guest: ProductGuest, grant: E2BWindowGrant, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  if (await activeWindowId(guest, signal) !== grant.windowId) {
    if (guest.activateWindow) await guest.activateWindow(grant.windowId);
    else await runFixed(guest, `xdotool windowactivate --sync ${grant.windowId}`, { signal });
  }
  return (await activeWindowId(guest, signal)) === grant.windowId;
}

async function verifyWindow(guest: ProductGuest, grant: E2BWindowGrant): Promise<boolean> {
  try {
    if (await activeWindowId(guest) !== grant.windowId) return false;
    return (await readProcessId(guest, grant.windowId)) === grant.processId;
  } catch { return false; }
}

async function createGuest(
  Sandbox: ProductSandboxClass,
  options: E2BProductWorkspaceOptions,
  metadata: Readonly<Record<string, string>>,
  timeoutMs: number,
  startupTimeoutMs: number,
  requestTimeoutMs: number,
  signal?: AbortSignal,
): Promise<ProductGuest> {
  throwIfAborted(signal);
  let created: Promise<ProductGuest>;
  try {
    const allowInternetAccess = options.allowInternetAccess ?? true;
    created = Promise.resolve(Sandbox.create({
      template: "desktop",
      timeoutMs,
      requestTimeoutMs,
      metadata,
      allowInternetAccess,
      // Public ingress is never enabled by this product. Outbound access is
      // separately controlled by allowInternetAccess and the host-supplied
      // network rules; allowPublicTraffic is not an egress permission.
      network: { ...(options.network ?? {}), allowPublicTraffic: false },
    }));
  } catch { throw productError("guest_start_failed"); }
  try {
    const guest = await waitFor(created, startupTimeoutMs, signal);
    if (signal?.aborted) { await killGuest(guest); throw productError("guest_start_failed"); }
    return guest;
  } catch (error) {
    void created.then(guest => killGuest(guest), () => undefined);
    if (error instanceof E2BProductWorkspaceError) throw error;
    throw productError("guest_start_failed");
  }
}

async function prepareWriter(guest: ProductGuest, runtimeId: string, signal?: AbortSignal): Promise<void> {
  if (!guest.files?.write) throw productError("writer_start_failed");
  const directory = `/tmp/desklatch-product-writer-${safeId(runtimeId)}`;
  const blankText = `${directory}/blank.txt`;
  const document = `${directory}/blank.odt`;
  const profile = `${directory}/profile`;
  await runFixed(guest, `mkdir -p -- ${profile}/user`, { signal });
  await guest.files.write(blankText, "", { user: "user", requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS, signal });
  await runFixed(guest, `/usr/bin/soffice -env:UserInstallation=file://${directory}/export-profile --headless --convert-to odt:writer8 --outdir ${directory} ${blankText}`, { signal, timeoutMs: 30_000 });
  const preferences = '<oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop></item></oor:items>';
  await guest.files.write(`${profile}/user/registrymodifications.xcu`, preferences, { user: "user", requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS, signal });
  await runFixed(guest, `/usr/bin/soffice -env:UserInstallation=file://${profile} --norestore --nofirststartwizard --writer ${document}`, { signal, background: true, timeoutMs: DEFAULT_GUEST_TIMEOUT_MS });
}

async function openWriter(
  runtime: ProductRuntime,
  options: E2BProductWorkspaceOptions,
  actionTimeoutMs: number,
  signal?: AbortSignal,
): Promise<WorkspaceApplication> {
  if (runtime.writer) return runtime.writer.application;
  let backend: DesktopBackend | undefined;
  let recipient: (E2BX11Recipient & E2BX11KeyboardRecipient) | undefined;
  try {
    const { createE2BDesktopBackend, E2BX11RecipientProcess } = await import("../backends/e2b/index.js");
    await prepareWriter(runtime.guest, runtime.id, signal);
    const workingDocument = /^[\s*●]*blank\.odt(?:\s+[-–—]\s+LibreOffice Writer)?$/iu;
    const grant = await discoverWindow(runtime.guest, "libreoffice", workingDocument, actionTimeoutMs, signal);
    recipient = new E2BX11RecipientProcess(runtime.guest as unknown as E2BDesktopSurface, { timeoutMs: actionTimeoutMs });
    backend = await createE2BDesktopBackend(runtime.guest as unknown as E2BDesktopSurface, {
      windows: [grant],
      recipient,
      keyboardRecipient: recipient,
      allowKeyboardInput: true,
      allowTemporaryClipboard: true,
      allowScreenshot: true,
      allowDegradedScreenshot: true,
      includeValues: true,
      timeoutMs: actionTimeoutMs,
    });
    const session = createDeskSession(backend, {
      allowModelImages: true,
      onApprovalRequested: options.onApprovalRequested,
      async policy(input) {
        const { step, target } = input;
        const localSave = step.kind === "hotkey" && step.keys.length === 2
          && step.keys.some(key => /^(ctrl|control)$/iu.test(key)) && step.keys.some(key => /^s$/iu.test(key));
        const windowTyping = step.kind === "type" && target.role === "Window";
        if (!localSave && step.kind !== "type") return defaultRiskPolicy(input);
        if (target.sensitive || target.effect === "sensitive") return defaultRiskPolicy(input);
        if (!await verifyWindow(runtime.guest, grant)
            || !workingDocument.test(await runtime.guest.getWindowTitle?.(grant.windowId) ?? "")) {
          return { decision: "deny", code: "cloud_working_document_changed" };
        }
        if (localSave || windowTyping) return { decision: "allow", code: "cloud_enrolled_document_operation" };
        return defaultRiskPolicy(input);
      },
    });
    const application: WorkspaceApplication = {
      id: PRODUCT_APPLICATION_IDS.writer,
      name: "LibreOffice Writer (E2B Desktop)",
      description: "A real isolated LibreOffice Writer document in the product-owned cloud desktop.",
      session,
      activate: async context => ({ status: "activated", code: "e2b_writer_activated", ...(await activateWindow(runtime.guest, grant, context.signal) ? {} : { status: "failed" }) }),
      verifyFront: () => verifyWindow(runtime.guest, grant),
    };
    runtime.writer = { application, close: () => session.close() };
    return application;
  } catch (error) {
    await backend?.close().catch(() => undefined);
    if (!backend) await recipient?.close?.().catch(() => undefined);
    throw error instanceof E2BProductWorkspaceError ? error : productError("writer_start_failed");
  }
}

async function openBrowser(
  runtime: ProductRuntime,
  options: E2BProductWorkspaceOptions,
  origins: readonly string[],
  browserOptions: BrowserBackendOptions,
  navigationTimeoutMs: number,
  guestTimeoutMs: number,
  startupTimeoutMs: number,
  signal?: AbortSignal,
): Promise<WorkspaceApplication> {
  if (runtime.browser) return runtime.browser.application;
  let managed: { readonly page: import("playwright-core").Page; readonly close: () => Promise<void> } | undefined;
  let backend: BrowserBackend | undefined;
  try {
    const { openE2BManagedPage } = await import("../backends/e2b/index.js");
    managed = await openE2BManagedPage(runtime.guest as unknown as E2BGuest, {
      headless: false,
      startupTimeoutMs,
      processTimeoutMs: guestTimeoutMs,
      signal,
      browser: { ...browserOptions, authorizedOrigins: origins, allowBlank: true },
    });
    const grant = await discoverWindow(runtime.guest, "google-chrome", /Chrome|Chromium/iu, startupTimeoutMs, signal);
    backend = createBrowserBackend(managed.page, { ...browserOptions, authorizedOrigins: origins, allowBlank: true });
    const session = createDeskSession(backend, {
      allowModelImages: browserOptions.allowImages === true,
      allowModelDocumentText: browserOptions.allowDocumentText === true,
      onApprovalRequested: options.onApprovalRequested,
    });
    const navigator = createWorkspaceNavigator(managed.page, { authorizedOrigins: origins, timeoutMs: navigationTimeoutMs });
    const application: WorkspaceApplication = {
      id: PRODUCT_APPLICATION_IDS.browser,
      name: "E2B managed browser",
      description: "A fresh cloud Chromium page restricted to the host-authorized public origins.",
      session,
      activate: async context => ({ status: "activated", code: "e2b_browser_activated", ...(await activateWindow(runtime.guest, grant, context.signal) ? {} : { status: "failed" }) }),
      verifyFront: () => verifyWindow(runtime.guest, grant),
      navigate: async ({ url, signal: navigateSignal }) => {
        const result: WorkspaceNavigationResult = await navigator.navigate(url, navigateSignal);
        return { status: "completed", code: "e2b_navigation_completed", steps: [], ...result };
      },
    };
    runtime.browser = { application, close: async () => { await session.close().catch(() => undefined); await managed?.close().catch(() => undefined); } };
    return application;
  } catch (error) {
    await backend?.close().catch(() => undefined);
    await managed?.close().catch(() => undefined);
    if (error instanceof E2BProductWorkspaceError && error.code !== "writer_start_failed") throw error;
    throw productError("browser_start_failed");
  }
}

/**
 * Register the product's two bounded E2B applications without allocating a
 * cloud guest. The guest is created only when Workspace activates Writer or
 * the managed browser, and both entries then share that isolated guest.
 */
export function createE2BProductWorkspace(options: E2BProductWorkspaceOptions): E2BProductWorkspace {
  if (!options || typeof options !== "object") throw productError("invalid_option");
  const root = validateRoot(options.installationRoot);
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0 || options.apiKey.length > 8_192) throw productError("invalid_api_key");
  const Sandbox = resolveSandboxClass(root, options.apiKey);
  const origins = normalizeOrigins(options.browserAuthorizedOrigins);
  const metadataOptions = normalizeMetadata(options.metadata);
  const guestTimeoutMs = boundedOption(options.guestTimeoutMs, DEFAULT_GUEST_TIMEOUT_MS, MAX_GUEST_TIMEOUT_MS);
  const startupTimeoutMs = boundedOption(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, MAX_STARTUP_TIMEOUT_MS);
  const requestTimeoutMs = boundedOption(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS);
  const desktopTimeoutMs = Math.min(requestTimeoutMs, 30_000);
  const navigationTimeoutMs = boundedOption(options.navigationTimeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS, MAX_NAVIGATION_TIMEOUT_MS);
  const browserOptions: BrowserBackendOptions = {
    ...options.browser,
    allowImages: options.browser?.allowImages ?? true,
    allowDocumentText: options.browser?.allowDocumentText ?? true,
    documentTextLimit: options.browser?.documentTextLimit ?? 12_000,
    documentChunkLimit: options.browser?.documentChunkLimit ?? 32,
    documentChunkSize: options.browser?.documentChunkSize ?? 2_000,
  };
  let closed = false;
  let runtime: ProductRuntime | undefined;
  let starting: Promise<ProductRuntime> | undefined;

  const createRuntime = async (signal?: AbortSignal): Promise<ProductRuntime> => {
    const id = randomUUID().replace(/[^a-z0-9-]/giu, "").slice(0, 32);
    const metadata = Object.freeze({ ...metadataOptions, product: "desklatch", purpose: "workspace", run: id });
    const guest = await createGuest(Sandbox, options, metadata, guestTimeoutMs, startupTimeoutMs, requestTimeoutMs, signal);
    if (closed) {
      await killGuest(guest);
      throw productError("workspace_closed");
    }
    return { guest, id };
  };

  const ensureRuntime = async (signal?: AbortSignal): Promise<ProductRuntime> => {
    if (closed) throw productError("workspace_closed");
    if (runtime && !runtime.closed) return runtime;
    if (!starting) {
      starting = createRuntime(signal).then(value => {
        runtime = value;
        return value;
      }).finally(() => { starting = undefined; });
    }
    return starting;
  };

  async function shutdownRuntime(): Promise<void> {
    const current = runtime;
    runtime = undefined;
    if (!current) return;
    current.closed = true;
    await Promise.all([
      current.browser?.close().catch(() => undefined),
      current.writer?.close().catch(() => undefined),
      killGuest(current.guest),
    ]);
  }

  const writer = createOnDemandWorkspaceApplication({
    id: PRODUCT_APPLICATION_IDS.writer,
    name: "LibreOffice Writer (E2B Desktop)",
    description: "A real isolated LibreOffice Writer document in the product-owned cloud desktop.",
    capabilities: WRITER_CAPABILITIES,
    allowModelImages: true,
    open: async signal => {
      const current = await ensureRuntime(signal);
      try { return await openWriter(current, options, desktopTimeoutMs, signal); }
      catch (error) { if (!current.browser) await shutdownRuntime(); throw error; }
    },
  });
  const browser = createOnDemandWorkspaceApplication({
    id: PRODUCT_APPLICATION_IDS.browser,
    name: "E2B managed browser",
    description: "A fresh cloud Chromium page restricted to the host-authorized public origins.",
    capabilities: BROWSER_CAPABILITIES,
    allowModelImages: browserOptions.allowImages === true,
    allowModelDocumentText: browserOptions.allowDocumentText === true,
    allowNavigation: true,
    open: async signal => {
      const current = await ensureRuntime(signal);
      try { return await openBrowser(current, options, origins, browserOptions, navigationTimeoutMs, guestTimeoutMs, startupTimeoutMs, signal); }
      catch (error) { if (!current.writer) await shutdownRuntime(); throw error; }
    },
  });

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await starting?.catch(() => undefined);
    await shutdownRuntime();
  };

  return Object.freeze({ applications: Object.freeze([writer, browser]), close });
}
