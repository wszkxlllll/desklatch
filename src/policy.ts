import type {
  ActionKind,
  Control,
  Effect,
  Rect,
  RiskDecision,
  RiskInput,
  RiskPolicy,
  Step,
  State,
} from "./contracts.js";

/**
 * The policy deliberately has no model, OCR, desktop, or network dependency.
 * A host may inject a local OCR adapter and/or a text-only reviewer through
 * `createRiskPolicy`; the default policy never asks either one for help.
 */
export const RISK_POLICY_VERSION = "desklatch-risk-v2";

export type RiskCategory =
  | "external"
  | "financial"
  | "destructive"
  | "security"
  | "sensitive"
  | "unknown";

export interface TextRiskControl {
  id: string;
  role: string;
  name?: string;
  within?: string;
  states: readonly State[];
  actions: readonly ActionKind[];
  effect?: Effect;
  sensitive?: boolean;
  /** Values are intentionally not included: reviewers receive text facts, not input contents. */
  valueLength?: number;
}

export interface TextRiskReviewRequest {
  /** The action kind and safe parameter facts; text/setValue contents are reduced to lengths. */
  action: {
    kind: ActionKind;
    textLength?: number;
    valueLength?: number;
    key?: string;
    keys?: readonly string[];
    button?: "left" | "right";
    count?: 1 | 2;
    direction?: "up" | "down" | "left" | "right";
    amount?: number;
    by?: "line" | "page";
  };
  target: TextRiskControl;
  destination?: TextRiskControl;
  /** Bounded local OCR text, when the host opted into OCR. No image is ever passed here. */
  localText?: readonly TextRiskOcrLine[];
  /** Why the structural path could not determine the immediate consequence. */
  reason: string;
}

export interface TextRiskOcrLine {
  text: string;
  confidence?: number;
  /** A box is evidence metadata only; it does not grant geometry permission. */
  box?: readonly [number, number, number, number];
}

export type TextRiskReview =
  | {
      classification: "clear" | "low";
      reason?: string;
    }
  | {
      classification: "suspicious" | "high" | "unknown" | "unclear";
      reason?: string;
    }
  | {
      /** A reviewer may explicitly deny, but can never override a local hard denial. */
      decision: "allow" | "approve" | "deny";
      reason?: string;
      classification?: "clear" | "low" | "suspicious" | "high" | "unknown" | "unclear";
    };

/**
 * A reviewer is intentionally text-only. Implementations may call a local
 * model or another host service, but they receive no FrameImage and have no
 * dispatch/approval capability.
 */
export type TextRiskReviewer =
  | ((request: TextRiskReviewRequest, signal: AbortSignal) => Promise<TextRiskReview> | TextRiskReview)
  | {
      review(request: TextRiskReviewRequest, signal: AbortSignal): Promise<TextRiskReview> | TextRiskReview;
    }
  | {
      classify(request: TextRiskReviewRequest, signal: AbortSignal): Promise<TextRiskReview> | TextRiskReview;
    };

export interface LocalOcrRequest {
  input: RiskInput;
  /** Only a host-provided bounded region is allowed. Omitted means no OCR call. */
  region: Rect;
  /** Optional host-local image/crop. It is passed only to the local OCR hook. */
  image?: unknown;
  /** The host adapter owns image acquisition; policy never stores or forwards pixels. */
  signal: AbortSignal;
}

export interface LocalOcrResult {
  lines: readonly TextRiskOcrLine[];
  /** A host should identify the model; policy rejects non-local/download-backed adapters. */
  source?: "local";
  model?: "PP-OCRv5-mobile" | string;
}

/** Host-owned, lazy OCR adapter. No OCR engine is bundled in DeskLatch core. */
export interface LocalOcrProvider {
  readonly localOnly?: true;
  readonly model?: string;
  /** Optional host-local image acquisition, called only on the OCR path. */
  getImage?(request: Omit<LocalOcrRequest, "image">): Promise<unknown>;
  recognize(request: LocalOcrRequest): Promise<LocalOcrResult>;
}

export type HostRuleResult =
  | boolean
  | string
  | {
      match: boolean;
      code?: string;
    };

export type RiskHostRule = (input: RiskInput, signal: AbortSignal) => HostRuleResult | Promise<HostRuleResult>;

export interface RiskHostRules {
  /** Cannot be overridden by a reviewer or a low-risk structural result. */
  hardDeny?: RiskHostRule;
  /** Requires the host's one-time approval flow; it never silently allows. */
  requireApproval?: RiskHostRule;
}

export interface RiskPolicyOptions {
  /** The sole reviewer hook. It receives a text-only request. */
  reviewer?: TextRiskReviewer;
  /** Optional lazy local OCR. It is only used when structural evidence is insufficient. */
  ocr?: LocalOcrProvider;
  /** Region provider. If absent, policy will use target.rect only. */
  ocrRegion?: (input: RiskInput) => Rect | undefined;
  /** Override the per-hook deadline. Defaults: 1s for host rules, 5s for OCR or review. */
  timeoutMs?: number;
  /** Optional cumulative cap shared by OCR and review for this policy instance. Each evaluation tries each at most once. */
  maxExternalRequests?: number;
  /** Host rules run before any optional reviewer and OCR. */
  hostRules?: RiskHostRules;
  /** Additional key combinations that are forbidden for this host. */
  forbiddenHotkeys?: readonly (readonly string[])[];
}

