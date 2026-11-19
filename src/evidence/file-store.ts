import { chmod, lstat, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  EvidenceImage,
  PrivateEvidenceMetadata,
  PrivateEvidenceStore,
  RedactedEvidenceImage,
} from "./local-sink.js";

export interface FilePrivateEvidenceStoreOptions {
  /** A host-created, private, absolute directory. There is no global default. */
  rootDirectory: string;
  retentionMs?: number;
  maxRecords?: number;
  maxBytes?: number;
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECORDS = 100;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_RECORDS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const EVIDENCE_ID = /^evidence-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IMAGE_NAME = /^evidence-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpeg|webp|gif|bin)$/iu;

/**
 * Private filesystem implementation for execution-side evidence. The caller
 * must provide an existing private/ACL-protected root (especially on Windows);
 * this class only accepts generated IDs and writes atomically inside it. It has
 * no shared/global directory and no upload operation.
 */
export class FilePrivateEvidenceStore implements PrivateEvidenceStore {
  public readonly visibility = "private" as const;
  private readonly rootDirectory: string;
  private readonly retentionMs: number;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private rootReady: Promise<void> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(options: FilePrivateEvidenceStoreOptions) {
    if (options === undefined || options === null || typeof options !== "object") throw new Error("private evidence store options are required");
    if (typeof options.rootDirectory !== "string" || options.rootDirectory.trim().length === 0 || !path.isAbsolute(options.rootDirectory) || /^(?:\\\\|\/\/)/u.test(options.rootDirectory) || /[\u0000\r\n]/u.test(options.rootDirectory)) {
      throw new Error("rootDirectory must be an absolute host-private directory");
    }
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.retentionMs = bounded(options.retentionMs, DEFAULT_RETENTION_MS, 1, MAX_RETENTION_MS, "retentionMs");
    this.maxRecords = boundedInteger(options.maxRecords, DEFAULT_MAX_RECORDS, 1, MAX_RECORDS, "maxRecords");
    this.maxBytes = bounded(options.maxBytes, DEFAULT_MAX_BYTES, 1, MAX_BYTES, "maxBytes");
  }

