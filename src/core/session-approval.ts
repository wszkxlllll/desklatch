import type { Control, Step } from "../contracts.js";

export type ApprovalAnswer = "approve" | "deny";

function safeText(value: string, limit: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, limit);
}

export function approvalActionParams(step: Step): Readonly<Record<string, string | number | boolean | readonly string[]>> {
  switch (step.kind) {
    case "click":
      return { button: step.button ?? "left", count: step.count ?? 1 };
    case "type":
      return { text: "[redacted]", textLength: step.text.length };
    case "setValue":
      return { value: "[redacted]", valueLength: step.value.length };
    case "scroll":
      return { direction: step.direction, amount: step.amount, by: step.by ?? "line" };
    case "keypress":
      return { key: safeText(step.key, 64) };
    case "hotkey":
      return { keys: step.keys.map((key) => safeText(key, 32)) };
    case "drag":
      return { from: "[redacted]", to: "[redacted]" };
  }
}

export function approvalSummary(step: Step, target: Control, destination?: Control): string {
  const targetName = target.name ? ` ${safeText(target.name, 128)}` : "";
  const destinationName = destination?.name ? ` to ${safeText(destination.name, 128)}` : "";
  return `${step.kind}${targetName}${destinationName}`;
}

export function normalizeApprovalDecision(answer: ApprovalAnswer | boolean | void): ApprovalAnswer | undefined {
  if (answer === "approve" || answer === "deny") return answer;
  if (answer === true) return "approve";
  if (answer === false) return "deny";
  return undefined;
}
