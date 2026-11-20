import { createRequire } from "node:module";
import { join, resolve as resolvePath } from "node:path";

import {
  createRapidOcrCpuRunner,
  RapidOcrError,
  type RapidOcrCpuRunnerOptions,
  type RapidOcrStatus,
  type RapidOcrStatusCode,
} from "../evidence/rapidocr.js";
import { readE2BApiKey } from "../product/runtime-config.js";

export { readE2BApiKey } from "../product/runtime-config.js";

const E2B_PACKAGE = "@e2b/desktop" as const;

/** Configuration for the optional local PP-OCRv5 mobile probe. */
export interface OptionalOcrSetupOptions {
  readonly pythonExecutable: string;
  readonly detectorModelPath: string;
  readonly recognizerModelPath: string;
  readonly dictionaryPath: string;
  readonly classifierModelPath?: string;
}

/** Selects only the optional integrations that the consumer intends to use. */
export interface OptionalSetupOptions {
  /** Consumer/project directory from which optional packages are resolved. */
  readonly rootDirectory?: string;
  /** Check the consumer's optional @e2b/desktop dependency and API key. */
  readonly e2b?: boolean;
  /** Optional protected .env file; its key is read without mutating process.env. */
  readonly e2bEnvFile?: string;
  /** Check an explicitly configured local OCR environment and model set. */
  readonly ocr?: OptionalOcrSetupOptions;
}

export type OptionalSetupStatus =
  | "ready"
  | "missing_dependency"
  | "missing_configuration"
  | "invalid_configuration"
  | "unavailable";

export type E2BOptionalSetupCode =
  | "ready"
  | "E2B_PACKAGE_MISSING"
  | "E2B_PACKAGE_RESOLUTION_FAILED"
  | "E2B_API_KEY_MISSING";

export interface E2BOptionalSetupReport {
  readonly module: "e2b";
  readonly dependency: typeof E2B_PACKAGE;
  readonly available: boolean;
  readonly status: OptionalSetupStatus;
  readonly code: E2BOptionalSetupCode;
  readonly message: string;
  readonly guidance: string;
  /** True/false only; the API key value is never returned or copied. */
  readonly apiKeyConfigured: boolean;
  /** True when the dependency resolved from the selected consumer project. */
  readonly packageAvailable: boolean;
}

export interface OcrOptionalSetupReport {
  readonly module: "ocr";
  readonly dependency: "RapidOCR CPU Python environment";
  readonly available: boolean;
  readonly status: OptionalSetupStatus;
  readonly code: RapidOcrStatusCode;
  readonly message: string;
  readonly guidance: string;
  /** Typed result returned by the existing local RapidOCR runner probe. */
  readonly rapidOcr: RapidOcrStatus;
}

export interface OptionalSetupReports {
  readonly e2b?: E2BOptionalSetupReport;
  readonly ocr?: OcrOptionalSetupReport;
}

export interface OptionalSetupResult {
  /** Normalized consumer root used for E2B package resolution. */
  readonly rootDirectory: string;
  /** True when every selected optional module reports ready. */
  readonly ready: boolean;
  /** Reports are present only for modules selected in the request. */
  readonly reports: OptionalSetupReports;
}

/**
 * Check selected optional integrations without installing packages, changing
 * global state, downloading models, allocating an E2B sandbox, or sending
 * data to a remote service.
 */
export async function checkOptionalSetup(
  options: OptionalSetupOptions,
): Promise<OptionalSetupResult> {
  const rootDirectory = normalizeRootDirectory(options.rootDirectory);
  const reports: OptionalSetupReports = {
    ...(options.e2b === true ? { e2b: checkE2BSetup(rootDirectory, options.e2bEnvFile) } : {}),
    ...(options.ocr === undefined ? {} : { ocr: await checkOcrSetup(options.ocr) }),
  };
  const selected = Object.values(reports);
  return {
    rootDirectory,
    ready: selected.every((report) => report.available),
    reports,
  };
}

function normalizeRootDirectory(value: string | undefined): string {
  if (value === undefined) return resolvePath(process.cwd());
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new TypeError("rootDirectory must be a non-empty local directory path");
  }
  return resolvePath(value);
}

function checkE2BSetup(rootDirectory: string, envFile?: string): E2BOptionalSetupReport {
  const packageResolution = resolveConsumerPackage(rootDirectory, E2B_PACKAGE);
  const packageAvailable = packageResolution === "resolved";
  const apiKey = readE2BApiKey(envFile);
  const apiKeyConfigured = apiKey !== undefined;
  if (packageResolution === "missing") {
    return {
      module: "e2b",
      dependency: E2B_PACKAGE,
      available: false,
      status: "missing_dependency",
      code: "E2B_PACKAGE_MISSING",
      message: "The optional E2B Desktop dependency is not installed for the selected consumer project.",
      guidance: "Install @e2b/desktop in that project (for example, npm install @e2b/desktop), then run this check again.",
      apiKeyConfigured,
      packageAvailable,
    };
  }
  if (packageResolution === "failed") {
    return {
      module: "e2b",
      dependency: E2B_PACKAGE,
      available: false,
      status: "unavailable",
      code: "E2B_PACKAGE_RESOLUTION_FAILED",
      message: "The optional E2B Desktop dependency could not be resolved from the selected consumer project.",
      guidance: "Repair the selected project's package installation or lockfile, then rerun this check; no E2B sandbox is started.",
      apiKeyConfigured,
      packageAvailable,
    };
  }
  if (!apiKeyConfigured) {
    return {
      module: "e2b",
      dependency: E2B_PACKAGE,
      available: false,
      status: "missing_configuration",
      code: "E2B_API_KEY_MISSING",
      message: "The optional E2B Desktop dependency resolves, but E2B_API_KEY is not configured.",
      guidance: "Set E2B_API_KEY in the consumer process environment. This check never reads or prints its value and never starts a sandbox.",
      apiKeyConfigured,
      packageAvailable,
    };
  }
  return {
    module: "e2b",
    dependency: E2B_PACKAGE,
    available: true,
    status: "ready",
    code: "ready",
    message: "The optional E2B Desktop dependency resolves and E2B_API_KEY is configured.",
    guidance: "Ready for a caller-owned E2B sandbox; this setup check allocates no sandbox and sends no data.",
    apiKeyConfigured,
    packageAvailable,
  };
}