type RiskEvidence =
  | {
      kind: "ocr";
      input: RiskInput;
      region: Rect;
      lines: readonly TextRiskOcrLine[];
      revalidationReserved: boolean;
    }
  | {
      kind: "review";
      input: RiskInput;
      request: TextRiskReviewRequest;
      /** Present when the reviewer saw OCR text and therefore needs fresh visual evidence. */
      ocr?: { region: Rect; lines: readonly TextRiskOcrLine[]; revalidationReserved: boolean };
    };

type RiskPolicyRechecker = (
  originalDecision: RiskDecision,
  originalInput: RiskInput,
  refreshedInput: RiskInput,
) => Promise<RiskDecision>;

// These maps deliberately never cross the public approval request boundary.
// A pending approval keeps the returned decision object, while the optional
// evidence that produced it remains host-only and can only be reused for that
// exact decision/input pair during the one approval resumption.
const riskEvidence = new WeakMap<RiskDecision, RiskEvidence>();
const riskPolicyRecheckers = new WeakMap<RiskPolicy, RiskPolicyRechecker>();

/** Internal session hook: recheck live host rules without repeating exact evidence. */
export function recheckRiskApproval(
  policy: RiskPolicy,
  originalDecision: RiskDecision,
  originalInput: RiskInput,
  refreshedInput: RiskInput,
): Promise<RiskDecision> | undefined {
  const rechecker = riskPolicyRecheckers.get(policy);
  return rechecker?.(originalDecision, originalInput, refreshedInput);
}

interface LocalClassification {
  decision: RiskDecision["decision"] | "review";
  code: string;
  category?: RiskCategory;
  reason: string;
}

const HOST_RULE_TIMEOUT_MS = 1_000;
const EVIDENCE_TIMEOUT_MS = 5_000;
const MAX_REVIEW_TEXT = 320;
const MAX_OCR_LINES = 24;
const HIGH_RISK_EFFECTS = new Map<Effect, RiskCategory>([
  ["external", "external"],
  ["financial", "financial"],
  ["destructive", "destructive"],
  ["security", "security"],
  ["sensitive", "sensitive"],
]);

const ACTION_VERBS = {
  external: /(?:^|[\s_:-])(?:send|publish|post|submit|share|transfer|发送|发布|提交|转发|共享)(?:$|[\s_:-])/iu,
  financial: /(?:^|[\s_:-])(?:pay|purchase|buy|checkout|charge|refund|付款|支付|购买|结算|退款)(?:$|[\s_:-])/iu,
  destructive: /(?:^|[\s_:-])(?:delete|erase|wipe|remove|destroy|overwrite|replace|revoke|永久删除|彻底删除|清空|删除|覆盖|替换|撤销)(?:$|[\s_:-])/iu,
  security: /(?:^|[\s_:-])(?:grant|permission|permissions|admin|administrator|role|authorize|密码|凭据|权限|管理员|授权)(?:$|[\s_:-])/iu,
};

const VIEW_ACTION_TEXT = /^(?:(?:view|inspect|browse|filter|search|query|find|expand|collapse|refresh)(?:$|[\s:…])|(?:查看|浏览|筛选|搜索|查询|展开|折叠|刷新))/iu;
const NAVIGATION_ACTION_TEXT = /^(?:back|previous|(?:previous|next) page|close|cancel|settings|preferences|help|返回|上一步|上一页|下一页|关闭|取消|设置|帮助)$/iu;
const MENU_CAPTION_TEXT = /^(?:file|edit|view|tools|window|format|文件|编辑|视图|工具|窗口|格式)$/iu;
const OPEN_VIEW_TEXT = /^(?:(?:open|show|hide|close) (?:.+ )?(?:menu|panel|popup|popover|sidebar|tab|dialog)|(?:打开|显示|隐藏|关闭).*(?:菜单|面板|弹窗|侧栏|选项卡|对话框))$/iu;

