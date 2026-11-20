import type { ActionKind, Capability, Control, DocumentObservation, DocumentRead, Expect, Frame, RiskPolicy, Selector, State, Step } from "../contracts.js";

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
}

export interface DeskObservation {
  observationId: string;
  view: "controls" | "image" | "both" | "document";
  complete: boolean;
  controls: readonly ControlObservation[];
  image?: Frame["image"];
  /** Optional host-authorized page-provided rendered text. */
  document?: DocumentObservation;
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

export interface ActResult {
  status: "completed" | "stopped" | "rejected";
  atStep?: number;
  code?: string;
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
}

export interface DeskObserveOptions {
  view?: "controls" | "image" | "both" | "document";
  where?: Selector;
  read?: DocumentRead;
  signal?: AbortSignal;
}

export interface DeskSession {
  readonly capabilities: readonly Capability[];
  readonly allowModelImages: boolean;
  readonly allowModelDocumentText: boolean;
  readonly limits: Readonly<{ maxSteps: number; maxTextLength: number; maxScrollAmount: number }>;
  observe(options?: DeskObserveOptions): Promise<DeskObservation>;
  act(raw: unknown, signal?: AbortSignal, options?: DeskSessionActOptions): Promise<ActResult>;
  /** Host-only replay boundary; absent on legacy/session adapters. */
  replay?(raw: unknown, signal?: AbortSignal): Promise<ActResult>;
  resolveApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalResolution>;
  correct(reason?: string): void;
  cancel(reason?: string): void;
  close(): Promise<void>;
}
