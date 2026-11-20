import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, dirname, join, normalize, resolve as resolvePath } from "node:path";
import { parseEnv } from "node:util";

import type { RapidOcrCpuRunnerOptions } from "../evidence/rapidocr.js";

export interface WindowsProductRuntimeConfig {
  readonly version: 1;
  readonly ocr?: RapidOcrCpuRunnerOptions;
  readonly e2b?: {
    readonly envFile?: string;
  };
}

export const emptyWindowsProductRuntimeConfig: WindowsProductRuntimeConfig = Object.freeze({ version: 1 });

/** Read only the settings consumed by E2B, without changing the host environment. */
export function readE2BProductEnvironment(envFile?: string): {
  readonly apiKey?: string;
  readonly browserAuthorizedOrigins?: readonly string[];
} {
  let source: Record<string, string | undefined> = process.env;
  if (envFile !== undefined) {
    if (!validEnvPath(envFile)) return {};
    try {
      const text = readFileSync(resolveLocalPath(envFile), "utf8");
      if (text.includes("\uFFFD")) return {};
      source = parseEnv(text.replace(/^\uFEFF/u, "")) as Record<string, string>;
    } catch { return {}; }
  }
  const apiKey = source.E2B_API_KEY?.trim() || undefined;
  const origins = source.DESKLATCH_E2B_BROWSER_ORIGINS?.split(",").map(value => value.trim()).filter(Boolean);
  return { apiKey, ...(origins?.length ? { browserAuthorizedOrigins: origins } : {}) };
}

export function readE2BApiKey(envFile?: string): string | undefined {
  return readE2BProductEnvironment(envFile).apiKey;
}

/** Runtime options live beside the protected grants file, never in the host's global config. */
export function windowsProductRuntimeConfigFile(authorizationFile: string): string {
  const grants = assertAuthorizationFile(authorizationFile);
  return join(dirname(grants), "runtime.json");
}

export async function readWindowsProductRuntimeConfig(authorizationFile: string): Promise<WindowsProductRuntimeConfig> {
  const path = windowsProductRuntimeConfigFile(authorizationFile);
  try {
    const source = await readFile(path, "utf8");
    if (source.includes("\uFFFD") || /\?{3,}/u.test(source)) throw new Error("utf8");
    return parseWindowsProductRuntimeConfig(JSON.parse(source));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyWindowsProductRuntimeConfig;
    if (error instanceof Error && error.message === "windows_runtime_config_invalid") throw error;
    throw new Error("windows_runtime_config_invalid");
  }
}

export async function writeWindowsProductRuntimeConfig(
  authorizationFile: string,
  config: WindowsProductRuntimeConfig,
): Promise<void> {
  const path = windowsProductRuntimeConfigFile(authorizationFile);
  const directory = dirname(path);
  const parsed = parseWindowsProductRuntimeConfig(config);
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  const temporary = join(directory, `runtime-${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const readBack = await readFile(temporary, "utf8");
    if (readBack !== serialized || readBack.includes("\uFFFD") || /\?{3,}/u.test(readBack)) {
      throw new Error("windows_runtime_config_write_failed");
    }
    await rename(temporary, path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("windows_runtime_config_")) throw error;
    throw new Error("windows_runtime_config_write_failed");
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function parseWindowsProductRuntimeConfig(value: unknown): WindowsProductRuntimeConfig {
  const record = objectRecord(value);
  if (record === undefined || record.version !== 1 || hasUnknownKeys(record, ["version", "ocr", "e2b"])) {
    throw new Error("windows_runtime_config_invalid");
  }
  const ocr = record.ocr === undefined ? undefined : parseOcr(record.ocr);
  const e2b = record.e2b === undefined ? undefined : parseE2b(record.e2b);
  return Object.freeze({
    version: 1 as const,
    ...(ocr === undefined ? {} : { ocr }),
    ...(e2b === undefined ? {} : { e2b }),
  });
}

function parseOcr(value: unknown): RapidOcrCpuRunnerOptions {
  const record = objectRecord(value);
  if (record === undefined || hasUnknownKeys(record, [
    "pythonExecutable", "detectorModelPath", "recognizerModelPath", "dictionaryPath", "classifierModelPath", "timeoutMs", "maxImageBytes",
  ])) throw new Error("windows_runtime_config_invalid");
  const pythonExecutable = localExecutable(record.pythonExecutable);
  const detectorModelPath = localFile(record.detectorModelPath, "detectorModelPath", [".onnx"]);
  const recognizerModelPath = localFile(record.recognizerModelPath, "recognizerModelPath", [".onnx"]);
  const dictionaryPath = localFile(record.dictionaryPath, "dictionaryPath", [".txt", ".dict", ".json"]);
  const classifierModelPath = record.classifierModelPath === undefined
    ? undefined
    : localFile(record.classifierModelPath, "classifierModelPath", [".onnx"]);
  const timeoutMs = positiveInteger(record.timeoutMs, "timeoutMs", 60_000);
  const maxImageBytes = positiveInteger(record.maxImageBytes, "maxImageBytes", 64 * 1024 * 1024);
  return Object.freeze({
    pythonExecutable,
    detectorModelPath,
    recognizerModelPath,
    dictionaryPath,
    ...(classifierModelPath === undefined ? {} : { classifierModelPath }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxImageBytes === undefined ? {} : { maxImageBytes }),
  });
}

function parseE2b(value: unknown): { readonly envFile?: string } {
  const record = objectRecord(value);
  if (record === undefined || hasUnknownKeys(record, ["envFile"])) throw new Error("windows_runtime_config_invalid");
  const envFile = record.envFile === undefined ? undefined : localFile(record.envFile, "envFile", []);
  return Object.freeze(envFile === undefined ? {} : { envFile });
}

function localExecutable(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000\r\n]/u.test(value)
    || /^(?:https?|ftp|file):\/\//iu.test(value)) throw new Error("windows_runtime_config_invalid");
  return value.trim();
}

function localFile(value: unknown, _field: string, extensions: readonly string[]): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\u0000\r\n]/u.test(value)
    || /^(?:\\\\|\/\/|(?:https?|ftp|file):\/\/)/iu.test(value)) {
    throw new Error("windows_runtime_config_invalid");
  }
  const normalized = normalize(value);
  if (extensions.length > 0 && !extensions.some(extension => normalized.toLocaleLowerCase().endsWith(extension))) {
    throw new Error("windows_runtime_config_invalid");
  }
  return normalized;
}

function positiveInteger(value: unknown, _field: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error("windows_runtime_config_invalid");
  }
  return value as number;
}

function assertAuthorizationFile(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\u0000\r\n]/u.test(value)
    || /^(?:\\\\|\/\/|(?:https?|ftp|file):\/\/)/iu.test(value)) {
    throw new Error("windows_runtime_config_path_invalid");
  }
  return normalize(value);
}

function validLocalPath(value: string): boolean {
  return !/[\u0000\r\n]/u.test(value)
    && !/^(?:\\\\|\/\/|(?:https?|ftp|file):\/\/)/iu.test(value);
}

function resolveLocalPath(value: string): string {
  return normalize(resolvePath(value));
}

function validEnvPath(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && validLocalPath(value);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(record).some(key => !keys.has(key));
}
