import type {
  ActionKind,
  ActRequest,
  Control,
  DesktopBackend,
  Frame,
  Point,
  Selector,
  State,
  Step,
  Target,
  View,
} from "../contracts.js";
import { matchControl } from "../grounding.js";
import type { StoredObservation } from "./observation-registry.js";
import { equivalentMaterial, findEquivalentControl, pointInRect, pointWithinImage, targetBindingKey } from "./session-targeting.js";

export interface FocusRecord {
  scope: string;
  controlId: string;
  step: number;
}

export interface Binding {
  scope: string;
  targetKey: string;
  parametersKey: string;
  destinationKey?: string;
  sourceObservationId?: string;
  point?: Point;
  destinationPoint?: Point;
}

export interface PreparedStep {
  step: Step;
  frame: Frame;
  target: Control;
  destination?: Control;
  origin?: Frame;
  binding: Binding;
}

export interface TargetResolution {
  prepared?: PreparedStep;
  code?: string;
  candidates?: readonly Control[];
  candidateObservation?: StoredObservation;
}

export interface TargetResolverDependencies {
  backend: DesktopBackend;
  observe(options: { view: View; where?: Selector; signal?: AbortSignal }, exposed: boolean): Promise<StoredObservation>;
  getObservation(observationId: string): StoredObservation | undefined;
  pin(stored: StoredObservation): void;
  getFocus(step: number): FocusRecord | undefined;
}

export function parametersKey(step: Step): string {
  return JSON.stringify(step);
}

export function sameBinding(left: Binding, right: Binding): boolean {
  return left.scope === right.scope
    && left.targetKey === right.targetKey
    && left.parametersKey === right.parametersKey
    && left.destinationKey === right.destinationKey
    && left.sourceObservationId === right.sourceObservationId
    && left.point?.x === right.point?.x
    && left.point?.y === right.point?.y
    && left.destinationPoint?.x === right.destinationPoint?.x
    && left.destinationPoint?.y === right.destinationPoint?.y;
}

export class TargetResolver {
  public constructor(private readonly deps: TargetResolverDependencies) {}

  public async resolve(request: ActRequest, _index: number, step: Step, signal: AbortSignal): Promise<TargetResolution> {
    if (signal.aborted) return { code: "cancelled" };
    const form = step.kind === "drag" ? "point" : this.targetForm(step.target);
    const observationId = request.observationId;

    if (step.kind === "drag") {
      if (!observationId) return { code: "observation_required" };
      const sourceObservation = this.deps.getObservation(observationId);
      if (!sourceObservation) return { code: "observation_not_found" };
      this.deps.pin(sourceObservation);
      if (!sourceObservation.frame.image) return { code: "point_evidence_required" };
      if (!pointWithinImage(sourceObservation.frame, step.from) || !pointWithinImage(sourceObservation.frame, step.to)) {
        return { code: "point_out_of_bounds" };
      }
      const current = await this.deps.observe({ view: "controls", signal }, false);
      if (current.frame.scope !== sourceObservation.frame.scope) return { code: "stale_point" };
      const originSource = await this.hitTestOrigin(sourceObservation.frame, step.from, signal);
      const originDestination = await this.hitTestOrigin(sourceObservation.frame, step.to, signal);
      const source = await this.hitTestUnique(current.frame, step.from, signal);
      const destination = await this.hitTestUnique(current.frame, step.to, signal);
      if (!originSource || !originDestination || !source || !destination) return { code: "point_not_unique" };
      if (originSource.id !== source.id || originDestination.id !== destination.id
        || !equivalentMaterial(originSource, source) || !equivalentMaterial(originDestination, destination)) {
        return { code: "stale_point" };
      }
      if (source.id === destination.id) return { code: "drag_same_target" };
      if (!source.actions.includes("drag") && !source.actions.includes("click")) return { code: "target_not_actionable" };
      return {
        prepared: {
          step,
          frame: current.frame,
          target: source,
          destination,
          origin: sourceObservation.frame,
          binding: {
            scope: current.frame.scope,
            targetKey: targetBindingKey(source),
            parametersKey: parametersKey(step),
            destinationKey: targetBindingKey(destination),
            sourceObservationId: observationId,
            point: step.from,
            destinationPoint: step.to,
          },
        },
      };
    }

    if (form === "selector") {
      const selector = this.selectorFromTarget(step.target);
      if (!selector) return { code: "invalid_target" };
      const result = await this.scopedSelector(selector, step.kind, signal);
      if (!result.control || !result.stored) {
        return { code: result.code ?? "target_not_found", candidates: result.candidates, candidateObservation: result.stored };
      }
      if (!result.control.actions.includes(step.kind)) return { code: "target_not_actionable", candidates: result.candidates };
      return {
        prepared: {
          step,
          frame: result.stored.frame,
          target: result.control,
          binding: {
            scope: result.stored.frame.scope,
            targetKey: targetBindingKey(result.control),
            parametersKey: parametersKey(step),
          },
        },
      };
    }

    if (form === "focus") {
      const focusStep = (step.target as { focusFromStep: number }).focusFromStep;
      const record = this.deps.getFocus(focusStep);
      if (!record) return { code: "focus_unavailable" };
      const current = await this.deps.observe({ view: "controls", signal }, false);
      if (current.frame.scope !== record.scope) return { code: "focus_changed" };
      const target = current.frame.controls.find((control) => control.id === record.controlId);
      if (!target || current.frame.focusId !== record.controlId && !this.hasState(target, "focused")) return { code: "focus_changed" };
      if (!target.actions.includes(step.kind)) return { code: "target_not_actionable" };
      return {
        prepared: {
          step,
          frame: current.frame,
          target,
          binding: { scope: current.frame.scope, targetKey: targetBindingKey(target), parametersKey: parametersKey(step) },
        },
      };
    }

    if (!observationId) return { code: "observation_required" };
    const sourceObservation = this.deps.getObservation(observationId);
    if (!sourceObservation) return { code: "observation_not_found" };
    this.deps.pin(sourceObservation);
    const current = await this.deps.observe({ view: "controls", signal }, false);
    if (current.frame.scope !== sourceObservation.frame.scope) return { code: form === "point" ? "stale_point" : "stale_reference" };

    let target: Control | undefined;
    let origin: Frame | undefined;
    let point: Point | undefined;
    if (form === "ref") {
      const ref = (step.target as { ref: string }).ref;
      const source = sourceObservation.refs.get(ref);
      if (!source) return { code: "stale_reference" };
      target = await this.freshEquivalentRef(source, current, signal);
      if (!target) return { code: "stale_reference" };
    } else if (form === "point") {
      point = (step.target as { point: Point }).point;
      origin = sourceObservation.frame;
      if (!sourceObservation.frame.image) return { code: "point_evidence_required" };
      if (!pointWithinImage(sourceObservation.frame, point)) return { code: "point_out_of_bounds" };
      const originTarget = await this.hitTestOrigin(sourceObservation.frame, point, signal);
      target = await this.hitTestUnique(current.frame, point, signal);
      if (!originTarget || !target) return { code: "point_not_unique" };
      if (originTarget.id !== target.id || !equivalentMaterial(originTarget, target)) return { code: "stale_point" };
    }
    if (!target) return { code: "target_not_found" };
    if (!target.actions.includes(step.kind)) return { code: "target_not_actionable" };
    return {
      prepared: {
        step,
        frame: current.frame,
        target,
        origin,
        binding: {
          scope: current.frame.scope,
          targetKey: targetBindingKey(target),
          parametersKey: parametersKey(step),
          sourceObservationId: observationId,
          ...(point ? { point } : {}),
        },
      },
    };
  }

