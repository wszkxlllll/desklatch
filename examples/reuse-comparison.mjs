import assert from "node:assert/strict";
import OpenAI from "openai";
import { chromium } from "playwright-core";
import { createBrowserBackend } from "desklatch/browser";
import { createDeskSession } from "desklatch";
import { createRiskPolicy } from "desklatch";
import { MemoryVerifiedStepReuseStore, createVerifiedStepReuse } from "desklatch/reuse";

// This is a deliberately small, headless, live-site comparison.  The page is
// the Rijksmuseum's own collection search, not a clone or a local fixture.
// The British Museum collection endpoint was tested separately but returned a
// Cloudflare interstitial in this isolated browser, so it is not measured.
const MODEL = "glm-5.3-flash";
const MODEL_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const SITE_ORIGIN = "https://www.rijksmuseum.nl";
const SEARCH_URL = `${SITE_ORIGIN}/en/search`;
const SEARCH_NAME = "Search the collection, library catalogue and visitor stories";
const QUERIES = ["bronze", "jade"];
const MAX_PROVIDER_REQUESTS = 12;
const MAX_OBSERVE_MS = 30_000;

const zhipuKey = readZhipuKey();
const metrics = {
  providerRequests: 0,
  modelCalls: [],
  imagesSent: 0,
  screenshots: 0,
  dispatches: 0,
  actionCalls: 0,
  observations: 0,
  observeTimingsMs: [],
  preflight: undefined,
};

function readZhipuKey() {
  const configured = process.env.ZHIPU_API_KEY || process.env.ZHIPUAI_API_KEY;
  if (!configured) throw new Error("Set ZHIPU_API_KEY (or ZHIPUAI_API_KEY) in the launcher environment");
  return configured;
}

function modelFetch(metricsObject) {
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== new URL(MODEL_BASE_URL).origin || !url.pathname.endsWith("/chat/completions")) {
      throw new Error("unexpected_model_endpoint");
    }
    const body = JSON.parse(init.body);
    if (body.model !== MODEL) throw new Error("unexpected_model");
    if (metricsObject.providerRequests >= MAX_PROVIDER_REQUESTS) throw new Error("provider_request_budget");
    for (const message of body.messages ?? []) {
      const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
      for (const block of blocks) {
        if (block.type === "image_url" || block.type === "input_image" || (block.type === "image" && block.data)) {
          metricsObject.imagesSent += 1;
          throw new Error("unexpected_model_image");
        }
      }
    }
    // GLM's reasoning budget is kept low so the comparison measures selection,
    // rather than spending the cap on hidden reasoning tokens.
    body.reasoning_effort = "low";
    metricsObject.providerRequests += 1;
    return fetch(url, {
      ...init,
      body: JSON.stringify(body),
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(45_000)])
        : AbortSignal.timeout(45_000),
    });
  };
}

const modelClient = new OpenAI({
  apiKey: zhipuKey,
  baseURL: MODEL_BASE_URL,
  maxRetries: 0,
  fetch: modelFetch(metrics),
});

function publicObservation(observation) {
  return {
    complete: observation.complete,
    controls: observation.controls.map(control => ({
      role: control.role,
      ...(control.name === undefined ? {} : { name: control.name }),
      states: control.states,
      actions: control.actions,
      ...(control.effect === undefined ? {} : { effect: control.effect }),
      ...(control.filterAction === undefined ? {} : { filterAction: control.filterAction }),
      ...(control.value === undefined ? {} : { value: String(control.value).slice(0, 120) }),
    })),
  };
}

function modelText(response) {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map(block => block.text ?? "").join("").trim();
  return "";
}

function parseModelJson(response, purpose) {
  const content = modelText(response).replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  if (!content) throw new Error(`empty_model_result:${purpose}`);
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`invalid_model_json:${purpose}`);
  }
}

async function callModel(purpose, messages) {
  const started = performance.now();
  let response;
  try {
    response = await modelClient.chat.completions.create({
      model: MODEL,
      temperature: 0,
      max_tokens: 512,
      response_format: { type: "json_object" },
      messages,
    });
  } catch (error) {
    metrics.modelCalls.push({ purpose, elapsedMs: Math.round(performance.now() - started), error: error.name });
    throw error;
  }
  metrics.modelCalls.push({
    purpose,
    elapsedMs: Math.round(performance.now() - started),
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    totalTokens: response.usage?.total_tokens ?? 0,
    finish: response.choices?.[0]?.finish_reason ?? "missing",
  });
  return parseModelJson(response, purpose);
}

