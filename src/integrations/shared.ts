import type { ToolEndpoint } from "../tools.js";

/**
 * How an integration should expose a frame image returned by `observe`.
 *
 * `native` keeps the image as a framework-native multimodal block. `omit`
 * retains only non-pixel image metadata. Pixel data is never placed in a
 * textual serialization by either integration.
 */
export type ImagePolicy = "native" | "omit";

export interface IntegrationOptions {
  readonly imagePolicy?: ImagePolicy;
}

export interface ImageMetadata {
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface ImageFrame {
  readonly mimeType: string;
  readonly dataBase64: string;
  readonly width: number;
  readonly height: number;
}

export function normalizeEndpoints(endpoints: readonly ToolEndpoint[]): readonly ToolEndpoint[] {
  const seen = new Set<string>();
  const normalized: ToolEndpoint[] = [];

  for (const endpoint of endpoints) {
    if (endpoint.name !== "observe" && endpoint.name !== "act") {
      throw new Error(`Unsupported DeskLatch tool endpoint: ${String(endpoint.name)}`);
    }
    if (seen.has(endpoint.name)) {
      throw new Error(`Duplicate DeskLatch tool endpoint: ${endpoint.name}`);
    }
    seen.add(endpoint.name);
    normalized.push(endpoint);
  }

  return normalized;
}

export function imagePolicy(options?: IntegrationOptions): ImagePolicy {
  return options?.imagePolicy ?? "native";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageLike(value: unknown): value is Partial<ImageFrame> & Record<string, unknown> {
  return isRecord(value) && ("dataBase64" in value || "mimeType" in value || "width" in value || "height" in value);
}

function metadataForImage(value: Partial<ImageFrame> & Record<string, unknown>): ImageMetadata {
  const metadata: { mimeType?: string; width?: number; height?: number } = {};
  if (typeof value.mimeType === "string") metadata.mimeType = value.mimeType;
  if (typeof value.width === "number") metadata.width = value.width;
  if (typeof value.height === "number") metadata.height = value.height;
  return metadata;
}

/**
 * Remove the image payload from an observation before any textual encoding.
 * The returned value is intentionally shallow: the public observation shape
 * puts the image at the top level, and preserving other fields avoids changing
 * endpoint semantics.
 */
export function observationWithoutPixels(value: unknown): { value: unknown; image?: ImageFrame; imageMetadata?: ImageMetadata } {
  if (!isRecord(value) || !("image" in value)) return { value };

  const { image, ...rest } = value;
  if (!isImageLike(image)) return { value: rest };

  const imageMetadata = metadataForImage(image);
  const dataBase64 = typeof image.dataBase64 === "string" ? image.dataBase64 : undefined;
  const mimeType = typeof image.mimeType === "string" ? image.mimeType : undefined;
  const width = typeof image.width === "number" ? image.width : undefined;
  const height = typeof image.height === "number" ? image.height : undefined;

  if (dataBase64 !== undefined && mimeType !== undefined && width !== undefined && height !== undefined) {
    return {
      value: { ...rest, image: imageMetadata },
      image: { dataBase64, mimeType, width, height },
      imageMetadata,
    };
  }

  // Even malformed image records must not leak an accidental dataBase64 field.
  return { value: { ...rest, image: imageMetadata }, imageMetadata };
}

export function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return String(value);
  }
}

const publicToolErrors = new Set(["closed", "invalid_view", "invalid_observe", "invalid_observe_filter",
  "image_delivery_not_authorized", "observe_failed", "cancelled"]);

export function errorText(error: unknown): string {
  return error instanceof Error && publicToolErrors.has(error.message) ? error.message : "desktop_tool_failed";
}
