import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CuaDriver, ListWindowsInput } from "@trycua/cua-driver";
import { chromium } from "playwright-core";
import { createBrowserBackend, createWorkspaceNavigator } from "desklatch/browser";
import {
  createDeskSession,
  createRiskPolicy,
} from "desklatch";
import {
  createWindowsDesktopBackend,
  loadWindowsPhysicalInspector,
  loadWindowsOwnedDialogInspector,
  NativeUiAutomationWindowsTransport,
} from "desklatch/windows";
import { createOnDemandWorkspaceApplication, createWorkspace } from "desklatch/workspace";
import { checkEastVisitHours, checkVisitNote, fetchMuseumReference, museumVisitTask } from "./support/museum-visit-oracle.mjs";
import { auditWorkspaceDelivery, verifySavedVisitNote } from "./support/workspace-audit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resultsRoot = process.env.DESKLATCH_RESULTS_DIR;
const modelName = "glm-5.3-flash";
const officialOrigin = "https://www.shanghaimuseum.cn";

function scrub(value, key) {
  if (typeof value === "bigint") return value.toString();
  if (key === "images" && Array.isArray(value)) {
    return value.map((item) => {
      if (!item || typeof item !== "object") return item;
      const encoded = JSON.stringify(item, (_childKey, child) => typeof child === "bigint" ? child.toString() : child);
      return { sha256: createHash("sha256").update(encoded, "utf8").digest("hex"), length: encoded.length };
    });
  }
  if (key && /(?:base64|screenshot|bytes|credential|apiKey|api_key|rawImage)/iu.test(key)) {
    if (value === undefined || value === null) return value;
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    return { sha256: createHash("sha256").update(encoded, "utf8").digest("hex"), length: encoded.length };
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, scrub(childValue, childKey)]));
  }
  return value;
}

function scrubText(value, key, keyToHide) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return keyToHide && value.includes(keyToHide) ? value.replaceAll(keyToHide, "[credential]") : value;
  if (Array.isArray(value)) return value.map((item) => scrubText(item, undefined, keyToHide));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, scrubText(childValue, childKey, keyToHide)]));
  }
  return value;
}

