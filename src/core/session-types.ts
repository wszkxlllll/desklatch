import type { ActionKind, Capability, Control, DocumentObservation, DocumentRead, Expect, Frame, RiskPolicy, Selector, State, Step, TargetForm } from "../contracts.js";

export interface ControlObservation {
  ref: string;
  role: string;
  name?: string;
  windowScope?: string;
  states: readonly State[];
  actions: readonly ActionKind[];
  rect?: { x: number; y: number; width: number; height: number };
  value?: string;
  valueRedacted?: boolean;
  labels?: readonly string[];
  effect?: Control["effect"];
  filterAction?: boolean;
  disclosure?: boolean;
  sameDocumentTab?: boolean;
  /** Compact view identity for read-side diffs. Act accepts the current ref. */
  snapshotKey?: string;
  valueTruncated?: boolean;
  labelsTruncated?: boolean;
}

export type ObservationProjectionRequest =
  | { readonly mode: "compact"; readonly maxControls?: number; readonly since?: string }
  | { readonly mode: "full" };

export interface ObservationProjection {
  readonly mode: "compact";
  readonly kind: "snapshot" | "unchanged" | "delta";
  readonly backendComplete: boolean;
  readonly truncated: boolean;
  readonly observedControls: number;
  readonly returnedControls: number;
  readonly base?: string;
  readonly fallback?: string;
  readonly basis?: "published_controls";
  readonly removed?: readonly string[];
  /** A read-side suggestion for narrowing an incomplete broad controls query. */
  readonly guidance?: string;
}

export interface DeskObservation {
  observationId: string;
  view: "controls" | "image" | "both" | "document";
  complete: boolean;
  controls: readonly ControlObservation[];
  image?: Frame["image"];
  /** Optional host-authorized page-provided rendered text. */
  document?: DocumentObservation;
  projection?: ObservationProjection;
}

export interface CandidateSummary {
  ref?: string;
  observationId?: string;
  role: string;
  name?: string;
  windowScope?: string;
  states: readonly State[];
  actions: readonly ActionKind[];
  rect?: { x: number; y: number; width: number; height: number };
  effect?: Control["effect"];
}

export type StepReceiptStatus = "verified" | "dispatched" | "partial" | "unknown" | "not_dispatched";

export interface StepReceipt {
  index: number;
  kind?: ActionKind;
  status: StepReceiptStatus;
  code?: string;
}

/** Bounded structural feedback for one atomic preflight validation failure. */
export interface ActValidationDiagnostic {
  readonly atStep?: number;
  readonly kind?: ActionKind;
  readonly constraint?: "observation_id_required" | "focus_from_step_earlier";
  readonly targetForms?: readonly TargetForm[];
  readonly requiredFields?: readonly string[];
  readonly allowedFields?: readonly string[];
  readonly allowedKeys?: readonly string[];
  readonly allowedChords?: readonly (readonly string[])[];
}

const VALIDATION_ACTIONS = new Set<ActionKind>(["click", "type", "setValue", "scroll", "keypress", "hotkey", "drag"]);
const VALIDATION_TARGET_FORMS = new Set<TargetForm>(["selector", "ref", "point", "focus", "path"]);
const VALIDATION_FIELDS = new Set(["kind", "target", "text", "value", "key", "keys", "from", "to", "button", "count", "direction", "amount", "by", "expect", "delivery"]);

/** Keep Code Mode receipts limited to the typed structural validation shape. */
export function sanitizeActValidationDiagnostic(value: unknown): ActValidationDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const atStep = typeof raw.atStep === "number" && Number.isSafeInteger(raw.atStep) && raw.atStep >= 1 && raw.atStep <= 512
    ? raw.atStep : undefined;
  const kind = typeof raw.kind === "string" && VALIDATION_ACTIONS.has(raw.kind as ActionKind) ? raw.kind as ActionKind : undefined;
  const constraint = raw.constraint === "observation_id_required" || raw.constraint === "focus_from_step_earlier"
    ? raw.constraint : undefined;
  const targetForms = Array.isArray(raw.targetForms)
    ? [...new Set(raw.targetForms.filter((entry): entry is TargetForm => typeof entry === "string" && VALIDATION_TARGET_FORMS.has(entry as TargetForm)))].slice(0, 5)
    : [];
  const fields = (name: "requiredFields" | "allowedFields") => Array.isArray(raw[name])
    ? [...new Set(raw[name].filter((entry): entry is string => typeof entry === "string" && VALIDATION_FIELDS.has(entry)))].slice(0, 16)
    : [];
  const requiredFields = fields("requiredFields");
  const allowedFields = fields("allowedFields");
  const allowedKeys = Array.isArray(raw.allowedKeys)
    ? [...new Set(raw.allowedKeys.filter((entry): entry is string => typeof entry === "string" && /^[A-Za-z0-9]{1,32}$/u.test(entry)))].slice(0, 32)
    : [];
  const allowedChords = Array.isArray(raw.allowedChords)
    ? raw.allowedChords.flatMap((entry): readonly string[][] => {
      if (!Array.isArray(entry) || entry.length < 2 || entry.length > 5 || !entry.every(item => typeof item === "string" && /^[A-Za-z0-9]{1,32}$/u.test(item))) return [];
      return [[...entry]];
    }).slice(0, 16)
    : [];
  if (atStep === undefined && kind === undefined && constraint === undefined && targetForms.length === 0
    && requiredFields.length === 0 && allowedFields.length === 0 && allowedKeys.length === 0 && allowedChords.length === 0) return undefined;
  return {
    ...(atStep === undefined ? {} : { atStep }),
    ...(kind === undefined ? {} : { kind }),
    ...(constraint === undefined ? {} : { constraint }),
    ...(targetForms.length === 0 ? {} : { targetForms }),
    ...(requiredFields.length === 0 ? {} : { requiredFields }),
    ...(allowedFields.length === 0 ? {} : { allowedFields }),
    ...(allowedKeys.length === 0 ? {} : { allowedKeys }),
    ...(allowedChords.length === 0 ? {} : { allowedChords }),
  };
}

