import type { Rect, RiskInput } from "../contracts.js";
import type { LocalOcrProvider, LocalOcrRequest, LocalOcrResult, TextRiskOcrLine } from "../policy.js";

/**
 * The core package does not depend on RapidOCR, ONNX Runtime, or a model
 * registry. A host can bridge its already-installed local runner through this
 * narrow interface. The runner is called lazily and only with a bounded region.
 */
export interface RapidOcrV5MobileRunner {
  recognize(request: {
    /** Host-owned image handle; no image bytes are retained by this adapter. */
    input: RiskInput;
    region: Rect;
    image?: unknown;
    signal: AbortSignal;
  }): Promise<readonly TextRiskOcrLine[]>;
}

export interface LocalPpOcrV5MobileOptions {
  /** Must be the local RapidOCR ONNX path; URLs and package downloads are rejected. */
  detectorModelPath: string;
  recognizerModelPath: string;
  classifierModelPath?: string;
  /** The host's configured RapidOCR/ONNX runner. No runner means no OCR adapter. */
  runner: RapidOcrV5MobileRunner;
  /** Optional host-local image/crop acquisition for the bounded region. */
  getImage?: (request: Omit<LocalOcrRequest, "image">) => Promise<unknown>;
  /** Explicitly documented guard: runtime downloads are never supported. */
  allowDownloads?: boolean;
}

/**
 * Build a local PP-OCRv5 mobile adapter around an already-configured host
 * runner. This does not install RapidOCR or download models. The host remains
 * responsible for proving that the paths are local PP-OCRv5 mobile ONNX
 * models and for running CPU-only/local inference.
 */
export function createLocalPpOcrV5Mobile(options: LocalPpOcrV5MobileOptions): LocalOcrProvider {
  if (options.allowDownloads === true) throw new Error("DeskLatch OCR adapters cannot download models at runtime");
  assertLocalModelPath(options.detectorModelPath, "detectorModelPath");
  assertLocalModelPath(options.recognizerModelPath, "recognizerModelPath");
  if (options.classifierModelPath !== undefined) assertLocalModelPath(options.classifierModelPath, "classifierModelPath");
  if (options.runner === undefined || typeof options.runner.recognize !== "function") throw new Error("A configured local RapidOCR runner is required");

  return {
    localOnly: true,
    model: "PP-OCRv5-mobile",
    ...(options.getImage === undefined ? {} : { getImage: options.getImage }),
    async recognize(request: LocalOcrRequest): Promise<LocalOcrResult> {
      const lines = await options.runner.recognize({ input: request.input, region: request.region, ...(request.image === undefined ? {} : { image: request.image }), signal: request.signal });
      if (!Array.isArray(lines)) throw new Error("RapidOCR runner returned invalid lines");
      return { source: "local", model: "PP-OCRv5-mobile", lines };
    },
  };
}

function assertLocalModelPath(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a local model path`);
  const path = value.trim();
  if (/^(?:https?|ftp|file):\/\//iu.test(path) || /[\u0000\r\n]/u.test(path)) throw new Error(`${field} must not be a URL or unsafe path`);
  if (!/\.(?:onnx|pdmodel|bin)$/iu.test(path)) throw new Error(`${field} must point to an ONNX/local model file`);
}
