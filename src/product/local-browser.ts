import type { ApprovalHandler, DeskSession } from "../core/session-types.js";
import { createDeskSession } from "../session.js";
import {
  createBrowserBackend,
  createWorkspaceNavigator,
  type WorkspaceNavigationResult,
} from "../backends/browser/index.js";
import { findChromiumExecutable } from "../backends/browser/local.js";
import { createOnDemandWorkspaceApplication, type OnDemandWorkspaceApplication, type WorkspaceOpenedApplication } from "../workspace.js";

const MAX_LOCAL_BROWSER_ORIGINS = 64;

const LOCAL_BROWSER_CAPABILITIES = Object.freeze([
  Object.freeze({ kind: "click", targets: ["selector", "ref", "point"] as const, buttons: ["left"] as const, counts: [1] as const }),
  Object.freeze({ kind: "type", targets: ["selector", "ref", "focus"] as const }),
  Object.freeze({ kind: "setValue", targets: ["selector", "ref"] as const }),
  Object.freeze({ kind: "scroll", targets: ["selector", "ref"] as const, directions: ["up", "down", "left", "right"] as const, units: ["line", "page"] as const }),
  Object.freeze({ kind: "keypress", targets: ["selector", "ref", "focus"] as const, keys: ["enter", "escape", "tab", "space", "left", "right", "up", "down", "home", "end", "page_up", "page_down"] as const }),
  Object.freeze({ kind: "hotkey", targets: ["selector", "ref", "focus"] as const, chords: [["ctrl", "a"], ["Control", "a"], ["meta", "a"], ["Meta", "a"]] as const }),
]);

export interface LocalBrowserProductOptions {
  /** Comma-separated env text is accepted for the packaged Windows product. */
  readonly origins?: readonly string[] | string;
  readonly executablePath?: string;
  readonly onApprovalRequested?: ApprovalHandler;
}

export function parseLocalBrowserOrigins(value: string | undefined = process.env.DESKLATCH_LOCAL_BROWSER_ORIGINS): readonly string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const rawOrigins = value.split(",").map(origin => origin.trim());
  if (rawOrigins.length === 0 || rawOrigins.some(origin => origin.length === 0) || rawOrigins.length > MAX_LOCAL_BROWSER_ORIGINS) {
    throw new Error("local_browser_origins_invalid");
  }
  const origins = new Set<string>();
  for (const raw of rawOrigins) {
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new Error("local_browser_origins_invalid"); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.origin === "null" || parsed.username !== "" || parsed.password !== ""
      || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      throw new Error("local_browser_origins_invalid");
    }
    origins.add(parsed.origin);
  }
  return Object.freeze([...origins]);
}

function normalizedOrigins(value: readonly string[] | string | undefined): readonly string[] | undefined {
  if (typeof value === "string" || value === undefined) return parseLocalBrowserOrigins(value);
  return parseLocalBrowserOrigins(value.join(","));
}

/**
 * Build the optional private Chromium application. No browser is launched
 * while registering this declaration; Workspace opens it only on explicit
 * `act({activate: "windows-local-browser"})`.
 */
export function createWindowsLocalBrowserApplication(options: LocalBrowserProductOptions = {}): OnDemandWorkspaceApplication | undefined {
  const origins = normalizedOrigins(options.origins);
  if (origins === undefined) return undefined;
  return createOnDemandWorkspaceApplication({
    id: "windows-local-browser",
    name: "DeskLatch private Chromium",
    description: "A fresh private Chromium context restricted to operator-authorized exact origins.",
    capabilities: LOCAL_BROWSER_CAPABILITIES,
    allowModelImages: true,
    allowModelDocumentText: true,
    allowNavigation: true,
    open: signal => openLocalBrowser({ ...options, origins }, signal),
  });
}

interface OpenLocalBrowserOptions extends LocalBrowserProductOptions {
  readonly origins: readonly string[];
}

async function openLocalBrowser(options: OpenLocalBrowserOptions, signal?: AbortSignal): Promise<WorkspaceOpenedApplication> {
  signal?.throwIfAborted();
  const { chromium } = await import("playwright-core");
  const executablePath = options.executablePath ?? findChromiumExecutable();
  if (!executablePath) throw new Error("local_browser_executable_unavailable");
  let browser: import("playwright-core").Browser | undefined;
  let context: import("playwright-core").BrowserContext | undefined;
  let page: import("playwright-core").Page | undefined;
  let navigator: { close(): Promise<void>; navigate(url: string, signal?: AbortSignal): Promise<WorkspaceNavigationResult> } | undefined;
  let session: DeskSession | undefined;
  try {
    // No userDataDir, persistent context, remote debugging port, or signed-in
    // profile is supplied: Playwright creates a new private context.
    browser = await chromium.launch({ headless: true, executablePath });
    context = await browser.newContext();
    page = await context.newPage();
    signal?.throwIfAborted();
    const backend = createBrowserBackend(page, {
      scope: "windows-local-browser",
      authorizedOrigins: options.origins,
      allowBlank: true,
      allowImages: true,
      allowDocumentText: true,
      includePublicValues: true,
    });
    navigator = createWorkspaceNavigator(page, { authorizedOrigins: options.origins });
    const rawSession = createDeskSession(backend, {
      allowModelImages: true,
      allowModelDocumentText: true,
      onApprovalRequested: options.onApprovalRequested,
    });
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await navigator?.close().catch(() => undefined);
      await rawSession.close().catch(() => undefined);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    };
    session = Object.freeze({ ...rawSession, close });
    const opened: WorkspaceOpenedApplication = {
      session,
      activate: () => ({ status: "activated", code: "local_browser_activated" }),
      verifyFront: () => Boolean(page && !page.isClosed() && browser?.isConnected()),
      navigate: async ({ url, signal: navigateSignal }) => ({
        status: "completed",
        code: "local_browser_navigation_completed",
        steps: [],
        ...(await navigator!.navigate(url, navigateSignal)),
      }),
    };
    return opened;
  } catch (error) {
    await navigator?.close().catch(() => undefined);
    await session?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    throw error;
  }
}
