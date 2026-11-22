import { createHash, randomUUID } from "node:crypto";
import type { ActionKind, Control, DocumentObservation, Frame, View } from "../contracts.js";
import type { CandidateSummary, ControlObservation, DeskObservation, ObservationProjection } from "./session-types.js";

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
  maxPublicControls?: number;
}

export interface ObservationProjectionOptions {
  readonly mode: "compact" | "full";
  readonly maxControls?: number;
  readonly since?: string;
}

type ProjectionMetadata = ObservationProjection;

type ProjectionObservation = DeskObservation & { projection?: ProjectionMetadata };
type ProjectionControl = ControlObservation & {
  snapshotKey?: string;
  nameTruncated?: boolean;
  windowScopeTruncated?: boolean;
  valueTruncated?: boolean;
  labelsTruncated?: boolean;
};

interface CompactRecord {
  readonly source: Control;
  readonly ref: string;
  readonly snapshotKey: string;
  readonly control: ProjectionControl;
  readonly fingerprint: string;
  readonly clipped: boolean;
}

interface PublicSnapshot {
  readonly observationId: string;
  readonly createdAt: number;
  readonly scope: string;
  readonly queryKey?: string;
  readonly maxControls: number;
  readonly view: View;
  readonly windowScopes: readonly string[];
  readonly eligibleForDelta: boolean;
  readonly eligibleForPublishedDelta: boolean;
  readonly rows: ReadonlyMap<string, { fingerprint: string }>;
}

const CREDENTIAL_WORDS = /password|passwd|passcode|passphrase|secret|token|credential|authorization|cookie|api[ _-]?key|access[ _-]?key|private[ _-]?key|\bpin\b|\botp\b|cvv|cvc|card[ _-]?number|security[ _-]?code|ssn|密码|密钥|令牌|验证码|安全码|卡号|身份证/iu;
const SAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const PROJECTION_TTL_MS = 90_000;
const MAX_PUBLIC_SNAPSHOTS = 4;
const DEFAULT_COMPACT_CONTROLS = 48;
const MAX_COMPACT_LABELS = 4;
const MAX_COMPACT_LABEL_LENGTH = 128;
const MAX_COMPACT_VALUE_LENGTH = 512;
const MAX_COMPACT_BYTES = 9 * 1024;

