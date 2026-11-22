import type { Point, Rect, Step } from "../contracts.js";

export type WindowPointGesture = Extract<Step, { kind: "click" | "scroll" }> & { target: { point: Point } };

/** Gestures that can use the window alone as their physical recipient. */
export function isWindowPointGesture(step: Step): step is WindowPointGesture {
  if (step.kind === "click") {
    return "point" in step.target && (step.button ?? "left") === "left" && (step.count ?? 1) === 1;
  }
  return step.kind === "scroll" && "point" in step.target && (step.by ?? "line") === "line";
}

export function sameWindowPointBounds(left: Rect | undefined, right: Rect | undefined): boolean {
  return left !== undefined && right !== undefined
    && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
