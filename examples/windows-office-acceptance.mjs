import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { CuaDriver, ListWindowsInput } from "@trycua/cua-driver";
import { createDeskSession } from "../dist/index.js";
import {
  createWindowsDesktopBackend,
  loadWindowsOwnedDialogInspector,
  NativeUiAutomationWindowsTransport,
} from "../dist/backends/windows/index.js";
import { createRiskPolicy } from "../dist/policy.js";
import { fileURLToPath } from "node:url";

/**
 * Portable live Office acceptance entry.
 *
 * The host owns window selection. This runner requires an explicit exact Word
 * PID/HWND, then exercises public DeskLatch observe/act calls. It discovers an
 * owned Save As modal only through the parent+PID ownership proof; it never
 * fills a dialog through host scripting or COM.
 *
 * Optional host inputs:
 *   DESKLATCH_WINDOWS_WORD_PID/HWND  exact test-owned Word PID/HWND
 *   DESKLATCH_WINDOWS_SOURCE_PATH   exact disposable source DOCX for oracle readback
 */

const execFileAsync = promisify(execFile);

const saveAsName = "\u53e6\u5b58\u4e3a";
const fileTabName = "\u201c\u6587\u4ef6\u201d\u9009\u9879\u5361";

function parsePositive(value, label) {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value) || BigInt(value) <= 0n) throw new Error(`${label}_invalid`);
  return BigInt(value);
}

function targetFromWindow(window) {
  assert.ok(window?.pid > 0, "window_pid_missing");
  assert.ok(window?.windowId > 0n, "window_id_missing");
  return { pid: window.pid, hwnd: window.windowId, title: window.title };
}

function targetJson(target) {
  return { pid: target.pid, hwnd: String(target.hwnd), title: target.title };
}

async function readWordFile(filePath) {
  const reader = fileURLToPath(new URL("./support/read-word-file.ps1", import.meta.url));
  const result = await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", reader, "-FilePath", filePath,
  ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  const text = String(result.stdout ?? "").trim();
  if (!text || text.includes("\uFFFD") || /\?{3,}/u.test(text)) throw new Error("word_oracle_utf8_corrupt");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed.sha256 !== "string" || !Array.isArray(parsed.paragraphs)) throw new Error("word_oracle_invalid");
  return parsed;
}

async function discoverWord(driver) {
  const listed = await driver.listWindows(ListWindowsInput.new({ onScreenOnly: false }));
  const requestedPid = Number.parseInt(process.env.DESKLATCH_WINDOWS_WORD_PID ?? "", 10);
  const requestedHwnd = parsePositive(process.env.DESKLATCH_WINDOWS_WORD_HWND, "word_hwnd");
  assert.ok(requestedPid > 0 && requestedHwnd !== undefined, "explicit_test_word_target_required");
  const matches = listed.windows.filter(window => {
    if (window.pid !== requestedPid) return false;
    if (window.windowId !== requestedHwnd) return false;
    return /Word/iu.test(window.title ?? "") && window.windowId > 0n;
  });
  assert.equal(matches.length, 1, `expected_one_word_window:${matches.length}`);
  return targetFromWindow(matches[0]);
}

async function findOwnedSaveAs(driver, dialogs) {
  const filenameName = "\u6587\u4ef6\u540d";
  const saveName = "\u4fdd\u5b58";
  for (const dialog of dialogs) {
    const target = { pid: dialog.pid, hwnd: dialog.hwnd, title: "owned-dialog" };
    let backend;
    let session;
    try {
      const transport = new NativeUiAutomationWindowsTransport();
      backend = await createWindowsDesktopBackend({
        driver,
        transport,
        authorization: { targets: [target], background: { source: "native-uia-v1" } },
      });
      session = createDeskSession(backend, { allowModelImages: false });
      const observation = await session.observe({ view: "controls" });
      const filename = observation.controls.find(control => control.role === "Edit" && control.name === filenameName);
      const save = observation.controls.find(control => control.role === "Button" && control.name === saveName);
      if (filename?.ref && save?.ref) return { target, backend, session, observation, filename, save };
    } catch {
      // A same-PID owned window can disappear or be an add-in page; it is not
      // a Save As dialog until the exact native controls are observed.
    }
    await session?.close().catch(() => undefined);
    await backend?.close().catch(() => undefined);
  }
  return undefined;
}

