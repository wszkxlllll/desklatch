import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rect } from "../contracts.js";
import type { LocalOcrRequest, TextRiskOcrLine } from "../policy.js";
import type { RapidOcrV5MobileRunner } from "./ocr.js";

/** The worker is shipped as an asset and is never selected from user input. */
export const RAPIDOCR_WORKER_FILENAME = "rapidocr_worker.py";

export type RapidOcrErrorCode =
  | "RAPIDOCR_UNAVAILABLE"
  | "PYTHON_UNAVAILABLE"
  | "WORKER_UNAVAILABLE"
  | "MODEL_NOT_FOUND"
  | "INVALID_MODEL_PATH"
  | "INVALID_IMAGE"
  | "INVALID_REGION"
  | "TIMEOUT"
  | "ABORTED"
  | "WORKER_PROTOCOL_ERROR"
  | "WORKER_FAILED"
  | "MODEL_LOAD_FAILED"
  | "INFERENCE_FAILED";

export class RapidOcrError extends Error {
  public readonly code: RapidOcrErrorCode;

  public constructor(code: RapidOcrErrorCode, message: string) {
    super(message);
    this.name = "RapidOcrError";
    this.code = code;
  }
}

export interface RapidOcrLocalImage {
  mimeType: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface RapidOcrCpuRunnerOptions {
  /** A host-supplied Python executable, passed as one spawn argument (no shell). */
  pythonExecutable: string;
  /** Existing local PP-OCRv5 mobile ONNX files. They are checked lazily. */
  detectorModelPath: string;
  recognizerModelPath: string;
  dictionaryPath: string;
  /** Optional PP-OCRv5 text-line orientation model. Classification is off when omitted. */
  classifierModelPath?: string;
  timeoutMs?: number;
  maxImageBytes?: number;
}

export type RapidOcrStatusCode =
  | "ready"
  | "RAPIDOCR_UNAVAILABLE"
  | "PYTHON_UNAVAILABLE"
  | "WORKER_UNAVAILABLE"
  | "MODEL_NOT_FOUND"
  | "INVALID_MODEL_PATH"
  | "TIMEOUT"
  | "ABORTED"
  | "MODEL_LOAD_FAILED"
  | "WORKER_FAILED";

export interface RapidOcrStatus {
  available: boolean;
  code: RapidOcrStatusCode;
  model: "PP-OCRv5-mobile";
}

export interface RapidOcrCpuRunner extends RapidOcrV5MobileRunner {
  /** Checks the local executable, asset, model files, and RapidOCR API lazily. */
  check(signal?: AbortSignal): Promise<RapidOcrStatus>;
}

interface WorkerConfig {
  detectorModelPath: string;
  recognizerModelPath: string;
  dictionaryPath: string;
  classifierModelPath?: string;
}

interface WorkerImage {
  mimeType: string;
  width: number;
  height: number;
  region: Rect;
  dataBase64: string;
}

interface WorkerRequest {
  op: "probe" | "recognize";
  config: WorkerConfig;
  image?: WorkerImage;
}

interface WorkerSuccess {
  ok: true;
  status?: "ready";
  lines?: readonly TextRiskOcrLine[];
}

interface WorkerFailure {
  ok: false;
  error: { code: string };
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_WORKER_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * Spawn the bundled worker only when a caller requests OCR. The worker reads
 * image bytes from stdin, never argv; stdout is a single machine-readable
 * response and stderr is drained without retaining or forwarding it.
 */
export function createRapidOcrCpuRunner(options: RapidOcrCpuRunnerOptions): RapidOcrCpuRunner {
  const config = validateOptions(options);
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxImageBytes = boundedInteger(options.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES, 64 * 1024 * 1024);
  const workerPath = fileURLToPath(new URL(`./${RAPIDOCR_WORKER_FILENAME}`, import.meta.url));
  let assetPromise: Promise<void> | undefined;

  const ensureAssets = async (): Promise<void> => {
    assetPromise ??= (async () => {
      await assertFile(workerPath, "WORKER_UNAVAILABLE");
      await assertFile(config.detectorModelPath, "MODEL_NOT_FOUND");
      await assertFile(config.recognizerModelPath, "MODEL_NOT_FOUND");
      await assertFile(config.dictionaryPath, "MODEL_NOT_FOUND");
      if (config.classifierModelPath !== undefined) await assertFile(config.classifierModelPath, "MODEL_NOT_FOUND");
    })();
    try {
      await assetPromise;
    } catch (error) {
      assetPromise = undefined;
      throw error;
    }
  };

  const run = async (request: WorkerRequest, signal?: AbortSignal): Promise<WorkerResponse> => {
    await ensureAssets();
    return runWorker(options.pythonExecutable, workerPath, request, timeoutMs, signal);
  };

  return {
    async check(signal?: AbortSignal): Promise<RapidOcrStatus> {
      try {
        const response = await run({ op: "probe", config }, signal);
        if (!response.ok) throw workerError(response);
        return { available: true, code: "ready", model: "PP-OCRv5-mobile" };
      } catch (error) {
        const code = error instanceof RapidOcrError ? toStatusCode(error.code) : "WORKER_FAILED";
        return { available: false, code, model: "PP-OCRv5-mobile" };
      }
    },

    async recognize(request: LocalOcrRequest): Promise<readonly TextRiskOcrLine[]> {
      const image = normalizeImage(request.image, maxImageBytes);
      validateRegion(request.region, image.width, image.height);
      const response = await run({
        op: "recognize",
        config,
        image: {
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          region: request.region,
          dataBase64: Buffer.from(image.bytes).toString("base64"),
        },
      }, request.signal);
      if (!response.ok) throw workerError(response);
      if (!Array.isArray(response.lines)) throw new RapidOcrError("WORKER_PROTOCOL_ERROR", "RapidOCR worker returned no text lines");
      return response.lines;
    },
  };
}

function validateOptions(options: RapidOcrCpuRunnerOptions): WorkerConfig {
  if (options === undefined || options === null || typeof options !== "object") throw new RapidOcrError("INVALID_MODEL_PATH", "RapidOCR options are required");
  assertExecutable(options.pythonExecutable);
  assertModelPath(options.detectorModelPath, "detectorModelPath", [".onnx"]);
  assertModelPath(options.recognizerModelPath, "recognizerModelPath", [".onnx"]);
  assertModelPath(options.dictionaryPath, "dictionaryPath", [".txt", ".dict", ".json"]);
  if (options.classifierModelPath !== undefined) assertModelPath(options.classifierModelPath, "classifierModelPath", [".onnx"]);
  return {
    detectorModelPath: options.detectorModelPath,
    recognizerModelPath: options.recognizerModelPath,
    dictionaryPath: options.dictionaryPath,
    ...(options.classifierModelPath === undefined ? {} : { classifierModelPath: options.classifierModelPath }),
  };
}

function assertExecutable(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) throw new RapidOcrError("INVALID_MODEL_PATH", "pythonExecutable is invalid");
}

function assertModelPath(value: string, field: string, extensions: readonly string[]): void {
  if (typeof value !== "string" || value.trim().length === 0 || !isAbsolute(value) || /^(?:\\\\|\/\/)/u.test(value) || /[\u0000\r\n]/u.test(value) || /^(?:https?|ftp|file):\/\//iu.test(value)) {
    throw new RapidOcrError("INVALID_MODEL_PATH", `${field} must be an absolute local model path`);
  }
  const lower = value.toLocaleLowerCase();
  if (!extensions.some((extension) => lower.endsWith(extension))) throw new RapidOcrError("INVALID_MODEL_PATH", `${field} has an unsupported model extension`);
}

async function assertFile(value: string, missingCode: "MODEL_NOT_FOUND" | "WORKER_UNAVAILABLE"): Promise<void> {
  try {
    const info = await stat(value);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    throw new RapidOcrError(missingCode, missingCode === "MODEL_NOT_FOUND" ? "A configured OCR asset is unavailable" : "The bundled OCR worker is unavailable");
  }
}

function normalizeImage(value: unknown, maxBytes: number): RapidOcrLocalImage {
  if (value === null || typeof value !== "object") throw new RapidOcrError("INVALID_IMAGE", "A local OCR image is required");
  const record = value as Record<string, unknown>;
  let bytes: Uint8Array;
  if (record.bytes instanceof Uint8Array) bytes = new Uint8Array(record.bytes);
  else if (typeof record.dataBase64 === "string") bytes = decodeBase64(record.dataBase64);
  else throw new RapidOcrError("INVALID_IMAGE", "The local OCR image has no bytes");
  const mimeType = record.mimeType;
  const width = record.width;
  const height = record.height;
  if (typeof mimeType !== "string" || !/^image\/[a-z0-9.+-]+$/iu.test(mimeType) || !Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1 || (width as number) > 16_384 || (height as number) > 16_384) {
    throw new RapidOcrError("INVALID_IMAGE", "The local OCR image metadata is invalid");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new RapidOcrError("INVALID_IMAGE", "The local OCR image exceeds the configured bound");
  return { mimeType, bytes, width: width as number, height: height as number };
}

function decodeBase64(value: string): Uint8Array {
  const encoded = value.replace(/^data:[^;,]+;base64,/iu, "");
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 === 1) throw new RapidOcrError("INVALID_IMAGE", "The local OCR image encoding is invalid");
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

function validateRegion(region: Rect, imageWidth: number, imageHeight: number): void {
  if (!Number.isFinite(region.x) || !Number.isFinite(region.y) || !Number.isFinite(region.width) || !Number.isFinite(region.height) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.width > 4096 || region.height > 4096 || region.x + region.width > imageWidth || region.y + region.height > imageHeight) {
    throw new RapidOcrError("INVALID_REGION", "The OCR region is outside the supplied image bound");
  }
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) throw new RapidOcrError("INVALID_MODEL_PATH", "OCR limits must be positive finite numbers");
  return Math.min(Math.floor(value), maximum);
}

function toStatusCode(code: RapidOcrErrorCode): Exclude<RapidOcrStatusCode, "ready"> {
  if (code === "INVALID_MODEL_PATH" || code === "MODEL_NOT_FOUND" || code === "TIMEOUT" || code === "ABORTED" || code === "PYTHON_UNAVAILABLE" || code === "WORKER_UNAVAILABLE" || code === "MODEL_LOAD_FAILED" || code === "RAPIDOCR_UNAVAILABLE" || code === "WORKER_FAILED") return code;
  return "WORKER_FAILED";
}

function workerError(response: WorkerFailure): RapidOcrError {
  const allowed: readonly RapidOcrErrorCode[] = ["RAPIDOCR_UNAVAILABLE", "MODEL_LOAD_FAILED", "INFERENCE_FAILED", "INVALID_IMAGE", "INVALID_REGION", "WORKER_PROTOCOL_ERROR", "WORKER_FAILED"];
  const code = allowed.includes(response.error.code as RapidOcrErrorCode) ? response.error.code as RapidOcrErrorCode : "WORKER_FAILED";
  return new RapidOcrError(code, "RapidOCR worker reported a typed failure");
}

function runWorker(pythonExecutable: string, workerPath: string, request: WorkerRequest, timeoutMs: number, parentSignal?: AbortSignal): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    if (parentSignal?.aborted) {
      reject(new RapidOcrError("ABORTED", "OCR was cancelled"));
      return;
    }
    let child;
    try {
      child = spawn(pythonExecutable, [workerPath], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1", CUDA_VISIBLE_DEVICES: "" },
      });
    } catch {
      reject(new RapidOcrError("PYTHON_UNAVAILABLE", "The configured Python executable could not start"));
      return;
    }
    let settled = false;
    let stdout = "";
    const finish = (error?: RapidOcrError, value?: WorkerResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else if (value !== undefined) resolve(value);
      else reject(new RapidOcrError("WORKER_PROTOCOL_ERROR", "RapidOCR worker returned no response"));
    };
    const abort = (): void => {
      child.kill();
      finish(new RapidOcrError("ABORTED", "OCR was cancelled"));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new RapidOcrError("TIMEOUT", "RapidOCR exceeded its bounded time"));
    }, timeoutMs);
    parentSignal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, "utf8") > MAX_WORKER_OUTPUT_BYTES) {
        child.kill();
        finish(new RapidOcrError("WORKER_PROTOCOL_ERROR", "RapidOCR worker response exceeded its bound"));
      }
    });
    child.stderr.on("data", () => {
      // Drain logs without retaining or forwarding image/model/user content.
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(new RapidOcrError(error.code === "ENOENT" ? "PYTHON_UNAVAILABLE" : "WORKER_UNAVAILABLE", "RapidOCR worker could not start"));
    });
    child.on("close", (code) => {
      if (settled) return;
      const parsed = parseWorkerResponse(stdout);
      if (parsed !== undefined) {
        finish(undefined, parsed);
        return;
      }
      finish(new RapidOcrError(code === 0 ? "WORKER_PROTOCOL_ERROR" : "WORKER_FAILED", "RapidOCR worker failed without a typed response"));
    });
    child.stdin.on("error", () => {
      if (!settled) finish(new RapidOcrError("WORKER_FAILED", "RapidOCR worker input failed"));
    });
    child.stdin.end(JSON.stringify(request) + "\n", "utf8");
  });
}

function parseWorkerResponse(stdout: string): WorkerResponse | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value !== null && typeof value === "object" && typeof (value as { ok?: unknown }).ok === "boolean") return value as WorkerResponse;
  } catch {
    return undefined;
  }
  return undefined;
}