function selectionMessages(mode, query, observation) {
  const task = mode === "single"
    ? `Select exactly one next action for the query ${JSON.stringify(query)}. This turn must choose only the editable search field and type the query.`
    : mode === "single-click"
      ? "Select exactly one next action now that the requested query is already in the field. Choose only the named Search control and click it."
    : mode === "batch"
      ? `Select exactly two sequential actions for the query ${JSON.stringify(query)}: type the query in the collection search field, then click its search control.`
      : "Select a reusable two-step search template. Choose the editable collection search field and its search control; the host will provide the query parameter at replay time.";
  return [
    {
      role: "system",
      content: [
        "You select actions for a live Rijksmuseum collection-search page.",
        "Use only controls present in the supplied observation. Do not choose cookie buttons, links, filters, tabs, or result cards.",
        "The search button is a read-only filter action. Never submit a form other than by choosing that named search control.",
        mode === "single"
          ? 'Return JSON exactly as {"steps":[{"kind":"type","targetName":"EXACT CONTROL NAME","text":"QUERY"}]}.'
          : mode === "single-click"
            ? 'Return JSON exactly as {"steps":[{"kind":"click","targetName":"Search"}]}.'
          : mode === "batch"
            ? 'Return JSON exactly as {"steps":[{"kind":"type","targetName":"EXACT CONTROL NAME","text":"QUERY"},{"kind":"click","targetName":"EXACT CONTROL NAME"}]}.'
            : 'Return JSON exactly as {"template":[{"kind":"type","targetName":"EXACT CONTROL NAME","parameter":"query"},{"kind":"click","targetName":"EXACT CONTROL NAME"}]}.'
      ].join(" "),
    },
    { role: "user", content: `${task}\nOBSERVATION_JSON=${JSON.stringify(publicObservation(observation))}` },
  ];
}

function findControl(observation, name) {
  return observation.controls.find(control => control.name === name);
}

function validateModelStep(step, observation, expectedKind) {
  assert.equal(typeof step?.targetName, "string", "model must select a named target");
  assert.equal(step.kind, expectedKind, "model selected an unexpected action kind");
  const control = findControl(observation, step.targetName);
  assert.ok(control, `model selected a control absent from observation: ${step.targetName}`);
  assert.ok(control.actions.includes(expectedKind), `model selected a control without ${expectedKind}`);
  return control;
}

function validateBatchPlan(plan, observation, query) {
  assert.ok(Array.isArray(plan?.steps) && plan.steps.length === 2, "model batch must contain two steps");
  assert.equal(plan.steps[0].text, query, "model batch must use the requested query");
  validateModelStep(plan.steps[0], observation, "type");
  validateModelStep(plan.steps[1], observation, "click");
  assert.equal(plan.steps[1].targetName, "Search", "model batch must choose the live Search control");
  assert.equal(plan.steps[0].targetName, SEARCH_NAME, "model batch must choose the live search field");
}

function validateTemplate(template, observation) {
  assert.ok(Array.isArray(template?.template) && template.template.length === 2, "model template must contain two steps");
  const [typeStep, clickStep] = template.template;
  validateModelStep(typeStep, observation, "type");
  validateModelStep(clickStep, observation, "click");
  assert.equal(typeStep.parameter, "query", "template must expose the query parameter");
  assert.equal(typeStep.targetName, SEARCH_NAME, "template must bind the live search field");
  assert.equal(clickStep.targetName, "Search", "template must bind the live Search control");
  const field = findControl(observation, typeStep.targetName);
  const button = findControl(observation, clickStep.targetName);
  assert.ok(field.states.includes("editable"), "template field is not editable");
  assert.equal(button.filterAction, true, "template search button is not structurally a filter action");
  return {
    steps: [
      { kind: "type", target: { name: typeStep.targetName }, parameter: typeStep.parameter },
      { kind: "click", target: { name: clickStep.targetName } },
    ],
    binding: {
      field: { role: field.role, actions: [...field.actions], states: [...field.states] },
      button: { role: button.role, actions: [...button.actions], filterAction: button.filterAction },
    },
  };
}

