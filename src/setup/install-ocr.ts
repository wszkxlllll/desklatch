import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import type { OptionalOcrSetupOptions } from "./optional.js";

const RAPIDOCR_VERSION = "3.10.0" as const;
const ONNXRUNTIME_VERSION = "1.23.2" as const;
const PIP_INSTALL_TIMEOUT_MS = 300_000;
const PYTHON_COMMAND_TIMEOUT_MS = 30_000;
const ASSET_DOWNLOAD_TIMEOUT_MS = 120_000;
const PYTHON_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_ASSET_BYTES = 128 * 1024 * 1024;

const OCR_ASSETS = [
  {
    name: "detector",
    fileName: "ch_PP-OCRv5_det_mobile.onnx",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx",
    sha256: "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae",
  },
  {
    name: "recognizer",
    fileName: "ch_PP-OCRv5_rec_mobile.onnx",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx",
    sha256: "5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5",
  },
  {
    name: "dictionary",
    fileName: "ppocrv5_dict.txt",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile/ppocrv5_dict.txt",
    sha256: "d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b",
  },
] as const;

export type OcrSetupInstallErrorCode =
  | "INVALID_ROOT"
  | "PYTHON_UNAVAILABLE"
  | "PYTHON_COMMAND_FAILED"
  | "PIP_INSTALL_FAILED"
  | "ASSET_DOWNLOAD_FAILED"
  | "ASSET_CHECKSUM_MISMATCH"
  | "MANIFEST_WRITE_FAILED";

export class OcrSetupInstallError extends Error {
  public readonly code: OcrSetupInstallErrorCode;

  public constructor(code: OcrSetupInstallErrorCode, message: string) {
    super(message);
    this.name = "OcrSetupInstallError";
    this.code = code;
  }
}

export interface InstallOcrSetupOptions {
  /** Consumer/project directory that receives .desklatch/ocr. */
  readonly rootDirectory?: string;
  /** Existing base Python executable or launcher. It is never installed globally. */
  readonly pythonExecutable?: string;
}

interface PythonCommand {
  readonly executable: string;
  readonly prefixArguments: readonly string[];
}

interface ProcessResult {
  readonly code: number | null;
  readonly error?: NodeJS.ErrnoException;
}

/**
 * Install an explicitly requested local OCR environment under
 * `<root>/.desklatch/ocr`. The helper only uses the selected Python to create
 * a project-local venv, installs pinned CPU packages into that venv, and
 * downloads/verifies the official PP-OCRv5 mobile assets into the same local
 * directory. It never runs a global pip install.
 */
export async function installOcrSetup(
  options: InstallOcrSetupOptions = {},
): Promise<OptionalOcrSetupOptions> {
  const rootDirectory = normalizeRootDirectory(options.rootDirectory);
  const ocrDirectory = join(rootDirectory, ".desklatch", "ocr");
  const modelDirectory = join(ocrDirectory, "models");
  const venvDirectory = join(ocrDirectory, ".venv");
  const pipCacheDirectory = join(ocrDirectory, ".pip-cache");
  await ensureDirectory(modelDirectory);
  await ensureDirectory(pipCacheDirectory);

  const basePython = options.pythonExecutable === undefined
    ? await discoverPython(rootDirectory)
    : explicitPython(options.pythonExecutable);
  const venvPython = venvPythonPath(venvDirectory);
  if (!(await isRunnable(venvPython, rootDirectory))) {
    await runPython(basePython, ["-m", "venv", venvDirectory], rootDirectory, "PYTHON_COMMAND_FAILED", PYTHON_COMMAND_TIMEOUT_MS);
  }
  if (!(await isRunnable(venvPython, rootDirectory))) {
    throw new OcrSetupInstallError("PYTHON_COMMAND_FAILED", "The local OCR Python virtual environment could not be started");
  }

  await runPython(venvPythonCommand(venvPython), [
    "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--cache-dir", pipCacheDirectory, "--retries", "4", "--timeout", "30",
    `rapidocr==${RAPIDOCR_VERSION}`,
    `onnxruntime==${ONNXRUNTIME_VERSION}`,
  ], rootDirectory, "PIP_INSTALL_FAILED", PIP_INSTALL_TIMEOUT_MS);
  await runPython(venvPythonCommand(venvPython), [
    "-c", "import rapidocr, onnxruntime",
  ], rootDirectory, "PIP_INSTALL_FAILED", PYTHON_COMMAND_TIMEOUT_MS);

  const [detectorModelPath, recognizerModelPath, dictionaryPath] = await Promise.all(
    OCR_ASSETS.map(async asset => {
      const target = join(modelDirectory, asset.fileName);
      await ensureVerifiedAsset(target, asset.url, asset.sha256);
      return target;
    }),
  );
  const setup: OptionalOcrSetupOptions = {
    pythonExecutable: venvPython,
    detectorModelPath,
    recognizerModelPath,
    dictionaryPath,
  };
  await writeManifest(join(ocrDirectory, "ocr.json"), setup);
  return setup;
}

function normalizeRootDirectory(value: string | undefined): string {
  if (value === undefined) return resolvePath(process.cwd());
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new OcrSetupInstallError("INVALID_ROOT", "rootDirectory must be a non-empty local directory path");
  }
  return resolvePath(value);
}

function explicitPython(value: string): PythonCommand {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new OcrSetupInstallError("PYTHON_UNAVAILABLE", "pythonExecutable must be a local executable or launcher");
  }
  return { executable: value, prefixArguments: [] };
}

