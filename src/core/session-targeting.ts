import type { Control, Frame, Point } from "../contracts.js";
import { sameWindowPointBounds } from "./window-point.js";

/** Private identity used to bind a target across an approval/readback boundary. */
export function targetBindingKey(control: Control): string {
  return JSON.stringify({
    id: control.id,
    role: control.role,
    name: control.name,
    within: control.within,
    states: [...control.states].sort(),
    actions: [...control.actions].sort(),
    rect: control.rect,
    effect: control.effect,
    pointInteraction: control.pointInteraction && [control.pointInteraction.kind, control.pointInteraction.binding],
    windowPoint: control.windowPoint,
    sensitive: control.sensitive,
    filterAction: control.filterAction,
    enterMaySubmit: control.enterMaySubmit,
    approvalToken: control.approvalContext?.token,
  });
}

/** Material shared by ref and point grounding. Coordinates are checked by the hit test. */
function sameRecipient(left: Control, right: Control): boolean {
  return left.id === right.id
    && left.role === right.role
    && left.name === right.name
    && left.within === right.within
    && left.effect === right.effect
    && left.sensitive === right.sensitive
    && left.filterAction === right.filterAction
    && left.enterMaySubmit === right.enterMaySubmit
    && left.pointInteraction?.kind === right.pointInteraction?.kind
    && left.pointInteraction?.binding === right.pointInteraction?.binding
    && left.windowPoint === right.windowPoint
    && (left.windowPoint !== true || (left.windowScope === right.windowScope && sameWindowPointBounds(left.rect, right.rect)))
    && JSON.stringify([...(left.labels ?? [])].sort()) === JSON.stringify([...(right.labels ?? [])].sort())
    && left.approvalContext?.token === right.approvalContext?.token;
}

export function equivalentMaterial(left: Control, right: Control): boolean {
  return sameRecipient(left, right)
    && JSON.stringify([...left.actions].sort()) === JSON.stringify([...right.actions].sort());
}

/**
 * Point clicks are grounded against an image and a fresh control query.  A
 * private focus probe can make that fresh query advertise keyboard actions
 * which were not present in the image's public control snapshot.  Those
 * transient keyboard capabilities do not change the pointer recipient, but
 * every other material binding must still match exactly.
 *
 * Keep this comparator separate from `equivalentMaterial`: refs, drags, and
 * keyboard actions must retain their existing strict action comparison.
 */
export function equivalentPointClickMaterial(left: Control, right: Control): boolean {
  if (left.windowScope !== right.windowScope) return false;
  const pointerActions = (control: Control): readonly string[] => control.actions
    .filter((action) => action !== "keypress" && action !== "hotkey")
    .sort();
  return sameRecipient(left, right)
    && JSON.stringify(pointerActions(left)) === JSON.stringify(pointerActions(right));
}

export function findEquivalentControl(frame: Frame, source: Control): Control | undefined {
  const candidate = frame.controls.find((control) => control.id === source.id);
  return candidate && equivalentMaterial(source, candidate) ? candidate : undefined;
}

export function pointInRect(point: Point, control: Control): boolean {
  const rect = control.rect;
  return !!rect
    && point.x >= rect.x
    && point.y >= rect.y
    && point.x < rect.x + rect.width
    && point.y < rect.y + rect.height;
}

export function pointWithinImage(frame: Frame, point: Point): boolean {
  const image = frame.image;
  return image === undefined
    || (point.x >= 0 && point.y >= 0 && point.x < image.width && point.y < image.height);
}
