import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDeskSession, createRiskPolicy } from "desklatch";
import { createWorkspaceNavigator } from "desklatch/browser";
import {
  createE2BBrowserBackend,
  createE2BDesktopBackend,
  E2BX11RecipientProcess,
} from "desklatch/e2b";
import { createWorkspace } from "desklatch/workspace";
import { checkEastVisitHours, directEastVisitTask, eastVisitGuide, fetchMuseumReference } from "./support/museum-visit-oracle.mjs";
import { auditWorkspaceDelivery, verifySavedVisitNote } from "./support/workspace-audit.mjs";
import {
  activateCloudWindow,
  cloudOutputDirectory,
  cloudOutputPath,
  cloudResultPath,
  createBlankOdt,
  createCloudDirectory,
  discoverEditorWindows,
  discoverUniqueWindow,
  loadCloudCredentials,
  openBlankWriter,
  readCloudFileBytes,
  readOfficeText,
  sha256,
  verifyCloudWindow,
} from "./support/cloud-desktop.mjs";

const officialOrigin = "https://www.shanghaimuseum.cn";
const modelName = "glm-5.3-flash";

function scrub(value, apiKey) {
  if (typeof value === "string") return apiKey ? value.replaceAll(apiKey, "[credential]") : value;
  if (Array.isArray(value)) return value.map(item => scrub(item, apiKey));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, apiKey)]));
  return value;
}

