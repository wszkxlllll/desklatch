import type { ActionKind, Capability, Control, Frame, RiskPolicy, Selector, State } from "../contracts.js";

export interface ControlObservation {
  ref: string;
  role: string;
  name?: string;
  states: readonly State[];
  actions: readonly ActionKind[];
  rect?: { x: number; y: number; width: number; height: number };
  value?: string;
  valueRedacted?: boolean;
  labels?: readonly string[];
  effect?: Control["effect"];
  filterAction?: boolean;
}

export interface DeskObservation {
  observationId: string;
  view: "controls" | "image" | "both";
  complete: boolean;
  controls: readonly ControlObservation[];
  image?: Frame["image"];
}

export interface CandidateSummary {
  ref?: string;
  observationId?: string;
  role: string;
  name?: string;
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
  maxSteps?: number;
  maxTextLength?: number;
  maxScrollAmount?: number;
  capabilities?: readonly Capability[];
  timeoutMs?: number;
  approvalTimeoutMs?: number;
  expectTimeoutMs?: number;
  onApprovalRequested?: ApprovalHandler;
  signal?: AbortSignal;
}

export interface DeskObserveOptions {
  view?: "controls" | "image" | "both";
  where?: Selector;
  signal?: AbortSignal;
}

export interface DeskSession {
  readonly capabilities: readonly Capability[];
  readonly allowModelImages: boolean;
  readonly limits: Readonly<{ maxSteps: number; maxTextLength: number; maxScrollAmount: number }>;
  observe(options?: DeskObserveOptions): Promise<DeskObservation>;
  act(raw: unknown, signal?: AbortSignal): Promise<ActResult>;
  resolveApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalResolution>;
  correct(reason?: string): void;
  cancel(reason?: string): void;
  close(): Promise<void>;
}
