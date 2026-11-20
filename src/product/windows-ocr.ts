import type { Rect, RiskInput } from "../contracts.js";
import type { RapidOcrV5MobileRunner } from "../evidence/ocr.js";
import { createRapidOcrCpuRunner, type RapidOcrCpuRunnerOptions } from "../evidence/rapidocr.js";
import type { LocalOcrProvider } from "../policy.js";
import type { WindowsTransport, WindowsWindowTarget } from "../backends/windows/index.js";

/** A conservative cap for an OCR crop requested from the Windows host. */
const MAX_OCR_WIDTH = 2048;
const MAX_OCR_HEIGHT = 2048;
const POINT_CROP_WIDTH = 256;
const POINT_CROP_HEIGHT = 160;

export interface WindowsOcrProviderOptions {
  readonly rapidOcr: RapidOcrCpuRunnerOptions;
  readonly transport: Pick<WindowsTransport, "observeWindowImage">;
  readonly regionForInput: (input: RiskInput) => Rect | undefined;
  readonly targetForInput: (input: RiskInput) => Promise<WindowsWindowTarget | undefined>;
  /** Test-only runner seam; production always creates the configured CPU runner. */
  readonly runner?: RapidOcrV5MobileRunner;
}

/**
 * Build the local OCR adapter used by the Windows product host. The provider
 * obtains a fresh exact-window image only through the already grant-guarded
 * transport, then gives RapidOCR the exact bounded crop selected by policy.
 * No image is written to disk or passed through backend.observe().
 */
export function createWindowsOcrProvider(options: WindowsOcrProviderOptions): LocalOcrProvider {
  const runner = options.runner ?? createRapidOcrCpuRunner(options.rapidOcr);
  const model = "PP-OCRv5-mobile";
  return {
    localOnly: true,
    model,
    async recognize({ input, region, signal }) {
      const expected = options.regionForInput(input);
      if (expected === undefined || !sameRect(expected, region) || !validRegion(region)) {
        throw new Error("ocr_region_invalid");
      }
      const target = await options.targetForInput(input);
      if (target === undefined) throw new Error("ocr_target_unavailable");
      const image = await options.transport.observeWindowImage?.(target, { signal });
      if (image === undefined) throw new Error("desktop_image_unavailable");
      const origin = image.origin ?? { x: 0, y: 0 };
      const crop = { ...region, x: region.x - origin.x, y: region.y - origin.y };
      if (!validRegion(crop) || crop.x < 0 || crop.y < 0
          || crop.x + crop.width > image.width || crop.y + crop.height > image.height) {
        throw new Error("ocr_region_out_of_bounds");
      }
      const lines = await runner.recognize({ input, region: crop, image, signal });
      return { source: "local", model, lines };
    },
  };
}

/**
 * Select only the exact native control rectangle, or a small point-centered
 * crop when the resolved target is a desktop canvas. A point is never widened
 * to the entire authorized desktop.
 */
export function windowsOcrRegion(input: RiskInput): Rect | undefined {
  const target = input.target.rect;
  if (target === undefined || !validGeometry(target)) return undefined;
  const point = pointForInput(input);
  if (point === undefined || !isCanvasTarget(input.target.role)) {
    return validRegion(target) ? { ...target } : undefined;
  }
  if (!regionContains(target, point)) return undefined;
  const width = Math.min(POINT_CROP_WIDTH, target.width);
  const height = Math.min(POINT_CROP_HEIGHT, target.height);
  return {
    x: Math.max(target.x, Math.min(point.x - width / 2, target.x + target.width - width)),
    y: Math.max(target.y, Math.min(point.y - height / 2, target.y + target.height - height)),
    width,
    height,
  };
}

function pointForInput(input: RiskInput): { readonly x: number; readonly y: number } | undefined {
  const step = input.step;
  if (step.kind === "drag") return step.from;
  if ("point" in step.target) return step.target.point;
  return undefined;
}

function isCanvasTarget(role: string): boolean {
  return role.replace(/[ _-]/gu, "").toLocaleLowerCase() === "canvas";
}

function validRegion(region: Rect): boolean {
  return validGeometry(region) && region.width <= MAX_OCR_WIDTH && region.height <= MAX_OCR_HEIGHT;
}

function validGeometry(region: Rect): boolean {
  return Number.isFinite(region.x) && Number.isFinite(region.y)
    && Number.isFinite(region.width) && Number.isFinite(region.height)
    && region.width > 0 && region.height > 0;
}

function regionContains(region: Rect, point: { readonly x: number; readonly y: number }): boolean {
  return point.x >= region.x && point.y >= region.y
    && point.x < region.x + region.width && point.y < region.y + region.height;
}

function sameRect(left: Rect, right: Rect): boolean {
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height;
}
