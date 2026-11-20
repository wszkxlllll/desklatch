import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWorkspace } from "desklatch/workspace";

const DEFAULT_PORT = 17_642;
const DEFAULT_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The settings screen intentionally works with a host-owned fixture.  These
 * are labels only: no process is launched and no real personal window is
 * discovered or touched by this preview server.
 */
const BASE_GROUPS = Object.freeze([
  Object.freeze({
    id: "browser",
    name: "Chrome",
    windows: Object.freeze([
      Object.freeze({ id: "browser-research", title: "网页调研" }),
      Object.freeze({ id: "browser-account", title: "已登录窗口" }),
    ]),
  }),
  Object.freeze({
    id: "editor",
    name: "Word",
    windows: Object.freeze([
      Object.freeze({ id: "editor-project", title: "项目笔记" }),
      Object.freeze({ id: "editor-private", title: "个人草稿" }),
    ]),
  }),
]);

const MAIL_GROUP = Object.freeze({
  id: "mail",
  name: "Mail",
  windows: Object.freeze([
    Object.freeze({ id: "mail-inbox", title: "收件箱" }),
  ]),
});

// One deterministic public-browser proof target keeps the preview useful
// before a product host supplies its real independent-browser factory.
const BROWSER_CHECKS = Object.freeze([
  Object.freeze({ id: "python-docs", name: "Python 官方文档", origin: "https://docs.python.org" }),
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clonePreferences(preferences) {
  return {
    blockedApps: [...preferences.blockedApps],
    blockedWindows: [...preferences.blockedWindows],
    browser: {
      mode: preferences.browser.mode,
      origins: [...preferences.browser.origins],
    },
  };
}

function fixtureGroups(includeMail) {
  return includeMail ? [...BASE_GROUPS, MAIL_GROUP] : [...BASE_GROUPS];
}

function fixtureIndexes(groups) {
  const appIds = new Set(groups.map((group) => group.id));
  const windowIds = new Set(groups.flatMap((group) => group.windows.map((window) => window.id)));
  const windowToGroup = new Map();
  for (const group of groups) {
    for (const window of group.windows) windowToGroup.set(window.id, group.id);
  }
  return { appIds, windowIds, windowToGroup };
}

function defaultPreferences() {
  return {
    blockedApps: [],
    blockedWindows: [],
    browser: { mode: "public", origins: [] },
  };
}

function uniqueStrings(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field}_invalid`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function normalizeOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new Error("browser_origins_invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("browser_origins_invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol)
    || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("browser_origins_invalid");
  }
  return parsed.origin;
}

function normalizePreferences(input, indexes, previous = defaultPreferences()) {
  if (!isRecord(input)) throw new Error("preferences_invalid");
  const blockedApps = uniqueStrings(input.blockedApps, "blocked_apps") ?? [...previous.blockedApps];
  const blockedWindows = uniqueStrings(input.blockedWindows, "blocked_windows") ?? [...previous.blockedWindows];
  for (const id of blockedApps) {
    if (!indexes.appIds.has(id)) throw new Error("blocked_app_unknown");
  }
  for (const id of blockedWindows) {
    if (!indexes.windowIds.has(id)) throw new Error("blocked_window_unknown");
  }

  let browser = previous.browser;
  if (input.browser !== undefined) {
    if (!isRecord(input.browser)) throw new Error("browser_invalid");
    const mode = input.browser.mode === undefined ? previous.browser.mode : input.browser.mode;
    if (mode !== "public" && mode !== "sites") throw new Error("browser_mode_invalid");
    const originsValue = input.browser.origins === undefined
      ? previous.browser.origins
      : uniqueStrings(input.browser.origins, "browser_origins");
    browser = {
      mode,
      origins: [...new Set((originsValue ?? []).map(normalizeOrigin))],
    };
  }
  return { blockedApps, blockedWindows, browser };
}

async function readPersistedPreferences(statePath, indexes) {
  if (!statePath) return defaultPreferences();
  try {
    const encoded = await readFile(statePath, "utf8");
    if (encoded.includes("\uFFFD") || /\?{3,}/u.test(encoded)) throw new Error("state_utf8_corrupt");
    const parsed = JSON.parse(encoded);
    const candidate = isRecord(parsed) && isRecord(parsed.preferences) ? parsed.preferences : parsed;
    return normalizePreferences(candidate, indexes);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // A damaged preference file must not prevent the local preview from
      // opening.  The next successful save replaces it atomically.
    }
    return defaultPreferences();
  }
}

async function persistPreferences(statePath, preferences) {
  if (!statePath) return;
  const target = resolve(statePath);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const encoded = `${JSON.stringify({ version: 1, preferences }, null, 2)}\n`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, encoded, { encoding: "utf8", flag: "wx" });
    const readBack = await readFile(temporary, "utf8");
    if (readBack !== encoded || readBack.includes("\uFFFD") || /\?{3,}/u.test(readBack)) {
      throw new Error("state_utf8_corrupt");
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function parsePort(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error("port_invalid");
  return parsed;
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function formatHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}

function resultCode(result) {
  return isRecord(result) && typeof result.code === "string"
    ? result.code
    : isRecord(result) && typeof result.status === "string" ? result.status : "unknown";
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendError(response, status, code) {
  sendJson(response, status, { error: code });
}

function requestHostOrigin(request, expectedHost, expectedOrigin) {
  if (typeof request.headers.host !== "string" || request.headers.host.toLowerCase() !== expectedHost) {
    return false;
  }
  const origin = request.headers.origin;
  return origin === undefined || origin === expectedOrigin;
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectBody(error);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        fail(new Error("request_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", fail);
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.includes("\uFFFD")) throw new Error("invalid_utf8");
        resolveBody(text ? JSON.parse(text) : {});
      } catch (error) {
        rejectBody(error);
      }
    });
  });
}

function runAbortable(task, signal) {
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(task).then(
      (value) => finish(value),
      (error) => finish(undefined, error),
    );
  });
}

function makeSyntheticSession() {
  let closed = false;
  return {
    capabilities: Object.freeze([]),
    allowModelImages: false,
    allowModelDocumentText: false,
    limits: Object.freeze({ maxSteps: 1, maxTextLength: 256, maxScrollAmount: 1 }),
    async observe() {
      if (closed) throw new Error("closed");
      return { observationId: "sample-observation", view: "controls", complete: true, controls: [] };
    },
    async act() {
      if (closed) return { status: "stopped", code: "closed", steps: [] };
      return { status: "completed", code: "sample_dispatched", steps: [] };
    },
    async resolveApproval(requestId) {
      return { requestId, status: "stopped", code: "approval_not_found", steps: [] };
    },
    correct() {},
    cancel() {},
    async close() { closed = true; },
  };
}

function createFixtureWorkspace(groups, getPreferences) {
  const indexes = fixtureIndexes(groups);
  let foreground;
  const applications = groups.flatMap((group) => group.windows.map((window) => {
    const session = makeSyntheticSession();
    return {
      id: window.id,
      name: `${group.name}: ${window.title}`,
      description: "Sample window used by the settings preview; never a personal window.",
      session,
      activate() {
        foreground = window.id;
        return { status: "dispatched", code: "sample_activation" };
      },
      verifyFront() {
        return foreground === window.id;
      },
    };
  }));
  const canAutomate = ({ id }) => {
    const preferences = getPreferences();
    const groupId = indexes.windowToGroup.get(id);
    return groupId !== undefined
      && !preferences.blockedApps.includes(groupId)
      && !preferences.blockedWindows.includes(id);
  };
  const workspace = createWorkspace({ applications, canAutomate });
  const act = workspace.tools.find((tool) => tool.name === "act");
  if (!act) throw new Error("workspace_act_tool_missing");
  return { workspace, act, indexes };
}

function snapshot(groups, preferences) {
  return {
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      windows: group.windows.map((window) => ({
        id: window.id,
        title: window.title,
        status: preferences.blockedApps.includes(group.id) || preferences.blockedWindows.includes(window.id)
          ? "blocked" : "allowed",
      })),
    })),
    preferences: clonePreferences(preferences),
    browserChecks: BROWSER_CHECKS.map((check) => ({ ...check })),
    sampleOnly: true,
    notice: "Preview choices apply to sample windows only; personal windows are never touched.",
  };
}

function staticHeaders(type, length) {
  return {
    "Content-Type": type,
    "Content-Length": length,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  };
}

/**
 * Start the dependency-free local settings host.
 *
 * The returned URL contains a per-run capability in its fragment.  Fragments
 * are not sent in HTTP requests; the companion UI must copy the `key` value
 * into `X-DeskLatch-Key` on same-origin API requests.
 */
export async function startAutomationSettingsServer(options = {}) {
  const port = parsePort(options.port ?? process.env.DESKLATCH_AUTOMATION_SETTINGS_PORT ?? DEFAULT_PORT);
  const host = options.host ?? process.env.DESKLATCH_AUTOMATION_SETTINGS_HOST ?? DEFAULT_HOST;
  if (!isLoopbackHost(host)) throw new Error("loopback_host_required");
  const includeMail = options.includeMail === true || process.env.DESKLATCH_AUTOMATION_SETTINGS_MAIL === "true";
  if (options.checkSite !== undefined && typeof options.checkSite !== "function") {
    throw new TypeError("checkSite_must_be_function");
  }
  const groups = fixtureGroups(includeMail);
  const indexes = fixtureIndexes(groups);
  const statePath = options.statePath === null
    ? undefined
    : options.statePath ?? process.env.DESKLATCH_AUTOMATION_SETTINGS_STATE;
  let preferences = await readPersistedPreferences(statePath, indexes);
  const fixture = createFixtureWorkspace(groups, () => preferences);
  const capabilityToken = randomBytes(32).toString("base64url");
  const staticRoot = resolve(options.staticDir ?? here);
  let actualPort;
  let closed = false;
  let siteProbe;
  let siteProbeController;

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "invalid"}`);
      const hostHeader = `${formatHost(host)}:${actualPort}`.toLowerCase();
      const origin = `http://${hostHeader}`;
      if (!requestHostOrigin(request, hostHeader, origin)) {
        sendError(response, 403, "host_or_origin_denied");
        return;
      }

      const isApi = requestUrl.pathname.startsWith("/api/");
      if (isApi && request.headers["x-desklatch-key"] !== capabilityToken) {
        sendError(response, 401, "capability_key_required");
        return;
      }

      if (requestUrl.pathname === "/api/settings" || requestUrl.pathname === "/api/seed") {
        if (request.method === "GET") {
          sendJson(response, 200, snapshot(groups, preferences));
          return;
        }
        if (request.method !== "PUT" || requestUrl.pathname !== "/api/settings") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
        if (contentType !== "application/json") {
          sendError(response, 415, "json_required");
          return;
        }
        let body;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          sendError(response, error?.message === "request_too_large" ? 413 : 400, error?.message === "request_too_large" ? "request_too_large" : "invalid_json");
          return;
        }
        const candidate = isRecord(body) && isRecord(body.preferences) ? body.preferences : body;
        try {
          const nextPreferences = normalizePreferences(candidate, indexes, preferences);
          const previous = preferences;
          // Correct before changing the gate so pending workspace operations
          // cannot cross the preference revision boundary.
          siteProbeController?.abort("settings_saved");
          fixture.workspace.correct("settings_saved");
          preferences = nextPreferences;
          try {
            await persistPreferences(statePath, preferences);
          } catch (error) {
            preferences = previous;
            throw error;
          }
          sendJson(response, 200, snapshot(groups, preferences));
        } catch (error) {
          const code = [
            "blocked_apps_invalid", "blocked_windows_invalid", "blocked_app_unknown", "blocked_window_unknown",
            "browser_invalid", "browser_mode_invalid", "browser_origins_invalid", "preferences_invalid",
          ].includes(error?.message) ? error.message : "settings_persist_failed";
          sendError(response, code === "settings_persist_failed" ? 500 : 400, code);
        }
        return;
      }

      if (requestUrl.pathname === "/api/check") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
        if (contentType !== "application/json") {
          sendError(response, 415, "json_required");
          return;
        }
        let body;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          sendError(response, error?.message === "request_too_large" ? 413 : 400, error?.message === "request_too_large" ? "request_too_large" : "invalid_json");
          return;
        }
        if (!isRecord(body) || typeof body.id !== "string" || body.id.length === 0 || body.id.length > 256) {
          sendError(response, 400, "application_id_invalid");
          return;
        }
        const result = await fixture.act.invoke({ activate: body.id });
        sendJson(response, 200, {
          id: body.id,
          allowed: isRecord(result) && result.status === "completed",
          code: resultCode(result),
        });
        return;
      }

      if (requestUrl.pathname === "/api/check-site") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
        if (contentType !== "application/json") {
          sendError(response, 415, "json_required");
          return;
        }
        let body;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          sendError(response, error?.message === "request_too_large" ? 413 : 400, error?.message === "request_too_large" ? "request_too_large" : "invalid_json");
          return;
        }
        const check = BROWSER_CHECKS.find((candidate) => candidate.id === body?.id);
        if (!check) {
          sendError(response, 400, "browser_check_unknown");
          return;
        }
        if (!siteProbe) {
          // Keep the complete gate + host probe under one promise. This means
          // two clicks cannot race between sample activation and callback
          // registration and accidentally start two independent browsers.
          const controller = new AbortController();
          siteProbeController = controller;
          siteProbe = Promise.resolve().then(async () => {
            const probePreferences = clonePreferences(preferences);
            if (probePreferences.browser.mode === "sites"
              && !probePreferences.browser.origins.includes(check.origin)) {
              return { id: check.id, allowed: false, code: "browser_site_not_granted" };
            }
            const sampleResult = await fixture.act.invoke({ activate: "browser-research" });
            if (!isRecord(sampleResult) || sampleResult.status !== "completed") {
              return { id: check.id, allowed: false, code: resultCode(sampleResult) };
            }
            if (typeof options.checkSite !== "function") {
              return { id: check.id, allowed: false, code: "browser_probe_unavailable" };
            }
            const result = await runAbortable(() => options.checkSite({
              id: check.id,
              origin: check.origin,
              preferences: probePreferences,
              signal: controller.signal,
            }), controller.signal);
            if (isRecord(result) && result.aborted === true) {
              return { id: check.id, allowed: false, code: "browser_probe_aborted" };
            }
            const actualOrigin = isRecord(result) && typeof result.origin === "string" ? result.origin : check.origin;
            if (probePreferences.browser.mode === "sites" && !probePreferences.browser.origins.includes(actualOrigin)) {
              return { id: check.id, allowed: false, code: "browser_site_not_granted" };
            }
            if (result === true) return { id: check.id, allowed: true, code: "browser_probe_allowed" };
            if (isRecord(result)) {
              return {
                id: check.id,
                allowed: result.allowed === true,
                code: typeof result.code === "string" ? result.code : result.allowed === true ? "browser_probe_allowed" : "browser_probe_blocked",
              };
            }
            return { id: check.id, allowed: false, code: "browser_probe_blocked" };
          }).catch(() => ({ id: check.id, allowed: false, code: "browser_probe_failed" })).finally(() => {
            if (siteProbeController === controller) siteProbeController = undefined;
            siteProbe = undefined;
          });
        }
        sendJson(response, 200, await siteProbe);
        return;
      }

      if (!requestUrl.pathname.startsWith("/api/") && request.method === "GET") {
        const staticFile = STATIC_FILES.get(requestUrl.pathname);
        if (!staticFile) {
          sendError(response, 404, "not_found");
          return;
        }
        const [fileName, contentType] = staticFile;
        const filePath = resolve(staticRoot, fileName);
        if (dirname(filePath) !== staticRoot) {
          sendError(response, 404, "not_found");
          return;
        }
        try {
          const body = await readFile(filePath);
          response.writeHead(200, staticHeaders(contentType, body.byteLength));
          response.end(body);
        } catch (error) {
          sendError(response, error?.code === "ENOENT" ? 404 : 500, error?.code === "ENOENT" ? "not_found" : "static_read_failed");
        }
        return;
      }

      sendError(response, 404, "not_found");
    } catch {
      if (!response.headersSent) sendError(response, 500, "internal_error");
      else response.destroy();
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const address = server.address();
  actualPort = typeof address === "object" && address ? address.port : port;
  const hostHeader = `${formatHost(host)}:${actualPort}`.toLowerCase();
  const origin = `http://${hostHeader}`;
  const url = `${origin}/#key=${capabilityToken}`;

  const close = async () => {
    if (closed) return;
    closed = true;
    siteProbeController?.abort("closed");
    await fixture.workspace.close();
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  };

  return Object.freeze({
    server,
    workspace: fixture.workspace,
    url,
    origin,
    host,
    port: actualPort,
    token: capabilityToken,
    capabilityToken,
    statePath,
    close,
  });
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    // Keep the core host framework-neutral. The optional sibling probe is
    // loaded only for the CLI, so embedding/tests can inject their own host
    // callback (or leave site checks unavailable).
    const probeModule = process.env.DESKLATCH_AUTOMATION_SETTINGS_DISABLE_BROWSER_PROBE === "true"
      ? undefined
      : await import("./browser-probe.mjs").catch(() => undefined);
    const running = await startAutomationSettingsServer({
      ...(probeModule?.probeBrowserSite ? { checkSite: probeModule.probeBrowserSite } : {}),
    });
    console.log(running.url);
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
