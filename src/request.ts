import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  ActionKind,
  ActRequest,
  Capability,
  TargetForm,
} from "./contracts.js";

/** Stable, deliberately opaque request-validation results. */
export const REQUEST_ERROR_CODES = Object.freeze({
  schema: "schema_invalid",
  combination: "capability_combination_invalid",
  budget: "budget_exceeded",
  focus: "focus_reference_order_invalid",
} as const);

export type RequestErrorCode = (typeof REQUEST_ERROR_CODES)[keyof typeof REQUEST_ERROR_CODES];

export class RequestValidationError extends Error {
  public readonly code: RequestErrorCode;

  public constructor(code: RequestErrorCode) {
    super(code);
    this.name = "RequestValidationError";
    this.code = code;
  }
}

export interface RequestLimits {
  maxSteps?: number;
  maxTextLength?: number;
  maxScrollAmount?: number;
}

/** A provider-independent JSON Schema value. */
export type JsonSchema = Record<string, unknown>;

type AnyRecord = Record<string, unknown>;
type JsonSchemaMap = Record<string, JsonSchema>;

const ACTION_KINDS: readonly ActionKind[] = [
  "click",
  "type",
  "setValue",
  "scroll",
  "keypress",
  "hotkey",
  "drag",
];

const POINTER_TARGET_FORMS: readonly TargetForm[] = ["selector", "ref", "point"];
const CONTROL_TARGET_FORMS: readonly TargetForm[] = ["selector", "ref"];
const KEYBOARD_TARGET_FORMS: readonly TargetForm[] = ["selector", "ref", "focus"];
const DRAG_TARGET_FORMS: readonly TargetForm[] = ["path"];

const BUTTONS = ["left", "right"] as const;
const COUNTS = [1, 2] as const;
const DIRECTIONS = ["up", "down", "left", "right"] as const;
const UNITS = ["line", "page"] as const;
const MODIFIERS = ["ctrl", "alt", "shift", "meta"] as const;
const KEY_PATTERN = "^(?:[a-z0-9]|[A-Z][A-Za-z0-9]*)$";

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function normalizeLimits(limits: RequestLimits | undefined): RequestLimits {
  if (limits === undefined) return {};
  if (!isRecord(limits)) throw new RequestValidationError(REQUEST_ERROR_CODES.schema);
  for (const key of ["maxSteps", "maxTextLength", "maxScrollAmount"] as const) {
    const value = limits[key];
    if (value !== undefined && !positiveSafeInteger(value)) {
      throw new RequestValidationError(REQUEST_ERROR_CODES.schema);
    }
  }
  const maxSteps = limits.maxSteps as number | undefined;
  const maxTextLength = limits.maxTextLength as number | undefined;
  const maxScrollAmount = limits.maxScrollAmount as number | undefined;
  return {
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(maxTextLength === undefined ? {} : { maxTextLength }),
    ...(maxScrollAmount === undefined ? {} : { maxScrollAmount }),
  };
}

let reviewed: JsonSchema | undefined;
function loadReviewedSchema(): JsonSchema {
  if (!reviewed) {
    const json: unknown = JSON.parse(readFileSync(new URL("../schema/act-input.schema.json", import.meta.url), "utf8"));
    if (!isRecord(json)) throw new RequestValidationError(REQUEST_ERROR_CODES.schema);
    reviewed = json;
  }
  return reviewed;
}

function ref(name: string): JsonSchema {
  return { $ref: `#/$defs/${name}` };
}

function targetSchema(forms: readonly TargetForm[], defs: JsonSchemaMap): JsonSchema | undefined {
  const references: JsonSchema[] = [];
  for (const form of forms) {
    const name = form === "selector" ? "selector" : form === "ref" ? "refTarget" : form === "point" ? "pointTarget" : form === "focus" ? "focusTarget" : undefined;
    if (name !== undefined && defs[name] !== undefined) references.push(ref(name));
  }
  if (references.length === 0) return undefined;
  return references.length === 1 ? references[0] : { oneOf: references };
}

function valuesFromCapability<T extends string | number>(
  value: readonly T[] | undefined,
  all: readonly T[],
): T[] | undefined {
  if (value === undefined) return undefined;
  const allowed = new Set(all);
  return unique(value.filter((entry): entry is T => allowed.has(entry)));
}

function keyValues(value: readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return unique(value.filter((entry) => typeof entry === "string" && new RegExp(KEY_PATTERN, "u").test(entry)));
}

function normalizedChords(value: readonly (readonly string[])[] | undefined): string[][] | undefined {
  if (value === undefined) return undefined;
  const result: string[][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2 || entry.length > 5) continue;
    if (new Set(entry).size !== entry.length) continue;
    const modifiers = entry.slice(0, -1);
    const key = entry[entry.length - 1];
    if (!modifiers.every((item) => (MODIFIERS as readonly string[]).includes(item)) || typeof key !== "string" || !new RegExp(KEY_PATTERN, "u").test(key)) continue;
    result.push([...entry]);
  }
  return result;
}

