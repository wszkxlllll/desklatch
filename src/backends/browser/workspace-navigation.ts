import type { Page } from "playwright-core";

/** Exact-origin grants and bounded navigation are host policy, not model policy. */
export interface WorkspaceNavigationOptions {
  authorizedOrigins: readonly string[];
  maxUrlLength?: number;
  timeoutMs?: number;
}

export interface WorkspaceNavigationResult {
  requestedUrl: string;
  finalUrl: string;
  /** Final origin/path only; query strings and fragments are intentionally omitted. */
  sourceUrl: string;
}

export interface WorkspaceNavigator {
  navigate(url: string, signal?: AbortSignal): Promise<WorkspaceNavigationResult>;
  /** Disable the temporary CDP guard. This never closes the borrowed Page. */
  close(): Promise<void>;
}

const DEFAULT_WORKSPACE_NAVIGATION_MAX_URL_LENGTH = 2_048;
const DEFAULT_WORKSPACE_NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_WORKSPACE_NAVIGATION_TIMEOUT_MS = 120_000;
const MAX_WORKSPACE_AUTHORIZED_ORIGINS = 128;

const WORKSPACE_NAVIGATION_ERROR_CODES = Object.freeze({
  invalidOriginGrant: "invalid_origin_grant",
  invalidUrl: "invalid_url",
  urlTooLarge: "url_too_large",
  unsupportedScheme: "unsupported_scheme",
  credentialsNotAllowed: "credentials_not_allowed",
  unauthorizedOrigin: "unauthorized_origin",
  redirectBlocked: "redirect_blocked",
  finalUrlInvalid: "final_url_invalid",
  finalOriginUntrusted: "final_origin_untrusted",
  navigationUnavailable: "navigation_unavailable",
  navigationBusy: "navigation_busy",
  navigationFailed: "navigation_failed",
  pageClosed: "page_closed",
  aborted: "aborted",
} as const);

export type WorkspaceNavigationErrorCode =
  (typeof WORKSPACE_NAVIGATION_ERROR_CODES)[keyof typeof WORKSPACE_NAVIGATION_ERROR_CODES];

export class WorkspaceNavigationError extends Error {
  readonly code: WorkspaceNavigationErrorCode;

  constructor(code: WorkspaceNavigationErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "WorkspaceNavigationError";
    this.code = code;
  }
}

interface ParsedUrl {
  value: URL;
  origin: string;
}

interface CdpFrameTree {
  frame?: { id?: string };
}

interface CdpFrameTreeResponse {
  frameTree?: CdpFrameTree;
  frame?: { id?: string };
}

interface CdpRequestPaused {
  requestId?: string;
  request?: { url?: string };
  frameId?: string;
  resourceType?: string;
}

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: unknown) => void): void;
  off(event: string, listener: (params: unknown) => void): void;
}

interface NavigationRun {
  session: CdpSession;
  listener: (params: unknown) => void;
  completion: Promise<unknown>;
  cancel(): void;
  cleanup?: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bounded(value: unknown, fallback: number, maximum: number, code: WorkspaceNavigationErrorCode): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new WorkspaceNavigationError(code);
  }
  return value as number;
}

function normalizeOrigins(origins: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > MAX_WORKSPACE_AUTHORIZED_ORIGINS) {
    throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.invalidOriginGrant);
  }
  const result = new Set<string>();
  for (const raw of origins) {
    if (typeof raw !== "string" || raw.length === 0 || raw.trim() !== raw) {
      throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.invalidOriginGrant);
    }
    let parsed: URL;
    try { parsed = new URL(raw); }
    catch (error) { throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.invalidOriginGrant, error); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.origin === "null"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== "") {
      throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.invalidOriginGrant);
    }
    result.add(parsed.origin);
  }
  return result;
}

function parseUrl(value: unknown, maxLength: number, origins: ReadonlySet<string>, code: WorkspaceNavigationErrorCode): ParsedUrl {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.invalidUrl);
  }
  if (value.length > maxLength) throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.urlTooLarge);
  let parsed: URL;
  try { parsed = new URL(value); }
  catch (error) { throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.invalidUrl, error); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.unsupportedScheme);
  }
  if (parsed.origin === "null") throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.invalidUrl);
  if (parsed.username !== "" || parsed.password !== "") {
    throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.credentialsNotAllowed);
  }
  if (!origins.has(parsed.origin)) throw new WorkspaceNavigationError(code);
  return { value: parsed, origin: parsed.origin };
}

function sourceUrl(value: URL): string {
  return `${value.origin}${value.pathname || "/"}`;
}

function aborted(): WorkspaceNavigationError {
  return new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.aborted);
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted();
}

function cdpErrorCode(error: unknown): WorkspaceNavigationErrorCode | undefined {
  if (error instanceof WorkspaceNavigationError) return error.code;
  if (isRecord(error) && typeof error.code === "string") {
    const codes = Object.values(WORKSPACE_NAVIGATION_ERROR_CODES) as readonly string[];
    return codes.includes(error.code) ? error.code as WorkspaceNavigationErrorCode : undefined;
  }
  return undefined;
}