function publicPriority(control: Control): number {
  return control.states.includes("focused") ? 2 : control.actions.length > 0 ? 1 : 0;
}

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
  private readonly publicSnapshots = new Map<string, PublicSnapshot>();
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

  public invalidatePublicSnapshots(): void {
    this.publicSnapshots.clear();
  }

  public publicObservation(
    stored: StoredObservation,
    view: View,
    projection?: ObservationProjectionOptions,
    queryKey?: string,
    automaticIncremental = false,
  ): DeskObservation {
    if (projection?.mode === "compact") return this.compactObservation(stored, view, projection, queryKey, automaticIncremental);
    return this.fullObservation(stored, view);
  }

  private fullObservation(stored: StoredObservation, view: View): DeskObservation {
    const limit = this.options.maxPublicControls ?? stored.frame.controls.length;
    const entries = [...stored.refs];
    if (entries.length > limit) {
      entries.sort(([, left], [, right]) => publicPriority(right) - publicPriority(left));
      for (const [ref] of entries.slice(limit)) stored.refs.delete(ref);
    }
    const controls = entries.slice(0, limit).map(([ref, control]) => this.publicControl(control, ref));
    const result: DeskObservation = {
      observationId: stored.observationId,
      view,
      complete: stored.frame.complete && controls.length === stored.frame.controls.length,
      controls,
    };
    if ((view === "image" || view === "both") && this.options.allowModelImages && stored.frame.image) result.image = stored.frame.image;
    if (stored.documentRequested && this.options.allowModelDocumentText && stored.frame.document) result.document = this.publicDocument(stored.frame.document);
    return result;
  }

  private compactObservation(
    stored: StoredObservation,
    view: View,
    projection: ObservationProjectionOptions,
    queryKey: string | undefined,
    automaticIncremental: boolean,
  ): ProjectionObservation {
    const backendComplete = stored.frame.complete;
    const observedControls = stored.frame.controls.length;
    const requestedLimit = Number.isSafeInteger(projection.maxControls) && projection.maxControls! > 0
      ? projection.maxControls! : DEFAULT_COMPACT_CONTROLS;
    const configuredLimit = this.options.maxPublicControls ?? requestedLimit;
    const maxControls = Math.max(1, Math.min(configuredLimit, requestedLimit));
    const now = Date.now();
    const refByControl = new Map<Control, string>();
    for (const [ref, control] of stored.refs) {
      if (!refByControl.has(control)) refByControl.set(control, ref);
    }
    // Geometry is still a useful bound for the host-side focus proof.  The
    // byte budget below is the limiting factor; unlike image pixels, a rect
    // is small and does not disclose a separate model image capability.
    const includeRect = true;
    const imageOnly = view === "image";
    const selected = imageOnly
      ? { records: [], truncated: false }
      : this.selectCompactControls(stored, refByControl, maxControls, includeRect);
    const identityState = this.uniqueControlIds(stored.frame.controls);
    const windowScopes = this.normalizedWindowScopes(stored.frame.controls);
    // A pixels-only compact observation deliberately suppresses controls. That
    // is omission by view contract, not byte truncation. The backend's own
    // completeness remains exposed separately below.
    const modelTruncated = imageOnly ? false : selected.truncated;
    const queryEligible = typeof queryKey === "string";
    const previousSentinel = projection.since === "previous";
    const publishedDeltaEligible = (view === "controls" || view === "both")
      && backendComplete
      && identityState.unique
      && queryEligible;
    const canPublishedDelta = previousSentinel && publishedDeltaEligible;
    const canDelta = view === "controls"
      && backendComplete
      && !modelTruncated
      && identityState.unique
      && queryEligible;
    const explicitPrevious = !previousSentinel && projection.since !== undefined
      ? this.publicSnapshots.get(projection.since)
      : undefined;
    this.pruneSnapshots(now);
    const lookedUpPrevious = previousSentinel
      ? this.latestCompatibleSnapshot(view, queryKey, maxControls)
      : explicitPrevious;
    const previous = lookedUpPrevious !== undefined
      && (now - lookedUpPrevious.createdAt > PROJECTION_TTL_MS
        || this.publicSnapshots.get(lookedUpPrevious.observationId) === lookedUpPrevious)
      ? lookedUpPrevious
      : undefined;
    let effectiveFallback: string | undefined;
    let sameBase = false;
    if (view !== "controls" && !previousSentinel) effectiveFallback = "controls_only";
    else if (!backendComplete && projection.since === undefined) effectiveFallback = "backend_incomplete";
    if (projection.since !== undefined && effectiveFallback === undefined) {
      if (previous === undefined) effectiveFallback = previousSentinel ? "since_previous_missing" : "since_invalid";
      else if (now - previous.createdAt > PROJECTION_TTL_MS) effectiveFallback = "since_expired";
      else if (previous.scope !== stored.frame.scope) effectiveFallback = "since_scope_changed";
      else if (previous.queryKey !== queryKey || queryKey === undefined) effectiveFallback = "since_query_changed";
      else if (previous.maxControls !== maxControls) effectiveFallback = "since_limits_changed";
      else if (previous.view !== view) effectiveFallback = "since_view_changed";
      else if (!this.sameWindowScopes(previous.windowScopes, windowScopes)) effectiveFallback = "since_window_scope_changed";
      else if (previousSentinel) {
        if (!previous.eligibleForPublishedDelta || !canPublishedDelta) effectiveFallback = modelTruncated ? "since_delta_truncated" : "since_delta_unsafe";
        else sameBase = true;
      } else if (!previous.eligibleForDelta || !canDelta) effectiveFallback = modelTruncated ? "since_delta_truncated" : "since_delta_unsafe";
      else sameBase = true;
    }
    const currentRows = new Map(selected.records.map((row) => [row.snapshotKey, { fingerprint: row.fingerprint }] as const));
    let kind: ProjectionMetadata["kind"] = "snapshot";
    let returned = selected.records;
    let base: string | undefined;
    let removed: string[] | undefined;
    let basis: ProjectionMetadata["basis"] | undefined;
    let deltaTooLarge = false;
    if (sameBase && previous) {
      const changed = selected.records.filter((row) => previous.rows.get(row.snapshotKey)?.fingerprint !== row.fingerprint);
      const currentIds = new Set(currentRows.keys());
      removed = [...previous.rows.keys()].filter((key) => !currentIds.has(key));
      const comparingPublishedControls = previousSentinel && canPublishedDelta;
      if (automaticIncremental && comparingPublishedControls && (changed.length > 0 || removed.length > 0)) {
        // Include the base/basis metadata and a small framing allowance. The
        // automatic path should emit a delta only when it is meaningfully
        // smaller than the current bounded snapshot.
        const deltaBytes = this.compactRecordsBytes(changed)
          + Buffer.byteLength(JSON.stringify(removed ?? []), "utf8")
          + Buffer.byteLength(previous.observationId, "utf8")
          + 256;
        const snapshotBytes = this.compactRecordsBytes(selected.records);
        if (deltaBytes >= snapshotBytes) {
          deltaTooLarge = true;
          effectiveFallback = "delta_not_smaller";
          removed = undefined;
        }
      }
      if (!deltaTooLarge && changed.length === 0 && (removed?.length ?? 0) === 0) {
        kind = "unchanged";
        returned = [];
      } else if (!deltaTooLarge) {
        kind = "delta";
        returned = changed;
      }
      if (!deltaTooLarge) {
        base = projection.since === "previous" ? previous.observationId : projection.since;
        if (comparingPublishedControls) basis = "published_controls";
      }
    }
    this.pruneRefs(stored, returned);
    this.publicSnapshots.set(stored.observationId, {
      observationId: stored.observationId,
      createdAt: now,
      scope: stored.frame.scope,
      ...(queryKey === undefined ? {} : { queryKey }),
      maxControls,
      view,
      windowScopes,
      eligibleForDelta: canDelta,
      eligibleForPublishedDelta: publishedDeltaEligible,
      rows: (canDelta || publishedDeltaEligible) ? currentRows : new Map(),
    });
    this.pruneSnapshots(now);
    const truncated = modelTruncated;
    const result: ProjectionObservation = {
      observationId: stored.observationId,
      view,
      complete: kind === "snapshot" && backendComplete && !truncated,
      controls: returned.map(row => row.control),
      projection: {
        mode: "compact",
        kind,
        backendComplete,
        truncated,
        observedControls,
        returnedControls: returned.length,
        ...(base === undefined ? {} : { base }),
        ...(effectiveFallback === undefined ? {} : { fallback: effectiveFallback }),
        ...(basis === undefined ? {} : { basis }),
        ...(removed && removed.length > 0 ? { removed } : {}),
      },
    };
    if ((view === "image" || view === "both") && this.options.allowModelImages && stored.frame.image) result.image = stored.frame.image;
    if (stored.documentRequested && this.options.allowModelDocumentText && stored.frame.document) result.document = this.publicDocument(stored.frame.document);
    return result;
  }

  private pruneSnapshots(now: number): void {
    for (const [key, snapshot] of this.publicSnapshots) {
      if (now - snapshot.createdAt > PROJECTION_TTL_MS) this.publicSnapshots.delete(key);
    }
    while (this.publicSnapshots.size > MAX_PUBLIC_SNAPSHOTS) {
      const oldest = this.publicSnapshots.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.publicSnapshots.delete(oldest);
    }
  }

  /**
   * Resolve the most recent compact snapshot for the same published query.
   * The scope and window checks remain in compactObservation so a changed
   * desktop never inherits a previous target set.
   */
  private latestCompatibleSnapshot(
    view: View,
    queryKey: string | undefined,
    maxControls: number,
  ): PublicSnapshot | undefined {
    const snapshots = [...this.publicSnapshots.values()].reverse();
    const candidates = snapshots.filter((snapshot) => snapshot.view === view
      && snapshot.queryKey === queryKey
      && snapshot.maxControls === maxControls);
    // The newest matching query is the only valid baseline. Falling back to an
    // older same-scope snapshot could bridge an intervening navigation or
    // authorization change without exposing the mismatch to the caller.
    return candidates[0];
  }

  private compactRecordsBytes(records: readonly CompactRecord[]): number {
    return Buffer.byteLength(JSON.stringify(records.map((record) => record.control)), "utf8");
  }

  private uniqueControlIds(controls: readonly Control[]): { unique: boolean } {
    const seen = new Set<string>();
    let unique = true;
    for (const control of controls) {
      const id = control.id;
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) unique = false;
      seen.add(id);
    }
    return { unique };
  }

  private selectCompactControls(
    stored: StoredObservation,
    refByControl: ReadonlyMap<Control, string>,
    maxControls: number,
    includeRect: boolean,
  ): { records: CompactRecord[]; truncated: boolean } {
    const idCounts = new Map<string, number>();
    for (const control of stored.frame.controls) idCounts.set(control.id, (idCounts.get(control.id) ?? 0) + 1);
    const idOrdinals = new Map<string, number>();
    const indexed = stored.frame.controls
      .map((control, index) => {
        const ordinal = idOrdinals.get(control.id) ?? 0;
        idOrdinals.set(control.id, ordinal + 1);
        return {
          control,
          index,
          ref: refByControl.get(control),
          score: this.compactPriority(control),
          duplicateOrdinal: (idCounts.get(control.id) ?? 0) > 1 ? ordinal : undefined,
        };
      })
      .filter((entry): entry is { control: Control; index: number; ref: string; score: number; duplicateOrdinal: number | undefined } => entry.ref !== undefined);
    indexed.sort((left, right) => right.score - left.score || left.index - right.index);
    const records: CompactRecord[] = [];
    let bytes = 0;
    let truncated = indexed.length !== stored.frame.controls.length || indexed.length > maxControls;
    for (const entry of indexed) {
      if (records.length >= maxControls) {
        truncated = true;
        break;
      }
      const snapshotKey = this.compactSnapshotKey(entry.control, stored.frame, entry.duplicateOrdinal);
      const compact = this.compactControl(entry.control, entry.ref, snapshotKey, includeRect);
      const size = Buffer.byteLength(JSON.stringify(compact.control), "utf8");
      if (bytes > 0 && bytes + size > MAX_COMPACT_BYTES) {
        truncated = true;
        break;
      }
      if (bytes === 0 && size > MAX_COMPACT_BYTES) {
        truncated = true;
        break;
      }
      records.push({
        source: entry.control,
        ref: entry.ref,
        snapshotKey,
        control: compact.control,
        fingerprint: this.controlFingerprint(compact.control),
        clipped: compact.clipped,
      });
      bytes += size;
      if (compact.clipped) truncated = true;
    }
    return { records, truncated };
  }

  private compactPriority(control: Control): number {
    let score = 0;
    if (control.states.includes("focused")) score += 1_000;
    if (control.value !== undefined) score += 400;
    if (control.states.includes("editable")) score += 300;
    if (control.name !== undefined && control.name.length > 0) score += 200;
    if (control.actions.some(this.options.grantedAction)) score += 100;
    return score;
  }

  private compactControl(
    control: Control,
    ref: string,
    snapshotKey: string,
    includeRect: boolean,
  ): { control: ProjectionControl; clipped: boolean } {
    const sensitive = isSensitiveControl(control);
    const result: ProjectionControl = {
      snapshotKey,
      ref,
      role: sanitizeText(control.role, 128),
      states: [...control.states],
      actions: control.actions.filter(this.options.grantedAction),
    };
    let clipped = false;
    if (control.name !== undefined) {
      result.name = sanitizeText(control.name, 512);
      if (control.name.length > 512) {
        result.nameTruncated = true;
        clipped = true;
      }
    }
    if (control.windowScope !== undefined) {
      result.windowScope = sanitizeText(control.windowScope, 128);
      if (control.windowScope.length > 128) {
        result.windowScopeTruncated = true;
        clipped = true;
      }
    }
    if (includeRect && control.rect) result.rect = { x: control.rect.x, y: control.rect.y, width: control.rect.width, height: control.rect.height };
    if (control.labels && control.labels.length > 0) {
      result.labels = control.labels.slice(0, MAX_COMPACT_LABELS).map(label => sanitizeText(label, MAX_COMPACT_LABEL_LENGTH));
      if (control.labels.length > MAX_COMPACT_LABELS || control.labels.some((label) => label.length > MAX_COMPACT_LABEL_LENGTH)) {
        result.labelsTruncated = true;
        clipped = true;
      }
    }
    if (control.effect !== undefined) result.effect = control.effect;
    if (control.filterAction !== undefined) result.filterAction = control.filterAction;
    if (control.disclosure !== undefined) result.disclosure = control.disclosure;
    if (control.sameDocumentTab !== undefined) result.sameDocumentTab = control.sameDocumentTab;
    if (control.value !== undefined) {
      if (sensitive) result.valueRedacted = true;
      else {
        result.value = sanitizeText(control.value, MAX_COMPACT_VALUE_LENGTH);
        if (control.value.length > MAX_COMPACT_VALUE_LENGTH) {
          result.valueTruncated = true;
          clipped = true;
        }
      }
    }
    return { control: result, clipped };
  }

  private controlFingerprint(control: ProjectionControl): string {
    const { ref: _ref, snapshotKey: _snapshotKey, ...stable } = control;
    return JSON.stringify(stable);
  }

  private compactSnapshotKey(control: Control, frame: Frame, duplicateOrdinal: number | undefined): string {
    const shape = {
      role: control.role,
      name: control.name ?? "",
      within: control.within ?? "",
      windowScope: control.windowScope ?? "",
      duplicateOrdinal: duplicateOrdinal ?? "",
    };
    return createHash("sha256")
      .update(JSON.stringify([this.namespace, control.id, frame.scope, control.windowScope ?? "", shape]))
      .digest("hex")
      .slice(0, 24);
  }

  private normalizedWindowScopes(controls: readonly Control[]): string[] {
    return [...new Set(controls
      .map((control) => typeof control.windowScope === "string" ? control.windowScope.trim() : "")
      .filter((scope) => scope.length > 0))].sort();
  }

  private sameWindowScopes(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((scope, index) => scope === right[index]);
  }

  private pruneRefs(stored: StoredObservation, returned: readonly CompactRecord[]): void {
    stored.refs.clear();
    for (const row of returned) stored.refs.set(row.ref, row.source);
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
    if (control.windowScope !== undefined) result.windowScope = sanitizeText(control.windowScope, 128);
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
    if (control.windowScope !== undefined) result.windowScope = sanitizeText(control.windowScope, 128);
    if (control.rect) result.rect = { x: control.rect.x, y: control.rect.y, width: control.rect.width, height: control.rect.height };
    if (control.labels && control.labels.length > 0) result.labels = control.labels.map((label) => sanitizeText(label, 256));
    if (control.effect !== undefined) result.effect = control.effect;
    if (control.filterAction !== undefined) result.filterAction = control.filterAction;
    if (control.disclosure !== undefined) result.disclosure = control.disclosure;
    if (control.sameDocumentTab !== undefined) result.sameDocumentTab = control.sameDocumentTab;
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
      ...(document.query === undefined ? {} : { query: sanitizeText(document.query, 256) }),
      ...(document.matchCount === undefined ? {} : { matchCount: Math.max(0, Math.min(256, Math.floor(document.matchCount))) }),
      ...(document.nextCursor === undefined ? {} : { nextCursor: sanitizeText(document.nextCursor, 512) }),
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
