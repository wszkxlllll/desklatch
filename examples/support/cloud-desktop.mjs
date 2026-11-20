import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const SAFE_WINDOW_ID = /^(?:0x[0-9a-f]+|[0-9]+)$/iu;

/** Credentials are injected by the local launcher; shipped examples never read sibling .env files. */
export function loadCloudCredentials() {
  if (!process.env.E2B_API_KEY || !process.env.ZHIPU_API_KEY) throw Error("cloud_credentials_missing");
  return { loaded: ["E2B_API_KEY", "ZHIPU_API_KEY"], source: "process-environment" };
}

function normalizeWindowId(value) {
  if (typeof value !== "string" || !SAFE_WINDOW_ID.test(value)) return undefined;
  if (value.toLocaleLowerCase().startsWith("0x")) return BigInt(value).toString(10);
  return value.replace(/^0+(?=\d)/u, "");
}

async function readWindowPid(desktop, windowId) {
  if (!desktop.commands?.run) throw Error("cloud_window_pid_unavailable");
  const result = await desktop.commands.run(`xprop -id ${windowId} _NET_WM_PID`, { timeoutMs: 10_000, requestTimeoutMs: 40_000 });
  const match = /_NET_WM_PID[^=]*=\s*(\d+)/u.exec(result.stdout ?? "");
  if (!match) throw Error("cloud_window_pid_unavailable");
  const processId = Number(match[1]);
  if (!Number.isSafeInteger(processId) || processId <= 0) throw Error("cloud_window_pid_invalid");
  return processId;
}

export async function activeTopLevelWindowId(desktop) {
  if (!desktop.commands?.run) return desktop.getCurrentWindowId ? normalizeWindowId(await desktop.getCurrentWindowId()) : undefined;
  const result = await desktop.commands.run("xprop -root _NET_ACTIVE_WINDOW", { timeoutMs: 10_000, requestTimeoutMs: 40_000 });
  const match = /(?:window id #\s*)?(0x[0-9a-f]+|\d+)/iu.exec(result.stdout ?? "");
  const id = normalizeWindowId(match?.[1]);
  if (!id) throw Error("cloud_active_window_unavailable");
  return id;
}

/** Discover exactly one visible window for a host-owned application class. */
export async function discoverUniqueWindow(desktop, { application, title, titlePattern } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/u.test(application ?? "")) throw Error("cloud_application_invalid");
  const ids = await desktop.getApplicationWindows(application);
  const found = [];
  for (const rawId of ids) {
    const windowId = normalizeWindowId(rawId);
    if (!windowId) continue;
    const windowTitle = await desktop.getWindowTitle(windowId);
    if (title !== undefined && windowTitle !== title) continue;
    if (titlePattern && !titlePattern.test(windowTitle)) continue;
    found.push({ windowId, application, processId: await readWindowPid(desktop, windowId), title: windowTitle });
  }
  if (found.length !== 1) throw Error(`cloud_window_not_unique:${application}:${found.length}`);
  return Object.freeze(found[0]);
}

/** Host-only refresh for editor windows, including a newly-opened Save As dialog. */
export async function discoverEditorWindows(desktop, { application, titlePattern } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/u.test(application ?? "")) throw Error("cloud_application_invalid");
  const ids = await desktop.getApplicationWindows(application);
  const found = [];
  for (const rawId of ids) {
    const windowId = normalizeWindowId(rawId);
    if (!windowId) continue;
    const title = await desktop.getWindowTitle(windowId);
    if (titlePattern && !titlePattern.test(title)) continue;
    found.push(Object.freeze({ windowId, application, processId: await readWindowPid(desktop, windowId), title }));
  }
  if (found.length === 0) throw Error(`cloud_editor_window_missing:${application}`);
  return Object.freeze(found);
}

/** Use only a fixed activation command assembled from an exact numeric X11 id. */
export async function activateCloudWindow(desktop, grant) {
  const windowId = typeof grant === "string" ? grant : grant?.windowId;
  const expectedProcessId = typeof grant === "object" ? grant?.processId : undefined;
  const normalized = normalizeWindowId(windowId);
  if (!normalized) throw Error("cloud_window_id_invalid");
  const before = await activeTopLevelWindowId(desktop);
  if (before === normalized) {
    const processId = await readWindowPid(desktop, normalized);
    if (expectedProcessId !== undefined && processId !== expectedProcessId) throw Error("cloud_window_process_changed");
    return { status: "already_active", windowId: normalized, processId, expectedProcessId, changed: false };
  }
  if (typeof desktop.activateWindow === "function") await desktop.activateWindow(normalized);
  else if (desktop.commands?.run) {
    const result = await desktop.commands.run(`xdotool windowactivate --sync ${normalized}`, { timeoutMs: 10_000, requestTimeoutMs: 40_000 });
    if (typeof result.exitCode === "number" && result.exitCode !== 0) throw Error("cloud_window_activation_failed");
  } else throw Error("cloud_window_activation_unavailable");
  const after = await activeTopLevelWindowId(desktop);
  if (after !== normalized) throw Error("cloud_window_activation_unconfirmed");
  const processId = await readWindowPid(desktop, normalized);
  if (expectedProcessId !== undefined && processId !== expectedProcessId) throw Error("cloud_window_process_changed");
  return { status: "activated", windowId: normalized, fromWindowId: before, processId, expectedProcessId, changed: true };
}

export async function verifyCloudWindow(desktop, grant) {
  const current = await activeTopLevelWindowId(desktop);
  if (current !== grant.windowId) return false;
  return await readWindowPid(desktop, current) === grant.processId;
}