/** Safe result-only feedback for a failed declared check before later steps. */
export const ACT_EXPECTATION_FAILURE_HINT = "The step identified by atStep was dispatched. Its check ran before the next step and failed, so later steps were not sent. Do not repeat the delivered step. If the intended condition depends on a later action, put the check on that action or read afterward." as const;

/** Safe result-only feedback when a grounded point click has no established effect. */
export const ACT_POINT_CLICK_EVIDENCE_HINT = "Do not retry the same pixels with the same evidence. Locate an explicit control or focused target; stop if unresolved." as const;

export type ActRecoveryHint = typeof ACT_EXPECTATION_FAILURE_HINT | typeof ACT_POINT_CLICK_EVIDENCE_HINT;

export interface ActResult {
  status: "completed" | "stopped" | "rejected";
  atStep?: number;
  code?: string;
  validation?: ActValidationDiagnostic;
  recoveryHint?: ActRecoveryHint;
  steps: readonly StepReceipt[];
  candidates?: readonly CandidateSummary[];
  requestId?: string;
  observationId?: string;
}

/** Host-only execution controls. Model-facing tools never expose this value. */
export interface DeskSessionActOptions {
  /** Run a verified replay with a pre-dispatch expectation short-circuit. */
  readonly replay?: boolean;
  /** Receive independently observed post-action evidence for host-owned capture. */
  readonly onVerifiedStep?: (evidence: VerifiedStepEvidence) => void;
}

/** Evidence emitted only after the normal target, policy, dispatch, and expect checks. */
export interface VerifiedStepEvidence {
  readonly index: number;
  readonly step: Step;
  readonly target: Control;
  readonly after: Control;
  readonly expectation: Expect;
  /** True only when the expected state was absent in the pre-action frame and present after dispatch. */
  readonly changed: boolean;
}

export interface ApprovalRequest {
  requestId: string;
  step: number;
  kind: ActionKind;
  summary: string;
  contextSummary?: string;
  target?: { role: string; name?: string };
  params: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  expiresAt: number;
}

export type ApprovalDecision = "approve" | "deny";
export type ApprovalResolution = ActResult & { requestId: string };
export type ApprovalHandler =
  (request: ApprovalRequest) => ApprovalDecision | boolean | void | Promise<ApprovalDecision | boolean | void>;

export interface DeskSessionOptions {
  policy?: RiskPolicy;
  allowModelImages?: boolean;
  /** Explicit model-surface gate; effective only when the backend opts in. */
  allowModelDocumentText?: boolean;
  maxSteps?: number;
  maxTextLength?: number;
  maxScrollAmount?: number;
  /** Public control list limit. Internal grounding still uses the backend's complete scope. */
  maxPublicControls?: number;
  capabilities?: readonly Capability[];
  timeoutMs?: number;
  approvalTimeoutMs?: number;
  expectTimeoutMs?: number;
  onApprovalRequested?: ApprovalHandler;
  signal?: AbortSignal;
  /** Keep legacy/full output unless a bounded projection is explicitly opted into. */
  defaultObservationProjection?: "compact" | "incremental";
}

export interface DeskObserveOptions {
  view?: "controls" | "image" | "both" | "document";
  where?: Selector;
  read?: DocumentRead;
  projection?: ObservationProjectionRequest;
  signal?: AbortSignal;
}

export interface DeskSession {
  readonly capabilities: readonly Capability[];
  readonly allowModelImages: boolean;
  readonly allowModelDocumentText: boolean;
  readonly limits: Readonly<{ maxSteps: number; maxTextLength: number; maxScrollAmount: number }>;
  readonly supportsObservationProjection?: true;
  readonly defaultObservationProjection?: "compact" | "incremental";
  observe(options?: DeskObserveOptions): Promise<DeskObservation>;
  act(raw: unknown, signal?: AbortSignal, options?: DeskSessionActOptions): Promise<ActResult>;
  /** Host-only replay boundary; absent on legacy/session adapters. */
  replay?(raw: unknown, signal?: AbortSignal): Promise<ActResult>;
  resolveApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalResolution>;
  correct(reason?: string): void;
  cancel(reason?: string): void;
  /** Host-only invalidation for the public snapshot history. */
  invalidateObservationSnapshots?(): void;
  close(): Promise<void>;
}