async function writeArtifact(path, value, apiKey) {
  const encoded = `${JSON.stringify(scrub(value, apiKey), null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encoded, "utf8");
  const readBack = await readFile(path, "utf8");
  if (readBack !== encoded || readBack.includes("\uFFFD") || /\?{3,}/u.test(readBack)) throw Error("cloud_artifact_utf8_corrupt");
}

async function runAcceptance(guest, metrics) {
  const visitedUrls = new Set();
  let browser;
  let browserSession;
  let editorBackend;
  let editorSession;
  let workspace;
  let navigator;
  let page;
  try {
    const editor = { application: "libreoffice", launch: "libreoffice-writer", format: "odt", extension: "odt" };
    metrics.phase = "prepare_blank_document";
    metrics.editor = { application: editor.application, launch: editor.launch, format: editor.format, extension: editor.extension, genuine: true };
    const outputPath = cloudOutputPath(metrics.runId, editor.extension);
    await createCloudDirectory(guest, cloudOutputDirectory(outputPath));
    metrics.saveMode = "fresh-disposable-existing-odt";
    metrics.blankInput = await createBlankOdt(guest, outputPath);
    metrics.outputOrigin = "host-created-empty-disposable";
    metrics.outputPath = outputPath;

    const browserPrepare = async managedPage => {
      page = managedPage;
      // Egress is allowlisted by the guest. Do not proxy every image/font request
      // back through the host; the navigator separately guards top-level redirects.
      page.on("framenavigated", frame => {
        if (frame === page.mainFrame()) visitedUrls.add(frame.url());
      });
    };
    metrics.phase = "open_blank_browser";
    browser = await createE2BBrowserBackend(guest, {
      prepare: browserPrepare,
      headless: false,
      startupTimeoutMs: 45_000,
      processTimeoutMs: 540_000,
      browser: {
        authorizedOrigins: [officialOrigin],
        includePublicValues: true,
        allowImages: true,
        allowDocumentText: true,
        documentTextLimit: 12_000,
        documentChunkLimit: 32,
        documentChunkSize: 2_000,
        observeLimit: 64,
        searchTimeoutMs: 8_000,
        settleMs: 250,
        allowBlank: true,
        actionTimeoutMs: 15_000,
      },
    });
    metrics.phase = "identify_browser";
    const browserGrant = await discoverUniqueWindow(guest, {
      application: "google-chrome",
      titlePattern: /上海博物馆|Shanghai Museum|Chrome/iu,
    });
    metrics.browserGrant = browserGrant;
    metrics.browserInitialUrl = page?.url();

    metrics.phase = "open_writer";
    await openBlankWriter(guest, outputPath);
    metrics.startupTipEnabled = false;
    let editorWindows = [];
    const readyBy = Date.now() + 30_000;
    while (!editorWindows.length && Date.now() < readyBy) {
      try { editorWindows = await discoverEditorWindows(guest, { application: editor.application, titlePattern: /museum-visit-note\.odt/iu }); }
      catch { await guest.wait(500); }
    }
    const editorMatches = editorWindows.filter(window => !/Save As|另存为/iu.test(window.title));
    if (editorMatches.length !== 1) throw Error("cloud_test_document_window_not_unique");
    const editorGrant = editorMatches[0];
    metrics.editorGrant = editorGrant;
    metrics.editorWindowCandidates = editorWindows;
    const activationEvents = [];
    const recipient = new E2BX11RecipientProcess(guest, { timeoutMs: 30_000 });
    const { windowId, processId, application } = editorGrant;
    const cleanTitle = title => title.replace(/^[*●\s]+/u, "").trim();
    const editorDesktopOptions = {
      windows: [{ windowId, processId, application }],
      recipient,
      keyboardRecipient: recipient,
      allowKeyboardInput: true,
      allowTemporaryClipboard: true,
      allowScreenshot: true,
      allowDegradedScreenshot: true,
      allowPointActions: true,
      includeValues: false,
      onWindowActivated: event => { activationEvents.push(event); metrics.activationEvents = activationEvents; },
      maxElements: 512,
      maxTextLength: 16_384,
      timeoutMs: 30_000,
    };
    editorBackend = await createE2BDesktopBackend(guest, editorDesktopOptions);

    const browserPolicy = createRiskPolicy({
      hostRules: {
        hardDeny: ({ target }) => /预约|购票|购买|支付|提交|确认|reservation|ticket|purchase|payment|submit|confirm/iu.test(`${target.name ?? ""} ${target.within ?? ""}`)
          ? { match: true, code: "cloud_read_only_block" } : false,
      },
    });
    browserSession = createDeskSession(browser, {
      policy: browserPolicy,
      allowModelImages: true,
      allowModelDocumentText: true,
      maxSteps: 24,
      timeoutMs: 120_000,
      approvalTimeoutMs: 15_000,
      onApprovalRequested: request => { metrics.approvals.push({ applicationId: "browser", target: request.target, kind: request.kind, summary: request.summary }); return "deny"; },
    });
    const ordinaryEditorPolicy = createRiskPolicy({
      hostRules: {
        hardDeny: ({ target }) => /(?:delete|remove|overwrite|replace|覆盖|删除|替换)/iu.test(`${target.name ?? ""} ${target.within ?? ""}`)
          ? { match: true, code: "cloud_editor_destructive_block" } : false,
      },
    });
    let approvedSaveKind;
    // This grant applies to the existing blank file that this guest opened.
    // Neither an attempted filename nor a self-reported model result grants consent.
    async function editorPolicy(input) {
      approvedSaveKind = undefined;
      const { step, target } = input;
      const chord = (step.keys ?? []).map(k => k.toLowerCase().replace(/^control$/u, "ctrl")).join("+");
      const save = (step.kind === "hotkey" && chord === "ctrl+s")
        || (step.kind === "click" && /^(?:Save|保存)(?:\s*[(（].*[)）])?$/iu.test(target.name ?? ""));
      const windowTyping = step.kind === "type" && target.role === "Window";
      if (editor.extension === "odt" && (save || windowTyping)) {
        const sameFile = (await verifyCloudWindow(guest, editorGrant))
          && cleanTitle(await guest.getWindowTitle(windowId)) === cleanTitle(editorGrant.title);
        if (!sameFile) return { decision: "deny", code: "cloud_working_document_changed" };
        if (windowTyping) return { decision: "allow", code: "type_into_enrolled_working_document" };
        approvedSaveKind = step.kind;
        return { decision: "approve", code: "save_enrolled_working_document" };
      }
      return ordinaryEditorPolicy(input);
    }
    const measuredEditor = {
      capabilities: editorBackend.capabilities,
      get hitTestSnapshot() { return editorBackend.hitTestSnapshot === true; },
      observe: options => editorBackend.observe(options),
      hitTest: (frame, point, signal) => editorBackend.hitTest(frame, point, signal),
      close: () => editorBackend.close(),
      async dispatch(request) {
        try { return await editorBackend.dispatch(request); }
        catch (error) {
          const diagnostic = { kind: request.step.kind, code: error.code, name: error.name,
            message: String(error.message).slice(0, 200), stderr: String(error.stderr ?? error.result?.stderr ?? "").slice(0, 300) };
          (metrics.editorErrors ??= []).push(diagnostic);
          await appendFile(join(dirname(cloudResultPath(metrics.runId)), "adapter-errors.jsonl"), JSON.stringify(diagnostic) + "\n", "utf8").catch(() => undefined);
          throw error;
        }
      },
    };
    const rawEditorSession = createDeskSession(measuredEditor, {
      policy: editorPolicy,
      allowModelImages: true,
      maxSteps: 32,
      timeoutMs: 120_000,
      approvalTimeoutMs: 15_000,
      onApprovalRequested: request => {
        metrics.approvals.push({ applicationId: "editor", target: request.target, kind: request.kind, summary: request.summary });
        const approved = approvedSaveKind !== undefined && request.kind === approvedSaveKind;
        approvedSaveKind = undefined;
        return approved ? "approve" : "deny";
      },
    });
    editorSession = rawEditorSession;

    const browserNavigate = createWorkspaceNavigator(page, { authorizedOrigins: [officialOrigin], timeoutMs: 30_000 });
    navigator = browserNavigate;
    const browserApp = {
      id: "browser",
      name: "Official Shanghai Museum browser",
      description: "Fresh cloud Chromium, allowlisted to www.shanghaimuseum.cn.",
      session: browserSession,
      async activate() {
        const record = await activateCloudWindow(guest, browserGrant);
        metrics.workspaceActivations.push({ applicationId: "browser", ...record, selectedByModel: true });
        return record;
      },
      async verifyFront() {
        const verified = await verifyCloudWindow(guest, browserGrant);
        metrics.foregroundChecks.push({ applicationId: "browser", windowId: browserGrant.windowId, processId: browserGrant.processId, verified });
        return verified;
      },
      async navigate({ url, signal }) {
        const result = await browserNavigate.navigate(url, signal);
        metrics.navigations.push({ ...result, selectedByModel: true });
        return { status: "completed", code: "model_navigation_completed", steps: [], ...result };
      },
    };
    const editorApp = {
      id: "editor",
      name: `${editor.application} cloud editor (${editor.extension.toUpperCase()})`,
      description: `Genuine installed ${editor.application}; save format is .${editor.extension}.`,
      session: editorSession,
      async activate() {
        const record = await activateCloudWindow(guest, editorGrant);
        metrics.workspaceActivations.push({ applicationId: "editor", ...record, selectedByModel: true });
        return record;
      },
      async verifyFront() {
        const verified = await verifyCloudWindow(guest, editorGrant);
        metrics.foregroundChecks.push({ applicationId: "editor", windowId: editorGrant.windowId, processId: editorGrant.processId, verified });
        return verified;
      },
    };
    workspace = createWorkspace({ applications: [browserApp, editorApp], initialActive: null });
    metrics.workspaceApplications = workspace.applications;

    const { runWorkspaceAgent } = await import("./support/workspace-agent.mjs");
    metrics.phase = "model_task";
    const result = await runWorkspaceAgent({
      tools: workspace.tools,
      task: directEastVisitTask(outputPath),
      apiKey: process.env.ZHIPU_API_KEY,
      maxTurns: 18,
      signal: AbortSignal.timeout(360_000),
      verifyDelivery: ({ events, signal }) => verifySavedVisitNote(events, {
        outputPath, baselineSha: metrics.blankInput.sha256, signal,
        readSaved: async () => {
          const bytes = await readCloudFileBytes(guest, outputPath);
          return { text: await readOfficeText(bytes, "odt"), sha256: sha256(bytes) };
        },
      }),
      instructions: [
        "Use only the supplied Workspace observe and act tools. Discover the owned applications with observe({workspace:true}) and choose actions from current observations.",
        "Read the official Chinese Shanghai Museum site through rendered page text and controls. Do not use shell, filesystem, clipboard, hidden APIs, or an answer from memory.",
        `Use the genuine installed editor application named in the task and save the designated .${editor.extension.toUpperCase()} file at the exact path in the task. It is a fresh disposable run-owned file; its content must be entered through the observed editor UI.`,
        "Use actions advertised on the observed editor. A window target denotes the focused recipient; it does not identify a semantic text field. Use images when needed.",
      ].join(" "),
      async onEvent(event) {
        metrics.events.push(scrub(event, process.env.ZHIPU_API_KEY));
        await appendFile(join(dirname(cloudResultPath(metrics.runId)), "events.jsonl"), JSON.stringify(metrics.events.at(-1)) + "\n", "utf8");
        if (event.type === "model.request") metrics.modelRequests += 1;
        if (event.type === "tool.call") metrics.toolCalls += 1;
      },
    });
    metrics.agent = scrub(result, process.env.ZHIPU_API_KEY);
    metrics.answer = result.answer;
    metrics.actionAudit = auditWorkspaceDelivery(result.events, { outputPath });
    metrics.visitedUrls = [...visitedUrls].filter(url => url.startsWith(`${officialOrigin}/`));
    metrics.activationEvents = activationEvents;

    metrics.phase = "read_saved_file";
    const bytes = await readCloudFileBytes(guest, outputPath);
    metrics.output = { path: outputPath, format: editor.extension, bytes: bytes.byteLength, sha256: sha256(bytes) };
    metrics.editorCapabilityMode = editorBackend.capabilityMode;
    const localOutputPath = join(dirname(cloudResultPath(metrics.runId)), `museum-visit-note.${editor.extension}`);
    await mkdir(dirname(localOutputPath), { recursive: true });
    await writeFile(localOutputPath, bytes);
    const downloaded = await readFile(localOutputPath);
    if (downloaded.byteLength !== bytes.byteLength || sha256(downloaded) !== metrics.output.sha256) throw Error("cloud_output_download_mismatch");
    metrics.localOutputPath = localOutputPath;
    const text = await readOfficeText(bytes, editor.extension);
    metrics.noteChecks = checkEastVisitHours(text, { observedUrls: metrics.actionAudit.observedUrls });
    metrics.outputTextDigest = createHash("sha256").update(text, "utf8").digest("hex");
    metrics.independentReference = await fetchMuseumReference();
    metrics.navigationFromBlank = metrics.browserInitialUrl === "about:blank" && metrics.navigations.length > 0;
    metrics.foregroundTransitionVerified = metrics.foregroundChecks.some(check => check.applicationId === "browser" && check.verified)
      && metrics.foregroundChecks.some(check => check.applicationId === "editor" && check.verified)
      && metrics.workspaceActivations.some(activation => activation.applicationId === "editor" && activation.changed === true && activation.processId === editorGrant.processId);
    metrics.outputVerified = metrics.noteChecks.passed === true
      && metrics.independentReference.confirmed === true
      && metrics.navigationFromBlank === true
      && metrics.foregroundTransitionVerified === true
      && metrics.actionAudit.modelOperatedAcrossApps
      && result.events.some(event => event.type === "delivery.verified" && event.evidence.sha256 === metrics.output.sha256)
      && (!metrics.blankInput || metrics.output.sha256 !== metrics.blankInput.sha256);
  } finally {
    await workspace?.close().catch(() => undefined);
    await navigator?.close().catch(() => undefined);
    await editorSession?.close().catch(() => undefined);
    await browserSession?.close().catch(() => undefined);
    await editorBackend?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

export async function runCloudWorkspaceAcceptance() {
  const runId = randomUUID();
  await mkdir(dirname(cloudResultPath(runId)), { recursive: true });
  const metrics = {
    event: "cloud-workspace-acceptance",
    runId,
    model: modelName,
    backend: "e2b-desktop",
    task: "shanghai-museum-east-hours-to-writer",
    guide: eastVisitGuide,
    managedBrowserOnly: false,
    genuineEditorRequired: true,
    modelRequests: 0,
    toolCalls: 0,
    events: [],
    approvals: [],
    workspaceActivations: [],
    foregroundChecks: [],
    navigations: [],
    activationEvents: [],
    independentlyVerified: false,
  };
  const started = performance.now();
  let credentials;
  try {
    if (!process.env.DESKLATCH_RESULTS_DIR) throw Error("cloud_results_dir_missing");
    credentials = loadCloudCredentials();
    metrics.credentials = credentials;
    const { runInHostedDesktop } = await import("./support/hosted-desktop.mjs");
    await runInHostedDesktop(guest => runAcceptance(guest, metrics), {
      purpose: "shanghai-museum-cloud-workspace",
      metadata: { acceptanceRun: runId },
      timeoutMs: 540_000,
      allowInternetAccess: true,
      network: { allowOut: ["www.shanghaimuseum.cn"], denyOut: ({ allTraffic }) => [allTraffic], allowPublicTraffic: false },
    });
  } catch (error) {
    metrics.error = scrub({ code: error?.code, message: error?.message ?? String(error) }, process.env.ZHIPU_API_KEY);
  }
  metrics.elapsedMs = Math.round(performance.now() - started);
  metrics.independentlyVerified = metrics.outputVerified === true;
  const resultPath = cloudResultPath(runId);
  metrics.metricsArtifact = resultPath;
  await writeArtifact(resultPath, metrics, process.env.ZHIPU_API_KEY);
  return metrics;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCloudWorkspaceAcceptance();
  console.log(JSON.stringify({ path: result.metricsArtifact, requests: result.modelRequests, verified: result.independentlyVerified, error: result.error }));
  if (!result.independentlyVerified) process.exitCode = 1;
}