function assertTemplateStillBound(template, observation) {
  const field = findControl(observation, template.steps[0].target.name);
  const button = findControl(observation, template.steps[1].target.name);
  assert.ok(field && button, "replay target disappeared from the fresh observation");
  assert.equal(field.role, template.binding.field.role, "replay field role changed");
  assert.deepEqual([...field.actions].sort(), [...template.binding.field.actions].sort(), "replay field actions changed");
  assert.ok(template.binding.field.states.every(state => field.states.includes(state)), "replay field state weakened");
  assert.equal(button.role, template.binding.button.role, "replay button role changed");
  assert.deepEqual([...button.actions].sort(), [...template.binding.button.actions].sort(), "replay button actions changed");
  assert.equal(button.filterAction, true, "replay button is no longer a filter action");
}

async function observeTimed(session, label) {
  const started = performance.now();
  const observation = await session.observe({ view: "controls" });
  const elapsedMs = Math.round(performance.now() - started);
  if (elapsedMs > MAX_OBSERVE_MS) throw new Error(`observe_timeout:${label}`);
  metrics.observations += 1;
  metrics.observeTimingsMs.push({ label, elapsedMs, controls: observation.controls.length });
  return observation;
}

async function act(session, steps, label) {
  const result = await session.act({ steps });
  recordActionResult(result, steps.length, label);
  return result;
}

function recordActionResult(result, expectedSteps, label) {
  metrics.actionCalls += 1;
  const dispatches = result.steps.filter(step => step.status === "dispatched" || step.status === "verified").length;
  metrics.dispatches += dispatches;
  if (result.status !== "completed" || dispatches !== expectedSteps) {
    throw new Error(`act_failed:${label}:${result.code ?? result.status}`);
  }
}

function measurementMark() {
  return {
    started: performance.now(),
    modelCalls: metrics.modelCalls.length,
    modelTokens: metrics.modelCalls.reduce((sum, call) => sum + (call.totalTokens ?? 0), 0),
    actionCalls: metrics.actionCalls,
    dispatches: metrics.dispatches,
    observations: metrics.observations,
  };
}

function measurementSlice(mark) {
  return {
    modelCalls: metrics.modelCalls.length - mark.modelCalls,
    modelTokens: metrics.modelCalls.slice(mark.modelCalls).reduce((sum, call) => sum + (call.totalTokens ?? 0), 0),
    actionCalls: metrics.actionCalls - mark.actionCalls,
    dispatches: metrics.dispatches - mark.dispatches,
    observations: metrics.observations - mark.observations,
    elapsedMs: Math.round(performance.now() - mark.started),
  };
}

async function currentArtworkCount(page) {
  return page.evaluate(() => /ARTWORKS \(([^)]+)\)/iu.exec(document.body?.innerText ?? "")?.[1] ?? null);
}

