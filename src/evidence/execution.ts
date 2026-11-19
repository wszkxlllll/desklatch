import type {
  Capability,
  Control,
  DesktopBackend,
  Dispatch,
  Delivery,
  Frame,
  ObserveOptions,
} from "../contracts.js";
import type { EvidenceImage, PrivateEvidenceMetadata, PrivateEvidenceRecord } from "./local-sink.js";

export interface LocalCaptureEvent {
  phase: "before" | "after";
  sessionId: string;
  /** The already prepared dispatch. Capture hooks must not replace or rebind it. */
  dispatch: Dispatch;
  step: Dispatch["step"];
  target: Control;
  destination?: Control;
  delivery?: Delivery;
}

export type LocalCaptureImage = NonNullable<Frame["image"]> | EvidenceImage;

export interface LocalCaptureDiagnostic {
  phase: "before" | "after";
  code: "capture_unavailable" | "capture_failed" | "storage_failed" | "policy_failed";
}

export interface LocalCapturePolicy {
  /** This marker prevents accidentally wiring a provider/remote capture policy here. */
  readonly localOnly: true;
  approve(event: LocalCaptureEvent, signal?: AbortSignal): boolean | Promise<boolean>;
}

export interface EvidenceCapturingBackendOptions {
  sessionId: string;
  sink: LocalEvidenceSinkLike;
  capturePolicy: LocalCapturePolicy;
  captureBefore?: boolean;
  captureAfter?: boolean;
  /** Before-capture failures can prevent dispatch; after-capture failures cannot undo dispatch. */
  failClosed?: boolean;
  /** Independent local image source. It is never used to replace the dispatch frame. */
  captureImage?: (event: LocalCaptureEvent, signal?: AbortSignal) => Promise<LocalCaptureImage | undefined>;
  /** Receives local archival diagnostics without changing a known backend delivery. */
  onDiagnostic?: (diagnostic: LocalCaptureDiagnostic) => void;
  metadata?: (event: LocalCaptureEvent, frame: Frame) => PrivateEvidenceMetadata;
}

export interface LocalEvidenceSinkLike {
  save(image: EvidenceImage, metadata: PrivateEvidenceMetadata, signal?: AbortSignal): Promise<PrivateEvidenceRecord>;
}

/**
 * Optional execution-side wrapper. It captures only after the host's explicit
 * local policy approves a before/after event, and sends pixels only to the
 * private sink. It never invokes a reviewer, model provider, or uploader.
 */
export class EvidenceCapturingBackend implements DesktopBackend {
  public readonly capabilities: readonly Capability[];
  private readonly failClosed: boolean;

  public constructor(private readonly backend: DesktopBackend, private readonly options: EvidenceCapturingBackendOptions) {
    if (backend === undefined || options === undefined) throw new Error("evidence backend and options are required");
    if (options.sessionId.trim().length === 0) throw new Error("evidence sessionId is required");
    if (options.sink === undefined || options.capturePolicy === undefined || options.capturePolicy.localOnly !== true || typeof options.capturePolicy.approve !== "function") {
      throw new Error("evidence capture requires an explicit local-only policy and sink");
    }
    this.capabilities = backend.capabilities;
    this.failClosed = options.failClosed ?? true;
  }

  public observe(options: ObserveOptions): Promise<Frame> {
    return this.backend.observe(options);
  }

  public hitTest(frame: Frame, point: { x: number; y: number }, signal?: AbortSignal): Promise<Control | undefined> {
    if (this.backend.hitTest === undefined) return Promise.resolve(undefined);
    return this.backend.hitTest(frame, point, signal);
  }

  public async dispatch(request: Dispatch): Promise<Delivery> {
    const beforeEvent: LocalCaptureEvent = {
      phase: "before",
      sessionId: this.options.sessionId,
      dispatch: request,
      step: request.step,
      target: request.target,
      ...(request.destination === undefined ? {} : { destination: request.destination }),
    };
    if (this.options.captureBefore && await this.approved(beforeEvent, request.signal)) {
      try {
        let image: LocalCaptureImage | undefined;
        try {
          image = request.frame.image === undefined
            ? await this.options.captureImage?.(beforeEvent, request.signal)
            : request.frame.image;
        } catch {
          throw new CaptureFailure("capture_failed");
        }
        if (image === undefined) throw new CaptureFailure("capture_unavailable");
        await this.save(image, beforeEvent, request.signal);
      } catch (error) {
        this.report(beforeEvent.phase, error);
        if (this.failClosed) return { status: "refused", code: "evidence_capture_failed" };
      }
    }

    const delivery = await this.backend.dispatch(request);
    const afterEvent: LocalCaptureEvent = {
      ...beforeEvent,
      phase: "after",
      delivery,
    };
    if (this.options.captureAfter && delivery.status !== "refused" && await this.approved(afterEvent, request.signal)) {
      try {
        let image: LocalCaptureImage | undefined;
        try {
          image = await this.options.captureImage?.(afterEvent, request.signal);
        } catch {
          throw new CaptureFailure("capture_failed");
        }
        if (image === undefined) throw new CaptureFailure("capture_unavailable");
        await this.save(image, afterEvent, request.signal);
      } catch (error) {
        // A known backend delivery remains authoritative. Archival failure is
        // diagnostic only and must not turn dispatched into unknown.
        this.report(afterEvent.phase, error);
      }
    }
    return delivery;
  }

  public close(): Promise<void> {
    return this.backend.close();
  }

  private async approved(event: LocalCaptureEvent, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    try {
      return await this.options.capturePolicy.approve(event, signal);
    } catch {
      return false;
    }
  }

  private async save(source: LocalCaptureImage, event: LocalCaptureEvent, signal?: AbortSignal): Promise<void> {
    const image = isEvidenceImage(source) ? source : frameImageToEvidence(source);
    const frame = event.dispatch.frame;
    const metadata = this.options.metadata?.(event, frame) ?? {
      sessionId: this.options.sessionId,
      ...(frame.scope.length === 0 ? {} : { observationId: frame.scope }),
    };
    await this.options.sink.save(image, metadata, signal);
  }

  private report(phase: LocalCaptureEvent["phase"], error: unknown): void {
    const code = error instanceof CaptureFailure ? error.code : "storage_failed";
    try {
      this.options.onDiagnostic?.({ phase, code });
    } catch {
      // Diagnostics must never affect dispatch or mask its original outcome.
    }
  }
}

class CaptureFailure extends Error {
  public constructor(public readonly code: "capture_unavailable" | "capture_failed") {
    super(code);
  }
}

function isEvidenceImage(value: LocalCaptureImage): value is EvidenceImage {
  return value !== null && typeof value === "object" && "bytes" in value && value.bytes instanceof Uint8Array;
}

function frameImageToEvidence(image: NonNullable<Frame["image"]>): EvidenceImage {
  const encoded = image.dataBase64.replace(/^data:[^;,]+;base64,/iu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 === 1) throw new Error("invalid local evidence image encoding");
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  if (bytes.byteLength === 0) throw new Error("empty local evidence image");
  return { mimeType: image.mimeType, bytes, width: image.width, height: image.height };
}
