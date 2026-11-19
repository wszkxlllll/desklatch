/**
 * Execution-side evidence is intentionally separate from model/reviewer
 * egress. The sink accepts only an already-redacted image and writes through a
 * host-owned private store. There is no upload method on this type.
 */

export interface EvidenceImage {
  mimeType: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface RedactedEvidenceImage extends EvidenceImage {
  /** A redactor must set this to true; the sink rejects unmarked output. */
  redacted: true;
}

export interface EvidenceRedactor {
  redact(image: EvidenceImage, signal?: AbortSignal): Promise<RedactedEvidenceImage> | RedactedEvidenceImage;
}

export interface PrivateEvidenceMetadata {
  sessionId: string;
  observationId?: string;
  stepIndex?: number;
  capturedAt?: string;
  /** Optional host labels, never raw OCR or image data. */
  labels?: Readonly<Record<string, string>>;
}

export interface PrivateEvidenceRecord {
  evidenceId: string;
  metadata: PrivateEvidenceMetadata;
  bytes: number;
  mimeType: string;
  width: number;
  height: number;
  redacted: true;
}

/**
 * A storage implementation must make privacy explicit. This keeps accidental
 * use of a shared/public bucket out of the execution-side path.
 */
export interface PrivateEvidenceStore {
  readonly visibility: "private";
  putPrivate(image: RedactedEvidenceImage, metadata: PrivateEvidenceMetadata): Promise<{ evidenceId: string }>;
}

export interface LocalEvidenceSinkOptions {
  store: PrivateEvidenceStore;
  redactor: EvidenceRedactor;
  /** Default false; retained as a runtime assertion against accidental egress. */
  allowEgress?: boolean;
  maxBytes?: number;
  clock?: () => string;
}

export class LocalEvidenceSink {
  private readonly maxBytes: number;
  private readonly clock: () => string;

  public constructor(private readonly options: LocalEvidenceSinkOptions) {
    if (options.store === undefined || options.store.visibility !== "private" || typeof options.store.putPrivate !== "function") {
      throw new Error("Evidence storage must be an explicit private store");
    }
    if (options.redactor === undefined || typeof options.redactor.redact !== "function") {
      throw new Error("A redactor is required; evidence storage fails closed without one");
    }
    if (options.allowEgress === true) throw new Error("Local evidence sink does not permit egress");
    if (options.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || options.maxBytes < 1)) throw new Error("maxBytes must be a positive integer");
    this.maxBytes = options.maxBytes ?? 20_000_000;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  /** Redact in memory, then write only the redacted bytes to private storage. */
  public async save(image: EvidenceImage, metadata: PrivateEvidenceMetadata, signal?: AbortSignal): Promise<PrivateEvidenceRecord> {
    if (signal?.aborted) throw new Error("evidence save aborted");
    validateImage(image, this.maxBytes);
    validateMetadata(metadata);
    const redacted = await this.options.redactor.redact(copyImage(image), signal);
    if (signal?.aborted) throw new Error("evidence save aborted");
    validateRedactedImage(redacted, this.maxBytes);
    const storedMetadata: PrivateEvidenceMetadata = {
      ...metadata,
      capturedAt: metadata.capturedAt ?? this.clock(),
      ...(metadata.labels === undefined ? {} : { labels: { ...metadata.labels } }),
    };
    const result = await this.options.store.putPrivate(copyImage(redacted), storedMetadata);
    if (result === undefined || typeof result.evidenceId !== "string" || result.evidenceId.length === 0) throw new Error("private evidence store returned no evidence id");
    return {
      evidenceId: result.evidenceId,
      metadata: storedMetadata,
      bytes: redacted.bytes.byteLength,
      mimeType: redacted.mimeType,
      width: redacted.width,
      height: redacted.height,
      redacted: true,
    };
  }
}

/** A tiny in-memory private store useful for host tests and local fixtures. */
export class MemoryPrivateEvidenceStore implements PrivateEvidenceStore {
  public readonly visibility = "private" as const;
  private readonly records = new Map<string, { image: RedactedEvidenceImage; metadata: PrivateEvidenceMetadata }>();
  private sequence = 0;

  public async putPrivate(image: RedactedEvidenceImage, metadata: PrivateEvidenceMetadata): Promise<{ evidenceId: string }> {
    const evidenceId = `local-evidence-${++this.sequence}`;
    this.records.set(evidenceId, { image: copyImage(image), metadata: { ...metadata, ...(metadata.labels === undefined ? {} : { labels: { ...metadata.labels } }) } });
    return { evidenceId };
  }

  /** Host-only readback for tests; there is deliberately no upload/export method. */
  public readPrivate(evidenceId: string): { image: RedactedEvidenceImage; metadata: PrivateEvidenceMetadata } | undefined {
    const record = this.records.get(evidenceId);
    if (record === undefined) return undefined;
    return { image: copyImage(record.image), metadata: { ...record.metadata, ...(record.metadata.labels === undefined ? {} : { labels: { ...record.metadata.labels } }) } };
  }

  public get size(): number {
    return this.records.size;
  }
}

function validateImage(image: EvidenceImage, maxBytes: number): void {
  if (image === undefined || typeof image !== "object" || !(image.bytes instanceof Uint8Array) || image.bytes.byteLength === 0 || image.bytes.byteLength > maxBytes) {
    throw new Error("invalid or oversized evidence image");
  }
  if (typeof image.mimeType !== "string" || !/^image\/[a-z0-9.+-]+$/iu.test(image.mimeType)) throw new Error("evidence must be an image mime type");
  if (!Number.isInteger(image.width) || image.width < 1 || !Number.isInteger(image.height) || image.height < 1) throw new Error("evidence dimensions are invalid");
}

function validateRedactedImage(image: RedactedEvidenceImage, maxBytes: number): void {
  validateImage(image, maxBytes);
  if (image.redacted !== true) throw new Error("redaction failed closed: output is not marked redacted");
}

function validateMetadata(metadata: PrivateEvidenceMetadata): void {
  if (metadata === undefined || typeof metadata !== "object" || typeof metadata.sessionId !== "string" || metadata.sessionId.trim().length === 0) throw new Error("evidence metadata needs a sessionId");
  if (metadata.stepIndex !== undefined && (!Number.isInteger(metadata.stepIndex) || metadata.stepIndex < 0)) throw new Error("evidence stepIndex is invalid");
  if (metadata.labels !== undefined) {
    for (const [key, value] of Object.entries(metadata.labels)) {
      if (key.length > 80 || typeof value !== "string" || value.length > 240) throw new Error("evidence metadata labels are invalid");
    }
  }
}

function copyImage<T extends EvidenceImage>(image: T): T {
  return { ...image, bytes: new Uint8Array(image.bytes) } as T;
}
