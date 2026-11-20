import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CuaDriver, ListWindowsInput } from "@trycua/cua-driver";
import { createDeskSession, createRiskPolicy } from "desklatch";
import { createWindowsDesktopBackend, loadWindowsPhysicalInspector } from "desklatch/windows";
import { createWorkspace } from "desklatch/workspace";
import { runWorkspaceAgent } from "./support/workspace-agent.mjs";
import { checkVisitNote } from "./support/museum-visit-oracle.mjs";
import { auditWorkspaceDelivery } from "./support/workspace-audit.mjs";
import {
  exactActivation,
  guardedSession,
  readWordFile,
  targetFromWindow,
  verifyFront,
} from "./local-workspace-acceptance.mjs";

const resultsRoot = process.env.DESKLATCH_RESULTS_DIR;
const modelName = "glm-5.3-flash";

function executable(candidates) { return candidates.find((candidate) => candidate && existsSync(candidate)); }
function wordPath() { return executable([process.env.DESKLATCH_LOCAL_WORD_PATH, "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE", "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE"]); }
function spawnOwned(path, args) { return spawn(path, args, { detached: false, stdio: "ignore", windowsHide: false }); }
function scrub(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  return value;
}
async function listWindows(driver) {
  const listed = await driver.listWindows(ListWindowsInput.new({ onScreenOnly: false }));
  return listed.windows ?? [];
}
function windowKey(window) { return `${window.pid}:${String(window.windowId)}`; }
async function waitNewWordWindow(driver, baselineKeys, expectedPid, fileMarker, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let observed = [];
  while (Date.now() < deadline) {
    const windows = await listWindows(driver);
    const newWordWindows = windows.filter(window => window.pid === expectedPid && /^winword(?:\.exe)?$/iu.test(window.appName ?? "")
      && !baselineKeys.has(windowKey(window)) && window.windowId > 0n);
    const candidates = newWordWindows.filter(window => window.title?.toLowerCase().includes(fileMarker.toLowerCase())
      && !/(?:正在打开|Opening|Starting)/iu.test(window.title ?? "") && window.isOnScreen !== false);
    if (candidates.length === 1) return { window: candidates[0], observed };
    observed = newWordWindows.map(window => ({ pid: window.pid, hwnd: String(window.windowId),
      fileMarkerMatched: window.title?.toLowerCase().includes(fileMarker) ?? false, onScreen: window.isOnScreen }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw Object.assign(new Error("owned_word_document_window_not_found"), { observed });
}
async function writeJson(path, value) {
  const encoded = `${JSON.stringify(scrub(value), (_key, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`;
  await writeFile(path, encoded, "utf8");
  const readBack = await readFile(path, "utf8");
  if (readBack !== encoded || readBack.includes("\uFFFD") || /\?{3,}/u.test(readBack)) throw Error("utf8_artifact_corrupt");
}
async function loadRequiredPath(name) {
  const value = process.env[name];
  if (!value) throw Error(`${name.toLowerCase()}_missing`);
  await access(value);
  return value;
}

export async function runWordOnly() {
  if (!resultsRoot) throw Error("desklatch_results_dir_missing");
  const runId = randomUUID();
  const runDirectory = resolve(resultsRoot, `word-only-${runId}`);
  const tempDirectory = resolve(process.env.TEMP ?? "C:\\Temp", `desklatch-word-only-${runId}`);
  await mkdir(runDirectory, { recursive: true });
  await mkdir(tempDirectory, { recursive: true });
  const templateSource = await loadRequiredPath("DESKLATCH_WORD_TEMPLATE_PATH");
  const sourceTextPath = await loadRequiredPath("DESKLATCH_WORD_SOURCE_TEXT_PATH");
  const sourceText = await readFile(sourceTextPath, "utf8");
  if (!sourceText.trim() || sourceText.includes("\uFFFD") || /\?{3,}/u.test(sourceText)) throw Error("source_text_utf8_invalid");
  const sourceMaterial = sourceText.replace(/\s+/gu, " ").trim();
  const fileMarker = `museum-visit-${runId}`;
  const outputPath = join(tempDirectory, `${fileMarker}.docx`);
  await copyFile(templateSource, outputPath);
  const baseline = await readWordFile(outputPath);
  if (baseline.paragraphs.join("\n").trim()) throw Error("template_not_blank");
  const metrics = {
    event: "local-word-only-acceptance", runId, model: modelName, task: "deliver-verified-museum-note-to-existing-blank-word-docx",
    runDirectory, outputPath, sourceTextPath, templateSource, baselineSha256: baseline.sha256,
    activations: [], foreground: [], foregroundChecks: [], modelCalls: 0, modelImages: 0, modelTokens: 0,
    modelArgs: [], dispatches: [], readbacks: [], calls: [], documentWrites: 0, saveActions: 0,
    independentlyVerified: false,
  };
  const word = wordPath();
  if (!word) throw Error("word_not_installed");
  const driver = CuaDriver.create(undefined);
  const baselineWindows = await listWindows(driver);
  const baselineKeys = new Set(baselineWindows.map(windowKey));
  const child = spawnOwned(word, [outputPath]);
  let backend;
  let workspace;
  try {
    const discovered = await waitNewWordWindow(driver, baselineKeys, child.pid, fileMarker);
    const window = discovered.window;
    metrics.startup = { childPid: child.pid, baselineWindowCount: baselineWindows.length, fileMarker,
      observedDuringStartup: discovered.observed };
    const target = targetFromWindow(window);
    metrics.word = { pid: target.pid, hwnd: target.hwnd.toString(), title: target.title };
    const inspector = await loadWindowsPhysicalInspector();
    if (!inspector) throw Error("windows_physical_inspector_unavailable");
    const activate = exactActivation({ driver, inspector, metrics, label: "word" });
    backend = await createWindowsDesktopBackend({
      driver,
      authorization: { targets: [target], allowForegroundInput: true, allowDesktopCapture: true, background: { source: "cua-uia-0.54" } },
      activateForeground: activate,
    });
    const basePolicy = createRiskPolicy({
      hostRules: {
        requireApproval: ({ step, target: control }) => {
          if (step.kind === "hotkey" && Array.isArray(step.keys) && step.keys.length === 2
            && step.keys[0].toLocaleLowerCase() === "ctrl" && step.keys[1].toLocaleLowerCase() === "s") return { match: true, code: "existing_disposable_save" };
          if (step.kind === "keypress" && step.key === "F12") return { match: true, code: "existing_disposable_save_as" };
          if (step.kind === "click" && /^(?:保存|Save)$/u.test(control.name ?? "")) return { match: true, code: "existing_disposable_save" };
          return false;
        },
      },
    });
    const rawSession = createDeskSession(backend, {
      policy: basePolicy,
      allowModelImages: false,
      maxSteps: 12,
      timeoutMs: 120_000,
      approvalTimeoutMs: 15_000,
      onApprovalRequested(request) {
        metrics.approvals = metrics.approvals ?? [];
        metrics.approvals.push({ requestId: request.requestId, kind: request.kind, target: request.target, summary: request.summary });
        const keys = Array.isArray(request.params?.keys) ? request.params.keys.map((key) => String(key).toLocaleLowerCase()) : [];
        const ctrlS = request.kind === "hotkey" && keys.length === 2 && keys[0] === "ctrl" && keys[1] === "s";
        const saveButton = request.kind === "click" && /^(?:保存|Save)$/u.test(request.target?.name ?? "");
        const currentWindow = metrics.word && metrics.foreground?.at(-1);
        const liveTarget = currentWindow?.verified === true && currentWindow.target?.pid === metrics.word.pid && currentWindow.target?.hwnd === metrics.word.hwnd;
        return liveTarget && (ctrlS || saveButton) ? "approve" : "deny";
      },
    });
    const probeDeadline = Date.now() + 30_000;
    let probe;
    while (Date.now() < probeDeadline) {
      const frame = await rawSession.observe({ view: "controls" });
      const names = frame.controls.map((control) => control.name ?? "");
      if (names.some((name) => /(?:恢复|无法读取|recovered|unreadable)/iu.test(name))) throw Error("word_recovery_dialog_detected");
      const hasDocument = frame.controls.some((control) => control.role === "Document" && control.actions.includes("type"));
      probe = { complete: frame.complete, controlCount: frame.controls.length, hasDocument, names: names.slice(0, 32) };
      if (hasDocument) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    metrics.startup.documentProbe = probe;
    if (!probe?.hasDocument) throw Error("word_document_controls_not_ready");
    const session = guardedSession(rawSession, target, inspector, "word", metrics, {
      beforeAct(input) {
        for (const step of input?.steps ?? []) {
          if (step.target?.role === "Document" && (step.kind === "type" || step.kind === "setValue")) metrics.documentWrites += 1;
          if (step.kind === "hotkey" || (step.kind === "click" && /^(?:保存|Save)$/u.test(step.target?.name ?? ""))) metrics.saveActions += 1;
        }
      },
    });
    const app = {
      id: "word",
      name: "Granted existing disposable blank Word document",
      description: "Fresh copied blank DOCX; save is limited to this run-owned path.",
      session,
      async activate() { return activate(target); },
      async verifyFront(context) { return verifyFront({ inspector, metrics, label: "word" })({ ...context, target }); },
    };
    workspace = createWorkspace({ applications: [app], initialActive: null });
    const tracePath = join(runDirectory, "events.jsonl");
    const run = await runWorkspaceAgent({
      tools: workspace.tools,
      apiKey: process.env.ZHIPU_API_KEY,
      task: `请把刚才的网页研究整理成一段约150字的中文参观提示，保留四项关键信息：青铜馆所在馆区、普通周二下午是否开放、开放日最晚入场时间、一个可行的工作日下午方案，并保留官网来源链接。把这段提示写入当前已打开的空白 Word 文档并保存已有文件，不要只回复文字。网页研究原文如下：\n\n${sourceText}`,
      maxTurns: 16,
      instructions: "只操作 observe({workspace:true}) 列出的已授权 Word 应用。所有激活、观察、正文输入和保存都必须由你通过公开 observe/act 根据当前控件选择；不要使用 shell、文件系统、COM、隐藏剪贴板或其他应用。使用当前真实 Word 控件完成写入与保存；保存目标只能是任务中已打开的一次性 DOCX。",
      async onEvent(event) {
        const safe = scrub(event);
        await appendFile(tracePath, `${JSON.stringify(safe)}\n`, "utf8");
        metrics.calls.push(safe);
        if (event.type === "model.request") { metrics.modelCalls += 1; metrics.modelImages += Number(event.imageCount ?? 0) || 0; }
        if (event.type === "model.response") metrics.modelTokens += Number(event.tokenUsage?.totalTokens ?? 0) || 0;
        if (event.type === "tool.call") metrics.modelArgs.push({ name: event.name, arguments: event.arguments, normalizedArguments: event.normalizedArguments });
        if (event.type === "tool.result" && event.name === "observe") metrics.readbacks.push(safe);
        if (event.type === "tool.result" && event.name === "act") {
          const steps = event.receipt?.steps ?? [];
          if (event.receipt?.status === "completed" && steps.some((step) => step.status === "dispatched" || step.status === "verified")) metrics.dispatches.push(safe);
        }
      },
    });
    metrics.agent = scrub(run);
    const after = await readWordFile(outputPath);
    const actualText = after.paragraphs.join("\n");
    metrics.readback = { sha256: after.sha256, paragraphs: after.paragraphs, paragraphCount: after.paragraphs.length };
    const audit = auditWorkspaceDelivery(run.events, { editors: ["word"], outputPath });
    metrics.noteChecks = checkVisitNote(actualText, { observedUrls: [...new Set(sourceText.match(/https:\/\/www\.shanghaimuseum\.cn\/[^\s)]+/giu) ?? [])] });
    metrics.workflowChecks = {
      wordForeground: metrics.activations.some((item) => item.label === "word" && item.verified === true),
      nativeDocumentWrite: audit.writes.length > 0,
      nativeSave: audit.saves.some(save => audit.writes.some(write => write.seq < save.seq || (write.seq === save.seq && write.index < save.index))),
      outputBytesChanged: after.sha256 !== baseline.sha256,
    };
    metrics.independentlyVerified = Object.values(metrics.workflowChecks).every(Boolean) && metrics.noteChecks.passed;
  } catch (error) {
    metrics.error = String(error?.message ?? error);
    if (Array.isArray(error?.observed)) metrics.observedDuringStartup = error.observed;
  } finally {
    try {
      await writeJson(join(runDirectory, "run.json"), metrics);
    } finally {
      await workspace?.close().catch(() => undefined);
      await backend?.close().catch(() => undefined);
      await driver.shutdown().catch(() => undefined);
      driver.uniffiDestroy?.();
      try { child.kill(); } catch { /* exact ephemeral Word only */ }
    }
  }
  console.log(JSON.stringify({ event: metrics.event, runId, status: metrics.agent?.status ?? (metrics.error ? "error" : "unknown"), independentlyVerified: metrics.independentlyVerified,
    outputPath, runDirectory, workflowChecks: metrics.workflowChecks, error: metrics.error }));
  if (!metrics.independentlyVerified) process.exitCode = 1;
  return metrics;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runWordOnly();