async function writeUtf8Json(filePath, value, keyToHide) {
  const cleaned = scrubText(value, undefined, keyToHide);
  const encoded = `${JSON.stringify(cleaned, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, encoded, "utf8");
  const readBack = await readFile(filePath, "utf8");
  if (readBack !== encoded || readBack.includes("\uFFFD") || /\?{3,}/u.test(readBack)) throw Error("utf8_artifact_corrupt");
}

async function loadZhipuKey() {
  const key = process.env.ZHIPU_API_KEY;
  if (!key) throw Error("zhipu_api_key_missing");
  return key;
}

function executable(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function chromePath() {
  return executable([
    process.env.DESKLATCH_LOCAL_CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ]);
}

function wordPath() {
  return executable([
    process.env.DESKLATCH_LOCAL_WORD_PATH,
    "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
    "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
  ]);
}

function spawnOwned(filePath, args) {
  return spawn(filePath, args, { detached: false, stdio: "ignore", windowsHide: false });
}

function windowJson(window) {
  return { pid: window.pid, hwnd: String(window.windowId), title: window.title, appName: window.appName,
    bounds: window.bounds, minimized: window.minimized, onScreen: window.isOnScreen, zIndex: window.zIndex };
}

async function listWindows(driver, options = { onScreenOnly: false }) {
  const listed = await driver.listWindows(ListWindowsInput.new(options));
  return listed.windows ?? [];
}

async function waitExactWindow(driver, pid, predicate, timeoutMs = 20_000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error("activation_cancelled"), { code: "activation_cancelled" });
    const windows = await listWindows(driver, { onScreenOnly: false });
    const found = windows.filter((window) => window.pid === pid && window.windowId > 0n && predicate(window));
    if (found.length === 1) return found[0];
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw Error(`owned_window_not_found:${pid}`);
}

async function waitCdp(profile, port, timeoutMs = 20_000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error("activation_cancelled"), { code: "activation_cancelled" });
    try {
      const assignedPort = port || Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/, 1)[0]);
      if (!Number.isInteger(assignedPort) || assignedPort < 1 || assignedPort > 65_535) throw Error("chrome_cdp_invalid_port");
      const endpoint = new URL(`http://127.0.0.1:${assignedPort}`);
      const timeout = AbortSignal.timeout(1_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(new URL("/json/version", endpoint), { signal: requestSignal });
      if (response.ok) return { endpoint: endpoint.origin, port: assignedPort };
    } catch { /* Chrome is still starting. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw Error("chrome_cdp_not_ready");
}

function targetFromWindow(window) {
  return Object.freeze({ pid: window.pid, hwnd: BigInt(window.windowId), title: window.title });
}

function stringifyNative(value) {
  const marker = `__desklatch_bigint_${randomUUID()}__`;
  const encoded = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `${marker}${item.toString()}` : item);
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return encoded.replace(new RegExp(`"${escaped}(\\d+)"`, "gu"), "$1");
}

function resultIsSuccessful(result) {
  if (!result || result.isError === true) return false;
  const action = result.action && typeof result.action === "object" ? result.action : result.structuredContent;
  if (action && typeof action === "object" && typeof action.effect === "string") {
    return !/refused|failed|error/iu.test(action.effect);
  }
  return true;
}

function exactActivation({ driver, inspector, metrics, label }) {
  return async (target) => {
    const args = { pid: target.pid, window_id: target.hwnd };
    const started = performance.now();
    let result;
    try {
      result = await driver.callTool("bring_to_front", stringifyNative(args));
      const evidence = await inspector?.read(target);
      const verified = evidence?.foregroundHwnd === target.hwnd && evidence?.foregroundPid === target.pid;
      const record = { label, target: { pid: target.pid, hwnd: target.hwnd.toString(), title: target.title },
        args, driverResult: scrub(result), evidence: scrub(evidence), verified, elapsedMs: Math.round(performance.now() - started) };
      metrics.activations.push(record);
      if (!resultIsSuccessful(result)) return { status: "refused", code: "activation_driver_refused" };
      return { status: verified ? "dispatched" : "unknown", ...(verified ? {} : { code: "foreground_not_confirmed" }) };
    } catch (error) {
      const record = { label, target: { pid: target.pid, hwnd: target.hwnd.toString(), title: target.title }, args,
        error: String(error?.message ?? error), elapsedMs: Math.round(performance.now() - started), verified: false };
      metrics.activations.push(record);
      return { status: "unknown", code: "activation_failed" };
    }
  };
}

function verifyFront({ inspector, metrics, label }) {
  return async (context) => {
    const target = context.target;
    const evidence = await inspector?.read(target);
    const verified = evidence?.foregroundHwnd === target.hwnd && evidence?.foregroundPid === target.pid;
    metrics.foreground.push({ label, target: { pid: target.pid, hwnd: target.hwnd.toString(), title: target.title },
      evidence: scrub(evidence), verified });
    return verified;
  };
}

function inactiveError(label) {
  const error = new Error(`${label}_not_foreground`);
  error.code = "application_not_foreground";
  return error;
}

function guardedSession(session, target, inspector, label, metrics, hooks = {}) {
  const front = async () => {
    const evidence = await inspector?.read(target);
    const verified = evidence?.foregroundHwnd === target.hwnd && evidence?.foregroundPid === target.pid;
    metrics.foregroundChecks.push({ label, evidence: scrub(evidence), verified });
    return verified;
  };
  return {
    get capabilities() { return session.capabilities; },
    get allowModelImages() { return session.allowModelImages; },
    get allowModelDocumentText() { return session.allowModelDocumentText; },
    get limits() { return session.limits; },
    async observe(options) {
      if (!(await front())) throw inactiveError(label);
      return session.observe(options);
    },
    async act(input, signal) {
      if (!(await front())) {
        return { status: "stopped", code: "application_not_foreground", steps: Array.isArray(input?.steps)
          ? input.steps.map((_step, index) => ({ index: index + 1, status: "not_dispatched", code: "application_not_foreground" })) : [] };
      }
      hooks.beforeAct?.(input);
      const result = await session.act(input, signal);
      const replaced = await hooks.afterAct?.(input, result);
      return replaced ?? result;
    },
    resolveApproval(requestId, decision) { return session.resolveApproval(requestId, decision); },
    correct(reason) { return session.correct(reason); },
    cancel(reason) { return session.cancel(reason); },
    close() { return session.close(); },
  };
}

function savePolicy(outputPath, existingPath) {
  const saveNames = new Set(["保存", "Save"]);
  const base = createRiskPolicy({
    hostRules: {
      hardDeny: ({ target }) => {
        if (target.name && /(?:send|submit|purchase|buy|payment|预约|购票|购买|支付)/iu.test(target.name)) {
          return { match: true, code: "local_read_only_block" };
        }
        return false;
      },
      requireApproval: ({ step, target }) => {
        const ctrlS = step.kind === "hotkey" && Array.isArray(step.keys) && step.keys.length === 2
          && step.keys[0].toLocaleLowerCase() === "ctrl" && step.keys[1].toLocaleLowerCase() === "s";
        return ctrlS || (target.name !== undefined && saveNames.has(target.name))
          ? { match: true, code: "disposable_save_requires_host_approval" } : false;
      },
    },
  });
  return async (input) => {
    if (input.step.kind === "click" && input.target.name && /^(?:文件|File|另存为|Save As|空白文档|Blank Document)$/u.test(input.target.name)) {
      return { decision: "allow", code: "safe_word_navigation" };
    }
    return base(input);
  };
}

async function readWordFile(filePath) {
  const reader = resolve(here, "support", "read-word-file.ps1");
  const result = await new Promise((resolvePromise, reject) => execFile("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", reader, "-FilePath", filePath,
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolvePromise({ stdout, stderr });
  }));
  const text = String(result.stdout ?? "").trim();
  if (!text || text.includes("\uFFFD") || /\?{3,}/u.test(text)) throw Error("word_oracle_utf8_corrupt");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.paragraphs) || typeof parsed.sha256 !== "string") throw Error("word_oracle_invalid");
  return parsed;
}

async function createCollisionFixture(filePath) {
  const sentinel = `DESKLATCH_COLLISION_SENTINEL_${randomUUID()}\n`;
  await writeFile(filePath, sentinel, "utf8");
  return { sha256: createHash("sha256").update(sentinel, "utf8").digest("hex"), sentinel };
}

async function launchRuntime({ runDirectory, metrics }) {
  const driver = CuaDriver.create(undefined);
  const childProcesses = [];
  const resources = { browser: undefined, word: undefined };
  const openPromises = { browser: undefined, word: undefined };
  const chrome = chromePath();
  const word = wordPath();
  if (!chrome || !word) throw Error("chrome_or_word_not_installed");
  const profile = join(runDirectory, "chrome-profile");
  await mkdir(profile, { recursive: true });
  const port = Number(process.env.DESKLATCH_LOCAL_CHROME_PORT ?? 0);
  const wordInputPath = process.env.DESKLATCH_LOCAL_WORD_INPUT_PATH;
  const inspector = await loadWindowsPhysicalInspector();
  if (!inspector) throw Error("windows_physical_inspector_unavailable");
  const visitedUrls = [];
  const modalApplications = new Map();
  metrics.lazyRegistration = { registered: ["browser", "word"], spawnedBeforeActivation: 0, opened: [], profile, cdpPort: port };
  metrics.startup = { registeredApplications: ["browser", "word"], spawnedBeforeActivation: 0, profile, cdpPort: port };

  const abortIfNeeded = (signal) => {
    if (signal?.aborted) throw Object.assign(new Error("activation_cancelled"), { code: "activation_cancelled" });
  };
  const ownedPid = (child, label) => {
    const pid = Number(child?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error(`${label}_owned_pid_unavailable`);
    return pid;
  };
  const killChild = (child) => {
    try { child?.kill(); } catch { /* exact child only */ }
  };
  const recordLaunch = (id, executablePath, child, window) => {
    const pid = Number(child.pid);
    const record = { id, executable: basename(executablePath), spawnedPid: pid, target: windowJson(window),
      exactPidMatch: window.pid === pid, openedAt: new Date().toISOString() };
    metrics.lazyRegistration.opened.push(record);
    metrics.startup.openedApplications = metrics.lazyRegistration.opened;
  };
  const closeBrowserResource = async (resource) => {
    if (!resource || resource.closed) return;
    resource.closed = true;
    resource.page?.off?.("framenavigated", resource.onNavigated);
    await resource.session?.close().catch(() => undefined);
    await resource.navigator?.close().catch(() => undefined);
    await resource.connection?.close().catch(() => undefined);
    killChild(resource.child);
  };
  const closeWordResource = async (resource) => {
    if (!resource || resource.closed) return;
    resource.closed = true;
    await resource.session?.close().catch(() => undefined);
    killChild(resource.child);
  };

  async function openBrowserNow(signal) {
    abortIfNeeded(signal);
    const child = spawnOwned(chrome, [
      `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "about:blank",
    ]);
    childProcesses.push(child);
    let connection;
    let page;
    let navigator;
    let session;
    let onNavigated;
    try {
      const pid = ownedPid(child, "chrome");
      const cdp = await waitCdp(profile, port, 20_000, signal);
      metrics.lazyRegistration.cdpPort = cdp.port;
      metrics.startup.cdpPort = cdp.port;
      abortIfNeeded(signal);
      connection = await chromium.connectOverCDP(cdp.endpoint);
      page = connection.contexts()[0]?.pages()[0];
      if (!page || page.url() !== "about:blank") throw Error("browser_not_blank_at_start");
      const chromeWindow = await waitExactWindow(driver, pid, (window) => /chrome|edge/iu.test(window.appName ?? "")
        && /about:blank|Google Chrome|Microsoft Edge/iu.test(window.title ?? ""), 20_000, signal);
      if (chromeWindow.pid !== pid) throw Error("browser_window_pid_mismatch");
      const target = targetFromWindow(chromeWindow);
      const activate = exactActivation({ driver, inspector, metrics, label: "browser" });
      const front = verifyFront({ inspector, metrics, label: "browser" });
      onNavigated = (frame) => {
        if (frame !== page.mainFrame()) return;
        const url = frame.url();
        if (!visitedUrls.includes(url)) visitedUrls.push(url);
        metrics.visitedUrls = [...visitedUrls];
      };
      page.on("framenavigated", onNavigated);
      navigator = createWorkspaceNavigator(page, { authorizedOrigins: [officialOrigin] });
      const browserBackend = createBrowserBackend(page, {
        scope: `local-browser-${randomUUID()}`,
        authorizedOrigins: [officialOrigin],
        allowBlank: true,
        allowImages: true,
        includePublicValues: true,
        allowDocumentText: true,
        documentTextLimit: 16_000,
        documentChunkLimit: 4,
        documentChunkSize: 2_000,
        observeLimit: 96,
        searchLimit: 500,
        searchTimeoutMs: 4_000,
        settleMs: 250,
        actionTimeoutMs: 15_000,
      });
      const browserPolicy = createRiskPolicy({
        hostRules: {
          hardDeny: ({ target: control }) => control.name && /(?:reservation|ticket|purchase|buy|payment|checkout|submit|confirm|预约|购票|购买|支付|提交|确认)/iu.test(control.name)
            ? { match: true, code: "museum_read_only_block" } : false,
        },
      });
      const rawSession = createDeskSession(browserBackend, { policy: browserPolicy, allowModelImages: true, allowModelDocumentText: true, maxSteps: 24, timeoutMs: 120_000 });
      session = guardedSession(rawSession, target, inspector, "browser", metrics);
      abortIfNeeded(signal);
      const opened = {
        session,
        async activate() { return activate(target); },
        async verifyFront(context) { return front({ ...context, target }); },
        async navigate(context) {
          const url = context?.url;
          const navigateSignal = context?.signal;
          abortIfNeeded(navigateSignal);
          const parsed = new URL(url);
          if (parsed.origin !== officialOrigin) throw Error("browser_origin_not_allowlisted");
          if (!(await front({ id: "browser", applicationId: "browser", target }))) throw inactiveError("browser");
          let receipt;
          try {
            receipt = await navigator.navigate(url, navigateSignal);
          } catch (error) {
            metrics.navigationErrors = metrics.navigationErrors ?? [];
            metrics.navigationErrors.push({ code: error?.code, message: String(error?.message ?? error), url });
            throw error;
          }
          metrics.navigations = metrics.navigations ?? [];
          metrics.navigations.push({ ...receipt, selectedByModel: true });
          await page.waitForTimeout(300);
          abortIfNeeded(navigateSignal);
          return { status: "completed", code: "model_navigation_completed", steps: [], applicationId: "browser", ...receipt };
        },
      };
      resources.browser = { child, connection, page, navigator, session, target, onNavigated, opened, closed: false };
      metrics.browser = { pid: target.pid, hwnd: target.hwnd.toString(), title: target.title };
      recordLaunch("browser", chrome, child, chromeWindow);
      return opened;
    } catch (error) {
      page?.off?.("framenavigated", onNavigated);
      await session?.close().catch(() => undefined);
      await navigator?.close().catch(() => undefined);
      await connection?.close().catch(() => undefined);
      if (resources.browser?.child === child) resources.browser = undefined;
      killChild(child);
      throw error;
    }
  }

  function openBrowser(signal) {
    if (resources.browser && !resources.browser.closed) return Promise.resolve(resources.browser.opened);
    if (!openPromises.browser) openPromises.browser = openBrowserNow(signal).finally(() => { openPromises.browser = undefined; });
    return openPromises.browser;
  }

  async function openWordNow(signal) {
    abortIfNeeded(signal);
    const child = spawnOwned(word, wordInputPath ? ["/n", wordInputPath] : ["/n"]);
    childProcesses.push(child);
    let wordBackend;
    let session;
    try {
      const pid = ownedPid(child, "word");
      const wordMarker = wordInputPath ? basename(wordInputPath).toLocaleLowerCase().replace(/\.docx$/iu, "") : undefined;
      const wordWindow = await waitExactWindow(driver, pid, (window) => {
        const title = window.title ?? "";
        return !/(?:正在打开|Opening|启动|Starting)/iu.test(title)
          && (wordMarker ? title.toLocaleLowerCase().includes(wordMarker) : /(?:文档\s*\d+\s*-\s*Word|Document\s*\d+\s*-\s*Word|^Word$)/iu.test(title));
      }, 20_000, signal);
      if (wordWindow.pid !== pid) throw Error("word_window_pid_mismatch");
      const target = targetFromWindow(wordWindow);
      const activate = exactActivation({ driver, inspector, metrics, label: "word" });
      const front = verifyFront({ inspector, metrics, label: "word" });
      wordBackend = await createWindowsDesktopBackend({
        driver,
        authorization: {
          targets: [target],
          allowForegroundInput: true,
          allowDesktopCapture: true,
          background: { source: "cua-uia-0.54" },
        },
        activateForeground: activate,
        ownedDialogInspector: await loadWindowsOwnedDialogInspector(),
      });
      const rawSession = createDeskSession(wordBackend, {
        policy: savePolicy(metrics.outputPath, metrics.existingPath),
        allowModelImages: false,
        onApprovalRequested: (request) => {
          metrics.approvals = metrics.approvals ?? [];
          metrics.approvals.push({ requestId: request.requestId, kind: request.kind, target: request.target, summary: request.summary, contextSummary: request.contextSummary });
          const keys = Array.isArray(request.params?.keys) ? request.params.keys.map((key) => String(key).toLocaleLowerCase()) : [];
          const ctrlS = request.kind === "hotkey" && keys.length === 2 && keys[0] === "ctrl" && keys[1] === "s";
          if (request.target?.name && /^(?:保存|Save|Save As|另存为)$/u.test(request.target.name)) {
            const live = metrics.word && metrics.foreground?.at(-1);
            if (live?.verified === true && live.target?.pid === metrics.word.pid && live.target?.hwnd === metrics.word.hwnd
              && ((metrics.lastFilenameValue === metrics.outputPath && !existsSync(metrics.outputPath)) || process.env.DESKLATCH_LOCAL_WORD_TEMPLATE_PATH)) return "approve";
            return "deny";
          }
          if (ctrlS) {
            const live = metrics.word && metrics.foreground?.at(-1);
            return live?.verified === true && live.target?.pid === metrics.word.pid && live.target?.hwnd === metrics.word.hwnd ? "approve" : "deny";
          }
          return "deny";
        },
        maxSteps: 24,
        timeoutMs: 120_000,
        approvalTimeoutMs: 15_000,
      });
      session = guardedSession(rawSession, target, inspector, "word", metrics, {
        beforeAct(input) {
          for (const step of input?.steps ?? []) {
            const targetName = step?.target?.name;
            const value = step?.kind === "setValue" ? step.value : step?.kind === "type" ? step.text : undefined;
            if (step?.target?.role === "Document" && (step?.kind === "type" || step?.kind === "setValue")) metrics.documentWrites = (metrics.documentWrites ?? 0) + 1;
            if (step?.kind === "click" && typeof targetName === "string" && /^(?:保存|Save|Save As|另存为)$/iu.test(targetName)) metrics.saveActions = (metrics.saveActions ?? 0) + 1;
            if (typeof value === "string" && typeof targetName === "string" && /^(?:文件名|File name|Name)$/iu.test(targetName)) {
              metrics.lastFilenameValue = value;
              metrics.filenameDispatches = (metrics.filenameDispatches ?? 0) + 1;
            }
          }
        },
      });
      abortIfNeeded(signal);
      const opened = {
        session,
        async activate() { return activate(target); },
        async verifyFront(context) { return front({ ...context, target }); },
      };
      resources.word = { child, wordBackend, session, target, opened, closed: false };
      metrics.word = { pid: target.pid, hwnd: target.hwnd.toString(), title: target.title };
      recordLaunch("word", word, child, wordWindow);
      return opened;
    } catch (error) {
      await session?.close().catch(() => undefined);
      await wordBackend?.close().catch(() => undefined);
      if (resources.word?.child === child) resources.word = undefined;
      killChild(child);
      throw error;
    }
  }

  function openWord(signal) {
    if (resources.word && !resources.word.closed) return Promise.resolve(resources.word.opened);
    if (!openPromises.word) openPromises.word = openWordNow(signal).finally(() => { openPromises.word = undefined; });
    return openPromises.word;
  }

  const browserApp = createOnDemandWorkspaceApplication({
    id: "browser",
    name: "Granted Shanghai Museum browser",
    description: "Fresh blank Chrome window, limited to the official Shanghai Museum origin.",
    capabilities: Object.freeze([
      { kind: "click", targets: ["selector", "ref", "point"], buttons: ["left"], counts: [1] },
      { kind: "type", targets: ["selector", "ref", "focus"] },
      { kind: "setValue", targets: ["selector", "ref"] },
      { kind: "scroll", targets: ["selector", "ref"], directions: ["up", "down", "left", "right"], units: ["line", "page"] },
      { kind: "keypress", targets: ["selector", "ref", "focus"], keys: ["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp", "PageDown", "PageUp"] },
      { kind: "hotkey", targets: ["selector", "ref", "focus"], chords: [["ctrl", "a"], ["Control", "a"], ["meta", "a"], ["Meta", "a"]] },
    ]),
    allowModelImages: true,
    allowModelDocumentText: true,
    allowNavigation: true,
    open: openBrowser,
  });
  const wordApp = createOnDemandWorkspaceApplication({
    id: "word",
    name: "Granted disposable Word document",
    description: "Fresh blank test-owned Word window; no personal files are enrolled.",
    capabilities: Object.freeze([
      { kind: "click", targets: ["selector", "ref", "point"], buttons: ["left"], counts: [1] },
      { kind: "scroll", targets: ["selector", "ref", "point"], directions: ["up", "down", "left", "right"], units: ["line", "page"] },
      { kind: "type", targets: ["selector", "ref"] },
      { kind: "keypress", targets: ["selector", "ref", "focus"], keys: ["F12", "Enter", "Escape", "Tab"] },
      { kind: "hotkey", targets: ["selector", "ref", "focus"], keys: ["ctrl", "shift", "s"], chords: [["ctrl", "s"], ["ctrl", "shift", "s"]] },
    ]),
    allowModelImages: false,
    allowModelDocumentText: false,
    allowNavigation: false,
    open: openWord,
  });
  const applications = [browserApp, wordApp];

  const discover = async ({ signal } = {}) => {
    abortIfNeeded(signal);
    const resource = resources.word;
    if (!resource?.target || !resource.wordBackend) return [];
    const dialogInspector = resource.wordBackend.findOwnedDialogs ? resource.wordBackend : await loadWindowsOwnedDialogInspector();
    if (!dialogInspector?.findOwnedDialogs) return [];
    const found = [];
    const dialogs = await dialogInspector.findOwnedDialogs(resource.target);
    for (const dialog of dialogs) {
      const modalId = `word-dialog-${dialog.hwnd.toString()}`;
      if (modalApplications.has(modalId)) { found.push(modalApplications.get(modalId).app); continue; }
      const modalTarget = Object.freeze({ pid: dialog.pid, hwnd: dialog.hwnd, title: "Word Save As dialog" });
      let modalBackend;
      let modalRawSession;
      let modalTransport;
      try {
        modalTransport = new NativeUiAutomationWindowsTransport();
        modalBackend = await createWindowsDesktopBackend({
          driver,
          transport: modalTransport,
          authorization: { targets: [modalTarget], background: { source: "native-uia-v1" } },
          activateForeground: exactActivation({ driver, inspector, metrics, label: "word-save-as-dialog" }),
        });
        modalRawSession = createDeskSession(modalBackend, {
          policy: savePolicy(metrics.outputPath, metrics.existingPath),
          allowModelImages: false,
          onApprovalRequested: async (request) => {
            metrics.approvals = metrics.approvals ?? [];
            metrics.approvals.push({ requestId: request.requestId, kind: request.kind, target: request.target, summary: request.summary, contextSummary: request.contextSummary });
            if (request.target?.name && /^(?:保存|Save|Save As|另存为)$/u.test(request.target.name)) {
              let currentFilename;
              try {
                const snapshot = await modalTransport.observeWindow(modalTarget, { signal: request.signal });
                const filename = snapshot.elements.find((element) => element.role === "Edit" && /^(?:文件名|File name|Name)$/iu.test(element.label ?? ""));
                currentFilename = filename?.value;
                metrics.modalFilenameReadbacks = metrics.modalFilenameReadbacks ?? [];
                metrics.modalFilenameReadbacks.push({ value: currentFilename, matchesOutput: currentFilename === metrics.outputPath, outputExists: existsSync(metrics.outputPath) });
              } catch (error) {
                metrics.modalFilenameReadbacks = metrics.modalFilenameReadbacks ?? [];
                metrics.modalFilenameReadbacks.push({ readError: String(error?.message ?? error) });
              }
              return currentFilename === metrics.outputPath && !existsSync(metrics.outputPath) ? "approve" : "deny";
            }
            return "deny";
          },
          maxSteps: 8,
          timeoutMs: 60_000,
          approvalTimeoutMs: 15_000,
        });
        const initial = await modalRawSession.observe({ view: "controls" });
        const names = initial.controls.map((control) => `${control.role}:${control.name ?? ""}`);
        const filename = initial.controls.find((control) => control.role === "Edit" && /^(?:文件名|File name|Name)$/iu.test(control.name ?? ""));
        const save = initial.controls.find((control) => control.role === "Button" && /^(?:保存|Save)$/iu.test(control.name ?? ""));
        if (!filename || !save) {
          await modalRawSession.close();
          await modalBackend.close();
          continue;
        }
        metrics.modalDiscoveries = metrics.modalDiscoveries ?? [];
        metrics.modalDiscoveries.push({ id: modalId, target: windowJson({ pid: dialog.pid, windowId: dialog.hwnd, title: "Word Save As dialog", bounds: dialog.bounds, isOnScreen: true, minimized: false }), controls: names, owned: true });
        const modalSession = guardedSession(modalRawSession, modalTarget, inspector, "word-save-as-dialog", metrics, {
          beforeAct(input) {
            for (const step of input?.steps ?? []) {
              const targetName = step?.target?.name;
              const value = step?.kind === "setValue" ? step.value : step?.kind === "type" ? step.text : undefined;
              if (step?.kind === "click" && typeof targetName === "string" && /^(?:保存|Save|Save As|另存为)$/iu.test(targetName)) metrics.saveActions = (metrics.saveActions ?? 0) + 1;
              if (typeof value === "string" && typeof targetName === "string" && /^(?:文件名|File name|Name)$/iu.test(targetName)) metrics.lastFilenameValue = value;
            }
          },
        });
        const app = {
          id: modalId,
          name: "Word Save As dialog (owned by granted Word)",
          description: "Fresh visible native modal proven by exact same-PID owner chain; use only for the disposable output path.",
          session: modalSession,
          async activate() { return exactActivation({ driver, inspector, metrics, label: "word-save-as-dialog" })(modalTarget); },
          async verifyFront(context) { return verifyFront({ inspector, metrics, label: "word-save-as-dialog" })({ ...context, target: modalTarget }); },
        };
        modalApplications.set(modalId, { app, backend: modalBackend });
        found.push(app);
      } catch {
        await modalRawSession?.close().catch(() => undefined);
        await modalBackend?.close().catch(() => undefined);
      }
    }
    return found;
  };
  const workspace = createWorkspace({ applications, discover, initialActive: null });
  return {
    driver, workspace, applications, modalApplications, childProcesses,
    targets: { browser: undefined, word: undefined },
    async close({ success = false } = {}) {
      await workspace.close().catch(() => undefined);
      for (const entry of modalApplications.values()) await entry.backend?.close().catch(() => undefined);
      await closeBrowserResource(resources.browser);
      await closeWordResource(resources.word);
      await driver.shutdown().catch(() => undefined);
      driver.uniffiDestroy?.();
      if (success || process.env.DESKLATCH_LOCAL_KEEP_WINDOWS !== "true") {
        for (const child of childProcesses) killChild(child);
      }
    },
  };
}

async function run() {
  if (!resultsRoot) throw Error("desklatch_results_dir_missing");
  const runId = randomUUID();
  const runDirectory = resolve(resultsRoot, `local-${runId}`);
  await mkdir(runDirectory, { recursive: true });
  const tempDirectory = resolve(process.env.TEMP ?? "C:\\Temp", `desklatch-local-${runId}`);
  await mkdir(tempDirectory, { recursive: true });
  const outputPath = join(tempDirectory, `museum-visit-note-${runId}.docx`);
  const wordTemplatePath = process.env.DESKLATCH_LOCAL_WORD_TEMPLATE_PATH;
  const focusedTask = process.env.DESKLATCH_LOCAL_FOCUSED !== "0";
  if (focusedTask && !wordTemplatePath) throw Error("DESKLATCH_LOCAL_WORD_TEMPLATE_PATH must point to a blank Word document");
  let metricsBaselineSha;
  if (wordTemplatePath) {
    await copyFile(wordTemplatePath, outputPath);
    const templateBaseline = await readWordFile(outputPath);
    if (templateBaseline.paragraphs.join("\n").trim()) throw Error("local_word_template_not_blank");
    metricsBaselineSha = templateBaseline.sha256;
  }
  if (wordTemplatePath) process.env.DESKLATCH_LOCAL_WORD_INPUT_PATH = outputPath;
  const existingPath = join(tempDirectory, "existing-collision-sentinel.txt");
  const collision = await createCollisionFixture(existingPath);
  const metrics = {
    event: "local-workspace-acceptance",
    runId,
    model: modelName,
    task: focusedTask ? "shanghai-museum-focused-tuesday-to-word" : "shanghai-museum-tuesday-bronze-to-word",
    runDirectory,
    outputPath,
    existingPath,
    existingSha256Before: collision.sha256,
    baselineSha: metricsBaselineSha,
    calls: [],
    modelArgs: [],
    dispatches: [],
    readbacks: [],
    modelImages: 0,
    modelTokens: 0,
    modelCalls: 0,
    visitedUrls: [],
    blockedExternalRequests: 0,
    activations: [],
    foreground: [],
    foregroundChecks: [],
    navigations: [],
    approvals: [],
    modalDiscoveries: [],
    modalFilenameReadbacks: [],
    independentlyVerified: false,
  };
  const eventTracePath = join(runDirectory, "events.jsonl");
  metrics.eventTracePath = eventTracePath;
  const key = await loadZhipuKey();
  let runtime;
  let result;
  try {
    runtime = await launchRuntime({ runDirectory: tempDirectory, metrics });
    const task = focusedTask
      ? "请从上海博物馆官网的东馆到访信息页 https://www.shanghaimuseum.cn/mu/frontend/pg/service/visit-east 核对普通周二下午是否开放、几点停止入场，并给出一段简短参观提示，附你实际查看过的官网链接。请将这段提示写入 workspace 中提供的 Word 文档，并保存当前文件。"
      : museumVisitTask({ outputPath, existingPath });
    const instructions = [
      "Operate only the explicitly granted applications listed by observe with workspace:true.",
      "All application switches, browser navigation, and ordinary UI actions must be chosen by you through the public observe/act endpoints and current observations; do not assume a window is active or follow a host-provided itinerary.",
      focusedTask
        ? "Use only the same-origin official Shanghai Museum page and rendered page text/controls. Use the Word UI to write the requested note in the Word document provided through workspace and save the current file."
        : "Use only same-origin official Shanghai Museum pages and rendered page text/controls. Use the Word UI to write and save the requested note to the designated disposable output path from the task.",
      focusedTask
        ? "This run verifies browser text reading. Once on the requested page, call observe with {\"read\":\"document\"}, then call it with {\"read\":{\"cursor\":\"...\"}} using the actual returned document.nextCursor. Search for the exact words 周二 and 停止入场 using separate observe calls with {\"read\":{\"query\":\"...\"}}. Keep Word unopened until you have found both facts. The query and cursor must be nested JSON objects. Activate Word, write your note, and save the current document."
        : "",
      focusedTask
        ? "Do not use shell, filesystem, COM, notebook, hidden clipboard, external search, or any prewritten answer."
        : "Do not use shell, filesystem, COM, notebook, hidden clipboard, external search, or any prewritten answer. Do not overwrite the existing collision file; if a collision or overwrite confirmation appears, preserve it and ask for a corrected path.",
      "After saving, re-observe the relevant UI and report only what the model actually completed. The required deliverable is the Word DOCX.",
    ].join(" ");
    const { runWorkspaceAgent } = await import("./support/workspace-agent.mjs");
    result = await runWorkspaceAgent({
      tools: runtime.workspace.tools,
      task,
      apiKey: key,
      maxTurns: 48,
      instructions,
      verifyDelivery: focusedTask ? ({ events, signal }) => verifySavedVisitNote(events, {
        editors: ["word"], outputPath, baselineSha: metrics.baselineSha, signal,
        readSaved: async () => {
          const saved = await readWordFile(outputPath);
          return { sha256: saved.sha256, text: saved.paragraphs.join("\n") };
        },
      }) : undefined,
      async onEvent(event) {
        const safe = scrub(event);
        const encoded = `${JSON.stringify(safe, (_key, item) => typeof item === "bigint" ? item.toString() : item)}\n`;
        await appendFile(eventTracePath, encoded, "utf8");
        metrics.calls.push(safe);
        if (event?.type === "model.request") {
          metrics.modelCalls += 1;
          metrics.modelImages += typeof event.imageCount === "number" ? event.imageCount : 0;
        }
        if (event?.type === "model.response") metrics.modelTokens += Number(event.tokenUsage?.totalTokens ?? 0) || 0;
        if (event?.type === "tool.call") {
          metrics.modelArgs.push({ name: event.name, arguments: scrub(event.arguments), normalizedArguments: scrub(event.normalizedArguments) });
          if (event.name === "act") metrics.dispatches.push(safe);
        }
        if (event?.type === "tool.result" && event.name === "observe") metrics.readbacks.push(safe);
      },
    });
    metrics.agent = scrub(result);
    metrics.answer = typeof result?.answer === "string" ? result.answer : undefined;
    metrics.metrics = scrub(result?.metrics);
    metrics.visitedUrls = [...new Set([...(metrics.visitedUrls ?? []), ...(result?.metrics?.visitedUrls ?? [])])];
    metrics.actionAudit = auditWorkspaceDelivery(result.events, { outputPath, editors: ["word"] });
    metrics.visitedUrls = [...new Set([...metrics.visitedUrls, ...(metrics.actionAudit.observedUrls ?? [])])];
    try {
      const output = await readWordFile(outputPath);
      const note = output.paragraphs.join("\n");
      metrics.readback = { sha256: output.sha256, paragraphs: output.paragraphs, paragraphCount: output.paragraphs.length };
      metrics.noteChecks = focusedTask
        ? checkEastVisitHours(note, { observedUrls: metrics.visitedUrls })
        : checkVisitNote(note, { observedUrls: metrics.visitedUrls });
      metrics.independentReference = await fetchMuseumReference();
      const existing = await readFile(existingPath);
      const existingSha256After = createHash("sha256").update(existing).digest("hex");
      metrics.existingSha256After = existingSha256After;
      metrics.outputExists = true;
      metrics.sourcePreserved = existingSha256After === metrics.existingSha256Before;
      const verifiedBrowser = metrics.activations?.some((item) => item.label === "browser" && item.verified === true) === true;
      const verifiedWord = metrics.activations?.some((item) => item.label === "word" && item.verified === true) === true;
      const navigated = metrics.actionAudit.navigations.length > 0;
      const nativeWrite = metrics.actionAudit.writes.length > 0;
      const nativeSave = metrics.actionAudit.saves.length > 0;
      metrics.workflowChecks = { modelNavigation: navigated, browserForeground: verifiedBrowser, wordForeground: verifiedWord,
        nativeDocumentWrite: nativeWrite, nativeSave, outputBytesRead: typeof output.sha256 === "string", sourcePreserved: metrics.sourcePreserved };
      if (focusedTask) {
        const reads = new Map(result.events.filter(event => event.type === "tool.call" && event.name === "observe")
          .map(event => [event.toolCallId, event.normalizedArguments?.read]));
        const browserReads = metrics.readbacks.filter(event => event.observation?.applicationId === "browser"
          && event.observation.document?.chunks?.length > 0);
        metrics.workflowChecks.documentContinuation = browserReads.some(event => typeof reads.get(event.toolCallId)?.cursor === "string");
        metrics.workflowChecks.documentKeyword = browserReads.some(event => typeof reads.get(event.toolCallId)?.query === "string"
          && event.observation.document.matchCount > 0);
        metrics.workflowChecks.singleSavedDraft = result.events.some(event => event.type === "delivery.verified" && event.evidence.sha256 === output.sha256);
      }
      metrics.independentlyVerified = metrics.actionAudit.modelOperatedAcrossApps && Object.values(metrics.workflowChecks).every(Boolean)
        && metrics.noteChecks.passed && metrics.independentReference.confirmed;
      if (metrics.independentlyVerified) {
        const artifact = join(runDirectory, basename(outputPath));
        await copyFile(outputPath, artifact);
        const digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
        if (digest.toUpperCase() !== output.sha256.toUpperCase()) {
          metrics.independentlyVerified = false;
          throw Error("saved_document_copy_does_not_match");
        }
        metrics.artifact = artifact;
      }
    } catch (error) {
      metrics.readbackError = String(error?.message ?? error);
      metrics.outputExists = false;
      metrics.independentlyVerified = false;
    }
  } catch (error) {
    metrics.error = String(error?.message ?? error).replaceAll(key, "[credential]");
  } finally {
    try {
      const trace = await readFile(eventTracePath, "utf8").catch(() => "");
      if (trace.includes("\uFFFD") || /\?{3,}/u.test(trace)) throw Error("event_trace_utf8_corrupt");
      await writeUtf8Json(join(runDirectory, "run.json"), metrics, key);
    } finally {
      await runtime?.close({ success: metrics.independentlyVerified === true });
    }
  }
  console.log(JSON.stringify({ event: metrics.event, runId, status: result?.status ?? (metrics.error ? "error" : "unknown"),
    independentlyVerified: metrics.independentlyVerified, outputPath, runDirectory,
    workflowChecks: metrics.workflowChecks, noteChecks: metrics.noteChecks, error: metrics.error }));
  if (!metrics.independentlyVerified) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();

export {
  exactActivation,
  guardedSession,
  launchRuntime,
  readWordFile,
  targetFromWindow,
  verifyFront,
  waitExactWindow,
  run,
};
