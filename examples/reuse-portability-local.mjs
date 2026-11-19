import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { createBrowserBackend } from "desklatch/browser";
import { createDeskSession, createRiskPolicy } from "desklatch";
import { createVerifiedStepReuse, MemoryVerifiedStepReuseStore } from "desklatch/reuse";
import { selectedReuseSite } from "./support/reuse-sites.mjs";

const site = selectedReuseSite();
const { origin, searchUrl, searchName } = site;
const query = process.env.DESKLATCH_REUSE_CAPTURE_VALUE ?? site.captureQuery;
const replayQuery = process.env.DESKLATCH_REUSE_REPLAY_VALUE ?? site.localReplayQuery;
const recordPath = process.env.DESKLATCH_REUSE_RECORD_PATH
  ?? resolve("artifacts", site.defaultRecordFile);
const metricsPath = process.env.DESKLATCH_REUSE_METRICS_PATH
  ?? resolve(dirname(recordPath), site.defaultLocalMetricsFile);

function executablePath() {
  const candidates = [
    process.env.DESKLATCH_CHROMIUM,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    process.env.ProgramFiles && resolve(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.ProgramFiles && resolve(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["ProgramFiles(x86)"] && resolve(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] && resolve(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function writeUtf8(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, encoded, { encoding: "utf8" });
  const readBack = readFileSync(path, "utf8");
  if (readBack !== encoded || readBack.includes("\uFFFD") || /\?{3,}/u.test(readBack)) throw Error("utf8_corrupt");
}

const localPolicy = createRiskPolicy({ reviewer: ({ action, target }) => ({
  classification: action.kind === "click" && target.role === "button" && target.name === site.consentName ? "low" : "unknown",
}) });

const metrics = {
  task: site.localTask,
  site: site.id,
  origin,
  searchUrl,
  queryDigest: digest(query),
  queryLength: query.length,
  recordPath,
  status: "started",
};

let browser;
let context;
let session;

try {
  const path = executablePath();
  if (!path) throw Error("no_installed_chromium");
  browser = await chromium.launch({ headless: true, executablePath: path });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1_500);
  const backend = createBrowserBackend(page, {
    scope: `reuse-${site.id}-local-capture-${Date.now()}`,
    authorizedOrigins: [origin],
    allowImages: false,
    includePublicValues: true,
    observeLimit: 300,
    searchTimeoutMs: 2_000,
    settleMs: 500,
    actionTimeoutMs: 5_000,
  });
  session = createDeskSession(backend, {
    allowModelImages: false,
    policy: localPolicy,
    timeoutMs: 30_000,
    expectTimeoutMs: 3_000,
  });
  let observation = await session.observe({ view: "controls" });
  metrics.observation = { complete: observation.complete, controlCount: observation.controls.length };
  if (!observation.complete) {
    await page.waitForTimeout(2_000);
    observation = await session.observe({ view: "controls" });
    metrics.observationRetry = { complete: observation.complete, controlCount: observation.controls.length };
  }
  const cookieButton = site.consentName
    ? observation.controls.find((control) => control.name === site.consentName && control.actions.includes("click"))
    : undefined;
  if (cookieButton) {
    metrics.cookieTarget = { role: cookieButton.role, name: cookieButton.name, effect: cookieButton.effect, filterAction: cookieButton.filterAction };
    const consent = await session.act({ steps: [{ kind: "click", target: { name: cookieButton.name } }] });
    metrics.cookieConsent = { status: consent.status, code: consent.code, steps: consent.steps };
    if (consent.status !== "completed") throw Error(`cookie_consent_failed:${consent.code ?? consent.status}`);
    await page.waitForTimeout(500);
    observation = await session.observe({ view: "controls" });
  }
  const field = observation.controls.find((control) => control.name === searchName
    && control.states.includes("editable")
    && (control.actions.includes("setValue") || control.actions.includes("type")))
    ?? observation.controls.find((control) => /search/iu.test(control.name ?? "")
      && control.states.includes("editable")
      && (control.actions.includes("setValue") || control.actions.includes("type")));
  if (!field) {
    metrics.status = "field_unavailable";
    metrics.observedControls = observation.controls.map((control) => ({ role: control.role, name: control.name, states: control.states, actions: control.actions }));
    throw Error("search_field_unavailable");
  }
  const kind = field.actions.includes("setValue") ? "setValue" : "type";
  const target = { role: field.role, name: field.name };
  const scopedFrame = await backend.observe({ view: "controls", where: target });
  metrics.scopedObservation = { complete: scopedFrame.complete, controlCount: scopedFrame.controls.length };
  const captureRequest = {
    steps: [{
      kind,
      target,
      ...(kind === "setValue" ? { value: query } : { text: query }),
      expect: { target, valueEquals: query },
    }],
  };
  const reuse = createVerifiedStepReuse({ session, store: new MemoryVerifiedStepReuseStore() });
  const captureResult = await reuse.act(captureRequest);
  metrics.target = target;
  metrics.actionKind = kind;
  metrics.captureReceipt = captureResult.steps;
  if (captureResult.status !== "completed" || captureResult.steps.length !== 1 || captureResult.steps[0].status !== "verified") {
    metrics.status = "capture_not_verified";
    throw Error(`capture_not_verified:${captureResult.code ?? captureResult.status}`);
  }
  const record = await reuse.remember(site.recordKey, captureRequest, captureResult, {
    parameters: [{ name: "query", paths: [`steps.0.${kind === "setValue" ? "value" : "text"}`, "steps.0.expect.valueEquals"] }],
    context: { origin, page: site.contextPage },
    coverage: { target, expected: "same selector value readback" },
  });
  writeUtf8(recordPath, record);
  const readBack = JSON.parse(readFileSync(recordPath, "utf8"));
  if (JSON.stringify(readBack).includes(query)) throw Error("record_retained_capture_value");
  metrics.status = "captured_verified_record";
  metrics.recordVersion = readBack.version;
  metrics.parameterNames = readBack.parameterNames;
  metrics.recordDigest = digest(JSON.stringify(readBack));
  metrics.recordBytes = Buffer.byteLength(JSON.stringify(readBack), "utf8");

  // Close the capture runtime before opening a fresh context. This is a local
  // portability check for the exact serialized record; no DOM action bypasses
  // DeskLatch, and the search form is not submitted.
  await session.close();
  session = undefined;
  await context.close();
  context = undefined;
  await browser.close();
  browser = undefined;
  const replayBrowser = await chromium.launch({ headless: true, executablePath: path });
  const replayContext = await replayBrowser.newContext({ viewport: { width: 1280, height: 900 } });
  const replayPage = await replayContext.newPage();
  let replaySession;
  try {
    await replayPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await replayPage.waitForTimeout(1_500);
    const replayBackend = createBrowserBackend(replayPage, {
      scope: `reuse-${site.id}-local-replay-${Date.now()}`,
      authorizedOrigins: [origin],
      allowImages: false,
      includePublicValues: true,
      observeLimit: 300,
      searchTimeoutMs: 2_000,
      settleMs: 500,
      actionTimeoutMs: 5_000,
    });
    replaySession = createDeskSession(replayBackend, {
      allowModelImages: false,
      policy: localPolicy,
      timeoutMs: 30_000,
      expectTimeoutMs: 3_000,
    });
    const replayObservation = site.consentName
      ? await replaySession.observe({ where: { role: "button", name: site.consentName } })
      : undefined;
    const replayCookie = replayObservation && site.consentName
      ? replayObservation.controls.find((control) => control.name === site.consentName && control.actions.includes("click"))
      : undefined;
    if (replayCookie) {
      const consent = await replaySession.act({ steps: [{ kind: "click", target: { name: replayCookie.name } }] });
      if (consent.status !== "completed") throw Error(`replay_cookie_consent_failed:${consent.code ?? consent.status}`);
      await replayPage.waitForTimeout(500);
    }
    const replayReuse = createVerifiedStepReuse({ session: replaySession, store: new MemoryVerifiedStepReuseStore([readBack]) });
    const currentLocation = new URL(replayPage.url());
    if (currentLocation.origin !== origin || !site.canonicalPaths.includes(currentLocation.pathname.replace(/\/$/u, ""))) {
      throw Error("unverified_search_scope");
    }
    const replay = await replayReuse.run(site.recordKey, {
      values: { query: replayQuery },
      context: { origin: currentLocation.origin, page: site.contextPage },
      coverage: { target: site.target, expected: "same selector value readback" },
    });
    const freshRead = await replaySession.observe({ where: readBack.request.steps[0].target });
    const freshField = freshRead.controls.find((control) => control.name === readBack.request.steps[0].target.name);
    metrics.freshLocalReplay = {
      status: replay.status,
      succeeded: replay.status === "completed" && replay.succeeded === true,
      receipt: replay.result?.steps,
      observationComplete: freshRead.complete,
      observedValueDigest: typeof freshField?.value === "string" ? digest(freshField.value) : undefined,
      observedValueLength: typeof freshField?.value === "string" ? freshField.value.length : undefined,
      queryDigest: digest(replayQuery),
      differentValue: freshField?.value === replayQuery,
      submitted: false,
    };
    if (metrics.freshLocalReplay.succeeded !== true || metrics.freshLocalReplay.differentValue !== true) {
      throw Error("fresh_local_replay_readback_failed");
    }
  } finally {
    await replaySession?.close().catch(() => undefined);
    await replayContext.close().catch(() => undefined);
    await replayBrowser.close().catch(() => undefined);
  }
} catch (error) {
  metrics.status = metrics.status === "started" ? "boundary" : metrics.status;
  metrics.error = String(error?.message ?? error).slice(0, 240);
  const boundaryPath = recordPath.replace(/\.json$/u, "-boundary.json");
  writeUtf8(boundaryPath, metrics);
  process.exitCode = 1;
} finally {
  await session?.close().catch(() => undefined);
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
}

writeUtf8(metricsPath, metrics);
console.log(JSON.stringify(metrics));