export async function createCloudDirectory(desktop, path) {
  if (!/^\/tmp\/desklatch-cloud-[A-Za-z0-9-]{1,64}$/u.test(path)) throw Error("cloud_output_directory_invalid");
  if (!desktop.commands?.run) throw Error("cloud_directory_command_unavailable");
  const result = await desktop.commands.run(`mkdir -p -- '${path}'`, { timeoutMs: 10_000, requestTimeoutMs: 40_000 });
  if (typeof result.exitCode === "number" && result.exitCode !== 0) throw Error("cloud_output_directory_failed");
}

/** Only an empty starting document is produced in setup; the GUI writes all task text. */
export async function createBlankOdt(desktop, path) {
  if (!/^\/tmp\/desklatch-cloud-[A-Za-z0-9-]{1,64}\/museum-visit-note\.odt$/u.test(path)) throw Error("cloud_blank_odt_path_invalid");
  const folder = path.slice(0, path.lastIndexOf("/"));
  const blankText = path.replace(/\.odt$/u, ".txt");
  if (desktop.files.exists && await desktop.files.exists(path)) throw Error("cloud_input_already_exists");
  await desktop.files.write(blankText, "");
  const exportResult = await desktop.commands.run(
    `/usr/bin/soffice -env:UserInstallation=file://${folder}/empty-profile --headless --convert-to odt:writer8 --outdir ${folder} ${blankText}`,
    { user: "user", timeoutMs: 30_000, requestTimeoutMs: 35_000 },
  );
  if (exportResult.exitCode !== 0) throw Error("cloud_blank_odt_export_failed");
  const bytes = await readCloudFileBytes(desktop, path);
  if ((await readOfficeText(bytes, "odt")).trim()) throw Error("cloud_input_document_not_blank");
  return { bytes: bytes.byteLength, sha256: sha256(bytes), generator: "LibreOffice Writer" };
}

/** Start real Writer with a fresh profile. Suppress its one-time tutorial, before any task input. */
export async function openBlankWriter(desktop, path) {
  if (!/^\/tmp\/desklatch-cloud-[A-Za-z0-9-]{1,64}\/museum-visit-note\.odt$/u.test(path)) throw Error("cloud_blank_odt_path_invalid");
  const profile = `${dirname(path)}/writer-profile`;
  await desktop.files.makeDir(`${profile}/user`);
  const preferences = '<oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop></item></oor:items>';
  await desktop.files.write(`${profile}/user/registrymodifications.xcu`, preferences);
  await desktop.commands.run(`/usr/bin/soffice -env:UserInstallation=file://${profile} --norestore --nofirststartwizard --writer ${path}`,
    { user: "user", background: true, timeoutMs: 540_000, requestTimeoutMs: 20_000 });
}

export async function readCloudFileBytes(desktop, path, { maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!desktop.files?.read) throw Error("cloud_file_reader_unavailable");
  const value = await desktop.files.read(path, { format: "bytes" });
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw Error("cloud_file_size_invalid");
  return bytes;
}

function findEndOfCentralDirectory(bytes) {
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) return index;
  }
  return -1;
}

/** Read the text payload from a DOCX/ODT ZIP without asking the model for file access. */
export async function readOfficeText(bytes, format) {
  if (format === "txt") return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw Error("cloud_office_zip_missing");
  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const wanted = format === "odt" ? "content.xml" : "word/document.xml";
  let cursor = centralOffset;
  let target;
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw Error("cloud_office_zip_entry_invalid");
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    if (name === wanted) {
      if (target || uncompressedSize > 8 * 1024 * 1024) throw Error("cloud_office_text_entry_invalid");
      target = { method, compressedSize, uncompressedSize, localOffset };
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (!target) throw Error("cloud_office_text_entry_missing");
  if (view.getUint32(target.localOffset, true) !== 0x04034b50) throw Error("cloud_office_local_entry_invalid");
  const localNameLength = view.getUint16(target.localOffset + 26, true);
  const localExtraLength = view.getUint16(target.localOffset + 28, true);
  const start = target.localOffset + 30 + localNameLength + localExtraLength;
  if (start + target.compressedSize > bytes.byteLength) throw Error("cloud_office_text_entry_invalid");
  const compressed = bytes.subarray(start, start + target.compressedSize);
  const raw = target.method === 0 ? compressed : target.method === 8 ? inflateRawSync(compressed, { maxOutputLength: 8 * 1024 * 1024 }) : undefined;
  if (!raw) throw Error("cloud_office_compression_unsupported");
  if (raw.byteLength !== target.uncompressedSize) throw Error("cloud_office_text_entry_invalid");
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  return xml.replace(/<[^>]+>/gu, " ").replace(/&(?:lt|gt|amp|quot|apos);/gu, value => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": "\"", "&apos;": "'" }[value] ?? value)).replace(/\s+/gu, " ").trim();
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function cloudOutputPath(runId, format) {
  if (!SAFE_ID.test(runId)) throw Error("cloud_run_id_invalid");
  if (!["docx", "odt", "txt"].includes(format)) throw Error("cloud_format_invalid");
  return `/tmp/desklatch-cloud-${runId}/museum-visit-note.${format}`;
}

export function cloudOutputDirectory(path) {
  return dirname(path);
}

export function cloudResultPath(runId) {
  if (!SAFE_ID.test(runId)) throw Error("cloud_run_id_invalid");
  return resolve(process.env.DESKLATCH_RESULTS_DIR ?? "artifacts", `cloud-${runId}`, "run.json");
}