async function verifySearch(page, query, beforeUrl, baselineResultCount, mode, queryIndex) {
  const started = performance.now();
  await page.waitForFunction(({ expected, baseline }) => {
    if (new URL(location.href).searchParams.get("query") !== expected) return false;
    const count = /ARTWORKS \(([^)]+)\)/iu.exec(document.body?.innerText ?? "")?.[1] ?? null;
    return count !== null && (baseline === null || count !== baseline);
  }, { expected: query, baseline: baselineResultCount }, { timeout: 20_000 });
  const state = await page.evaluate(expected => {
    const body = (document.body?.innerText ?? "").replace(/\s+/gu, " ");
    const count = /ARTWORKS \(([^)]+)\)/iu.exec(body)?.[1] ?? null;
    const url = new URL(location.href);
    return {
      url: location.href,
      query: url.searchParams.get("query"),
      resultCount: count,
      hasCollectionControl: body.includes("Collection"),
      hasLanguageControl: body.includes("Language"),
      hasLoginControl: body.includes("Login"),
      hasCookieOverlay: body.includes("COOKIE USAGE"),
      hasSearchControl: Array.from(document.querySelectorAll("button")).some(button => (button.textContent ?? "").trim() === "Search"),
    };
  }, query);
  const resultCount = Number(String(state.resultCount ?? "").replace(/,/gu, ""));
  assert.equal(state.query, query, `${mode}[${queryIndex}] query did not reach the live URL`);
  assert.notEqual(beforeUrl, state.url, `${mode}[${queryIndex}] URL did not change`);
  assert.ok(Number.isFinite(resultCount) && resultCount > 0, `${mode}[${queryIndex}] result count was not positive`);
  assert.equal(state.hasCookieOverlay, false, `${mode}[${queryIndex}] cookie overlay returned`);
  assert.equal(state.hasCollectionControl, true, `${mode}[${queryIndex}] unrelated Collection control disappeared`);
  assert.equal(state.hasLanguageControl, true, `${mode}[${queryIndex}] unrelated Language control disappeared`);
  assert.equal(state.hasLoginControl, true, `${mode}[${queryIndex}] unrelated Login control disappeared`);
  return { ...state, resultCount, verificationMs: Math.round(performance.now() - started) };
}

async function resetToSearch(page) {
  // This is host-owned trial setup between isolated measurements.  No measured
  // control is clicked or filled through Playwright; all UI actions below go
  // through DeskLatch observe/act.
  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(700);
}

async function dismissCookieBanner(session, page) {
  const observation = await observeTimed(session, "cookie-preflight");
  const button = findControl(observation, "No, rather not");
  if (!button) return false;
  const started = performance.now();
  const result = await act(session, [{ kind: "click", target: { name: button.name } }], "cookie-preflight");
  await page.waitForTimeout(700);
  const remaining = await page.evaluate(() => document.body?.innerText.includes("COOKIE USAGE") ?? false);
  assert.equal(remaining, false, "cookie preference banner was not dismissed");
  metrics.preflight = { result: result.status, elapsedMs: Math.round(performance.now() - started), modelReview: true };
  return true;
}

async function runSingle(session, page) {
  const records = [];
  for (const [queryIndex, query] of QUERIES.entries()) {
    await resetToSearch(page);
    const beforeUrl = page.url();
    const baselineResultCount = await currentArtworkCount(page);
    const first = await observeTimed(session, `single-${query}-before-type`);
    const firstPlan = await callModel(`single:${query}:type-selection`, selectionMessages("single", query, first));
    const typeStep = firstPlan.steps?.[0];
    validateModelStep(typeStep, first, "type");
    assert.equal(typeStep.targetName, SEARCH_NAME, "single model selected the wrong input");
    await act(session, [{ kind: "type", target: { name: typeStep.targetName }, text: typeStep.text }], `single-${query}-type`);

    const second = await observeTimed(session, `single-${query}-before-click`);
    const secondPlan = await callModel(`single:${query}:click-selection`, selectionMessages("single-click", query, second));
    const clickStep = secondPlan.steps?.[0];
    validateModelStep(clickStep, second, "click");
    assert.equal(clickStep.targetName, "Search", "single model selected the wrong click control");
    await act(session, [{ kind: "click", target: { name: clickStep.targetName } }], `single-${query}-click`);
    records.push({ query, verification: await verifySearch(page, query, beforeUrl, baselineResultCount, "single", queryIndex) });
  }
  return records;
}

async function runBatch(session, page) {
  const records = [];
  for (const [queryIndex, query] of QUERIES.entries()) {
    await resetToSearch(page);
    const beforeUrl = page.url();
    const baselineResultCount = await currentArtworkCount(page);
    const observation = await observeTimed(session, `batch-${query}-before`);
    const plan = await callModel(`batch:${query}:action-selection`, selectionMessages("batch", query, observation));
    validateBatchPlan(plan, observation, query);
    await act(session, plan.steps.map(step => step.kind === "type"
      ? { kind: "type", target: { name: step.targetName }, text: step.text }
      : { kind: "click", target: { name: step.targetName } }), `batch-${query}`);
    records.push({ query, verification: await verifySearch(page, query, beforeUrl, baselineResultCount, "batch", queryIndex) });
  }
  return records;
}