const NEGATED_RISK_TEXT = /^(?:(?:do not|don['’]t|not) (?:send|publish|post|submit)|(?:不|不要|取消)(?:发送|发布|提交))$/iu;

/** Default local-only policy. It never invokes OCR, a reviewer, or external code. */
export const defaultRiskPolicy: RiskPolicy = createRiskPolicy();

/**
 * Construct an independent policy for one host/session. The returned function
 * is stateful only if the host sets a cumulative evidence budget; no approval is
 * cached, so a host must explicitly handle each `approve` result once.
 */
export function createRiskPolicy(options: RiskPolicyOptions = {}): RiskPolicy {
  const ruleTimeoutMs = boundedTimeout(options.timeoutMs ?? HOST_RULE_TIMEOUT_MS);
  const evidenceTimeoutMs = boundedTimeout(options.timeoutMs ?? EVIDENCE_TIMEOUT_MS);
  let remainingRequests = boundedRequestBudget(options.maxExternalRequests);
  const hostRules = options.hostRules ?? {};
  const reviewer = options.reviewer;
  const ocr = options.ocr;
  const forbiddenHotkeys = new Set((options.forbiddenHotkeys ?? []).map(normalizeHotkey));

  const getOcrRegion = (input: RiskInput): Rect | undefined => {
    try {
      return options.ocrRegion ? options.ocrRegion(input) : input.target.rect;
    } catch {
      return undefined;
    }
  };

  const freshOcr = async (
    evidence: { region: Rect; lines: readonly TextRiskOcrLine[]; revalidationReserved: boolean },
    input: RiskInput,
  ): Promise<{ lines: readonly TextRiskOcrLine[] } | { decision: RiskDecision }> => {
    if (ocr === undefined || (!evidence.revalidationReserved && remainingRequests === 0)) {
      return { decision: decision("needs_evidence", "ocr_revalidation_budget_exhausted", "Fresh local visual evidence is required before approval can resume.") };
    }
    const region = getOcrRegion(input);
    if (region === undefined || !isBoundedRegion(region) || !sameRect(region, evidence.region)) {
      return { decision: decision("needs_evidence", "ocr_evidence_changed", "The bounded visual evidence changed before approval resumed.") };
    }
    if (evidence.revalidationReserved) evidence.revalidationReserved = false;
    else remainingRequests -= 1;
    const result = await runOcr(ocr, {
      input,
      region,
      signal: input.signal ?? new AbortController().signal,
    }, evidenceTimeoutMs);
    if (result.kind === "aborted") return { decision: decision("deny", "aborted", "The action was cancelled during local evidence collection.") };
    if (result.kind !== "ok") return { decision: decision("needs_evidence", result.code, "Fresh local visual evidence could not be collected.") };
    if (evidenceFingerprint(result.lines) !== evidenceFingerprint(evidence.lines)) {
      return { decision: decision("needs_evidence", "ocr_evidence_changed", "The bounded visual evidence changed before approval resumed.") };
    }
    return { lines: result.lines };
  };

  const riskPolicy: RiskPolicy = async function riskPolicy(input: RiskInput): Promise<RiskDecision> {
    const basic = validateInput(input);
    if (basic !== undefined) return basic;

    const aborted = input.signal?.aborted === true;
    if (aborted) return decision("deny", "aborted", "The action was cancelled before risk evaluation.");

    const hardRule = hostRules.hardDeny;
    if (hardRule !== undefined) {
      const result = await runHostRule(hardRule, input, ruleTimeoutMs, input.signal);
      if (result.kind === "aborted") return decision("deny", "aborted", "The action was cancelled during host policy evaluation.");
      if (result.kind === "error") return decision("deny", "host_rule_failed_closed", "The host denial rule failed; the action is stopped.");
      if (result.match) return decision("deny", result.code ?? "host_denied", "The host policy denied this action.");
    }

    const local = classifyStructurally(input, forbiddenHotkeys);
    if (local.decision === "deny" || local.decision === "needs_evidence") return decision(local.decision, local.code, local.reason);

    const approvalRule = hostRules.requireApproval;
    if (approvalRule !== undefined) {
      const result = await runHostRule(approvalRule, input, ruleTimeoutMs, input.signal);
      if (result.kind === "aborted") return decision("deny", "aborted", "The action was cancelled during host policy evaluation.");
      if (result.kind === "error") return decision("deny", "host_rule_failed_closed", "The host approval rule could not be checked.");
      if (result.match) return decision("approve", result.code ?? "host_approval_required", "The host policy requires approval for this action.");
    }

    if (local.decision !== "review") {
      return decision(local.decision, local.code, local.reason);
    }

    // Structural evidence is insufficient. OCR is deliberately lazy and only
    // gets a host-bounded region; its text is never sent to an image-capable API.
    let localText: readonly TextRiskOcrLine[] | undefined;
    let localRegion: Rect | undefined;
    if (ocr !== undefined && remainingRequests > 0) {
      const region = getOcrRegion(input);
      if (region !== undefined && isBoundedRegion(region)) {
        localRegion = region;
        remainingRequests -= 1;
        const ocrResult = await runOcr(ocr, { input, region, signal: input.signal ?? new AbortController().signal }, evidenceTimeoutMs);
        if (ocrResult.kind === "ok") {
          localText = ocrResult.lines;
          const ocrRisk = classifyOcrText(localText);
          if (ocrRisk !== undefined) {
            // Approval based on pixels needs one fresh bounded OCR pass at
            // resume. Do not create consent that the configured cap cannot
            // actually revalidate.
            if (remainingRequests === 0) {
              return decision("needs_evidence", "ocr_revalidation_budget_exhausted", "Fresh local visual evidence is required before approval can resume.");
            }
            // Reserve the fresh pass now so concurrent pending approvals
            // cannot all spend the same final request at resume time.
            remainingRequests -= 1;
            return rememberRiskEvidence(
              decision("approve", ocrRisk.code, ocrRisk.reason),
              { kind: "ocr", input, region: cloneRect(region), lines: localText, revalidationReserved: true },
            );
          }
        } else if (ocrResult.kind === "aborted") {
          return decision("deny", "aborted", "The action was cancelled during local evidence collection.");
        }
      }
    }

    if (reviewer === undefined) return decision("needs_evidence", local.code, local.reason);
    if (remainingRequests === 0) return decision("needs_evidence", "review_budget_exhausted", "The configured evidence budget is exhausted.");

    remainingRequests -= 1;
    const reviewRequest = makeTextReviewRequest(input, local.reason, localText);
    const reviewed = await runReviewer(reviewer, reviewRequest, evidenceTimeoutMs, input.signal);
    if (reviewed.kind === "aborted") return decision("deny", "aborted", "The action was cancelled during risk review.");
    if (reviewed.kind !== "ok") return decision("needs_evidence", reviewed.code, reviewed.reason);

    const reviewedDecision = decisionFromReview(reviewed.value);
    if (reviewedDecision.decision !== "approve") return reviewedDecision;
    // A review that included OCR is also approval based on visual evidence,
    // so reserve a request for the fresh OCR pass before opening consent.
    if (localText !== undefined && remainingRequests === 0) {
      return decision("needs_evidence", "ocr_revalidation_budget_exhausted", "Fresh local visual evidence is required before approval can resume.");
    }
    if (localText !== undefined) {
      // Reserve the fresh pass now so concurrent pending approvals cannot all
      // pass a last-request check and later exceed the cumulative cap.
      remainingRequests -= 1;
    }
    return rememberRiskEvidence(reviewedDecision, {
      kind: "review",
      input,
      request: reviewRequest,
       ...(localText === undefined || localRegion === undefined ? {} : { ocr: { region: cloneRect(localRegion), lines: localText, revalidationReserved: true } }),
    });
  };

  const recheck: RiskPolicyRechecker = async (originalDecision, originalInput, refreshedInput): Promise<RiskDecision> => {
    const basic = validateInput(refreshedInput);
    if (basic !== undefined) return basic;
    if (refreshedInput.signal?.aborted === true) return decision("deny", "aborted", "The action was cancelled before risk evaluation.");

    const hardRule = hostRules.hardDeny;
    if (hardRule !== undefined) {
      const result = await runHostRule(hardRule, refreshedInput, ruleTimeoutMs, refreshedInput.signal);
      if (result.kind === "aborted") return decision("deny", "aborted", "The action was cancelled during host policy evaluation.");
      if (result.kind === "error") return decision("deny", "host_rule_failed_closed", "The host denial rule failed; the action is stopped.");
      if (result.match) return decision("deny", result.code ?? "host_denied", "The host policy denied this action.");
    }

    const local = classifyStructurally(refreshedInput, forbiddenHotkeys);
    if (local.decision === "deny" || local.decision === "needs_evidence") return decision(local.decision, local.code, local.reason);

    const approvalRule = hostRules.requireApproval;
    let liveApprovalCode: string | undefined;
    if (approvalRule !== undefined) {
      const result = await runHostRule(approvalRule, refreshedInput, ruleTimeoutMs, refreshedInput.signal);
      if (result.kind === "aborted") return decision("deny", "aborted", "The action was cancelled during host policy evaluation.");
      if (result.kind === "error") return decision("deny", "host_rule_failed_closed", "The host approval rule could not be checked.");
      if (result.match) liveApprovalCode = result.code ?? "host_approval_required";
    }

    if (local.decision !== "review") return decision(local.decision, local.code, local.reason);

    const evidence = riskEvidence.get(originalDecision);
    if (!evidence || evidence.input !== originalInput || originalDecision.decision !== "approve") {
      if (liveApprovalCode !== undefined) return decision("approve", liveApprovalCode, "The host policy requires approval for this action.");
      return decision("needs_evidence", "approval_evidence_unavailable", "The original optional evidence is not bound to this action.");
    }

    if (evidence.kind === "ocr") {
      const refreshedOcr = await freshOcr(evidence, refreshedInput);
      if ("decision" in refreshedOcr) return refreshedOcr.decision;
      const ocrRisk = classifyOcrText(refreshedOcr.lines);
      if (ocrRisk === undefined || ocrRisk.code !== originalDecision.code) {
        return decision("needs_evidence", "ocr_evidence_changed", "The bounded visual evidence no longer establishes the approved consequence.");
      }
      return liveApprovalCode === undefined ? originalDecision : decision("approve", liveApprovalCode, "The host policy requires approval for this action.");
    }

    let localText: readonly TextRiskOcrLine[] | undefined;
    if (evidence.ocr !== undefined) {
      const refreshedOcr = await freshOcr(evidence.ocr, refreshedInput);
      if ("decision" in refreshedOcr) return refreshedOcr.decision;
      localText = refreshedOcr.lines;
    }
    const refreshedRequest = makeTextReviewRequest(refreshedInput, local.reason, localText);
    if (evidenceFingerprint(refreshedRequest) !== evidenceFingerprint(evidence.request)) {
      return decision("needs_evidence", "review_evidence_changed", "The trusted text evidence changed before approval resumed.");
    }
    return liveApprovalCode === undefined ? originalDecision : decision("approve", liveApprovalCode, "The host policy requires approval for this action.");
  };
  riskPolicyRecheckers.set(riskPolicy, recheck);
  return riskPolicy;
}

function validateInput(input: RiskInput): RiskDecision | undefined {
  if (input === undefined || input === null || typeof input !== "object") {
    return decision("deny", "invalid_risk_input", "Risk input is missing.");
  }
  if (input.step === undefined || input.step === null || typeof input.step !== "object") {
    return decision("deny", "invalid_step", "The action step is missing.");
  }
  if (!(new Set<ActionKind>(["click", "type", "setValue", "scroll", "keypress", "hotkey", "drag"])).has(input.step.kind)) {
    return decision("deny", "invalid_step", "The action kind is not supported.");
  }
  if (input.target === undefined || input.target === null || typeof input.target !== "object") {
    return decision("deny", "missing_target", "The action target is missing.");
  }
  if (typeof input.target.id !== "string" || input.target.id.trim().length === 0 || typeof input.target.role !== "string" || input.target.role.trim().length === 0) {
    return decision("deny", "invalid_target", "The action target is not structurally identified.");
  }
  return undefined;
}

function classifyStructurally(input: RiskInput, forbiddenHotkeys: ReadonlySet<string>): LocalClassification {
  const step = input.step;
  const target = input.target;
  const effect = target.effect;

  if (step.kind === "hotkey") {
    const normalized = normalizeHotkey(step.keys);
    if (normalized.length === 0 || forbiddenHotkeys.has(normalized) || isKnownForbiddenHotkey(normalized)) {
      return { decision: "deny", code: "forbidden_hotkey", category: "security", reason: "This host-forbidden shortcut cannot be dispatched." };
    }
  }

  const stateError = checkStateForAction(step, target);
  if (stateError !== undefined) return stateError;

  const enter = step.kind === "keypress" && /^(enter|return)$/iu.test(step.key);
  if (enter && target.enterMaySubmit) {
    return { decision: "needs_evidence", code: "implicit_form_submit", reason: "Use the explicit form control so its effect and submitted parameters can be checked." };
  }
  const explicitRisk = effect === undefined ? undefined : HIGH_RISK_EFFECTS.get(effect);
  if (explicitRisk !== undefined) {
    return { decision: "approve", code: `effect_${explicitRisk}_requires_approval`, category: explicitRisk, reason: `The target is structurally marked as ${effect}.` };
  }
  if (target.sensitive === true) {
    return { decision: "approve", code: "protected_target", category: "sensitive", reason: "The target is marked sensitive; host approval is required." };
  }
  if (step.kind === "drag") {
    const destination = input.destination;
    if (!destination) return { decision: "deny", code: "missing_drag_destination", reason: "A drag needs an identifiable destination." };
    const category = destination.sensitive ? "sensitive" : destination.effect && HIGH_RISK_EFFECTS.get(destination.effect);
    if (category) return { decision: "approve", code: `destination_${category}_requires_approval`, category, reason: "The drag destination is consequential." };
    return { decision: "review", code: "ambiguous_drag", reason: "A drag can transfer or alter data; inspecting the source alone is insufficient." };
  }

  const primaryClick = step.kind === "click" && (step.button ?? "left") === "left" && (step.count ?? 1) === 1;
  const targetRole = normalizeText(target.role).toLowerCase();
  const actionLabel = isNonActionRole(targetRole) ? "" : normalizeText(target.name).replace(/(?:\.{3}|…)$/u, "").trimEnd();
  if ((step.kind === "click" || enter) && (effect === undefined || effect === "unknown")) {
    const namedRisk = actionLabelRisk(actionLabel);
    if (namedRisk !== undefined) {
      return { decision: "approve", code: `label_${namedRisk}_requires_approval`, category: namedRisk, reason: "The target itself identifies a consequential action." };
    }
  }
  if (target.filterAction === true && (primaryClick || enter || step.kind === "scroll" || step.kind === "type" || step.kind === "setValue")) {
    return { decision: "allow", code: "structural_filter_action", reason: "The host marked this as a bounded search/filter action." };
  }
  if (step.kind === "click" && !primaryClick) {
    return { decision: "review", code: "alternate_click", reason: "The default action of this control does not establish the effect of this mouse gesture." };
  }
  if (step.kind === "hotkey") {
    const chord = normalizeHotkey(step.keys);
    if (target.states.includes("editable") && (chord === "a+ctrl" || chord === "a+control" || chord === "a+meta" || chord === "a+command")) {
      return { decision: "allow", code: "select_field_text", reason: "Select all in the focused public editor." };
    }
    return { decision: "review", code: "shortcut_effect_unknown", reason: "The effect of this shortcut depends on the application command." };
  }
  if (step.kind === "keypress") {
    const editable = target.states.includes("editable") || effect === "edit";
    if (enter && editable) {
      return { decision: "review", code: "implicit_activation", reason: "Enter in this editor may activate the form's default action; editing permission alone does not identify it." };
    }
    if (editable && isNavigationKey(step.key)) {
      return { decision: "allow", code: "editor_navigation", reason: "The navigation key moves through the focused public editor." };
    }
    if (!enter || !/^(button|link)$/iu.test(target.role)) {
      return { decision: "review", code: "key_effect_unknown", reason: "The effect of this key is not established by the control's default action." };
    }
  }
  // Text contents are intentionally not inspected. A draft body containing
  // “do not send”, “pay”, or similar words is still merely typed text.
  if (step.kind === "type" || step.kind === "setValue") {
    if (effect !== "unknown" || (target.states.includes("editable") && target.actions.includes(step.kind))) {
      return { decision: "allow", code: "structural_text_input", reason: "Typing into a non-sensitive editable target is a local structural action." };
    }
  }

  if (effect === "read" || effect === "navigate" || effect === "edit") {
    return { decision: "allow", code: "structural_low_impact", reason: "The target has a non-consequential structural effect." };
  }

  // An undeclared effect still leaves the actual recipient and gesture as
  // evidence. Treat a window-only hit or a generic confirmation as ambiguous.
  if (step.kind === "scroll") {
    if (target.actions.includes("scroll") && /^(?:scrollbar|scrollarea|list|listbox|tree|document|pane|table|grid)$/iu.test(targetRole)) {
      return { decision: "allow", code: "structural_scroll", reason: "Scrolling within a structurally identified region is low impact." };
    }
    return { decision: "review", code: "ambiguous_scroll_target", reason: "The scroll recipient is not structurally identified as a bounded view." };
  }

  if (primaryClick || enter) {
    if (target.states.includes("visible") && target.states.includes("enabled") && target.actions.includes("click")) {
      if (/^(?:tab|tab[ _-]?item)$/iu.test(targetRole)) {
        return { decision: "allow", code: "structural_tab_selection", reason: "The action selects an identified tab." };
      }
      const opensMenu = /^(?:menu[ _-]?item)$/u.test(targetRole) && MENU_CAPTION_TEXT.test(actionLabel);
      const commandControl = /^(?:button|split[ _-]?button|menu[ _-]?item|link|hyperlink)$/u.test(targetRole);
      const localCommand = VIEW_ACTION_TEXT.test(actionLabel) || NAVIGATION_ACTION_TEXT.test(actionLabel) || OPEN_VIEW_TEXT.test(actionLabel)
        || isReadOnlyHistoryLabel(actionLabel) || isDraftActionLabel(actionLabel) || isExplicitNegation(actionLabel);
      if (opensMenu || (commandControl && localCommand)) {
        return { decision: "allow", code: "structural_safe_click", reason: "The action target is a clear navigation/filter control." };
      }
    }
    if (effect === "unknown") {
      return { decision: "review", code: "unknown_effect", category: "unknown", reason: "The target's immediate consequence is unknown." };
    }
    return { decision: "review", code: "ambiguous_click_target", reason: "The click target's immediate consequence is not established." };
  }

  return { decision: "review", code: "ambiguous_action", reason: "The action's immediate consequence is not established." };
}

function checkStateForAction(step: Step, target: Control): LocalClassification | undefined {
  const states = new Set(target.states ?? []);
  if (step.kind === "click" && states.size > 0 && !states.has("enabled")) {
    return { decision: "deny", code: "target_not_enabled", reason: "The click target is not currently enabled." };
  }
  if ((step.kind === "type" || step.kind === "setValue") && states.size > 0 && !states.has("editable")) {
    return { decision: "deny", code: "target_not_editable", reason: "The input target is not currently editable." };
  }
  if ((step.kind === "keypress" || step.kind === "hotkey") && states.size > 0 && !states.has("focused")) {
    return { decision: "deny", code: "target_not_focused", reason: "A key action requires a currently focused recipient." };
  }
  return undefined;
}

function actionLabelRisk(value: string): RiskCategory | undefined {
  if (value.length === 0 || isExplicitNegation(value) || isReadOnlyHistoryLabel(value) || isDraftActionLabel(value)) return undefined;
  if (/^(?:(?:确认|立即)?(?:发送|发布|提交|转发|共享))/u.test(value)) return "external";
  if (/^(?:确认|立即)?(?:付款|支付|购买|结算|退款)/u.test(value)) return "financial";
  if (/^(?:(?:确认|永久|彻底)?(?:删除|清空|覆盖|替换|撤销)|取消(?:订单|订阅|预约)|关闭(?:账号|账户))/u.test(value)) return "destructive";
  if (/^(?:cancel (?:the )?(?:order|booking|subscription)|close (?:the )?account)(?:$|\s)/iu.test(value)) return "destructive";
  if (/^(?:(?:确认)?授权|修改权限|启用宏)|\b(?:passwords?|credentials?|enable macros?)\b/iu.test(value)) return "security";
  if (ACTION_VERBS.external.test(value)) return "external";
  if (ACTION_VERBS.financial.test(value)) return "financial";
  if (ACTION_VERBS.destructive.test(value)) return "destructive";
  if (ACTION_VERBS.security.test(value)) return "security";
  return undefined;
}

function classifyOcrText(lines: readonly TextRiskOcrLine[]): LocalClassification | undefined {
  for (const line of lines.slice(0, MAX_OCR_LINES)) {
    if (line.confidence !== undefined && (!Number.isFinite(line.confidence) || line.confidence < 0.8)) continue;
    const risk = actionLabelRisk(normalizeText(line.text));
    if (risk !== undefined) return { decision: "approve", code: `ocr_${risk}_requires_approval`, category: risk, reason: "Bounded local OCR found a consequential action label." };
  }
  return undefined;
}

function makeTextReviewRequest(input: RiskInput, reason: string, localText?: readonly TextRiskOcrLine[]): TextRiskReviewRequest {
  const step = input.step;
  const action: TextRiskReviewRequest["action"] = { kind: step.kind };
  if (step.kind === "type") action.textLength = step.text.length;
  if (step.kind === "setValue") action.valueLength = step.value.length;
  if (step.kind === "keypress") action.key = redactText(step.key, 64);
  if (step.kind === "hotkey") action.keys = step.keys.map((key) => redactText(key, 32));
  if (step.kind === "click") {
    action.button = step.button;
    action.count = step.count;
  }
  if (step.kind === "scroll") {
    action.direction = step.direction;
    action.amount = step.amount;
    action.by = step.by;
  }
  return {
    action,
    target: toTextControl(input.target),
    ...(input.destination === undefined ? {} : { destination: toTextControl(input.destination) }),
    ...(localText === undefined ? {} : { localText: localText.slice(0, MAX_OCR_LINES).map(sanitizeOcrLine) }),
    reason: redactText(reason, MAX_REVIEW_TEXT),
  };
}

function toTextControl(control: Control): TextRiskControl {
  return {
    id: redactText(control.id, 128),
    role: redactText(control.role, 64),
    ...(control.name === undefined ? {} : { name: redactText(control.name, MAX_REVIEW_TEXT) }),
    ...(control.within === undefined ? {} : { within: redactText(control.within, 128) }),
    states: [...(control.states ?? [])],
    actions: [...(control.actions ?? [])],
    ...(control.effect === undefined ? {} : { effect: control.effect }),
    ...(control.sensitive === undefined ? {} : { sensitive: control.sensitive }),
    ...(control.value === undefined ? {} : { valueLength: control.value.length }),
  };
}

function sanitizeOcrLine(line: TextRiskOcrLine): TextRiskOcrLine {
  return {
    text: redactText(line.text, MAX_REVIEW_TEXT),
    ...(line.confidence === undefined ? {} : { confidence: clamp01(line.confidence) }),
    ...(line.box === undefined ? {} : { box: line.box.slice(0, 4) as [number, number, number, number] }),
  };
}

function decisionFromReview(review: TextRiskReview): RiskDecision {
  if ("decision" in review) {
    if (review.decision === "deny") return decision("deny", "review_denied", review.reason ?? "The text-only reviewer denied this action.");
    if (review.decision === "approve") return decision("approve", "review_approval_required", review.reason ?? "The text-only reviewer requires host approval.");
  }
  if (review.classification === "clear" || review.classification === "low" || review.classification === undefined) {
    return decision("allow", "review_clear", review.reason ?? "The text-only reviewer found no consequential effect.");
  }
  if (review.classification === "high") return decision("approve", "review_high", review.reason ?? "The reviewer identified a high-risk action.");
  return decision("needs_evidence", `review_${review.classification}`, review.reason ?? "The reviewer could not establish the immediate consequence.");
}

async function runReviewer(
  reviewer: TextRiskReviewer,
  request: TextRiskReviewRequest,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<{ kind: "ok"; value: TextRiskReview } | { kind: "timeout" | "error"; code: string; reason: string } | { kind: "aborted" }> {
  const controller = new AbortController();
  const signal = combineSignals(parentSignal, controller.signal);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const value = await Promise.race([
      invokeReviewer(reviewer, request, signal),
      abortPromise(signal),
    ]);
    if (signal.aborted) return parentSignal?.aborted ? { kind: "aborted" } : { kind: "timeout", code: "review_timeout", reason: "The text-only reviewer exceeded its bounded time." };
    if (!isReview(value)) return { kind: "error", code: "review_invalid", reason: "The text-only reviewer returned an invalid classification." };
    return { kind: "ok", value };
  } catch {
    if (parentSignal?.aborted) return { kind: "aborted" };
    if (signal.aborted) return { kind: "timeout", code: "review_timeout", reason: "The text-only reviewer exceeded its bounded time." };
    return { kind: "error", code: "review_failed", reason: "The text-only reviewer could not complete the assessment." };
  } finally {
    clearTimeout(timeout);
  }
}

async function runOcr(
  provider: LocalOcrProvider,
  request: LocalOcrRequest,
  timeoutMs: number,
): Promise<{ kind: "ok"; lines: readonly TextRiskOcrLine[] } | { kind: "timeout" | "error"; code: string } | { kind: "aborted" }> {
  if (provider.localOnly !== true) return { kind: "error", code: "ocr_not_local" };
  const controller = new AbortController();
  const signal = combineSignals(request.signal, controller.signal);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const value = await Promise.race([runLocalOcr(provider, { ...request, signal }), abortPromise(signal)]);
    if (signal.aborted) return request.signal.aborted ? { kind: "aborted" } : { kind: "timeout", code: "ocr_timeout" };
    if (!isOcrResult(value)) return { kind: "error", code: "ocr_invalid" };
    return { kind: "ok", lines: value.lines.slice(0, MAX_OCR_LINES).map(sanitizeOcrLine) };
  } catch {
    if (request.signal.aborted) return { kind: "aborted" };
    if (signal.aborted) return { kind: "timeout", code: "ocr_timeout" };
    return { kind: "error", code: "ocr_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

async function runLocalOcr(provider: LocalOcrProvider, request: LocalOcrRequest): Promise<LocalOcrResult> {
  const image = provider.getImage === undefined ? undefined : await provider.getImage({ input: request.input, region: request.region, signal: request.signal });
  return provider.recognize({ ...request, ...(image === undefined ? {} : { image }) });
}

function invokeReviewer(reviewer: TextRiskReviewer, request: TextRiskReviewRequest, signal: AbortSignal): Promise<TextRiskReview> | TextRiskReview {
  if (typeof reviewer === "function") return reviewer(request, signal);
  if ("review" in reviewer) return reviewer.review(request, signal);
  return reviewer.classify(request, signal);
}

function isReview(value: unknown): value is TextRiskReview {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.decision !== undefined && !["allow", "approve", "deny"].includes(String(record.decision))) return false;
  if (record.classification !== undefined && !["clear", "low", "suspicious", "high", "unknown", "unclear"].includes(String(record.classification))) return false;
  return record.decision !== undefined || record.classification !== undefined;
}

function isOcrResult(value: unknown): value is LocalOcrResult {
  if (value === null || typeof value !== "object") return false;
  const lines = (value as { lines?: unknown }).lines;
  return Array.isArray(lines) && lines.every((line) => line !== null && typeof line === "object" && typeof (line as { text?: unknown }).text === "string");
}

async function runHostRule(rule: RiskHostRule, input: RiskInput, timeoutMs: number, parentSignal?: AbortSignal): Promise<{ kind: "ok"; match: boolean; code?: string } | { kind: "error" } | { kind: "aborted" }> {
  const controller = new AbortController();
  const signal = combineSignals(parentSignal, controller.signal);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await Promise.race([Promise.resolve(rule(input, signal)), abortPromise(signal)]);
    if (signal.aborted) return parentSignal?.aborted ? { kind: "aborted" } : { kind: "error" };
    return parseHostRuleResult(result);
  } catch {
    return parentSignal?.aborted ? { kind: "aborted" } : { kind: "error" };
  } finally {
    clearTimeout(timeout);
  }
}

function parseHostRuleResult(value: unknown): { kind: "ok"; match: boolean; code?: string } | { kind: "error" } {
  if (typeof value === "boolean") return { kind: "ok", match: value };
  if (typeof value === "string") return { kind: "ok", match: true, code: normalizeCode(value) };
  if (value !== null && typeof value === "object" && typeof (value as { match?: unknown }).match === "boolean") {
    const code = (value as { code?: unknown }).code;
    return { kind: "ok", match: (value as { match: boolean }).match, ...(typeof code === "string" ? { code: normalizeCode(code) } : {}) };
  }
  return { kind: "error" };
}

function decision(decisionValue: RiskDecision["decision"], code: string, _reason: string): RiskDecision {
  // RiskDecision intentionally exposes only a stable code. Keep reason out of
  // the public contract so no accidental sensitive text is logged by callers.
  return { decision: decisionValue, code: normalizeCode(code) };
}

function rememberRiskEvidence(result: RiskDecision, evidence: RiskEvidence): RiskDecision {
  riskEvidence.set(result, evidence);
  return result;
}

function sameRect(left: Rect, right: Rect): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function cloneRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function evidenceFingerprint(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 1) throw new Error("timeoutMs must be a positive finite number");
  return Math.min(Math.floor(value), 60_000);
}

function boundedRequestBudget(value: number | undefined): number {
  if (value === undefined) return Infinity;
  if (!Number.isInteger(value) || value < 0) throw new Error("maxExternalRequests must be a non-negative integer");
  return Math.min(value, 8);
}

function combineSignals(parent: AbortSignal | undefined, local: AbortSignal): AbortSignal {
  if (parent === undefined) return local;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([parent, local]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted || local.aborted) controller.abort();
  else {
    parent.addEventListener("abort", abort, { once: true });
    local.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

function normalizeText(value: string | undefined): string {
  return value?.replace(/\s+/gu, " ").trim() ?? "";
}

function redactText(value: string, maxLength: number): string {
  return normalizeText(value)
    .replace(/(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,})/gu, "[redacted-credential]")
    .replace(/\b\d{13,19}\b/gu, "[redacted-number]")
    .replace(/((?:password|token|secret|api[_ -]?key|验证码|密码|密钥)\s*[:：=]\s*)\S+/giu, "$1[redacted]")
    .slice(0, maxLength);
}

function normalizeCode(value: string): string {
  const code = value.trim().replace(/[^A-Za-z0-9_.:-]+/gu, "_").slice(0, 80);
  return code.length > 0 ? code : "host_rule";
}

function normalizeHotkey(keys: readonly string[] | string): string {
  const values: readonly string[] = typeof keys === "string" ? keys.split("+") : keys;
  return values.map((key) => normalizeText(key).toLowerCase()).filter(Boolean).sort().join("+");
}

function isKnownForbiddenHotkey(value: string): boolean {
  return value === "alt+ctrl+delete" || value === "ctrl+alt+delete" || value === "command+q" || value === "ctrl+alt+del";
}

function isNavigationKey(value: string): boolean {
  return /^(tab|arrowleft|arrowright|arrowup|arrowdown|home|end)$/iu.test(normalizeText(value));
}

function isNonActionRole(role: string): boolean {
  return /(?:static|text|label|heading|description|image|icon|textbox|searchbox|combobox|edit|input|list|option|cell)/iu.test(role);
}

function isExplicitNegation(value: string): boolean {
  return NEGATED_RISK_TEXT.test(value);
}

function isReadOnlyHistoryLabel(value: string): boolean {
  return /^(?:(?:view|show|inspect|browse|open)\s+)?(?:payment|transaction|billing|purchase)\s+(?:history|records?|logs?)$/iu.test(value)
    || /^(?:(?:查看|浏览|查阅|打开)\s*)?(?:付款|支付|账单)\s*(?:历史|记录|日志)$/u.test(value);
}

function isDraftActionLabel(value: string): boolean {
  return /^(?:(?:save|store)\s+(?:as\s+)?(?:draft|locally)|(?:保存|另存)(?:为)?(?:本地)?草稿)$/iu.test(value);
}

function isBoundedRegion(region: Rect): boolean {
  return Number.isFinite(region.x) && Number.isFinite(region.y)
    && Number.isFinite(region.width) && Number.isFinite(region.height)
    && region.width > 0 && region.height > 0
    && region.width <= 4096 && region.height <= 4096;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
