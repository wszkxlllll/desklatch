import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { setTracingDisabled } from "@openai/agents";
import {
  createDeskSession,
  createDeskTools,
  createRiskPolicy,
  desktopToolInstructions,
} from "desklatch";
import { createLangChainTools, prepareDeskChatCompletionsMessages } from "desklatch/langchain";
import { createE2BBrowserBackend } from "desklatch/e2b";
import { runInHostedDesktop } from "./support/hosted-desktop.mjs";

// This is an opt-in live acceptance check. It never books, purchases, submits,
// or follows an external link; the only browser origin granted below is the
// current official Shanghai Museum website.
const modelName = "glm-5.3-flash";
const baseURL = "https://open.bigmodel.cn/api/paas/v4";
const officialOrigin = "https://www.shanghaimuseum.cn";
const official = Object.freeze({
  home: `${officialOrigin}/mu/frontend/pg/en/index`,
  homeZh: `${officialOrigin}/mu/frontend/pg/index`,
  east: `${officialOrigin}/mu/frontend/pg/en/service/visit-east`,
  west: `${officialOrigin}/mu/frontend/pg/en/service/visit-west`,
  bronze: `${officialOrigin}/mu/frontend/pg/article/id/RI00004046`,
});
const startLocale = process.env.DESKLATCH_CLOUD_START_LOCALE === "zh" ? "zh" : "en";
const startUrl = startLocale === "zh" ? official.homeZh : official.home;
const requestBudget = 8;
const sourceTimeoutMs = 15_000;
const acceptanceRun = randomUUID();

setTracingDisabled(true);
process.env.LANGSMITH_TRACING = "false";
process.env.LANGCHAIN_TRACING_V2 = "false";

const key = process.env.ZHIPU_API_KEY || process.env.ZHIPUAI_API_KEY || process.env.GLM_API_KEY;
if (!key) throw Error("Set ZHIPU_API_KEY to run the Shanghai Museum cloud acceptance check");

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function scrubError(error) {
  return String(error?.message ?? error).replaceAll(key, "[credential]").replace(/data:image[^\s]+/giu, "[image]").slice(0, 280);
}

function targetForm(target) {
  if (!target || typeof target !== "object") return "missing";
  if (typeof target.ref === "string") return "ref";
  if (typeof target.name === "string") return "name";
  if (target.point && typeof target.point === "object") return "point";
  if (target.focusFromStep !== undefined) return "focus";
  return "selector";
}

function summarizeStep(step) {
  const target = step?.target;
  return {
    kind: typeof step?.kind === "string" ? step.kind : "unknown",
    targetForm: targetForm(target),
    ...(typeof step?.text === "string" ? { textLength: step.text.length } : {}),
    ...(typeof step?.value === "string" ? { valueLength: step.value.length } : {}),
  };
}

function extractText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(block => block && typeof block.text === "string").map(block => block.text).join("\n");
}