async function discoverPython(cwd: string): Promise<PythonCommand> {
  const candidates: readonly PythonCommand[] = process.platform === "win32"
    ? [{ executable: "py", prefixArguments: ["-3"] }, { executable: "python", prefixArguments: [] }]
    : [{ executable: "python3", prefixArguments: [] }, { executable: "python", prefixArguments: [] }];
  for (const candidate of candidates) {
    const result = await runProcess(candidate.executable, [...candidate.prefixArguments, "--version"], cwd, PYTHON_DISCOVERY_TIMEOUT_MS);
    if (result.code === 0) return candidate;
  }
  throw new OcrSetupInstallError("PYTHON_UNAVAILABLE", "No usable Python 3 executable was found; pass --python explicitly");
}

function venvPythonPath(venvDirectory: string): string {
  return process.platform === "win32"
    ? join(venvDirectory, "Scripts", "python.exe")
    : join(venvDirectory, "bin", "python");
}

function venvPythonCommand(executable: string): PythonCommand {
  return { executable, prefixArguments: [] };
}

async function isRunnable(command: string, cwd: string): Promise<boolean> {
  const result = await runProcess(command, ["--version"], cwd, PYTHON_DISCOVERY_TIMEOUT_MS);
  return result.code === 0;
}

async function runPython(
  command: PythonCommand,
  arguments_: readonly string[],
  cwd: string,
  errorCode: "PYTHON_COMMAND_FAILED" | "PIP_INSTALL_FAILED",
  timeoutMs: number,
): Promise<void> {
  const result = await runProcess(command.executable, [...command.prefixArguments, ...arguments_], cwd, timeoutMs);
  if (result.code !== 0) {
    throw new OcrSetupInstallError(errorCode, errorCode === "PIP_INSTALL_FAILED"
      ? "The local OCR venv could not install or import its pinned CPU dependencies"
      : "The selected Python executable could not create the local OCR venv");
  }
}

function runProcess(command: string, arguments_: readonly string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, arguments_, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, error: error as NodeJS.ErrnoException });
      return;
    }
    let settled = false;
    let forceFinishTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceFinishTimer !== undefined) clearTimeout(forceFinishTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      // Wait briefly for the child to release its venv files before reporting
      // the timeout. This keeps callers from racing their own cleanup with a
      // still-running pip process on Windows.
      forceFinishTimer = setTimeout(() => finish({ code: null }), 5_000);
    }, timeoutMs);
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", () => undefined);
    child.on("error", error => finish({ code: null, error: error as NodeJS.ErrnoException }));
    child.on("close", code => finish({ code }));
  });
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true });
    const info = await stat(directory);
    if (!info.isDirectory()) throw new Error("not_directory");
  } catch {
    throw new OcrSetupInstallError("INVALID_ROOT", "The local OCR directory could not be created");
  }
}

async function ensureVerifiedAsset(target: string, url: string, expectedSha256: string): Promise<void> {
  if (await matchesSha256(target, expectedSha256)) return;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS) });
  } catch {
    throw new OcrSetupInstallError("ASSET_DOWNLOAD_FAILED", "The official OCR asset could not be downloaded");
  }
  if (!response.ok) throw new OcrSetupInstallError("ASSET_DOWNLOAD_FAILED", "The official OCR asset could not be downloaded");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_ASSET_BYTES) {
    throw new OcrSetupInstallError("ASSET_DOWNLOAD_FAILED", "The official OCR asset exceeded the local size bound");
  }
  let bytes: Uint8Array;
  try {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_ASSET_BYTES) throw new Error("asset_too_large");
    bytes = new Uint8Array(buffer);
  } catch {
    throw new OcrSetupInstallError("ASSET_DOWNLOAD_FAILED", "The official OCR asset could not be read");
  }
  if (sha256(bytes) !== expectedSha256) {
    throw new OcrSetupInstallError("ASSET_CHECKSUM_MISMATCH", "The official OCR asset failed its pinned SHA-256 check");
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    if (!await matchesSha256(temporary, expectedSha256)) throw new Error("temporary_checksum_mismatch");
    await replaceOwnedFile(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (error instanceof OcrSetupInstallError) throw error;
    throw new OcrSetupInstallError("ASSET_DOWNLOAD_FAILED", "The verified OCR asset could not be stored locally");
  }
}

async function matchesSha256(path: string, expectedSha256: string): Promise<boolean> {
  try {
    const bytes = await readFile(path);
    return sha256(bytes) === expectedSha256;
  } catch {
    return false;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function replaceOwnedFile(temporary: string, target: string): Promise<void> {
  try {
    await rename(temporary, target);
    return;
  } catch {
    // Windows does not replace an existing file with rename. The target is
    // always inside this helper's own .desklatch/ocr directory.
    await unlink(target).catch(() => undefined);
    await rename(temporary, target);
  }
}

async function writeManifest(path: string, setup: OptionalOcrSetupOptions): Promise<void> {
  const encoded = `${JSON.stringify(setup, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, encoded, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const readBack = await readFile(temporary, "utf8");
    if (readBack !== encoded || readBack.includes("\uFFFD") || /\?{3,}/u.test(readBack)) throw new Error("manifest_utf8_corrupt");
    await replaceOwnedFile(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (error instanceof OcrSetupInstallError) throw error;
    throw new OcrSetupInstallError("MANIFEST_WRITE_FAILED", "The local OCR configuration manifest could not be written safely");
  }
}

export { OCR_ASSETS, ONNXRUNTIME_VERSION, RAPIDOCR_VERSION };
