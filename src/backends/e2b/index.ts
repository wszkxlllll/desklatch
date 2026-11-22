import { readFile } from "node:fs/promises";
import { chromium, type Browser, type ConnectOverCDPTransport, type Page } from "playwright-core";
import type { DesktopBackend } from "../../contracts.js";
import { createBrowserBackend, type BrowserBackendOptions } from "../browser/index.js";

interface GuestCommand {
  sendStdin(data: string, opts?: { requestTimeoutMs?: number }): Promise<void>;
  closeStdin(opts?: { requestTimeoutMs?: number }): Promise<void>;
  kill(): Promise<boolean>;
  wait(): Promise<unknown>;
}

/** Structural subset of a host-owned @e2b/desktop Sandbox. No sandbox is allocated here. */
export interface E2BGuest {
  commands: {
    run(cmd: string, options: {
      background: true; stdin: true; user: string; retainOutput: false;
      timeoutMs: number; requestTimeoutMs: number; onStdout: (data: string) => void;
      signal?: AbortSignal;
    }): Promise<GuestCommand>;
  };
}

export interface E2BBrowserOptions {
  /** Lifetime of this browser process, independent from the host's E2B sandbox lease. */
  processTimeoutMs?: number;
  startupTimeoutMs?: number;
  headless?: boolean;
  /** Cancel startup or retire an attached browser without touching the guest sandbox. */
  signal?: AbortSignal;
  /** Explicit host-owned observation/action grants for the scoped page. */
  browser?: BrowserBackendOptions;
  /** Optional trusted bootstrap, e.g. opening a specific fixture or whitelisted site. */
  prepare?: (page: Page) => Promise<void>;
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw Error("invalid_guest_timeout");
  return value;
}

const MAX_TRANSPORT_QUEUE = 1_024;
const MAX_BATCH_MESSAGES = 32;
const MAX_BATCH_BYTES = 256 * 1_024;