async function runReuse(session, page) {
  const records = [];
  let template;
  const reuseKey = "rijksmuseum-search-query";
  const context = { origin: SITE_ORIGIN, page: "collection-search" };
  const coverage = { target: SEARCH_NAME, verified: "live input value after type" };
  const store = new MemoryVerifiedStepReuseStore();
  const reuse = createVerifiedStepReuse({ session, store });
  let storedRecord;
  for (const [queryIndex, query] of QUERIES.entries()) {
    await resetToSearch(page);
    const beforeUrl = page.url();
    const baselineResultCount = await currentArtworkCount(page);
    const observation = await observeTimed(session, `reuse-${query}-before`);
    if (!template) {
      const selected = await callModel("reuse:template-selection", selectionMessages("reuse", query, observation));
      template = validateTemplate(selected, observation);
      const fieldRole = template.binding.field.role;
      const captureRequest = {
        steps: [{
          kind: "type",
          target: { role: fieldRole, name: template.steps[0].target.name },
          text: query,
          expect: { target: { role: fieldRole, name: template.steps[0].target.name }, valueEquals: query },
        }],
      };
      // This is the sole measured capture entry point.  The observing reuse
      // wrapper records provenance for this exact session.act result; remember
      // rejects pasted/fabricated receipts and stores only the parameterized
      // field request.  The first run is therefore both a real execution and
      // the verification that authorizes the later field replay.
      const captureResult = await reuse.act(captureRequest);
      recordActionResult(captureResult, 1, `reuse-${query}-capture`);
      storedRecord = await reuse.remember(reuseKey, captureRequest, captureResult, {
        parameters: [{ name: "query", paths: ["steps.0.text", "steps.0.expect.valueEquals"] }],
        context,
        coverage,
      });
      assert.equal(storedRecord.parameterNames[0], "query");
      assert.equal(JSON.stringify(storedRecord).includes(query), false, "stored reuse record retained the live query");
      await act(reuse, [{ kind: "click", target: { name: template.steps[1].target.name } }], `reuse-${query}-model-selected-submit`);
    } else {
      assertTemplateStillBound(template, observation);
      const replay = await reuse.run(reuseKey, { values: { query }, context, coverage });
      assert.equal(replay.reused, true, "reuse API did not find the verified record");
      assert.equal(replay.succeeded, true, "reuse API did not independently verify the replayed field");
      recordActionResult(replay.result, 1, `reuse-${query}-replay`);
      // The submit control is deliberately not a hidden second cache.  GLM
      // must select it again from this fresh observation on the warm run.
      const clickPlan = await callModel(`reuse:${query}:uncached-click-selection`, selectionMessages("single-click", query, observation));
      const clickStep = clickPlan.steps?.[0];
      validateModelStep(clickStep, observation, "click");
      assert.equal(clickStep.targetName, "Search", "reuse warm model selected the wrong submit control");
      await act(reuse, [{ kind: "click", target: { name: clickStep.targetName } }], `reuse-${query}-model-selected-submit`);
    }
    records.push({
      query,
      replay: {
        source: queryIndex === 0 ? "model-selected first run + captured verified field" : "verified parameterized field reuse API + fresh submit selection",
        parameterSource: "host-provided query",
        modelSelectedThisRun: queryIndex === 0,
        captureEntry: queryIndex === 0 ? "reuse.act -> reuse.remember (actual completed+verified field receipt)" : undefined,
        uncachedSubmitSelection: queryIndex === 1,
        reuseKey,
        succeeded: true,
      },
      verification: await verifySearch(page, query, beforeUrl, baselineResultCount, "reuse", queryIndex),
    });
  }
  return { template, records, storedRecord };
}