  public async putPrivate(image: RedactedEvidenceImage, metadata: PrivateEvidenceMetadata): Promise<{ evidenceId: string }> {
    validateRedactedImage(image);
    validateMetadata(metadata);
    if (image.bytes.byteLength > this.maxBytes) throw new Error("private evidence image exceeds the store byte bound");
    const evidenceId = `evidence-${randomUUID()}`;
    const extension = extensionForMime(image.mimeType);
    const imageName = `${evidenceId}.${extension}`;
    const metadataName = `${evidenceId}.json`;
    await this.enqueue(async () => {
      await this.ensureRoot();
      const imagePath = path.join(this.rootDirectory, imageName);
      const metadataPath = path.join(this.rootDirectory, metadataName);
      const imageTemp = path.join(this.rootDirectory, `.${imageName}.${randomUUID()}.tmp`);
      const metadataTemp = path.join(this.rootDirectory, `.${metadataName}.${randomUUID()}.tmp`);
      try {
        await writeFile(imageTemp, image.bytes, { mode: 0o600, flag: "wx" });
        await rename(imageTemp, imagePath);
        await writeFile(metadataTemp, JSON.stringify({ metadata, mimeType: image.mimeType, width: image.width, height: image.height }), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(metadataTemp, metadataPath);
        await privateMode(imagePath, 0o600);
        await privateMode(metadataPath, 0o600);
        await this.enforceRetention();
      } catch (error) {
        await safeRemove(imageTemp);
        await safeRemove(metadataTemp);
        await safeRemove(imagePath);
        await safeRemove(metadataPath);
        throw error;
      }
    });
    return { evidenceId };
  }

  /** Host-only readback; no export/upload method is provided. */
  public async readPrivate(evidenceId: string): Promise<{ image: EvidenceImage; metadata: PrivateEvidenceMetadata } | undefined> {
    if (!EVIDENCE_ID.test(evidenceId)) return undefined;
    await this.ensureRoot();
    const names = await readdir(this.rootDirectory);
    const imageName = names.find((name) => name.startsWith(`${evidenceId}.`) && IMAGE_NAME.test(name));
    if (imageName === undefined) return undefined;
    const metadataName = `${evidenceId}.json`;
    if (!names.includes(metadataName)) return undefined;
    try {
      const bytes = new Uint8Array(await readFile(path.join(this.rootDirectory, imageName)));
      const stored = JSON.parse(await readFile(path.join(this.rootDirectory, metadataName), "utf8")) as { metadata?: PrivateEvidenceMetadata; mimeType?: string; width?: number; height?: number };
      const metadata = stored.metadata ?? stored as unknown as PrivateEvidenceMetadata;
      const extension = path.extname(imageName).toLowerCase();
      return {
        image: {
          mimeType: typeof stored.mimeType === "string" ? stored.mimeType : mimeForExtension(extension),
          bytes,
          width: Number.isInteger(stored.width) && (stored.width as number) > 0 ? stored.width as number : 1,
          height: Number.isInteger(stored.height) && (stored.height as number) > 0 ? stored.height as number : 1,
        },
        metadata,
      };
    } catch {
      return undefined;
    }
  }

  public async close(): Promise<void> {
    await this.writeQueue;
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    await next;
  }

  private async ensureRoot(): Promise<void> {
    this.rootReady ??= (async () => {
      const info = await lstat(this.rootDirectory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("private evidence root is not a directory");
      await privateMode(this.rootDirectory, 0o700);
    })();
    try {
      await this.rootReady;
    } catch (error) {
      this.rootReady = undefined;
      throw error;
    }
  }

  private async enforceRetention(): Promise<void> {
    const now = Date.now();
    const entries = await readdir(this.rootDirectory, { withFileTypes: true });
    const records: Array<{ imageName: string; metadataName: string; bytes: number; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !IMAGE_NAME.test(entry.name)) continue;
      const imageInfo = await stat(path.join(this.rootDirectory, entry.name));
      records.push({
        imageName: entry.name,
        metadataName: `${entry.name.slice(0, entry.name.lastIndexOf("."))}.json`,
        bytes: imageInfo.size,
        mtimeMs: imageInfo.mtimeMs,
      });
    }
    records.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let totalBytes = records.reduce((total, record) => total + record.bytes, 0);
    for (const record of [...records]) {
      if (now - record.mtimeMs <= this.retentionMs) continue;
      await removeRecord(this.rootDirectory, record);
      totalBytes -= record.bytes;
      records.splice(records.indexOf(record), 1);
    }
    while (records.length > this.maxRecords || totalBytes > this.maxBytes) {
      const oldest = records.shift();
      if (oldest === undefined) break;
      await removeRecord(this.rootDirectory, oldest);
      totalBytes -= oldest.bytes;
    }
  }
}

function validateRedactedImage(image: RedactedEvidenceImage): void {
  if (image === undefined || image.redacted !== true || !(image.bytes instanceof Uint8Array) || image.bytes.byteLength === 0 || image.bytes.byteLength > MAX_BYTES) throw new Error("private store accepts only bounded redacted bytes");
  if (typeof image.mimeType !== "string" || !/^image\/[a-z0-9.+-]+$/iu.test(image.mimeType)) throw new Error("private store image mime type is invalid");
  if (!Number.isInteger(image.width) || image.width < 1 || !Number.isInteger(image.height) || image.height < 1) throw new Error("private store image dimensions are invalid");
}

function validateMetadata(metadata: PrivateEvidenceMetadata): void {
  if (metadata === undefined || typeof metadata.sessionId !== "string" || metadata.sessionId.trim().length === 0 || metadata.sessionId.length > 256) throw new Error("private store metadata sessionId is invalid");
  if (metadata.observationId !== undefined && (typeof metadata.observationId !== "string" || metadata.observationId.length > 256)) throw new Error("private store metadata observationId is invalid");
  if (metadata.stepIndex !== undefined && (!Number.isInteger(metadata.stepIndex) || metadata.stepIndex < 0)) throw new Error("private store metadata stepIndex is invalid");
  const serialized = JSON.stringify(metadata);
  if (serialized.length > 64 * 1024) throw new Error("private store metadata is too large");
}

function extensionForMime(mimeType: string): "png" | "jpeg" | "webp" | "gif" | "bin" {
  if (mimeType.toLowerCase() === "image/png") return "png";
  if (mimeType.toLowerCase() === "image/jpeg" || mimeType.toLowerCase() === "image/jpg") return "jpeg";
  if (mimeType.toLowerCase() === "image/webp") return "webp";
  if (mimeType.toLowerCase() === "image/gif") return "gif";
  return "bin";
}

function mimeForExtension(extension: string): string {
  if (extension === ".png") return "image/png";
  if (extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/octet-stream";
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${field} is outside its bounded retention limit`);
  return Math.floor(value);
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${field} is outside its bounded retention limit`);
  return value;
}

async function privateMode(value: string, mode: number): Promise<void> {
  try {
    await chmod(value, mode);
  } catch {
    // Windows ACLs are host-managed; the explicit private-store contract still
    // prevents accidental shared/public storage at the API boundary.
  }
}

async function safeRemove(value: string): Promise<void> {
  try {
    await rm(value, { force: true });
  } catch {
    // Preserve the original write failure without leaking a path in the error.
  }
}

async function removeRecord(root: string, record: { imageName: string; metadataName: string }): Promise<void> {
  await safeRemove(path.join(root, record.imageName));
  await safeRemove(path.join(root, record.metadataName));
}