  private targetForm(target: Target): "selector" | "ref" | "point" | "focus" {
    if ("ref" in target) return "ref";
    if ("point" in target) return "point";
    if ("focusFromStep" in target) return "focus";
    return "selector";
  }

  private hasState(control: Control, state: State): boolean {
    return control.states.includes(state);
  }

  private async hitTestUnique(frame: Frame, point: Point, signal: AbortSignal): Promise<Control | undefined> {
    if (this.deps.backend.hitTest) return this.deps.backend.hitTest(frame, point, signal);
    if (!frame.complete) return undefined;
    const matches = frame.controls.filter((control) => pointInRect(point, control));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private async hitTestOrigin(frame: Frame, point: Point, signal: AbortSignal): Promise<Control | undefined> {
    const snapshotHitTest = this.deps.backend.hitTestSnapshot === true;
    if (snapshotHitTest && this.deps.backend.hitTest) return this.deps.backend.hitTest(frame, point, signal);
    if (!frame.complete) return undefined;
    const matches = frame.controls.filter((control) => pointInRect(point, control));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private selectorFromTarget(target: Target): Selector | undefined {
    return this.targetForm(target) === "selector" ? target as Selector : undefined;
  }

  private failureCode(code: string | undefined, candidates?: readonly Control[]): string {
    if (candidates && candidates.length > 1) return "target_ambiguous";
    switch (code) {
      case "ambiguous": case "multiple": return "target_ambiguous";
      case "not_found": case "missing": case "no_match": case "alias_scope_required": case "alias_unsafe": return "target_not_found";
      case "selector_conflict": return "target_ambiguous";
      case "incomplete": case "partial": return "observation_incomplete";
      default: return code && /^[a-z][a-z0-9_:-]{1,63}$/i.test(code) ? code.toLowerCase() : "target_not_found";
    }
  }

  private async scopedSelector(selector: Selector, kind: ActionKind, signal: AbortSignal): Promise<{ stored?: StoredObservation; control?: Control; candidates?: readonly Control[]; code?: string }> {
    let stored = await this.deps.observe({ view: "controls", where: selector, signal }, false);
    if (!stored.frame.complete) stored = await this.deps.observe({ view: "controls", where: selector, signal }, false);
    const matched = matchControl(stored.frame, selector, { kind, aliases: true });
    const candidates = matched.candidates ?? [];
    if (!stored.frame.complete) return { stored, candidates, code: "observation_incomplete" };
    if (!matched.control) return { stored, candidates, code: this.failureCode(matched.code, candidates) };
    return { stored, control: matched.control, candidates };
  }

  private selectorForControl(control: Control): Selector {
    return { role: control.role, ...(control.name ? { name: control.name } : {}), ...(control.within ? { within: control.within } : {}) };
  }

  private async freshEquivalentRef(source: Control, current: StoredObservation, signal: AbortSignal): Promise<Control | undefined> {
    const direct = findEquivalentControl(current.frame, source);
    if (direct) return direct;
    if (current.frame.complete) return undefined;
    const scoped = await this.deps.observe({ view: "controls", where: this.selectorForControl(source), signal }, false);
    if (scoped.frame.scope !== current.frame.scope) return undefined;
    return findEquivalentControl(scoped.frame, source);
  }
}