function bounded<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timer = undefined;
      reject(Error("guest_timeout"));
    }, ms);
    const onAbort = (): void => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      reject(Error("guest_aborted"));
    };
    if (signal?.aborted) {
      onAbort();
      void work.catch(() => undefined);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

/** Attach Playwright to a fresh, private browser over the authenticated E2B command stream. */
export async function openE2BManagedPage(guest: E2BGuest, options: E2BBrowserOptions = {}): Promise<{
  page: Page; close(): Promise<void>;
}> {
  const startup = positiveTimeout(options.startupTimeoutMs ?? 25_000);
  const lifetime = positiveTimeout(options.processTimeoutMs ?? 300_000);
  if (options.signal?.aborted) throw Error("guest_aborted");
  const source = await readFile(new URL("./chromium_pipe.py", import.meta.url));
  // Only bundled code and a boolean selected by the host can enter this shell command.
  const command = 'exec python3 -u -c "import base64;exec(base64.b64decode(\'' + source.toString("base64") + '\'))"'
    + (options.headless ? " --headless" : "");
  let handle: GuestCommand | undefined;
  let browser: Browser | undefined;
  let buffer = "";
  let ended = false;
  let writing = Promise.resolve();
  let queued = 0;
  let pendingData = "";
  let pendingCount = 0;
  let pendingBytes = 0;
  const readyBatches: Array<{ data: string; count: number }> = [];
  let activeBatch: { data: string; count: number } | undefined;
  let draining = false;
  let closing: Promise<void> | undefined;
  const discardQueued = (): void => {
    pendingData = "";
    pendingCount = 0;
    pendingBytes = 0;
    readyBatches.length = 0;
    queued = activeBatch?.count ?? 0;
  };
  const finish = (reason?: string) => {
    if (ended) return;
    ended = true;
    discardQueued();
    transport.onclose?.(reason);
  };
  const flushPending = (): void => {
    if (pendingCount === 0) return;
    readyBatches.push({ data: pendingData, count: pendingCount });
    pendingData = "";
    pendingCount = 0;
    pendingBytes = 0;
  };
  const nextBatch = (): { data: string; count: number } | undefined => {
    const ready = readyBatches.shift();
    if (ready) return ready;
    if (pendingCount === 0) return undefined;
    const pending = { data: pendingData, count: pendingCount };
    pendingData = "";
    pendingCount = 0;
    pendingBytes = 0;
    return pending;
  };
  const drain = (): void => {
    if (draining || ended || !handle) return;
    const batch = nextBatch();
    if (!batch) return;
    const current = handle;
    activeBatch = batch;
    draining = true;
    writing = writing.then(async () => {
      if (!ended) await current.sendStdin(batch.data, { requestTimeoutMs: startup });
    }).catch(() => finish("guest_transport_lost")).finally(() => {
      queued = Math.max(0, queued - batch.count);
      activeBatch = undefined;
      draining = false;
      if (!ended) drain();
    });
  };
  const enqueue = (line: string): void => {
    const bytes = Buffer.byteLength(line, "utf8");
    if (pendingCount > 0 && (pendingCount >= MAX_BATCH_MESSAGES || pendingBytes + bytes > MAX_BATCH_BYTES)) flushPending();
    pendingData += line;
    pendingCount += 1;
    pendingBytes += bytes;
    if (pendingCount >= MAX_BATCH_MESSAGES || pendingBytes >= MAX_BATCH_BYTES) flushPending();
    drain();
  };
  async function retire(): Promise<void> {
    if (!handle) return;
    await bounded(writing, 4000).catch(() => undefined);
    try {
      await handle.closeStdin({ requestTimeoutMs: 3000 });
      await bounded(handle.wait(), 4000);
    } catch {
      await bounded(handle.kill(), 4000).catch(() => undefined);
    }
  }
  const transport: ConnectOverCDPTransport = {
    send(message) {
      if (ended || !handle) throw Error("guest_transport_closed");
      if (queued >= MAX_TRANSPORT_QUEUE) { finish("guest_queue_full"); return; }
      queued += 1;
      const line = JSON.stringify(message) + "\n";
      enqueue(line);
    },
    close() { finish(); closing ??= retire(); },
  };
  const abortTransport = (): void => {
    if (!ended) finish("guest_aborted");
    if (handle) closing ??= retire();
  };
  options.signal?.addEventListener("abort", abortTransport, { once: true });
  try {
    if (options.signal?.aborted) throw Error("guest_aborted");
    const starting = guest.commands.run(command, {
      background: true, stdin: true, retainOutput: false, user: "user",
      timeoutMs: lifetime, requestTimeoutMs: startup, signal: options.signal,
      onStdout(chunk) {
        if (ended) return;
        try {
          buffer += chunk;
          if (buffer.length > 36 * 1024 * 1024) throw Error("guest_message_too_large");
          for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
            const line = buffer.slice(0, newline).trimEnd();
            buffer = buffer.slice(newline + 1);
            if (line) transport.onmessage?.(JSON.parse(Buffer.from(line, "base64").toString("utf8")));
          }
        } catch { finish("guest_protocol_error"); }
      },
    });
    void starting.then((lateHandle) => {
      if (ended && !handle) {
        handle = lateHandle;
        void retire();
      }
    }, () => undefined);
    handle = await bounded(starting, startup, options.signal);
    if (options.signal?.aborted) {
      transport.close();
      await closing;
      throw Error("guest_aborted");
    }
    void handle.wait().then(() => finish("guest_closed"), () => finish("guest_terminated"));
    const connecting = chromium.connectOverCDP(transport, { timeout: startup, noDefaults: true });
    void connecting.catch(() => undefined);
    browser = await bounded(connecting, startup, options.signal);
    const contexts = browser.contexts();
    if (contexts.length !== 1 || contexts[0].pages().length !== 1) throw Error("guest_page_scope_ambiguous");
    const page = contexts[0].pages()[0];
    if (page.url() !== "about:blank") throw Error("guest_unexpected_initial_page");
    if (options.prepare) await bounded(options.prepare(page), startup, options.signal);
    if (options.signal?.aborted) throw Error("guest_aborted");
    return { page, close: async () => {
      options.signal?.removeEventListener("abort", abortTransport);
      try { await bounded(browser!.close(), 4000).catch(() => undefined); }
      finally { transport.close(); await closing; }
    } };
  } catch (error) {
    options.signal?.removeEventListener("abort", abortTransport);
    if (browser) await bounded(browser.close(), 4000).catch(() => undefined);
    transport.close();
    await closing;
    throw error;
  }
}

export async function createE2BBrowserBackend(guest: E2BGuest, options: E2BBrowserOptions = {}): Promise<DesktopBackend> {
  const managed = await openE2BManagedPage(guest, options);
  try {
    // Playwright actionability and delivery span multiple round trips to the guest.
    const scoped = createBrowserBackend(managed.page, { ...options.browser,
      skipPostNavigationFocusRefresh: options.browser?.skipPostNavigationFocusRefresh ?? true,
      preferMouseNavigationClick: options.browser?.preferMouseNavigationClick ?? true,
      actionTimeoutMs: options.browser?.actionTimeoutMs ?? 15_000 });
    // Preserve method receivers; the caller owns the enclosing sandbox.
    return {
      allowDocumentText: scoped.allowDocumentText,
      supportsScopedRefRefresh: scoped.supportsScopedRefRefresh,
      hitTestSnapshot: scoped.hitTestSnapshot,
      capabilities: scoped.capabilities,
      observe: o => scoped.observe(o),
      ...(scoped.hitTest ? { hitTest: scoped.hitTest.bind(scoped) } : {}),
      dispatch: r => scoped.dispatch(r),
      close: async () => { try { await scoped.close(); } finally { await managed.close(); } },
    };
  } catch (error) { await managed.close(); throw error; }
}

export {
  createE2BDesktopBackend,
  E2BAtSpiCommandWorker,
  E2BX11RecipientProcess,
  E2B_X11_SCROLL_MAX_AMOUNT,
} from "./desktop.js";
export type {
  E2BAtSpiWorker,
  E2BX11Recipient,
  E2BX11KeyboardRecipient,
  E2BDesktopActivationEvent,
  E2BDesktopBackendOptions,
  E2BDesktopSurface,
  E2BWindowGrant,
} from "./desktop.js";
