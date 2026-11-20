import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Browser, BrowserContext, Page, Request, Route, WebSocketRoute } from "playwright-core";
import { createBrowserBackend } from "./index.js";
import { findChromiumExecutable } from "./local.js";
import type { BrowserBackend, BrowserBackendOptions } from "./types.js";
import type { WorkspaceNavigationResult } from "./workspace-navigation.js";

const DEFAULT_PUBLIC_URL_LENGTH = 2_048;
const DEFAULT_PUBLIC_NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_PUBLIC_NAVIGATION_TIMEOUT_MS = 120_000;
const DEFAULT_PUBLIC_DNS_TIMEOUT_MS = 5_000;
const MAX_PUBLIC_DNS_TIMEOUT_MS = 30_000;

const PUBLIC_BROWSER_ERROR_CODES = Object.freeze({
  invalidUrl: "invalid_url",
  urlTooLarge: "url_too_large",
  unsupportedScheme: "unsupported_scheme",
  credentialsNotAllowed: "credentials_not_allowed",
  privateAddress: "private_address",
  dnsResolutionFailed: "dns_resolution_failed",
  requestBlocked: "request_blocked",
  finalUrlInvalid: "final_url_invalid",
  navigationUnavailable: "navigation_unavailable",
  navigationBusy: "navigation_busy",
  navigationFailed: "navigation_failed",
  pageClosed: "page_closed",
  aborted: "aborted",
} as const);

export type PublicBrowserErrorCode =
  (typeof PUBLIC_BROWSER_ERROR_CODES)[keyof typeof PUBLIC_BROWSER_ERROR_CODES];

export class PublicBrowserError extends Error {
  readonly code: PublicBrowserErrorCode;

  constructor(code: PublicBrowserErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "PublicBrowserError";
    this.code = code;
  }
}

export interface PublicBrowserOptions extends Omit<BrowserBackendOptions, "authorizedOrigins" | "allowBlank"> {
  /** Explicitly selected Chromium executable; no executable is downloaded. */
  executablePath?: string;
  /** Defaults to true. Every invocation still receives a fresh context. */
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Optional first public page, opened through the same guarded navigate path. */
  initialUrl?: string;
  maxUrlLength?: number;
  timeoutMs?: number;
  dnsTimeoutMs?: number;
}

export interface PublicBrowserWorkspace {
  readonly backend: BrowserBackend;
  navigate(url: string, signal?: AbortSignal): Promise<WorkspaceNavigationResult>;
  close(): Promise<void>;
}

interface PublicDestination {
  address: string;
  family: 4 | 6;
  port: number;
}

interface NavigationState {
  blocked?: PublicBrowserError;
  stop(): void;
}

function invalid(code: PublicBrowserErrorCode, cause?: unknown): PublicBrowserError {
  return new PublicBrowserError(code, cause);
}

function boundedOption(
  value: unknown,
  fallback: number,
  maximum: number,
  code: PublicBrowserErrorCode,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw invalid(code);
  }
  return value as number;
}

function parseHttpUrl(value: unknown, maxLength: number): URL {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw invalid(PUBLIC_BROWSER_ERROR_CODES.invalidUrl);
  }
  if (value.length > maxLength) throw invalid(PUBLIC_BROWSER_ERROR_CODES.urlTooLarge);
  let parsed: URL;
  try { parsed = new URL(value); }
  catch (error) { throw invalid(PUBLIC_BROWSER_ERROR_CODES.invalidUrl, error); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid(PUBLIC_BROWSER_ERROR_CODES.unsupportedScheme);
  }
  if (parsed.origin === "null" || parsed.hostname.length === 0) {
    throw invalid(PUBLIC_BROWSER_ERROR_CODES.invalidUrl);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw invalid(PUBLIC_BROWSER_ERROR_CODES.credentialsNotAllowed);
  }
  return parsed;
}

function lookupHostName(url: URL): string {
  const hostname = url.hostname;
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function defaultPort(url: URL): number {
  return url.protocol === "https:" ? 443 : 80;
}

function portFor(url: URL): number {
  const port = url.port === "" ? defaultPort(url) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw invalid(PUBLIC_BROWSER_ERROR_CODES.invalidUrl);
  }
  return port;
}

function ipv4Bytes(address: string): [number, number, number, number] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((part) => {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return Number.NaN;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : Number.NaN;
  });
  if (bytes.some((value) => !Number.isInteger(value))) return undefined;
  return bytes as [number, number, number, number];
}