function normalizeRenderedText(value) {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractOfficialUrls(value) {
  return [...new Set((String(value).match(/https:\/\/www\.shanghaimuseum\.cn\/[^\s"'}`]+/giu) ?? [])
    .map(url => url.replace(/[),.;]+$/gu, "")))];
}

function canonicalOfficialUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.origin !== officialOrigin || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.origin + url.pathname;
  } catch {
    return undefined;
  }
}

function savePublicAnswer(answer, metrics) {
  const sanitized = String(answer)
    .replaceAll(key, "[credential]")
    .replace(/data:[^\s"']+/giu, "[image]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .slice(0, 16_384);
  const artifactPath = process.env.DESKLATCH_CLOUD_RESULT_PATH
    ?? resolve("artifacts", `cloud-shanghai-museum-result-${metrics.runId}.json`);
  mkdirSync(dirname(artifactPath), { recursive: true });
  const payload = {
    task: metrics.task,
    model: metrics.model,
    answer: sanitized,
    citedUrls: extractOfficialUrls(sanitized),
    visitedOfficialUrls: metrics.visitedUrls,
  };
  const encoded = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(artifactPath, encoded, { encoding: "utf8" });
  const readBack = readFileSync(artifactPath, "utf8");
  if (readBack !== encoded || readBack.includes("\uFFFD") || /\?{3,}/u.test(readBack)) throw Error("public_answer_utf8_corrupt");
  metrics.finalAnswerArtifact = artifactPath;
  metrics.finalAnswerCitedUrls = payload.citedUrls;
}

async function fetchOfficialSource(url, metrics) {
  if (new URL(url).origin !== officialOrigin) throw Error("independent_source_origin_denied");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), sourceTimeoutMs);
  try {
    const response = await fetch(url, { redirect: "error", signal: controller.signal });
    const body = await response.text();
    const rendered = normalizeRenderedText(body);
    const source = { url, status: response.status, bytes: Buffer.byteLength(body, "utf8"), digest: digest(body) };
    metrics.independentSources.push(source);
    if (!response.ok) throw Error(`independent_source_http_${response.status}`);
    return rendered;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyOfficialSources(metrics) {
  const [east, west, bronze] = await Promise.all([
    fetchOfficialSource(official.east, metrics),
    fetchOfficialSource(official.west, metrics),
    fetchOfficialSource(official.bronze, metrics),
  ]);
  const facts = {
    eastClosedTuesday: /closed on Tuesdays/iu.test(east),
    eastHours: /10:00\s*[–-]\s*18:00/iu.test(east),
    eastLastEntry17: /last entry at 17:00/iu.test(east),
    eastAddress: /1952 Century Avenue/iu.test(east),
    westOpenTuesday: /Tuesday to Sunday/iu.test(west),
    westHours: /(?:09:00|9:00)\s*[–-]\s*17:00/iu.test(west),
    bronzeGalleryPage: /Ancient Chinese Bronze Gallery/iu.test(bronze),
  };
  metrics.independentFacts = facts;
  assert.equal(facts.eastClosedTuesday, true);
  assert.equal(facts.eastHours, true);
  assert.equal(facts.eastLastEntry17, true);
  assert.equal(facts.eastAddress, true);
  assert.equal(facts.westOpenTuesday, true);
  assert.equal(facts.westHours, true);
  assert.equal(facts.bronzeGalleryPage, true);
  return facts;
}

function modelAnswerChecks(answer, visitedUrls = [], documentSourceUrls = []) {
  const text = normalizeRenderedText(answer);
  let structured;
  try {
    structured = JSON.parse(String(answer).trim().replace(/^\x60\x60\x60(?:json)?\s*/iu, "").replace(/\s*\x60\x60\x60$/u, ""));
  } catch { structured = {}; }
  const negativeField = /\b(?:null|unknown|not stated|not confirmed|not available|unavailable|could not|cannot|unable|closed|not open|does not|doesn't|no (?:evidence|venue|gallery))\b/iu;
  const fieldText = name => typeof structured?.[name] === "string" ? structured[name].trim() : "";
  const venue = fieldText("venue");
  const bronzeGallery = fieldText("bronzeGallery");
  const lastAdmission = fieldText("lastAdmission");
  const alternateDay = fieldText("alternateDay");
  const alternateArrival = fieldText("alternateArrival");
  const sourceUrls = Array.isArray(structured?.sourceUrls) ? structured.sourceUrls.filter(value => typeof value === "string") : [];
  const visitedCanonical = new Set(visitedUrls.map(canonicalOfficialUrl).filter(Boolean));
  const documentCanonical = new Set(documentSourceUrls.map(canonicalOfficialUrl).filter(Boolean));
  const venuePresent = venue.length > 0;
  const bronzeGalleryPresent = bronzeGallery.length > 0;
  const lastAdmissionPresent = lastAdmission.length > 0;
  const venueAffirmative = venuePresent && !negativeField.test(venue);
  const bronzeGalleryAffirmative = bronzeGalleryPresent && !negativeField.test(bronzeGallery) && /(?:ancient chinese )?bronze gallery/iu.test(bronzeGallery);
  const venueIsEast = venueAffirmative && /(?:museum east|上海博物馆东馆|\beast\b)/iu.test(venue);
  const hasTuesday = /Tuesday/iu.test(text);
  const saysEastClosed = /(?:closed|not open|unavailable|not available|cannot|can't)[^.]{0,120}Tuesday|Tuesday[^.]{0,120}(?:closed|not open|unavailable|not available|cannot|can't)/iu.test(text);
  const hasLastEntry17 = /\b(?:17:00|5(?::00)?\s*p\.?m\.?)\b/iu.test(lastAdmission);
  const bronzeEastAssociation = venueIsEast && bronzeGalleryAffirmative;
  const validAlternateDay = /\b(?:Monday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/iu.test(alternateDay);
  const alternateTimeMatch = /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\b/iu.exec(alternateArrival);
  const alternateMinutes = alternateTimeMatch
    ? (Number(alternateTimeMatch[1]) + (alternateTimeMatch[3]?.toLowerCase() === "pm" && Number(alternateTimeMatch[1]) < 12 ? 12 : 0)) * 60 + Number(alternateTimeMatch[2] ?? "0")
    : undefined;
  const validAlternateArrival = alternateMinutes !== undefined && alternateMinutes >= 12 * 60 && alternateMinutes <= 17 * 60;
  const sourceUrlsPresent = sourceUrls.length > 0;
  const sourceUrlsOfficial = sourceUrlsPresent && sourceUrls.every(url => canonicalOfficialUrl(url) !== undefined);
  const sourceUrlsVisited = sourceUrlsOfficial && sourceUrls.every(url => visitedCanonical.has(canonicalOfficialUrl(url)));
  const sourceUrlsDocumentBacked = sourceUrlsOfficial && sourceUrls.every(url => documentCanonical.has(canonicalOfficialUrl(url)));
  return {
    structuredJson: structured !== null && typeof structured === "object" && !Array.isArray(structured),
    requestedDayPresent: typeof structured?.requestedDay === "string" && structured.requestedDay.trim().length > 0,
    venuePresent,
    venueAffirmative,
    venueIsEast,
    bronzeGalleryPresent,
    bronzeGalleryAffirmative,
    lastAdmissionPresent,
    hasTuesday,
    saysEastClosed,
    hasLastEntry17,
    bronzeEastAssociation,
    alternateDayPresent: alternateDay.length > 0,
    validAlternateDay,
    alternateArrivalPresent: alternateArrival.length > 0,
    validAlternateArrival,
    sourceUrlsPresent,
    sourceUrlsOfficial,
    sourceUrlsVisited,
    sourceUrlsDocumentBacked,
  };
}

function auditFetch(metrics) {
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== new URL(baseURL).origin || !url.pathname.endsWith("/chat/completions")) throw Error("unexpected_model_endpoint");
    const body = JSON.parse(init.body);
    if (body.model !== modelName) throw Error("unexpected_model");
    if (metrics.requests >= requestBudget) throw Error("provider_request_budget");
    const imageRoles = [];
    for (const message of body.messages ?? []) {
      const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
      for (const block of blocks) {
        if (block?.type === "image_url" || block?.type === "input_image" || (block?.type === "image" && block.data)) imageRoles.push(message.role);
        if (typeof block?.text === "string" && /data:image\/[^;]+;base64,|"(?:data|dataBase64)"\s*:\s*"[A-Za-z0-9+/=]{256}/u.test(block.text)) {
          throw Error("provider_image_in_text");
        }
      }
    }
    const lastTool = (body.messages ?? []).filter(message => message.role === "tool").at(-1);
    if (typeof lastTool?.content === "string" && lastTool.content.startsWith("Error")) {
      metrics.toolErrors.push(lastTool.content.replace(/data:[^ ]+/gu, "[data]").slice(0, 240));
    }
    body.reasoning_effort = "low";
    metrics.requests++;
    metrics.images += imageRoles.length;
    metrics.imageRoles.push(...imageRoles);
    const response = await fetch(url, {
      ...init,
      body: JSON.stringify(body),
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(45_000)])
        : AbortSignal.timeout(45_000),
    });
    if (response.ok) {
      try {
        const result = await response.clone().json();
        metrics.tokens += result.usage?.total_tokens ?? 0;
        metrics.completionTokens += result.usage?.completion_tokens ?? 0;
        metrics.finishes.push(result.choices?.[0]?.finish_reason ?? "missing");
        for (const call of result.choices?.[0]?.message?.tool_calls ?? []) {
          let args = {};
          try { args = JSON.parse(call.function.arguments); } catch { /* measured as an empty proposal */ }
          metrics.proposed.push({
            name: call.function.name,
            fields: Object.keys(args),
            ...(call.function.name === "observe" ? {
              observeShape: {
                viewType: typeof args.view,
                view: typeof args.view === "string" ? args.view : undefined,
                readType: typeof args.read,
                read: typeof args.read === "string" ? args.read : undefined,
                readKeys: args.read && typeof args.read === "object" && !Array.isArray(args.read) ? Object.keys(args.read) : undefined,
              },
            } : {}),
            steps: Array.isArray(args.steps) ? args.steps.map(summarizeStep) : undefined,
          });
        }
      } catch {
        metrics.finishes.push("unparseable");
      }
    }
    return response;
  };
}

function initialMetrics() {
  return {
    model: modelName,
    backend: "e2b-desktop",
    runId: acceptanceRun,
    startLocale,
    startUrl,
    managedBrowserOnly: true,
    cloudNativeAppDelivery: "not_exposed_by_desklatch_e2b_browser",
    task: "shanghai-museum-tuesday-bronze-alternate",
    requests: 0,
    images: 0,
    documentReads: 0,
    documentNonemptyReads: 0,
    documentSourceUrls: [],
    documentChunkCount: 0,
    imageRoles: [],
    tokens: 0,
    completionTokens: 0,
    finishes: [],
    proposed: [],
    calls: [],
    observations: [],
    targets: [],
    receipts: [],
    endpointErrors: [],
    approvals: [],
    toolErrors: [],
    visitedUrls: [],
    blockedExternalRequests: 0,
    blockedExternalHosts: [],
    popupsClosed: 0,
    independentSources: [],
    independentlyVerified: false,
  };
}

async function runAcceptance(guest, metrics) {
  let page;
  const blockedHosts = new Set();
  const prepare = async managedPage => {
    page = managedPage;
    await page.route("**/*", route => {
      let url;
      try { url = new URL(route.request().url()); } catch { return route.abort(); }
      if (url.origin === officialOrigin || url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") {
        return route.continue();
      }
      metrics.blockedExternalRequests++;
      blockedHosts.add(url.host || url.protocol);
      return route.abort();
    });
    page.on("framenavigated", frame => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!metrics.visitedUrls.includes(url)) metrics.visitedUrls.push(url);
    });
    page.on("popup", popup => {
      metrics.popupsClosed++;
      void popup.close().catch(() => undefined);
    });
    // Start on the official museum entry page so the model can discover the
    // venue and its public hours without a consent-gated cross-page navigation.
    await page.goto(startUrl, { waitUntil: "commit", timeout: 30_000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
  };

  const backend = await createE2BBrowserBackend(guest, {
    prepare,
    headless: false,
    startupTimeoutMs: 45_000,
    processTimeoutMs: 180_000,
    browser: {
      authorizedOrigins: [officialOrigin],
      includePublicValues: true,
      allowImages: true,
      allowDocumentText: true,
      documentTextLimit: 12_000,
      documentChunkLimit: 8,
      documentChunkSize: 2_000,
      observeLimit: 32,
      searchTimeoutMs: 8_000,
      settleMs: 250,
      allowBlank: false,
      actionTimeoutMs: 15_000,
    },
  });
  metrics.blockedExternalHosts = [...blockedHosts];
  const forbidden = /reservation|book(?: a)? visit|ticket|purchase|buy|checkout|payment|pay|shop|subscribe|newsletter|wechat|trip\.com|submit|confirm|预约|购票|购买|支付|商店|订阅/iu;
  const policy = createRiskPolicy({
    hostRules: {
      hardDeny: ({ target }) => {
        const label = `${target.name ?? ""} ${target.within ?? ""}`;
        if (forbidden.test(label)) return { match: true, code: "cloud_read_only_block" };
        if (["external", "financial", "destructive", "security", "sensitive"].includes(target.effect ?? "")) {
          return { match: true, code: "cloud_consequential_block" };
        }
        return false;
      },
    },
  });
  const measuredBackend = {
    ...backend,
    async observe(options) {
      const started = performance.now();
      try {
        return await backend.observe(options);
      } catch (error) {
        (metrics.backendErrors ??= []).push({ view: options.view, filtered: Boolean(options.where),
          type: error?.name, code: error?.code, message: scrubError(error), elapsedMs: Math.round(performance.now() - started) });
        throw error;
      }
    },
  };
  const session = createDeskSession(measuredBackend, {
    policy,
    allowModelImages: true,
    allowModelDocumentText: true,
    maxSteps: 24,
    timeoutMs: 120_000,
    approvalTimeoutMs: 15_000,
    onApprovalRequested(request) {
      metrics.approvals.push({
        step: request.step,
        kind: request.kind,
        targetRole: request.target?.role,
        targetNameDigest: request.target?.name ? digest(request.target.name) : undefined,
      });
      // A normal runtime navigation approval is a real approval boundary. This
      // read-only acceptance declines it and records the stop; it never turns
      // consent into an automatic success.
      return "deny";
    },
  });
  try {
    // A failed transport cannot supply evidence to the model. Check it once
    // on the real page; keep the diagnostic observation out of the model input.
    const frame = await measuredBackend.observe({ view: "document", read: "document", signal: AbortSignal.timeout(30_000) });
    const preflightChunks = frame.document?.chunks?.filter(chunk => typeof chunk?.text === "string" && chunk.text.trim().length > 0) ?? [];
    metrics.backendProbe = { ok: true, controls: frame.controls.length, hasDocument: Boolean(frame.document), documentChunks: frame.document?.chunks?.length ?? 0, nonemptyDocumentChunks: preflightChunks.length, sourceUrl: frame.document?.sourceUrl };
    if (!preflightChunks.length) throw Error("official_page_text_unavailable");
    if (process.env.DESKLATCH_CLOUD_BACKEND_ONLY === "1") {
      metrics.diagnosticOnly = true;
      metrics.pageUrlAtEnd = page?.url();
      return;
    }
    const instrumented = createDeskTools(session).map(endpoint => ({
      ...endpoint,
      async invoke(args, signal) {
        metrics.calls.push(endpoint.name);
        if (endpoint.name === "observe") {
          const read = typeof args?.read === "string" ? args.read : args?.read ? "document-options" : undefined;
          metrics.observations.push({ view: args?.view ?? "controls", filtered: Boolean(args?.where), ...(read ? { read } : {}) });
        }
        if (endpoint.name === "act") {
          for (const step of args?.steps ?? []) metrics.targets.push(summarizeStep(step));
        }
        let value;
        try {
          value = await endpoint.invoke(args, signal);
        } catch (error) {
          metrics.endpointErrors ??= [];
          metrics.endpointErrors.push({ name: endpoint.name, type: error?.name ?? "Error", code: error?.code, message: String(error?.message ?? error).slice(0, 160) });
          throw error;
        }
        if (endpoint.name === "observe") {
          const documentChunks = value?.document?.chunks?.filter(chunk => typeof chunk?.text === "string" && chunk.text.trim().length > 0) ?? [];
          if (documentChunks.length) {
            metrics.documentReads++;
            metrics.documentNonemptyReads++;
            metrics.documentChunkCount += documentChunks.length;
            const sourceUrl = canonicalOfficialUrl(value.document.sourceUrl);
            if (sourceUrl && !metrics.documentSourceUrls.includes(sourceUrl)) metrics.documentSourceUrls.push(sourceUrl);
          }
        }
        if (endpoint.name === "act") {
          metrics.receipts.push({
            status: value.status,
            code: value.code,
            atStep: value.atStep,
            steps: (value.steps ?? []).map(step => ({ index: step.index, kind: step.kind, status: step.status, code: step.code })),
          });
        }
        return value;
      },
    }));
    const tools = createLangChainTools(instrumented);
    const baseModel = new ChatOpenAI({
      model: modelName,
      apiKey: key,
      temperature: 0.1,
      maxTokens: 2048,
      maxRetries: 0,
      configuration: { baseURL, fetch: auditFetch(metrics) },
    });
    const model = baseModel.bindTools(tools);
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("model", async ({ messages }) => {
        const prepared = prepareDeskChatCompletionsMessages(messages);
        if (metrics.requests === requestBudget - 1) {
          metrics.usedReservedAnswerTurn = true;
          return { messages: [await baseModel.invoke([...prepared, new HumanMessage(
            "Return your final JSON now, using only the official page evidence you actually observed. Use null for any fact you could not establish."
          )])] };
        }
        return { messages: [await model.invoke(prepared)] };
      })
      .addNode("tools", new ToolNode(tools))
      .addEdge(START, "model")
      .addConditionalEdges("model", ({ messages }) => messages.at(-1)?.tool_calls?.length ? "tools" : END)
      .addEdge("tools", "model")
      .compile();
    const instructions = `${desktopToolInstructions} Start on the official Shanghai Museum homepage. Read and follow relevant same-origin public information pages as needed. To read rendered prose, call observe with {"read":"document"}. Controls and authorized images are available when useful. This is an information request. Leave all reservations, purchases and submissions untouched, and respect pending or denied approvals.`;
    const task = [
      "Plan a real Shanghai Museum visit for a Tuesday afternoon, with the Ancient Chinese Bronze Gallery as the goal.",
      "From the official entry information, state which venue hosts the bronze gallery, whether that venue can host Tuesday afternoon, the latest admission time when it is open, and one concrete alternate weekday and afternoon arrival time that the official hours support. If another campus is open Tuesday but does not host the target gallery, say so instead of substituting it.",
      "Return strict JSON only with keys: venue, requestedDay, requestedTime, bronzeGallery, lastAdmission, alternateDay, alternateArrival, reason, sourceUrls. sourceUrls must contain only official www.shanghaimuseum.cn URLs that you actually visited. Do not invent availability or use any source not shown on the official site.",
    ].join(" ");
    const result = await graph.invoke({ messages: [new SystemMessage(instructions), new HumanMessage(task)] }, { recursionLimit: 2 * requestBudget + 2 });
    const finalText = extractText(result.messages.at(-1));
    metrics.finalTextLength = finalText.length;
    metrics.finalTextDigest = digest(finalText);
    metrics.answerChecks = modelAnswerChecks(finalText, metrics.visitedUrls, metrics.documentSourceUrls);
    metrics.visitedUrls = metrics.visitedUrls.filter(url => url.startsWith(`${officialOrigin}/`));
    metrics.blockedExternalHosts = [...blockedHosts];
    metrics.pageUrlAtEnd = page?.url();
    savePublicAnswer(finalText, metrics);
    await verifyOfficialSources(metrics);
    const hasDispatchedStep = metrics.receipts.some(receipt => receipt.steps.some(step => ["verified", "dispatched"].includes(step.status)));
    const visitedEast = metrics.visitedUrls.some(url => new URL(url).pathname === new URL(official.east).pathname);
    const visitedBronze = metrics.visitedUrls.some(url => new URL(url).pathname === new URL(official.bronze).pathname);
    metrics.taskChecks = {
      usedObserve: metrics.calls.includes("observe"),
      usedAct: metrics.calls.includes("act"),
      sentAtLeastOneStep: hasDispatchedStep,
      documentTextRead: metrics.documentNonemptyReads > 0,
      imageTransmitted: metrics.images > 0,
      stayedOnAllowlistedOrigin: metrics.pageUrlAtEnd?.startsWith(`${officialOrigin}/`) === true,
      visitedEast,
      visitedBronze,
      ...metrics.answerChecks,
    };
    assert.equal(metrics.taskChecks.usedObserve, true);
    assert.equal(metrics.taskChecks.stayedOnAllowlistedOrigin, true);
    assert.equal(metrics.taskChecks.structuredJson, true);
    assert.equal(metrics.taskChecks.requestedDayPresent, true);
    assert.equal(metrics.taskChecks.venuePresent, true);
    assert.equal(metrics.taskChecks.venueAffirmative, true);
    assert.equal(metrics.taskChecks.venueIsEast, true);
    assert.equal(metrics.taskChecks.bronzeGalleryPresent, true);
    assert.equal(metrics.taskChecks.bronzeGalleryAffirmative, true);
    assert.equal(metrics.taskChecks.lastAdmissionPresent, true);
    assert.equal(metrics.taskChecks.hasTuesday, true);
    assert.equal(metrics.taskChecks.saysEastClosed, true);
    assert.equal(metrics.taskChecks.alternateDayPresent, true);
    assert.equal(metrics.taskChecks.alternateArrivalPresent, true);
    assert.equal(metrics.taskChecks.hasLastEntry17, true);
    assert.equal(metrics.taskChecks.bronzeEastAssociation, true);
    assert.equal(metrics.taskChecks.validAlternateDay, true);
    assert.equal(metrics.taskChecks.validAlternateArrival, true);
    assert.equal(metrics.taskChecks.sourceUrlsPresent, true);
    assert.equal(metrics.taskChecks.sourceUrlsOfficial, true);
    assert.equal(metrics.taskChecks.sourceUrlsVisited, true);
    assert.equal(metrics.taskChecks.sourceUrlsDocumentBacked, true);
    metrics.independentlyVerified = true;
  } finally {
    metrics.blockedExternalHosts = [...blockedHosts];
    await session.close();
  }
}

export async function runMuseumAcceptance(withDesktop = runInHostedDesktop) {
  const metrics = initialMetrics();
  try {
    await withDesktop(guest => runAcceptance(guest, metrics), {
      purpose: "shanghai-museum-public-acceptance",
      metadata: { acceptanceRun },
      timeoutMs: 300_000,
      allowInternetAccess: true,
      network: {
        allowOut: ["www.shanghaimuseum.cn"],
        denyOut: ({ allTraffic }) => [allTraffic],
        allowPublicTraffic: false,
      },
    });
  } catch (error) {
    metrics.independentlyVerified = false;
    metrics.errorType = error?.name ?? "Error";
    metrics.error = scrubError(error);
  }
  const result = { event: "cloud-shanghai-museum-acceptance", ...metrics };
  const metricsPath = process.env.DESKLATCH_CLOUD_METRICS_PATH;
  if (metricsPath) {
    try {
      const encoded = `${JSON.stringify(result, null, 2)}\n`;
      writeFileSync(metricsPath, encoded, { encoding: "utf8" });
      const readBack = readFileSync(metricsPath, "utf8");
      if (readBack !== encoded || readBack.includes("\uFFFD") || /\?{3,}/u.test(readBack)) throw Error("cloud_metrics_utf8_corrupt");
    } catch (error) {
      metrics.metricsArtifactError = scrubError(error);
      result.metricsArtifactError = metrics.metricsArtifactError;
    }
  }
  return { ...result, ...(metricsPath ? { metricsArtifact: metricsPath } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runMuseumAcceptance();
  console.log(JSON.stringify(result));
  if ((!result.independentlyVerified && !result.diagnosticOnly) || result.error || result.metricsArtifactError) process.exitCode = 1;
}
