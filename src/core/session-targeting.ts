import type { Control, Frame, Point } from "../contracts.js";

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
    approvalToken: control.approvalContext?.token,
  });
}

/** Material identity intentionally excludes value and geometry for ref targets. */
export function equivalentMaterial(left: Control, right: Control): boolean {
  return left.id === right.id
    && left.role === right.role
    && left.name === right.name
    && left.within === right.within
    && left.effect === right.effect
    && left.sensitive === right.sensitive
    && left.filterAction === right.filterAction
    && JSON.stringify([...left.actions].sort()) === JSON.stringify([...right.actions].sort())
    && JSON.stringify([...(left.labels ?? [])].sort()) === JSON.stringify([...(right.labels ?? [])].sort())
    && left.approvalContext?.token === right.approvalContext?.token;
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