function pauseValue(value: unknown): CdpRequestPaused | undefined {
  if (!isRecord(value)) return undefined;
  const request = isRecord(value.request) && typeof value.request.url === "string" ? { url: value.request.url } : undefined;
  return {
    requestId: typeof value.requestId === "string" ? value.requestId : undefined,
    request,
    frameId: typeof value.frameId === "string" ? value.frameId : undefined,
    resourceType: typeof value.resourceType === "string" ? value.resourceType : undefined,
  };
}

function resultFor(requested: ParsedUrl, rawFinal: unknown, maxLength: number, origins: ReadonlySet<string>): WorkspaceNavigationResult {
  let final: ParsedUrl;
  try { final = parseUrl(rawFinal, maxLength, origins, WORKSPACE_NAVIGATION_ERROR_CODES.finalOriginUntrusted); }
  catch (error) {
    if (error instanceof WorkspaceNavigationError && error.code === WORKSPACE_NAVIGATION_ERROR_CODES.unauthorizedOrigin) {
      throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.finalOriginUntrusted);
    }
    if (error instanceof WorkspaceNavigationError && ([
      WORKSPACE_NAVIGATION_ERROR_CODES.invalidUrl,
      WORKSPACE_NAVIGATION_ERROR_CODES.urlTooLarge,
      WORKSPACE_NAVIGATION_ERROR_CODES.unsupportedScheme,
      WORKSPACE_NAVIGATION_ERROR_CODES.credentialsNotAllowed,
    ] as readonly string[]).includes(error.code)) throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.finalUrlInvalid);
    throw error;
  }
  if (final.origin !== requested.origin) throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.finalOriginUntrusted);
  return Object.freeze({ requestedUrl: requested.value.href, finalUrl: final.value.href, sourceUrl: sourceUrl(final.value) });
}

function abortRequest(session: CdpSession, requestId: string): Promise<void> {
  return session.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).then(() => undefined);
}

function continueRequest(session: CdpSession, requestId: string): Promise<void> {
  return session.send("Fetch.continueRequest", { requestId }).then(() => undefined);
}

function waitWithAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    onAbort();
    void work.catch(() => undefined);
    return Promise.reject(aborted());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const handleAbort = (): void => {
      if (settled) return;
      onAbort();
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      reject(aborted());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    work.then((value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      reject(error);
    });
  });
}

async function enableSession(page: Page, signal?: AbortSignal): Promise<{ session: CdpSession; mainFrameId: string }> {
  let session: CdpSession | undefined;
  try {
    session = await page.context().newCDPSession(page) as unknown as CdpSession;
    abortIfNeeded(signal);
    const tree = await session.send("Page.getFrameTree") as CdpFrameTreeResponse;
    const mainFrameId = tree?.frameTree?.frame?.id ?? tree?.frame?.id;
    if (typeof mainFrameId !== "string" || mainFrameId.length === 0) throw Error("missing_main_frame");
    abortIfNeeded(signal);
    // Fetch is restricted to document requests. Subresources remain wholly
    // under the page/context host policy (and avoid a remote CDP RTT on every
    // image, stylesheet, or script in E2B).
    await session.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request", resourceType: "Document" }],
    });
    abortIfNeeded(signal);
    return { session, mainFrameId };
  } catch (error) {
    if (session) {
      try { await session.send("Fetch.disable"); } catch { /* setup failed or page already closed */ }
    }
    if (error instanceof WorkspaceNavigationError && error.code === WORKSPACE_NAVIGATION_ERROR_CODES.aborted) throw error;
    throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.navigationUnavailable, error);
  }
}

async function disableSession(session: CdpSession, listener: (params: unknown) => void): Promise<void> {
  session.off("Fetch.requestPaused", listener);
  try { await session.send("Fetch.disable"); } catch { /* a closed page/session is already stopped */ }
}

