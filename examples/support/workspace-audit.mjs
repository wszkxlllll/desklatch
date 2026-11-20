// Acceptance evidence only. This reader does not invoke tools, run an agent,
// or use the agent's final success statement.
import { setTimeout as delay } from "node:timers/promises";
import { checkEastVisitHours } from "./museum-visit-oracle.mjs";

export function auditWorkspaceDelivery(events, { browser = "browser", editors = ["editor"], outputPath } = {}) {
  const calls = new Map();
  const observedNames = new Map();
  const sources = new Set();
  const navigations = [];
  const switches = [];
  const writes = [];
  const saves = [];
  for (const event of events) {
    if (event.type === "tool.call") {
      calls.set(event.toolCallId, event);
      continue;
    }
    if (event.type !== "tool.result") continue;
    const call = calls.get(event.toolCallId);
    if (!call || call.name !== event.name) continue;
    const args = call.normalizedArguments ?? call.arguments;
    if (event.name === "observe") {
      const frame = event.observation;
      if (frame?.applicationId === browser && frame.document?.sourceUrl && frame.document.chunks?.some(chunk => chunk.text?.trim())) {
        sources.add(frame.document.sourceUrl);
      }
      for (const control of frame?.controls ?? []) {
        if (control.ref && control.name) observedNames.set(control.ref, control.name);
      }
      continue;
    }
    const receipt = event.receipt;
    if (event.name !== "act" || !receipt || !args) continue;
    const app = receipt.applicationId;
    if (args.navigate && app === browser && receipt.status === "completed") {
      navigations.push({ seq: event.seq, requested: args.navigate, arrived: receipt.finalUrl ?? receipt.sourceUrl });
    }
    if (args.activate && app === args.activate && receipt.status === "completed" && receipt.code === "activated") {
      switches.push({ seq: event.seq, app });
    }
    if (!editors.includes(app) || !Array.isArray(args.steps)) continue;
    for (const delivered of receipt.steps ?? []) {
      if (delivered.status !== "verified" && delivered.status !== "dispatched") continue;
      const step = args.steps[delivered.index - 1];
      if (!step || step.kind !== delivered.kind) continue;
      const name = step.target?.name ?? observedNames.get(step.target?.ref) ?? "";
      const value = step.kind === "type" ? step.text : step.kind === "setValue" ? step.value : undefined;
      if (typeof value === "string" && value.length && value !== outputPath && !/^(?:file ?name\b|文件名)/iu.test(name)) {
        writes.push({ seq: event.seq, app, index: delivered.index, characters: value.length, status: delivered.status });
      }
      const chord = (step.keys ?? []).map(key => key.toLowerCase().replace(/^control$/u, "ctrl")).join("+");
      if ((step.kind === "hotkey" && chord === "ctrl+s") ||
          (step.kind === "click" && /^(?:save|保存)(?:\s*[（(].*[）)])?$/iu.test(name.replaceAll("&", "").trim()))) {
        saves.push({ seq: event.seq, app, index: delivered.index, status: delivered.status });
      }
    }
  }
  const navigation = navigations.at(0);
  const switchToEditor = navigation && switches.find(item => editors.includes(item.app) && item.seq > navigation.seq);
  const edit = switchToEditor && writes.find(item => item.seq > switchToEditor.seq);
  const savedAfterEdit = edit && saves.some(item => item.seq > edit.seq || (item.seq === edit.seq && item.index > edit.index));
  return { observedUrls: [...sources], navigations, switches, writes, saves, modelOperatedAcrossApps: Boolean(savedAfterEdit) };
}

/** Read only the enrolled deliverable after a model-issued Save. Some native editors flush asynchronously. */
export async function verifySavedVisitNote(events, { editors = ["editor"], outputPath, baselineSha, readSaved, signal } = {}) {
  const current = events.at(-1);
  if (!baselineSha || current?.type !== "tool.result" || current.name !== "act") return;
  const audit = auditWorkspaceDelivery(events, { editors, outputPath });
  if (!audit.modelOperatedAcrossApps || audit.saves.at(-1)?.seq !== current.seq) return;
  const write = audit.writes.at(-1);
  const save = audit.saves.at(-1);
  if (write.seq > save.seq || (write.seq === save.seq && write.index >= save.index)) return;
  const result = events.find(event => event.seq === write.seq);
  const call = events.find(event => event.type === "tool.call" && event.toolCallId === result?.toolCallId);
  const step = (call?.normalizedArguments ?? call?.arguments)?.steps?.[write.index - 1];
  const intended = step?.kind === "type" ? step.text : step?.value;
  if (typeof intended !== "string" || !intended.trim()) return;
  const comparable = text => text.normalize("NFC").replace(/\s+/gu, "");
  const expected = comparable(intended);
  const until = Date.now() + 5_000;
  do {
    if (signal?.aborted) return;
    const saved = await readSaved();
    if (saved?.sha256 && saved.sha256.toLowerCase() !== baselineSha.toLowerCase() && typeof saved.text === "string" && comparable(saved.text) === expected) {
      const facts = checkEastVisitHours(saved.text, { observedUrls: audit.observedUrls });
      if (facts.passed) return { sha256: saved.sha256, textMatchedModelInput: true, ...facts };
    }
    if (Date.now() < until) await delay(250, undefined, { signal });
  } while (Date.now() < until);
}