function restrictedChord(keyList: readonly string[]): JsonSchema {
  const key: JsonSchema = { enum: [...keyList] };
  const modifier = ref("modifier");
  const make = (count: number): JsonSchema => ({
    minItems: count,
    maxItems: count,
    prefixItems: [...Array.from({ length: count - 1 }, () => modifier), key],
    items: false,
  });
  return { type: "array", uniqueItems: true, oneOf: [make(2), make(3), make(4), make(5)] };
}

function addExpect(properties: JsonSchema): void {
  properties.expect = ref("expect");
}

function actionBranch(
  capability: Capability,
  defs: JsonSchemaMap,
  limits: RequestLimits,
): JsonSchema | undefined {
  const kind = capability.kind;
  if (!(ACTION_KINDS as readonly string[]).includes(kind)) return undefined;

  const forms = Array.isArray(capability.targets) ? unique(capability.targets) : [];
  let permittedForms: readonly TargetForm[];
  switch (kind) {
    case "click":
    case "scroll":
      permittedForms = POINTER_TARGET_FORMS;
      break;
    case "type":
    case "keypress":
    case "hotkey":
      permittedForms = KEYBOARD_TARGET_FORMS;
      break;
    case "setValue":
      permittedForms = CONTROL_TARGET_FORMS;
      break;
    case "drag":
      permittedForms = DRAG_TARGET_FORMS;
      break;
  }
  const allowedForms = forms.filter((form): form is TargetForm => permittedForms.includes(form));

  const properties: JsonSchema = { kind: { const: kind } };
  const required: string[] = ["kind"];
  if (kind !== "drag") {
    const target = targetSchema(allowedForms, defs);
    if (target === undefined) return undefined;
    properties.target = target;
    required.push("target");
  } else if (!allowedForms.includes("path")) {
    return undefined;
  }
  const branch: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };

  switch (kind) {
    case "click": {
      const buttons = valuesFromCapability(capability.buttons, BUTTONS);
      const counts = valuesFromCapability(capability.counts, COUNTS);
      if (buttons?.length === 0 || counts?.length === 0) return undefined;
      properties.button = { enum: buttons === undefined ? [...BUTTONS] : buttons };
      properties.count = { enum: counts === undefined ? [...COUNTS] : counts };
      if (buttons !== undefined) {
        if (!buttons.includes("left")) required.push("button");
      }
      if (counts !== undefined) {
        if (!counts.includes(1)) required.push("count");
      }
      if (buttons?.every((button) => button === "right") && counts?.every((count) => count === 2)) return undefined;
      // The protocol's only globally invalid click combination is right double-click.
      branch.not = {
        required: ["button", "count"],
        properties: { button: { const: "right" }, count: { const: 2 } },
      };
      break;
    }
    case "type":
      properties.text = ref("text");
      required.push("text");
      break;
    case "setValue":
      properties.value = ref("literal");
      required.push("value");
      break;
    case "scroll": {
      const directions = valuesFromCapability(capability.directions, DIRECTIONS);
      const units = valuesFromCapability(capability.units, UNITS);
      if (directions?.length === 0 || units?.length === 0) return undefined;
      properties.direction = directions === undefined ? { enum: [...DIRECTIONS] } : { enum: directions };
      properties.amount = {
        ...ref("positiveInteger"),
        ...(limits.maxScrollAmount === undefined ? {} : { maximum: limits.maxScrollAmount }),
      };
      properties.by = units === undefined ? { enum: [...UNITS] } : { enum: units };
      required.push("direction", "amount");
      if (units !== undefined && !units.includes("line")) required.push("by");
      break;
    }
    case "keypress": {
      const keys = keyValues(capability.keys);
      if (keys?.length === 0) return undefined;
      properties.key = keys === undefined ? ref("key") : { enum: keys };
      required.push("key");
      break;
    }
    case "hotkey": {
      const chords = normalizedChords(capability.chords);
      if (chords?.length === 0) return undefined;
      const keys = keyValues(capability.keys);
      if (keys?.length === 0) return undefined;
      if (chords !== undefined) {
        properties.keys = { enum: chords };
      } else if (keys !== undefined) {
        properties.keys = restrictedChord(keys);
      } else {
        properties.keys = ref("chord");
      }
      required.push("keys");
      break;
    }
    case "drag":
      properties.from = ref("point");
      properties.to = ref("point");
      required.push("from", "to");
      break;
  }
  addExpect(properties);
  return branch;
}