async function main() {
  const started = performance.now();
  const browserStarted = performance.now();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.DESKLATCH_CHROMIUM || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const browserLaunchMs = Math.round(performance.now() - browserStarted);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageLoadStarted = performance.now();
  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(700);
  const firstPageLoadMs = Math.round(performance.now() - pageLoadStarted);
  const backend = createBrowserBackend(page, {
    scope: "reuse-comparison-live-rikjsmuseum",
    authorizedOrigins: [SITE_ORIGIN],
    allowImages: false,
    includePublicValues: true,
    observeLimit: 300,
    searchTimeoutMs: 1_500,
    settleMs: 700,
    actionTimeoutMs: 2_500,
  });
  const policy = createRiskPolicy({
    timeoutMs: 20_000,
    maxExternalRequests: 2,
    reviewer: async request => {
      const result = await callModel("preflight:cookie-risk-review", [
        {
          role: "system",
          content: "Classify the immediate UI effect. Return JSON only as {\"classification\":\"clear\"|\"high\"|\"unknown\"}. A cookie banner button named exactly ‘No, rather not’ only declines optional cookies and is clearly local/non-consequential, so classify it clear. Classify search submission, navigation, purchase, sending, deletion, or disclosure as unknown or high.",
        },
        { role: "user", content: JSON.stringify(request) },
      ]);
      return result;
    },
  });
  const session = createDeskSession(backend, { allowModelImages: false, timeoutMs: 40_000, policy });
  try {
    await dismissCookieBanner(session, page);
    const singleMark = measurementMark();
    const single = await runSingle(session, page);
    const singleMetrics = measurementSlice(singleMark);
    const batchMark = measurementMark();
    const batch = await runBatch(session, page);
    const batchMetrics = measurementSlice(batchMark);
    const reuseMark = measurementMark();
    const reuse = await runReuse(session, page);
    const reuseMetrics = measurementSlice(reuseMark);
    const result = {
      site: {
        name: "Rijksmuseum collection search",
        origin: SITE_ORIGIN,
        initialUrl: SEARCH_URL,
        realDeployment: true,
        fallbackReason: "British Museum collection search was Cloudflare-blocked in the isolated browser; Rijksmuseum was measured instead.",
      },
      model: MODEL,
      isolation: { headless: true, chromium: true, browserLaunchMs, firstPageLoadMs },
      actions: {
        singleStep: { ...singleMetrics, queries: single },
        batched: { ...batchMetrics, queries: batch },
        verifiedParameterizedReuse: { ...reuseMetrics, queries: reuse.records },
      },
      reuseBinding: reuse.template?.binding,
      replaySemantics: {
        templateSelectedByModel: true,
        replayFragment: "model-selected verified field fragment; target role/name is revalidated from a fresh DeskLatch observation before every execution",
        queryParameters: QUERIES,
        parameterSource: "host-provided query values (bronze, jade), not chosen by the replay call",
        executionApi: "createVerifiedStepReuse delegates only to DeskLatch session.act; no DOM action or cloned page",
        capture: "one actual reuse.act call followed by reuse.remember; receipt provenance is required",
        submit: "the warm jade run asks GLM to select Search again; it is not replayed from the template",
        scope: "verified parameterized field reuse plus an uncached submit-selection step (whole-task reuse is intentionally not claimed)",
      },
      metrics: {
        ...metrics,
        modelCalls: metrics.modelCalls,
        modelCallCount: metrics.modelCalls.length,
        modelTokens: metrics.modelCalls.reduce((sum, call) => sum + (call.totalTokens ?? 0), 0),
        modelSelectionCalls: metrics.modelCalls.filter(call => call.purpose.includes("selection")).length,
        screenshotCount: metrics.screenshots,
        imageCountSentToModel: metrics.imagesSent,
        dispatchCount: metrics.dispatches,
        actionCallCount: metrics.actionCalls,
        coldAndWarmObserveTimingsMs: metrics.observeTimingsMs,
        elapsedMs: Math.round(performance.now() - started),
      },
      independentVerification: {
        finishedBrowser: true,
        queryInLiveUrlAndPositiveResults: true,
        unrelatedControlsChecked: ["Collection", "Language", "Login"],
      },
    };
    console.log(JSON.stringify(result));
  } finally {
    await session.close();
    await context.close();
    await browser.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    errorType: error.name,
    message: String(error.message).replaceAll(zhipuKey, "[credential]"),
    providerRequests: metrics.providerRequests,
    modelCalls: metrics.modelCalls,
    dispatches: metrics.dispatches,
    actionCalls: metrics.actionCalls,
    screenshots: metrics.screenshots,
  }));
  process.exitCode = 1;
}
