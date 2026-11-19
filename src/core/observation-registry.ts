import { randomUUID } from "node:crypto";
import type { ActionKind, Control, DocumentObservation, Frame, View } from "../contracts.js";
import type { CandidateSummary, ControlObservation, DeskObservation } from "./session-types.js";

export interface StoredObservation {
  observationId: string;
  frame: Frame;
  refs: Map<string, Control>;
  revision: number;
  exposed: boolean;
  pinned: boolean;
  documentRequested: boolean;
}

export interface ObservationRegistryOptions {
  allowModelImages: boolean;
  allowModelDocumentText: boolean;
  grantedAction: (kind: ActionKind) => boolean;
  refsGranted: boolean;
}

const CREDENTIAL_WORDS = /password|passwd|passcode|passphrase|secret|token|credential|authorization|cookie|api[ _-]?key|access[ _-]?key|private[ _-]?key|\bpin\b|\botp\b|cvv|cvc|card[ _-]?number|security[ _-]?code|ssn|密码|密钥|令牌|验证码|安全码|卡号|身份证/iu;
const SAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function sanitizeText(value: string, limit = 512): string {
  return value.replace(SAFE_TEXT, "").slice(0, limit);
}

export function isSensitiveControl(control: Control): boolean {
  if (control.sensitive) return true;
  const fields = [control.name, ...(control.labels ?? [])].filter((field): field is string => typeof field === "string");
  return fields.some((field) => CREDENTIAL_WORDS.test(field));
}

export class ObservationRegistry {
  private readonly observations = new Map<string, StoredObservation>();
  private readonly namespace = randomUUID();
  private sequence = 0;
  private revision = 0;

  public constructor(private readonly options: ObservationRegistryOptions) {}

  public remember(frame: Frame, exposed: boolean, pinnedSet?: Set<StoredObservation>, documentRequested = false): StoredObservation {
    const observationId = `obs-${this.namespace}-${++this.sequence}`;
    if (exposed) {
      for (const [id, old] of this.observations) {
        if (old.exposed && !old.pinned) this.observations.delete(id);
      }
    } else {
      for (const [id, old] of this.observations) {
        if (!old.exposed && !old.pinned) this.observations.delete(id);
      }
    }
    const refs = new Map<string, Control>();
    for (let index = 0; index < frame.controls.length; index += 1) {
      refs.set(this.makeRef(observationId, index + 1), frame.controls[index]);
    }
    const stored: StoredObservation = {
      observationId,
      frame,
      refs,
      revision: ++this.revision,
      exposed,
      pinned: false,
      documentRequested,
    };
    this.observations.set(observationId, stored);
    if (pinnedSet && !exposed) this.pin(stored, pinnedSet);
    return stored;
  }

  public get(observationId: string): StoredObservation | undefined {
    return this.observations.get(observationId);
  }

  public pin(stored: StoredObservation, pinnedSet: Set<StoredObservation>): void {
    stored.pinned = true;
    pinnedSet.add(stored);
  }

  public markExposed(stored: StoredObservation): void {
    stored.exposed = true;
  }

  public release(pinnedSet: Set<StoredObservation>): void {
    for (const stored of pinnedSet) stored.pinned = false;
    pinnedSet.clear();
    for (const [id, stored] of this.observations) {
      if (!stored.exposed && !stored.pinned) this.observations.delete(id);
    }
  }

  public publicObservation(stored: StoredObservation, view: View): DeskObservation {
    const controls: ControlObservation[] = [];
    let index = 1;
    for (const control of stored.frame.controls) {
      controls.push(this.publicControl(control, this.makeRef(stored.observationId, index)));
      index += 1;
    }
    const result: DeskObservation = {
      observationId: stored.observationId,
      view,
      complete: stored.frame.complete,
      controls,
    };
    if ((view === "image" || view === "both") && this.options.allowModelImages && stored.frame.image) result.image = stored.frame.image;
    if (stored.documentRequested && this.options.allowModelDocumentText && stored.frame.document) result.document = this.publicDocument(stored.frame.document);
    return result;
  }

  public candidateSummary(control: Control, observation?: StoredObservation): CandidateSummary {
    const result: CandidateSummary = {
      role: sanitizeText(control.role, 128),
      states: [...control.states],
      actions: control.actions.filter(this.options.grantedAction),
    };
    if (observation) {
      const ref = [...observation.refs.entries()].find(([, candidate]) => candidate.id === control.id)?.[0];
      if (ref && this.options.refsGranted) {
        result.ref = ref;
        result.observationId = observation.observationId;
      }
    }
    if (control.name !== undefined) result.name = sanitizeText(control.name, 512);
    if (control.rect) result.rect = { x: control.rect.x, y: control.rect.y, width: control.rect.width, height: control.rect.height };
    if (control.effect !== undefined) result.effect = control.effect;
    return result;
  }

  private publicControl(control: Control, ref: string): ControlObservation {
    const sensitive = isSensitiveControl(control);
    const result: ControlObservation = {
      ref,
      role: sanitizeText(control.role, 128),
      states: [...control.states],
      actions: control.actions.filter(this.options.grantedAction),
    };
    if (control.name !== undefined) result.name = sanitizeText(control.name, 512);
    if (control.rect) result.rect = { x: control.rect.x, y: control.rect.y, width: control.rect.width, height: control.rect.height };
    if (control.labels && control.labels.length > 0) result.labels = control.labels.map((label) => sanitizeText(label, 256));
    if (control.effect !== undefined) result.effect = control.effect;
    if (control.filterAction !== undefined) result.filterAction = control.filterAction;
    if (control.value !== undefined) {
      if (sensitive) result.valueRedacted = true;
      else result.value = sanitizeText(control.value, 1_024);
    }
    return result;
  }

  private publicDocument(document: DocumentObservation): DocumentObservation {
    const chunks: Array<DocumentObservation["chunks"][number]> = [];
    let usedChars = 0;
    for (const chunk of document.chunks) {
      if (chunks.length >= 256 || usedChars >= 64_000) break;
      const text = sanitizeText(chunk.text, Math.min(4_096, 64_000 - usedChars));
      if (!text) continue;
      chunks.push({ text, index: chunks.length });
      usedChars += text.length;
    }
    const sourceUrl = sanitizeSourceUrl(document.sourceUrl);
    const truncated = document.truncated || chunks.length < document.chunks.length || usedChars < document.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
    return {
      kind: "page_text",
      chunks,
      complete: document.complete && !truncated,
      truncated,
      viewportOnly: document.viewportOnly === true,
      totalChars: Math.max(0, Math.min(64_000, Math.floor(document.totalChars))),
      totalChunks: Math.max(0, Math.min(256, Math.floor(document.totalChunks))),
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }

  private makeRef(observationId: string, index: number): string {
    return `${observationId}-c${index}`;
  }
}

function sanitizeSourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `${url.origin}${url.pathname || "/"}`.slice(0, 2_048);
  } catch {
    return undefined;
  }
}