function ipv6Bytes(address: string): Uint8Array | undefined {
  if (address.includes("%")) return undefined;
  const sections = address.toLowerCase().split("::");
  if (sections.length > 2) return undefined;
  const parseSection = (section: string): number[] | undefined => {
    if (section === "") return [];
    const groups = section.split(":");
    const result: number[] = [];
    for (const group of groups) {
      if (group.includes(".")) {
        const bytes = ipv4Bytes(group);
        if (!bytes) return undefined;
        result.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      result.push(Number.parseInt(group, 16));
    }
    return result;
  };
  const left = parseSection(sections[0]);
  const right = parseSection(sections[1] ?? "");
  if (!left || !right) return undefined;
  const groups = sections.length === 2
    ? [...left, ...new Array(8 - left.length - right.length).fill(0), ...right]
    : left;
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >>> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((value) => value === 0);
}

/**
 * Return true only for globally routable unicast addresses. This deliberately
 * rejects documentation, benchmark, carrier-grade NAT, multicast, and other
 * special-use ranges in addition to the usual private/loopback/link-local
 * ranges. A hostname is rejected if any answer is non-public.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4Bytes(address);
    if (!bytes) return false;
    const [a, b, c] = bytes;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 2 || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family !== 6) return false;
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  const mapped = bytes.slice(0, 10).every((value) => value === 0)
    && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return isPublicAddress([...bytes.slice(12)].join("."));
  if (allZero(bytes) || (allZero(bytes.slice(0, 15)) && bytes[15] === 1)) return false;
  if (bytes[0] === 0xff) return false;
  if ((bytes[0] & 0xfe) === 0xfc) return false;
  // The complete fe00::/9 block is reserved for link-local/site-local use;
  // rejecting it also covers the deprecated fec0::/10 site-local range.
  if (bytes[0] === 0xfe) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
  return true;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function addressForLookup(address: LookupAddress): { address: string; family: 4 | 6 } | undefined {
  if ((address.family !== 4 && address.family !== 6) || !isPublicAddress(address.address)) return undefined;
  return { address: address.address, family: address.family };
}

class PublicNetworkGuard {
  constructor(private readonly dnsTimeoutMs: number) {}

  async destination(url: URL): Promise<PublicDestination> {
    const hostname = lookupHostName(url);
    const port = portFor(url);
    const family = isIP(hostname);
    if (family === 4 || family === 6) {
      if (!isPublicAddress(hostname)) throw invalid(PUBLIC_BROWSER_ERROR_CODES.privateAddress);
      return { address: hostname, family, port };
    }
    if (hostname.length > 253 || hostname.includes("\0")) {
      throw invalid(PUBLIC_BROWSER_ERROR_CODES.invalidUrl);
    }
    let answers: LookupAddress[];
    try {
      answers = await withTimeout(
        dnsLookup(hostname, { all: true, verbatim: true }),
        this.dnsTimeoutMs,
        () => invalid(PUBLIC_BROWSER_ERROR_CODES.dnsResolutionFailed),
      );
    } catch (error) {
      if (error instanceof PublicBrowserError) throw error;
      throw invalid(PUBLIC_BROWSER_ERROR_CODES.dnsResolutionFailed, error);
    }
    const publicAnswers = answers.map(addressForLookup);
    if (publicAnswers.some((answer) => answer === undefined) || publicAnswers.length === 0) {
      throw invalid(PUBLIC_BROWSER_ERROR_CODES.privateAddress);
    }
    const first = publicAnswers[0];
    if (!first) throw invalid(PUBLIC_BROWSER_ERROR_CODES.dnsResolutionFailed);
    return { ...first, port };
  }

  async assert(url: string, maxLength: number): Promise<void> {
    const parsed = parseHttpUrl(url, maxLength);
    await this.destination(parsed);
  }
}

function proxyHeaders(request: IncomingMessage, host: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "upgrade"].includes(name.toLowerCase())) continue;
    if (typeof value === "string" || Array.isArray(value)) result[name] = value;
  }
  result.host = host;
  return result;
}

function writeProxyError(response: ServerResponse, status: number): void {
  if (response.headersSent) return;
  response.writeHead(status, { connection: "close", "content-type": "text/plain" });
  response.end("request blocked");
}

function proxyLookup(address: string, family: 4 | 6): (hostname: string, options: object, callback: (error: Error | null, address: string, family: number) => void) => void {
  return (_hostname, _options, callback) => callback(null, address, family);
}

class PublicNetworkProxy {
  private readonly sockets = new Set<Socket>();
  private server: Server | undefined;
  private closed = false;

  constructor(private readonly guard: PublicNetworkGuard, private readonly maxUrlLength: number) {}

  async listen(): Promise<number> {
    if (this.server) throw new Error("proxy_already_started");
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.on("connect", (request, socket, head) => {
      void this.handleConnect(request, socket, head);
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("proxy_address_unavailable");
    return address.port;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closed || !request.url) {
      writeProxyError(response, 403);
      return;
    }
    let target: URL;
    try { target = parseHttpUrl(request.url, this.maxUrlLength); }
    catch { writeProxyError(response, 403); return; }
    if (target.protocol !== "http:") {
      writeProxyError(response, 405);
      return;
    }
    let destination: PublicDestination;
    try { destination = await this.guard.destination(target); }
    catch { writeProxyError(response, 403); return; }
    const upstream = httpRequest({
      protocol: "http:",
      hostname: destination.address,
      family: destination.family,
      port: destination.port,
      method: request.method,
      path: `${target.pathname || "/"}${target.search}`,
      headers: proxyHeaders(request, target.host),
      agent: false,
      lookup: proxyLookup(destination.address, destination.family),
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => writeProxyError(response, 502));
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
  }

  private async handleConnect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (this.closed || !request.url) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    let target: URL;
    try { target = parseHttpUrl(`https://${request.url}`, this.maxUrlLength); }
    catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    let destination: PublicDestination;
    try { destination = await this.guard.destination(target); }
    catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = netConnect({
      host: destination.address,
      family: destination.family,
      port: destination.port,
      lookup: proxyLookup(destination.address, destination.family),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = (): void => { upstream.off("error", onError); resolve(); };
        const onError = (error: Error): void => { upstream.off("connect", onConnect); reject(error); };
        upstream.once("connect", onConnect);
        upstream.once("error", onError);
      });
    } catch {
      upstream.destroy();
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\nConnection: keep-alive\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function sourceUrl(url: URL): string {
  return `${url.origin}${url.pathname || "/"}`;
}

function navigationResult(requested: URL, final: URL): WorkspaceNavigationResult {
  return Object.freeze({
    requestedUrl: requested.href,
    finalUrl: final.href,
    sourceUrl: sourceUrl(final),
  });
}

function aborted(): PublicBrowserError {
  return invalid(PUBLIC_BROWSER_ERROR_CODES.aborted);
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
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      onAbort();
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

function topLevelNavigation(request: Request, page: Page): boolean {
  if (!request.isNavigationRequest()) return false;
  try { return request.frame() === page.mainFrame(); }
  catch { return false; }
}

/**
 * Launch a fresh Chromium context with an opt-in public-only network boundary.
 *
 * The browser has no borrowed profile or cookies. Every HTTP request is first
 * checked by the context route handler and then sent through a loopback proxy
 * that resolves the destination and connects only to public unicast addresses.
 * The proxy also handles CONNECT, so HTTPS redirects and subresources receive
 * the same address check. Chromium's implicit loopback proxy bypass is disabled
 * and service workers/background network paths are disabled for this context.
 */
export async function createPublicBrowserWorkspace(options: PublicBrowserOptions = {}): Promise<PublicBrowserWorkspace> {
  const maxUrlLength = boundedOption(options.maxUrlLength, DEFAULT_PUBLIC_URL_LENGTH, 65_536, PUBLIC_BROWSER_ERROR_CODES.urlTooLarge);
  const timeoutMs = boundedOption(options.timeoutMs, DEFAULT_PUBLIC_NAVIGATION_TIMEOUT_MS, MAX_PUBLIC_NAVIGATION_TIMEOUT_MS, PUBLIC_BROWSER_ERROR_CODES.invalidUrl);
  const dnsTimeoutMs = boundedOption(options.dnsTimeoutMs, DEFAULT_PUBLIC_DNS_TIMEOUT_MS, MAX_PUBLIC_DNS_TIMEOUT_MS, PUBLIC_BROWSER_ERROR_CODES.invalidUrl);
  if (options.initialUrl !== undefined) parseHttpUrl(options.initialUrl, maxUrlLength);
  const guard = new PublicNetworkGuard(dnsTimeoutMs);
  const proxy = new PublicNetworkProxy(guard, maxUrlLength);
  let proxyPort: number;
  try { proxyPort = await proxy.listen(); }
  catch (error) {
    await proxy.close();
    throw error;
  }
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let backend: BrowserBackend | undefined;
  let closed = false;
  let busy = false;
  let activeRun: NavigationState | undefined;
  const routePattern = /.*/;
  let routeHandler: ((route: Route) => Promise<void>) | undefined;
  try {
    const { chromium } = await import("playwright-core");
    const executablePath = options.executablePath ?? findChromiumExecutable();
    browser = await chromium.launch({
      headless: options.headless ?? true,
      // Public browsing must not silently fall back to Chromium's unsandboxed
      // mode. Playwright throws when the host cannot provide this isolation.
      chromiumSandbox: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        `--proxy-server=http://127.0.0.1:${proxyPort}`,
        "--proxy-bypass-list=<-loopback>",
        "--disable-quic",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-dns-prefetch",
        "--disable-features=AsyncDns",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
      ],
    });
    context = await browser.newContext({
      serviceWorkers: "block",
      proxy: { server: `http://127.0.0.1:${proxyPort}` },
      ...(options.viewport ? { viewport: options.viewport } : {}),
    });
    // WebSocket routes are separate from HTTP routes in Playwright. Do not
    // connect them to a server: public research is intentionally HTTP(S)-only.
    await context.routeWebSocket(/^wss?:\/\//, (_websocket: WebSocketRoute) => undefined);
    page = await context.newPage();
    routeHandler = async (route: Route): Promise<void> => {
      const request = route.request();
      try {
        await guard.assert(request.url(), maxUrlLength);
        await route.continue();
      } catch (error) {
        const blocked = error instanceof PublicBrowserError
          ? error
          : invalid(PUBLIC_BROWSER_ERROR_CODES.requestBlocked, error);
        if (activeRun && topLevelNavigation(request, page!)) activeRun.blocked ??= blocked;
        try { await route.abort("blockedbyclient"); }
        catch { /* context/page closure already stopped the request */ }
      }
    };
    await context.route(routePattern, routeHandler);
    backend = createBrowserBackend(page, {
      ...options,
      allowBlank: true,
      // Public navigation is enforced by the route handler and proxy rather
      // than by the exact-origin grant used by borrowed logged-in contexts.
      authorizedOrigins: undefined,
    });

    const navigate = async (rawUrl: string, signal?: AbortSignal): Promise<WorkspaceNavigationResult> => {
      if (closed) throw invalid(PUBLIC_BROWSER_ERROR_CODES.navigationUnavailable);
      if (busy) throw invalid(PUBLIC_BROWSER_ERROR_CODES.navigationBusy);
      if (page!.isClosed()) throw invalid(PUBLIC_BROWSER_ERROR_CODES.pageClosed);
      const requested = parseHttpUrl(rawUrl, maxUrlLength);
      await guard.destination(requested);
      if (signal?.aborted) throw aborted();
      busy = true;
      let completion: Promise<unknown> | undefined;
      const run: NavigationState = {
        stop: () => {
          void page!.evaluate(() => { window.stop(); }).catch(() => undefined);
        },
      };
      activeRun = run;
      try {
        completion = Promise.resolve().then(() => page!.goto(requested.href, { waitUntil: "domcontentloaded", timeout: timeoutMs }));
        try {
          await waitWithAbort(completion, signal, run.stop);
        } catch (error) {
          if (signal?.aborted) throw aborted();
          if (run.blocked) throw run.blocked;
          if (page!.isClosed()) throw invalid(PUBLIC_BROWSER_ERROR_CODES.pageClosed, error);
          throw invalid(PUBLIC_BROWSER_ERROR_CODES.navigationFailed, error);
        }
        if (run.blocked) throw run.blocked;
        let final: URL;
        try { final = parseHttpUrl(page!.url(), maxUrlLength); }
        catch (error) { throw invalid(PUBLIC_BROWSER_ERROR_CODES.finalUrlInvalid, error); }
        await guard.destination(final);
        return navigationResult(requested, final);
      } finally {
        if (completion) await completion.catch(() => undefined);
        if (activeRun === run) activeRun = undefined;
        busy = false;
      }
    };

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      activeRun?.stop();
      if (context && routeHandler) await context.unroute(routePattern, routeHandler).catch(() => undefined);
      await backend?.close().catch(() => undefined);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await proxy.close();
    };

    const workspace = Object.freeze({ backend, navigate, close }) as PublicBrowserWorkspace;
    if (options.initialUrl !== undefined) await navigate(options.initialUrl);
    return workspace;
  } catch (error) {
    closed = true;
    activeRun?.stop();
    if (context && routeHandler) await context.unroute(routePattern, routeHandler).catch(() => undefined);
    await backend?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await proxy.close();
    throw error;
  }
}