function resolveConsumerPackage(rootDirectory: string, packageName: string): "resolved" | "missing" | "failed" {
  try {
    // Resolve from the selected consumer, not from DeskLatch's own install.
    const consumerRequire = createRequire(join(rootDirectory, "package.json"));
    consumerRequire.resolve(packageName);
    return "resolved";
  } catch (error) {
    // Keep filesystem/package-manager paths and resolver details out of the
    // report while preserving a typed distinction for malformed installs.
    if (isModuleNotFound(error)) return "missing";
    return "failed";
  }
}

function isModuleNotFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
}

async function checkOcrSetup(options: OptionalOcrSetupOptions): Promise<OcrOptionalSetupReport> {
  let status: RapidOcrStatus;
  try {
    const runnerOptions: RapidOcrCpuRunnerOptions = options;
    status = await createRapidOcrCpuRunner(runnerOptions).check();
  } catch (error) {
    status = {
      available: false,
      code: codeFromOcrError(error),
      model: "PP-OCRv5-mobile",
    };
  }
  return ocrReport(status);
}

function codeFromOcrError(error: unknown): RapidOcrStatusCode {
  if (error instanceof RapidOcrError) {
    switch (error.code) {
      case "RAPIDOCR_UNAVAILABLE":
      case "PYTHON_UNAVAILABLE":
      case "WORKER_UNAVAILABLE":
      case "MODEL_NOT_FOUND":
      case "INVALID_MODEL_PATH":
      case "TIMEOUT":
      case "ABORTED":
      case "MODEL_LOAD_FAILED":
      case "WORKER_FAILED":
        return error.code;
      default:
        return "WORKER_FAILED";
    }
  }
  return "WORKER_FAILED";
}

function ocrReport(rapidOcr: RapidOcrStatus): OcrOptionalSetupReport {
  const { status, message, guidance } = ocrRemediation(rapidOcr.code);
  return {
    module: "ocr",
    dependency: "RapidOCR CPU Python environment",
    available: rapidOcr.available,
    status,
    code: rapidOcr.code,
    message,
    guidance,
    rapidOcr,
  };
}

function ocrRemediation(code: RapidOcrStatusCode): {
  status: OptionalSetupStatus;
  message: string;
  guidance: string;
} {
  switch (code) {
    case "ready":
      return {
        status: "ready",
        message: "The configured local PP-OCRv5 mobile CPU runner is available.",
        guidance: "DeskLatch will use the supplied Python executable and existing local model files; no model or package download is performed.",
      };
    case "INVALID_MODEL_PATH":
      return {
        status: "invalid_configuration",
        message: "The local OCR configuration is invalid.",
        guidance: "Provide absolute local paths for the detector, recognizer, dictionary, and optional classifier models, plus a valid Python executable; URLs and runtime downloads are not supported.",
      };
    case "MODEL_NOT_FOUND":
      return {
        status: "missing_configuration",
        message: "A configured local PP-OCRv5 mobile model or dictionary file is unavailable.",
        guidance: "Provide existing local detector, recognizer, dictionary, and optional classifier files; DeskLatch does not download OCR assets.",
      };
    case "PYTHON_UNAVAILABLE":
      return {
        status: "missing_dependency",
        message: "The configured Python executable could not be started.",
        guidance: "Install or activate the intended Python environment and point pythonExecutable at it; this check does not install Python or global packages.",
      };
    case "RAPIDOCR_UNAVAILABLE":
      return {
        status: "missing_dependency",
        message: "RapidOCR is unavailable in the configured Python environment.",
        guidance: "Install RapidOCR with its CPU ONNX runtime in the selected Python environment, then rerun this check; no package installation occurs here.",
      };
    case "MODEL_LOAD_FAILED":
      return {
        status: "invalid_configuration",
        message: "RapidOCR could not load the configured local PP-OCRv5 mobile models.",
        guidance: "Verify that the local files match PP-OCRv5 mobile and that the selected Python environment has the RapidOCR CPU runtime; downloads are disabled.",
      };
    case "WORKER_UNAVAILABLE":
      return {
        status: "unavailable",
        message: "The bundled RapidOCR worker is unavailable.",
        guidance: "Reinstall the DeskLatch distribution with its bundled OCR worker, then rerun this check; no external worker is downloaded.",
      };
    case "TIMEOUT":
      return {
        status: "unavailable",
        message: "The local RapidOCR probe exceeded its bounded time.",
        guidance: "Verify the selected Python environment and local model files, then retry; the setup check does not change process or model configuration.",
      };
    case "ABORTED":
      return {
        status: "unavailable",
        message: "The local RapidOCR probe was cancelled.",
        guidance: "Run the setup check again with the intended local OCR configuration.",
      };
    case "WORKER_FAILED":
      return {
        status: "unavailable",
        message: "The local RapidOCR worker failed its setup probe.",
        guidance: "Verify the selected Python environment and existing local PP-OCRv5 mobile model files, then retry; no downloads are performed.",
      };
    default:
      return {
        status: "unavailable",
        message: "The local RapidOCR setup probe returned an unsupported status.",
        guidance: "Verify the selected Python environment and local model configuration, then retry.",
      };
  }
}