function filteredReviewedSchema(capabilities: readonly Capability[], limits: RequestLimits): JsonSchema {
  const reviewed = loadReviewedSchema();
  if (reviewed === undefined) throw new RequestValidationError(REQUEST_ERROR_CODES.schema);
  const schema = clone(reviewed);
  const defs = schema.$defs as JsonSchemaMap | undefined;
  if (defs === undefined || defs.step === undefined) throw new RequestValidationError(REQUEST_ERROR_CODES.schema);
  if (limits.maxTextLength !== undefined) {
    for (const name of ["text", "literal"] as const) {
      if (isRecord(defs[name])) defs[name] = { ...defs[name], maxLength: limits.maxTextLength };
    }
  }
  const branches = capabilities
    .flatMap((capability) => {
      try {
        const branch = actionBranch(capability, defs, limits);
        return branch === undefined ? [] : [branch];
      } catch {
        return [];
      }
    });
  defs.step = branches.length === 0 ? { not: {} } : { anyOf: branches };
  // These broad unions are not referenced by the filtered action branches and
  // retaining them would advertise target variants the session did not grant.
  delete defs.controlTarget;
  delete defs.pointerTarget;
  delete defs.keyboardTarget;
  const reachable = new Set<string>();
  const pending: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/")) {
      const name = value.$ref.slice("#/$defs/".length);
      if (!reachable.has(name)) pending.push(name);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "$defs") visit(child);
    }
  };
  visit(schema);
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (reachable.has(name) || defs[name] === undefined) continue;
    reachable.add(name);
    visit(defs[name]);
  }
  for (const name of Object.keys(defs)) {
    if (!reachable.has(name)) delete defs[name];
  }
  schema.$defs = defs;
  const properties = schema.properties as JsonSchemaMap;
  const steps = properties.steps as JsonSchema;
  if (limits.maxSteps !== undefined) steps.maxItems = limits.maxSteps;
  schema.title = "DeskLatch act request";
  return schema;
}

function compile(schema: JsonSchema): (value: unknown) => boolean {
  return new Ajv2020({ strict: false, allowUnionTypes: true, ownProperties: true }).compile(schema);
}

let protocolAccepts: ReturnType<typeof compile> | undefined;
const sessionValidators = new WeakMap<readonly Capability[], { fingerprint: string; accepts: ReturnType<typeof compile> }>();

function validatorForGrant(capabilities: readonly Capability[]) {
  const fingerprint = JSON.stringify(capabilities);
  const cached = sessionValidators.get(capabilities);
  if (cached?.fingerprint === fingerprint) return cached.accepts;
  const accepts = compile(filteredReviewedSchema(capabilities, {}));
  sessionValidators.set(capabilities, { fingerprint, accepts });
  return accepts;
}

function hasBudgetViolation(request: ActRequest, limits: RequestLimits): boolean {
  if (limits.maxSteps !== undefined && request.steps.length > limits.maxSteps) return true;
  if (limits.maxScrollAmount !== undefined && request.steps.some((step) => step.kind === "scroll" && step.amount > limits.maxScrollAmount!)) return true;
  if (limits.maxTextLength !== undefined) {
    let textLength = 0;
    for (const step of request.steps) {
      if (step.kind === "type") textLength += step.text.length;
      if (step.kind === "setValue") textLength += step.value.length;
      if (step.expect !== undefined && "valueEquals" in step.expect) textLength += step.expect.valueEquals.length;
      if (textLength > limits.maxTextLength) return true;
    }
  }
  return false;
}

function hasFocusOrderViolation(request: ActRequest): boolean {
  for (let index = 0; index < request.steps.length; index += 1) {
    const step = request.steps[index];
    if ("target" in step && "focusFromStep" in step.target && step.target.focusFromStep >= index + 1) return true;
  }
  return false;
}

/**
 * Validate a complete request against the protocol, this session's exact
 * capability entries, and host budgets. No values from the request are put in
 * an error message, since model arguments may contain sensitive text.
 */
export function validateRequest(
  raw: unknown,
  capabilities: readonly Capability[],
  limits?: RequestLimits,
): ActRequest {
  const normalizedLimits = normalizeLimits(limits);
  if (normalizedLimits.maxSteps !== undefined && isRecord(raw) && Array.isArray(raw.steps)
    && raw.steps.length > normalizedLimits.maxSteps) throw new RequestValidationError(REQUEST_ERROR_CODES.budget);
  protocolAccepts ??= compile(loadReviewedSchema());
  if (!protocolAccepts(raw)) throw new RequestValidationError(REQUEST_ERROR_CODES.schema);

  const request = raw as ActRequest;
  if (!validatorForGrant(capabilities)(raw)) throw new RequestValidationError(REQUEST_ERROR_CODES.combination);
  if (hasBudgetViolation(request, normalizedLimits)) throw new RequestValidationError(REQUEST_ERROR_CODES.budget);
  if (hasFocusOrderViolation(request)) throw new RequestValidationError(REQUEST_ERROR_CODES.focus);
  return request;
}

/** Build the exact per-session schema exposed to a model/provider. */
export function actToolSchema(
  capabilities: readonly Capability[],
  limits?: RequestLimits,
): JsonSchema {
  const normalizedLimits = normalizeLimits(limits);
  return filteredReviewedSchema(capabilities, normalizedLimits);
}