async function run() {
  let backend;
  let session;
  const runDirectory = process.env.DESKLATCH_WINDOWS_RUN_DIR;
  const notePath = process.env.DESKLATCH_WINDOWS_NOTE_PATH;
  const sourcePath = process.env.DESKLATCH_WINDOWS_SOURCE_PATH;
  const correctionPath = process.env.DESKLATCH_WINDOWS_CORRECTION_PATH;
  if (!runDirectory) throw new Error("unique_run_directory_required");
  if (!notePath) throw new Error("public_note_path_required");
  if (!sourcePath) throw new Error("disposable_source_path_required");
  const rawNote = await readFile(notePath, "utf8");
  if (rawNote.includes("\uFFFD") || /\?{3,}/u.test(rawNote)) throw new Error("public_note_utf8_corrupt");
  const note = rawNote.replaceAll("**", "").replace(/^\s*[-*]\s*/gmu, "").replace(/\s+/gu, " ").trim();
  if (!note) throw new Error("public_note_empty");
  const rawCorrection = correctionPath === undefined ? "" : await readFile(correctionPath, "utf8");
  if (rawCorrection.includes("\uFFFD") || /\?{3,}/u.test(rawCorrection)) throw new Error("correction_utf8_corrupt");
  const correction = rawCorrection.replace(/\s+/gu, " ").trim();
  const sourceBefore = await readWordFile(sourcePath);
  try {
    await access(`${runDirectory}\\word-corrected.docx`);
    throw new Error("output_preexisting");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const skipDocumentType = process.env.DESKLATCH_WINDOWS_SKIP_DOCUMENT_TYPE === "true";
  const model = process.env.DESKLATCH_WINDOWS_MODEL;
  if (model && model !== "glm-5.3-flash") throw new Error("unsupported_office_test_model");
  const metrics = {
    word: undefined,
    modal: undefined,
    noteLength: note.length,
    documentTypeSkipped: skipDocumentType,
    notePath,
    sourcePath,
    outputPath: `${runDirectory}\\word-corrected.docx`,
    correctionPath,
    correctionLength: correction.length,
    sourceSha256Before: sourceBefore.sha256,
    documentObserved: false,
    documentTyped: false,
    saveAsObserved: false,
    approvalRequired: false,
    approvalResolved: false,
    filenameObserved: false,
    modalObservation: "not_attempted",
    modalAct: "not_attempted",
    outputVerified: false,
    sourceVerified: false,
    outputSha256: undefined,
    sourceSha256: undefined,
    stopCode: undefined,
  };
  const driver = CuaDriver.create(undefined);
  try {
    const word = await discoverWord(driver);
    metrics.word = targetJson(word);
    // Host setup only: activate the explicitly enrolled scratch HWND before
    // DeskLatch measures its native focus/occlusion. All typing, menu clicks,
    // dialog edits, and saves below still go through DeskLatch sessions.
    await driver.callTool("bring_to_front", JSON.stringify({ pid: word.pid, window_id: word.hwnd.toString() }));
    const basePolicy = createRiskPolicy({
      hostRules: {
        requireApproval: ({ target }) => target.name === saveAsName
          ? { match: true, code: "save_as_disposable_requires_approval" }
          : false,
      },
    });
    const policy = async input => {
      // This is a bounded, non-consequential navigation command. All other
      // actions go through the normal local risk policy and may stop for
      // evidence; Save As itself remains an approval boundary.
      if (input.step.kind === "click" && (input.target.name === fileTabName || input.target.name === "\u7a7a\u767d\u6587\u6863")) {
        return { decision: "allow", code: "open_file_tab" };
      }
      return basePolicy(input);
    };
    backend = await createWindowsDesktopBackend({
      driver,
      authorization: {
        targets: [word],
        allowForegroundInput: true,
        allowDesktopCapture: true,
        background: { source: "cua-uia-0.54" },
      },
    });
    session = createDeskSession(backend, { allowModelImages: false, policy });

    let observation = await session.observe({ view: "controls" });
    let document = observation.controls.find(control => control.role === "Document" && control.actions.includes("type"));
    if (!document) {
      const fileTab = observation.controls.find(control => control.name === fileTabName);
      if (!fileTab?.ref) {
        metrics.stopCode = "document_and_file_tab_missing";
        return metrics;
      }
      const openedFile = await session.act({
        observationId: observation.observationId,
        steps: [{ kind: "click", target: { ref: fileTab.ref } }],
      });
      if (openedFile.status !== "completed") {
        metrics.stopCode = openedFile.code ?? "file_tab_not_dispatched";
        return metrics;
      }
      observation = await session.observe({ view: "controls" });
      const blank = observation.controls.find(control => control.role === "ListItem" && control.name === "\u7a7a\u767d\u6587\u6863");
      if (!blank?.ref) {
        metrics.stopCode = "blank_document_target_missing";
        return metrics;
      }
      const openedBlank = await session.act({
        observationId: observation.observationId,
        steps: [{ kind: "click", target: { ref: blank.ref } }],
      });
      if (openedBlank.status !== "completed") {
        metrics.stopCode = openedBlank.code ?? "blank_document_not_dispatched";
        return metrics;
      }
      observation = await session.observe({ view: "controls" });
      document = observation.controls.find(control => control.role === "Document" && control.actions.includes("type"));
    }
    metrics.documentObserved = document !== undefined;
    if (!document?.ref) {
      metrics.stopCode = "document_uia_target_missing";
      return metrics;
    }
    if (!skipDocumentType) {
      let typed;
      if (model) {
        const { chooseAndActWithGlm } = await import("./support/office-agent.mjs");
        const observation = await session.observe({ where: { role: "Document" } });
        const modelMetrics = {};
        metrics.nativeModel = modelMetrics;
        const selected = await chooseAndActWithGlm({
          session, observation, note, model, metrics: modelMetrics,
          objective: "Write the supplied visitor note into the body of this disposable Word document.",
          allowedKinds: ["type", "setValue"],
        });
        metrics.nativeModelChoice = selected.plan;
        typed = selected.result;
      } else {
        typed = await session.act({ steps: [{ kind: "type", target: { role: document.role, name: document.name }, text: note }] });
      }
      metrics.documentTyped = typed.status === "completed";
      if (!metrics.documentTyped) {
        metrics.stopCode = typed.code ?? "document_type_not_dispatched";
        return metrics;
      }
    }

    observation = await session.observe({ view: "controls" });
    const fileTab = observation.controls.find(control => control.name === fileTabName);
    if (!fileTab?.ref) {
      metrics.stopCode = "file_tab_missing";
      return metrics;
    }
    const openedFile = await session.act({
      observationId: observation.observationId,
      steps: [{ kind: "click", target: { ref: fileTab.ref } }],
    });
    if (openedFile.status !== "completed") {
      metrics.stopCode = openedFile.code ?? "file_tab_not_dispatched";
      return metrics;
    }

    observation = await session.observe({ view: "controls" });
    const saveAs = observation.controls.find(control => control.role === "ListItem" && control.name === saveAsName && control.actions.includes("click"));
    metrics.saveAsObserved = saveAs !== undefined;
    if (!saveAs?.ref) {
      metrics.stopCode = "save_as_target_missing";
      return metrics;
    }
    const pending = await session.act({
      observationId: observation.observationId,
      steps: [{ kind: "click", target: { ref: saveAs.ref } }],
    });
    metrics.approvalRequired = pending.code === "approval_required" && typeof pending.requestId === "string";
    if (!metrics.approvalRequired) {
      metrics.stopCode = pending.code ?? "save_as_approval_missing";
      return metrics;
    }
    const approved = await session.resolveApproval(pending.requestId, "approve");
    metrics.approvalResolved = approved.status === "completed";
    if (!metrics.approvalResolved) {
      metrics.stopCode = approved.code ?? "save_as_approval_stopped";
      return metrics;
    }

    // The native Save As dialog is an owned top-level window and may appear
    // after the Backstage command has been acknowledged. Discovery below is
    // deliberately restricted to this exact Word PID/HWND ownership chain.
    await new Promise(resolve => setTimeout(resolve, 500));

    const modalInspector = await loadWindowsOwnedDialogInspector();
    const discovered = modalInspector === undefined ? [] : await modalInspector.findOwnedDialogs(word);
    if (discovered.length === 0) {
      metrics.stopCode = "modal_exact_target_required";
      return metrics;
    }
    const modalHarness = await findOwnedSaveAs(driver, discovered);
    if (!modalHarness) {
      metrics.stopCode = "save_as_native_dialog_not_observed";
      return metrics;
    }
    const { target: modal } = modalHarness;
    let modalBackend = modalHarness.backend;
    let modalSession = modalHarness.session;
    metrics.modal = targetJson(modal);
    metrics.modalObservation = "completed";
    metrics.filenameObserved = true;
    try {
      const modalPolicy = async input => {
        if (input.step.kind === "setValue" && input.target.name === "\u6587\u4ef6\u540d") {
          return { decision: "allow", code: "set_disposable_filename" };
        }
        if (input.step.kind === "click" && input.target.name === "\u4fdd\u5b58") {
          return { decision: "approve", code: "save_corrected_requires_approval" };
        }
        return policy(input);
      };
      // Recreate the public session over the already enrolled exact modal
      // backend so the filename replacement and Save approval share one live
      // UIA binding; no host script writes the field.
      await modalSession.close();
      const modalTransport = new NativeUiAutomationWindowsTransport();
      const reopenedBackend = await createWindowsDesktopBackend({
        driver,
        transport: modalTransport,
        authorization: { targets: [modal], background: { source: "native-uia-v1" } },
      });
      const reopenedSession = createDeskSession(reopenedBackend, { allowModelImages: false, policy: modalPolicy });
      // The helper's temporary session is closed above; use the exact
      // re-enrolled public session for all writes and keep cleanup explicit.
      modalBackend = reopenedBackend;
      modalSession = reopenedSession;
      const modalObservation = await modalSession.observe({ view: "controls" });
      metrics.modalObservation = "completed";
      const modalFilename = modalObservation.controls.find(control => control.role === "Edit" && control.name === "\u6587\u4ef6\u540d");
      if (!modalFilename?.ref) {
        metrics.stopCode = "modal_filename_target_missing";
        return metrics;
      }
      const filenameResult = await modalSession.act({
        observationId: modalObservation.observationId,
        steps: [{
          kind: "setValue",
          target: { ref: modalFilename.ref },
          value: `${runDirectory}\\word-corrected.docx`,
          expect: { target: { role: "Edit", name: "\u6587\u4ef6\u540d" }, valueEquals: `${runDirectory}\\word-corrected.docx` },
        }],
      });
      if (filenameResult.status !== "completed") {
        metrics.modalAct = filenameResult.status;
        metrics.stopCode = filenameResult.code ?? "modal_filename_not_dispatched";
        return metrics;
      }
      const refreshed = await modalSession.observe({ view: "controls" });
      const save = refreshed.controls.find(control => control.role === "Button" && control.name === "\u4fdd\u5b58");
      if (!save?.ref) {
        metrics.stopCode = "modal_save_button_missing";
        return metrics;
      }
      const pendingSave = await modalSession.act({
        observationId: refreshed.observationId,
        steps: [{ kind: "click", target: { ref: save.ref } }],
      });
      if (pendingSave.code !== "approval_required" || !pendingSave.requestId) {
        metrics.stopCode = pendingSave.code ?? "corrected_save_approval_missing";
        return metrics;
      }
      const saved = await modalSession.resolveApproval(pendingSave.requestId, "approve");
      metrics.modalAct = saved.status;
      metrics.stopCode = saved.status === "completed" ? "corrected_save_dispatched" : saved.code ?? "corrected_save_stopped";
      if (saved.status !== "completed") return metrics;
      await new Promise(resolve => setTimeout(resolve, 1_200));
      const sourceOracle = await readWordFile(sourcePath);
      const outputOracle = await readWordFile(metrics.outputPath);
      const sourceText = sourceOracle.paragraphs.join("\n");
      const outputText = outputOracle.paragraphs.join("\n");
      if (!sourceText.includes(note) || (correction && sourceText.includes(correction))) {
        metrics.stopCode = "source_preservation_failed";
        return metrics;
      }
      if (!outputText.includes(note)) {
        metrics.stopCode = "corrected_output_note_missing";
        return metrics;
      }
      if (correction && !outputText.includes(correction)) {
        metrics.stopCode = "corrected_output_correction_missing";
        return metrics;
      }
      if (sourceOracle.sha256 !== metrics.sourceSha256Before) {
        metrics.stopCode = "source_hash_changed";
        return metrics;
      }
      metrics.sourceVerified = true;
      metrics.outputVerified = true;
      metrics.sourceSha256 = sourceOracle.sha256;
      metrics.outputSha256 = outputOracle.sha256;
      metrics.stopCode = "corrected_output_verified";
    } catch (error) {
      metrics.modalObservation = `refused:${error?.code ?? error?.message ?? "unknown"}`;
      metrics.stopCode = "modal_cua_target_rejected";
    } finally {
      await modalSession?.close().catch(() => undefined);
      await modalBackend?.close().catch(() => undefined);
    }
    return metrics;
  } finally {
    await session?.close().catch(() => undefined);
    await backend?.close().catch(() => undefined);
    await driver.shutdown().catch(() => undefined);
    driver.uniffiDestroy?.();
  }
}

try {
  const result = await run();
  console.log(JSON.stringify({ event: "windows-office-acceptance", ...result }));
  if (result.outputVerified !== true) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ event: "windows-office-acceptance", ok: false, error: String(error?.message ?? error) }));
  process.exitCode = 1;
}