export function createWorkspaceNavigator(page: Page, options: WorkspaceNavigationOptions): WorkspaceNavigator {
  if (!page || typeof page.goto !== "function" || typeof page.url !== "function" || typeof page.context !== "function") {
    throw new TypeError("createWorkspaceNavigator requires a trusted Playwright Page");
  }
  if (!options || !Array.isArray(options.authorizedOrigins)) {
    throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.invalidOriginGrant);
  }
  const origins = normalizeOrigins(options.authorizedOrigins);
  const maxLength = bounded(options.maxUrlLength, DEFAULT_WORKSPACE_NAVIGATION_MAX_URL_LENGTH, 65_536, WORKSPACE_NAVIGATION_ERROR_CODES.invalidUrl);
  const timeoutMs = bounded(options.timeoutMs, DEFAULT_WORKSPACE_NAVIGATION_TIMEOUT_MS, MAX_WORKSPACE_NAVIGATION_TIMEOUT_MS, WORKSPACE_NAVIGATION_ERROR_CODES.invalidUrl);
  let closed = false;
  let busy = false;
  let activeRun: NavigationRun | undefined;

  async function navigate(rawUrl: string, signal?: AbortSignal): Promise<WorkspaceNavigationResult> {
    if (closed) throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.navigationUnavailable);
    if (busy) throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.navigationBusy);
    busy = true;
    let run: NavigationRun | undefined;
    try {
      abortIfNeeded(signal);
      const requested = parseUrl(rawUrl, maxLength, origins, WORKSPACE_NAVIGATION_ERROR_CODES.unauthorizedOrigin);
      if (page.isClosed?.()) throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.pageClosed);
      const { session, mainFrameId } = await enableSession(page, signal);
      const state = {
        cancelled: false,
        blockedCode: undefined as WorkspaceNavigationErrorCode | undefined,
        routeError: undefined as unknown,
        pendingTopLevel: new Set<string>(),
      };
      const listener = (value: unknown): void => {
        const paused = pauseValue(value);
        if (!paused?.requestId) return;
        const topLevel = paused.frameId === mainFrameId && paused.resourceType === "Document";
        if (!topLevel) {
          void continueRequest(session, paused.requestId).catch((error) => { state.routeError ??= error; });
          return;
        }
        state.pendingTopLevel.add(paused.requestId);
        if (state.cancelled) {
          state.blockedCode ??= WORKSPACE_NAVIGATION_ERROR_CODES.aborted;
          void abortRequest(session, paused.requestId)
            .catch((error) => { state.routeError ??= error; })
            .finally(() => { state.pendingTopLevel.delete(paused.requestId!); });
          return;
        }
        try {
          const candidate = parseUrl(paused.request?.url, maxLength, origins, WORKSPACE_NAVIGATION_ERROR_CODES.redirectBlocked);
          if (candidate.origin !== requested.origin) {
            state.blockedCode ??= WORKSPACE_NAVIGATION_ERROR_CODES.redirectBlocked;
            void abortRequest(session, paused.requestId)
              .catch((error) => { state.routeError ??= error; })
              .finally(() => { state.pendingTopLevel.delete(paused.requestId!); });
            return;
          }
          void continueRequest(session, paused.requestId)
            .catch((error) => { state.routeError ??= error; })
            .finally(() => { state.pendingTopLevel.delete(paused.requestId!); });
        } catch (error) {
          state.blockedCode ??= cdpErrorCode(error) === WORKSPACE_NAVIGATION_ERROR_CODES.unauthorizedOrigin
            ? WORKSPACE_NAVIGATION_ERROR_CODES.redirectBlocked
            : (cdpErrorCode(error) ?? WORKSPACE_NAVIGATION_ERROR_CODES.redirectBlocked);
          void abortRequest(session, paused.requestId)
            .catch((abortFailure) => { state.routeError ??= abortFailure; })
            .finally(() => { state.pendingTopLevel.delete(paused.requestId!); });
        }
      };
      session.on("Fetch.requestPaused", listener);
      run = {
        session,
        listener,
        cancel: () => {
          state.cancelled = true;
          state.blockedCode ??= WORKSPACE_NAVIGATION_ERROR_CODES.aborted;
          for (const requestId of state.pendingTopLevel) {
            void abortRequest(session, requestId).catch((error) => { state.routeError ??= error; });
          }
          void session.send("Page.stopLoading").catch((error) => { state.routeError ??= error; });
        },
        completion: Promise.resolve(),
      };
      activeRun = run;
      const completion = Promise.resolve().then(() => page.goto(requested.value.href, { waitUntil: "domcontentloaded", timeout: timeoutMs }));
      run.completion = completion;
      try {
        await waitWithAbort(completion, signal, run.cancel);
      } catch (error) {
        if (signal?.aborted) {
          run.cancel();
          run.cleanup = completion.catch(() => undefined)
            .then(() => disableSession(session, listener))
            .finally(() => {
              if (activeRun === run) activeRun = undefined;
              busy = false;
            });
          void run.cleanup;
          throw aborted();
        }
        if (error instanceof WorkspaceNavigationError) throw error;
        if (state.blockedCode) throw new WorkspaceNavigationError(state.blockedCode);
        throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.navigationFailed, error);
      }
      abortIfNeeded(signal);
      if (state.blockedCode) throw new WorkspaceNavigationError(state.blockedCode);
      if (state.routeError) throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.navigationFailed, state.routeError);
      let finalRaw: string;
      try { finalRaw = page.url(); }
      catch (error) { throw new WorkspaceNavigationError(WORKSPACE_NAVIGATION_ERROR_CODES.finalUrlInvalid, error); }
      return resultFor(requested, finalRaw, maxLength, origins);
    } finally {
      if (run && !run.cleanup) {
        await run.completion.catch(() => undefined);
        await disableSession(run.session, run.listener);
        if (activeRun === run) activeRun = undefined;
        busy = false;
      }
      if (!run) busy = false;
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    const run = activeRun;
    if (!run) return;
    run.cancel();
    await run.completion.catch(() => undefined);
    await disableSession(run.session, run.listener);
    if (activeRun === run) activeRun = undefined;
    busy = false;
  }

  return Object.freeze({ navigate, close });
}
