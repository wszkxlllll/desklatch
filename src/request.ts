import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type {
  ActionKind,
  ActRequest,
  Capability,
  TargetForm,
} from "./contracts.js";
import type { ActValidationDiagnostic } from "./core/session-types.js";

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
  public readonly atStep?: number;
  public readonly diagnostic?: ActValidationDiagnostic;

  public constructor(code: RequestErrorCode, atStep?: number, diagnostic?: ActValidationDiagnostic) {
    super(code);
    this.name = "RequestValidationError";
    this.code = code;
    if (Number.isSafeInteger(atStep) && (atStep as number) >= 1) this.atStep = atStep;
    if (diagnostic !== undefined) this.diagnostic = diagnostic;
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
const TYPE_TARGET_FORMS: readonly TargetForm[] = ["selector", "ref", "focus", "point"];
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
      permittedForms = TYPE_TARGET_FORMS;
      break;
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
      if (capability.foreground === true) properties.delivery = { const: "foreground" };
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
  if (isRecord(defs.point)) {
    defs.point = {
      ...defs.point,
      description: "Screenshot pixel target: use integer x/y in {point:{x,y}} from the exact fresh observationId; do not use an [x,y] array.",
    };
  }
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
  delete defs.typeTarget;
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

function compile(schema: JsonSchema): ValidateFunction<unknown> {
  return new Ajv2020({ strict: false, allowUnionTypes: true, ownProperties: true }).compile(schema);
}

let protocolAccepts: ValidateFunction<unknown> | undefined;
const sessionValidators = new WeakMap<readonly Capability[], { fingerprint: string; accepts: ValidateFunction<unknown> }>();

function rejectedStep(validator: ValidateFunction<unknown>): number | undefined {
  const errors = validator.errors;
  if (!errors || errors.length === 0) return undefined;
  let index: number | undefined;
  for (const error of errors) {
    const match = /^\/steps\/(\d+)(?:\/|$)/u.exec(error.instancePath);
    if (!match) return undefined;
    const candidate = Number(match[1]);
    if (!Number.isSafeInteger(candidate) || candidate < 0 || (index !== undefined && index !== candidate)) return undefined;
    index = candidate;
  }
  return index === undefined ? undefined : index + 1;
}

/**
 * A top-level observation guard has no `/steps/<index>` Ajv path. Infer the
 * affected step only when exactly one raw step uses a target that is bound to
 * an observation; otherwise leave atStep absent rather than guessing.
 */
function soleObservationBoundStep(raw: unknown): number | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.steps)) return undefined;
  const indices: number[] = [];
  let allStepsHaveKnownKinds = true;
  raw.steps.forEach((value, index) => {
    if (!isRecord(value) || typeof value.kind !== "string" || !(ACTION_KINDS as readonly string[]).includes(value.kind)) {
      allStepsHaveKnownKinds = false;
      return;
    }
    if (value.kind === "drag") {
      indices.push(index);
      return;
    }
    const target = value.target;
    if (isRecord(target) && (Object.hasOwn(target, "ref") || Object.hasOwn(target, "point"))) indices.push(index);
  });
  return allStepsHaveKnownKinds && indices.length === 1 ? indices[0] + 1 : undefined;
}

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

function focusOrderViolation(request: ActRequest): number | undefined {
  for (let index = 0; index < request.steps.length; index += 1) {
    const step = request.steps[index];
    if ("target" in step && "focusFromStep" in step.target && step.target.focusFromStep >= index + 1) return index + 1;
  }
  return undefined;
}

const DIAGNOSTIC_FIELDS = new Set(["target", "text", "value", "key", "keys", "from", "to", "button", "count", "direction", "amount", "by", "expect", "delivery"]);

function actionKindAt(raw: unknown, atStep: number | undefined): ActionKind | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.steps) || atStep === undefined) return undefined;
  const step = raw.steps[atStep - 1];
  return isRecord(step) && typeof step.kind === "string" && (ACTION_KINDS as readonly string[]).includes(step.kind)
    ? step.kind as ActionKind : undefined;
}

function stringEnum(values: readonly unknown[] | undefined): string[] {
  return values?.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 64).slice(0, 32) ?? [];
}

function chordEnums(value: unknown, root: AnyRecord): { chords: string[][]; keys: string[] } {
  const direct = enumValues(value, root) ?? [];
  const chords = direct.filter((entry): entry is string[] => Array.isArray(entry)
    && entry.length >= 2 && entry.length <= 5
    && entry.every(item => typeof item === "string" && /^[A-Za-z0-9]{1,32}$/u.test(item))).slice(0, 16).map(entry => [...entry]);
  if (chords.length > 0) return { chords, keys: [] };
  const resolved = resolveSchema(value, root);
  const alternatives = resolved && Array.isArray(resolved.oneOf) ? resolved.oneOf.filter(isRecord) : [];
  const keys = alternatives.flatMap(alternative => {
    const prefix = alternative.prefixItems;
    const last = Array.isArray(prefix) && prefix.length > 0 ? prefix[prefix.length - 1] : undefined;
    return stringEnum(enumValues(last, root));
  });
  return { chords: [], keys: [...new Set(keys)].slice(0, 32) };
}

/** Derive only bounded structural facts from the same filtered schema used by validation. */
function validationDiagnostic(
  raw: unknown,
  capabilities: readonly Capability[],
  limits: RequestLimits,
  code: RequestErrorCode,
  atStep: number | undefined,
  constraint?: ActValidationDiagnostic["constraint"],
): ActValidationDiagnostic | undefined {
  const kind = actionKindAt(raw, atStep);
  const boundedAtStep = Number.isSafeInteger(atStep) && (atStep as number) >= 1 && (atStep as number) <= 512 ? atStep : undefined;
  let schema: JsonSchema;
  try { schema = filteredReviewedSchema(capabilities, limits); } catch { return boundedAtStep === undefined && kind === undefined && constraint === undefined ? undefined : { ...(boundedAtStep === undefined ? {} : { atStep: boundedAtStep }), ...(kind === undefined ? {} : { kind }), ...(constraint === undefined ? {} : { constraint }) }; }
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const steps = properties && isRecord(properties.steps) ? properties.steps : undefined;
  const item = steps && isRecord(steps.items) ? steps.items : undefined;
  const branches = item === undefined ? [] : schemaAlternatives(item, schema);
  const relevant = kind === undefined ? [] : branches.filter(branch => propertySchema(branch, "kind")?.const === kind);
  const targetFormSet = new Set<TargetForm>();
  const requiredFields = new Set<string>();
  const allowedFields = new Set<string>();
  const allowedKeys = new Set<string>();
  const allowedChords: string[][] = [];
  for (const branch of relevant) {
    const required = requiredNames(branch);
    for (const field of required) if (field !== "kind" && DIAGNOSTIC_FIELDS.has(field)) requiredFields.add(field);
    const branchProperties = isRecord(branch.properties) ? Object.keys(branch.properties) : [];
    for (const field of branchProperties) if (field !== "kind" && DIAGNOSTIC_FIELDS.has(field)) allowedFields.add(field);
    const target = propertySchema(branch, "target");
    if (target !== undefined) for (const form of targetForms(target, schema)) if (["selector", "ref", "point", "focus"].includes(form)) targetFormSet.add(form as TargetForm);
    if (kind === "drag") targetFormSet.add("path");
    if (kind === "keypress") for (const key of stringEnum(enumValues(propertySchema(branch, "key"), schema))) allowedKeys.add(key);
    if (kind === "hotkey") {
      const chord = chordEnums(propertySchema(branch, "keys"), schema);
      for (const key of chord.keys) allowedKeys.add(key);
      for (const entry of chord.chords) if (!allowedChords.some(existing => JSON.stringify(existing) === JSON.stringify(entry))) allowedChords.push(entry);
    }
  }
  let observationRequired = constraint === "observation_id_required";
  if (!observationRequired && code === REQUEST_ERROR_CODES.schema && isRecord(raw) && typeof raw.observationId !== "string") {
    const stepsValue = Array.isArray(raw.steps) ? raw.steps : [];
    observationRequired = stepsValue.some(step => isRecord(step)
      && (step.kind === "drag" || (isRecord(step.target) && (Object.hasOwn(step.target, "ref") || Object.hasOwn(step.target, "point")))));
  }
  const diagnostic: ActValidationDiagnostic = {
    ...(boundedAtStep === undefined ? {} : { atStep: boundedAtStep }),
    ...(kind === undefined ? {} : { kind }),
    ...(observationRequired ? { constraint: "observation_id_required" as const } : constraint === undefined ? {} : { constraint }),
    ...(targetFormSet.size === 0 ? {} : { targetForms: [...targetFormSet] }),
    ...(requiredFields.size === 0 ? {} : { requiredFields: [...requiredFields] }),
    ...(allowedFields.size === 0 ? {} : { allowedFields: [...allowedFields] }),
    ...(allowedKeys.size === 0 ? {} : { allowedKeys: [...allowedKeys].slice(0, 32) }),
    ...(allowedChords.length === 0 ? {} : { allowedChords: allowedChords.slice(0, 16) }),
  };
  return Object.keys(diagnostic).length > 0 ? diagnostic : undefined;
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
  if (!protocolAccepts(raw)) {
    const atStep = rejectedStep(protocolAccepts) ?? soleObservationBoundStep(raw);
    throw new RequestValidationError(REQUEST_ERROR_CODES.schema, atStep, validationDiagnostic(raw, capabilities, normalizedLimits, REQUEST_ERROR_CODES.schema, atStep));
  }

  const request = raw as ActRequest;
  const grantAccepts = validatorForGrant(capabilities);
  if (!grantAccepts(raw)) {
    const atStep = rejectedStep(grantAccepts);
    throw new RequestValidationError(REQUEST_ERROR_CODES.combination, atStep, validationDiagnostic(raw, capabilities, normalizedLimits, REQUEST_ERROR_CODES.combination, atStep));
  }
  if (hasBudgetViolation(request, normalizedLimits)) throw new RequestValidationError(REQUEST_ERROR_CODES.budget);
  const focusStep = focusOrderViolation(request);
  if (focusStep !== undefined) {
    throw new RequestValidationError(REQUEST_ERROR_CODES.focus, focusStep, validationDiagnostic(raw, capabilities, normalizedLimits, REQUEST_ERROR_CODES.focus, focusStep, "focus_from_step_earlier"));
  }
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

function schemaRefName(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.$ref !== "string" || !value.$ref.startsWith("#/$defs/")) return undefined;
  const name = value.$ref.slice("#/$defs/".length);
  return name.length > 0 ? name : undefined;
}

function schemaDefinition(root: AnyRecord, name: string): AnyRecord | undefined {
  const defs = root.$defs;
  if (!isRecord(defs)) return undefined;
  const definition = defs[name];
  return isRecord(definition) ? definition : undefined;
}

/** Resolve a local definition without following a recursive schema forever. */
function resolveSchema(value: unknown, root: AnyRecord, seen = new Set<string>()): AnyRecord | undefined {
  if (!isRecord(value)) return undefined;
  const name = schemaRefName(value);
  if (name === undefined) return value;
  if (seen.has(name)) return value;
  const definition = schemaDefinition(root, name);
  if (definition === undefined) return value;
  const next = new Set(seen);
  next.add(name);
  const resolved = resolveSchema(definition, root, next) ?? definition;
  const { $ref: _ref, ...localConstraints } = value;
  return { ...resolved, ...localConstraints };
}

/** Expand only the alternatives at a schema node; each action branch stays separate. */
function schemaAlternatives(value: unknown, root: AnyRecord, seen = new Set<string>()): AnyRecord[] {
  if (!isRecord(value)) return [];
  const name = schemaRefName(value);
  if (name !== undefined) {
    if (seen.has(name)) return [value];
    const definition = schemaDefinition(root, name);
    if (definition === undefined) return [value];
    const next = new Set(seen);
    next.add(name);
    return schemaAlternatives(definition, root, next);
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    const alternatives = value[key];
    if (Array.isArray(alternatives)) {
      return alternatives.flatMap(item => schemaAlternatives(item, root, seen));
    }
  }
  return [value];
}

function requiredNames(value: AnyRecord): string[] {
  return Array.isArray(value.required)
    ? value.required.filter((name): name is string => typeof name === "string")
    : [];
}

function propertySchema(value: AnyRecord, name: string): AnyRecord | undefined {
  const properties = value.properties;
  if (!isRecord(properties)) return undefined;
  return isRecord(properties[name]) ? properties[name] : undefined;
}

function enumValues(value: unknown, root: AnyRecord): unknown[] | undefined {
  const resolved = resolveSchema(value, root);
  if (!resolved || !Array.isArray(resolved.enum)) return undefined;
  return resolved.enum;
}

function schemaNumber(value: unknown, root: AnyRecord, key: "minimum" | "maximum" | "maxLength" | "maxItems" | "minItems"): number | undefined {
  const resolved = resolveSchema(value, root);
  const number = resolved?.[key];
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function formatSchemaValue(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value.length <= 120 ? JSON.stringify(value) : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean" || value === null) return JSON.stringify(value);
  if (depth >= 2 || !Array.isArray(value)) return undefined;
  const entries = value.map(item => formatSchemaValue(item, depth + 1));
  return entries.every((entry): entry is string => entry !== undefined) ? `[${entries.join(",")}]` : undefined;
}

function formatEnum(values: readonly unknown[] | undefined): string | undefined {
  if (values === undefined) return undefined;
  const rendered = values.map(value => formatSchemaValue(value));
  if (!rendered.every((entry): entry is string => entry !== undefined)) return undefined;
  const text = rendered.join("|");
  return text.length <= 1200 ? text : undefined;
}

function targetForms(value: unknown, root: AnyRecord): string[] {
  const forms = new Set<string>();
  for (const alternative of schemaAlternatives(value, root)) {
    const required = requiredNames(alternative);
    if (required.includes("role") || required.includes("name")) forms.add("selector");
    if (required.includes("ref")) forms.add("ref");
    if (required.includes("point")) forms.add("point");
    if (required.includes("focusFromStep")) forms.add("focus");
  }
  return ["selector", "ref", "point", "focus"].filter(form => forms.has(form));
}

function targetShapeDescription(form: string): string | undefined {
  switch (form) {
    case "selector": return "selector={role?,name?,within?,state?} (role or name required)";
    case "ref": return "ref={ref}";
    case "point": return "point={point:{x:integer,y:integer}}";
    case "focus": return "focus={focusFromStep: earlier one-based step}";
    default: return undefined;
  }
}

function containsRequired(value: unknown, name: string, seen = new Set<object>()): boolean {
  if (Array.isArray(value)) return value.some(item => containsRequired(item, name, seen));
  if (!isRecord(value) || seen.has(value)) return false;
  seen.add(value);
  if (requiredNames(value).includes(name)) return true;
  return Object.values(value).some(child => containsRequired(child, name, seen));
}

function containsConst(value: unknown, expected: string, seen = new Set<object>()): boolean {
  if (Array.isArray(value)) return value.some(item => containsConst(item, expected, seen));
  if (!isRecord(value) || seen.has(value)) return false;
  seen.add(value);
  if (value.const === expected) return true;
  return Object.values(value).some(child => containsConst(child, expected, seen));
}

function rangeDescription(value: unknown, root: AnyRecord): string {
  const minimum = schemaNumber(value, root, "minimum");
  const maximum = schemaNumber(value, root, "maximum");
  if (minimum !== undefined && maximum !== undefined) return `integer ${minimum}..${maximum}`;
  if (minimum !== undefined) return `integer >=${minimum}`;
  if (maximum !== undefined) return `integer <=${maximum}`;
  return "integer";
}

function chordDescription(value: unknown, root: AnyRecord): string {
  const direct = formatEnum(enumValues(value, root));
  if (direct !== undefined) return `keys=${direct}`;
  const resolved = resolveSchema(value, root);
  const alternatives = resolved && Array.isArray(resolved.oneOf) ? resolved.oneOf.filter(isRecord) : [];
  const lengths = alternatives.flatMap(alternative => {
    const prefix = alternative.prefixItems;
    return Array.isArray(prefix) ? [prefix.length] : [];
  });
  if (lengths.length > 0) {
    const keySchemas = alternatives.flatMap(alternative => {
      const prefix = alternative.prefixItems;
      return Array.isArray(prefix) && prefix.length > 0 ? [prefix[prefix.length - 1]] : [];
    });
    const keys = keySchemas.flatMap(key => enumValues(key, root) ?? []);
    const keyText = formatEnum(unique(keys));
    const min = Math.min(...lengths);
    const max = Math.max(...lengths);
    return `keys=chord(${min}..${max} items${keyText ? `; key=${keyText}` : "; modifiers then key"})`;
  }
  return "keys=chord";
}

function describeActionBranch(branch: AnyRecord, root: AnyRecord, codeStyle: boolean): string | undefined {
  const kindValue = propertySchema(branch, "kind")?.const;
  if (typeof kindValue !== "string") return undefined;
  const required = requiredNames(branch).filter(name => codeStyle || name !== "kind");
  const parts = [`required=${required.length > 0 ? required.join(",") : "none"}`];
  const target = propertySchema(branch, "target");
  const forms = target === undefined ? [] : targetForms(target, root);
  if (target !== undefined) parts.push(`target=${forms.length > 0 ? forms.join("|") : "schema-defined"}`);
  switch (kindValue) {
    case "click": {
      const button = formatEnum(enumValues(propertySchema(branch, "button"), root));
      const count = formatEnum(enumValues(propertySchema(branch, "count"), root));
      parts.push(`button=${button ?? "schema-defined"}${required.includes("button") ? " (required)" : " (optional; default left)"}`);
      parts.push(`count=${count ?? "schema-defined"}${required.includes("count") ? " (required)" : " (optional; default 1)"}; right+2 is invalid`);
      break;
    }
    case "type": {
      const limit = schemaNumber(propertySchema(branch, "text"), root, "maxLength");
      parts.push(`text=string${limit === undefined ? "" : ` maxLength=${limit}`}`);
      if (propertySchema(branch, "delivery") !== undefined) parts.push("delivery=foreground (optional; requires the host's foreground type grant)");
      break;
    }
    case "setValue": {
      const limit = schemaNumber(propertySchema(branch, "value"), root, "maxLength");
      parts.push(`value=string${limit === undefined ? "" : ` maxLength=${limit}`}`);
      break;
    }
    case "scroll": {
      const direction = formatEnum(enumValues(propertySchema(branch, "direction"), root));
      const by = formatEnum(enumValues(propertySchema(branch, "by"), root));
      parts.push(`direction=${direction ?? "schema-defined"}`);
      parts.push(`amount=${rangeDescription(propertySchema(branch, "amount"), root)}`);
      parts.push(`by=${by ?? "schema-defined"}${required.includes("by") ? " (required)" : " (optional; default line)"}`);
      break;
    }
    case "keypress": {
      const key = formatEnum(enumValues(propertySchema(branch, "key"), root));
      parts.push(`key=${key ?? "schema-defined key"}`);
      break;
    }
    case "hotkey":
      parts.push(chordDescription(propertySchema(branch, "keys"), root));
      break;
    case "drag":
      parts.push("from=point", "to=point");
      break;
  }
  if (propertySchema(branch, "expect") !== undefined) parts.push("expect?{target:selector,state|valueEquals}");
  return codeStyle
    ? `step{kind:${JSON.stringify(kindValue)}; ${parts.join("; ")}}`
    : `${kindValue}{${parts.join("; ")}}`;
}

function actionExample(branch: AnyRecord, root: AnyRecord): string | undefined {
  const kindValue = propertySchema(branch, "kind")?.const;
  if (kindValue !== "click") return undefined;
  const required = requiredNames(branch);
  if (required.some(name => name !== "kind" && name !== "target")) return undefined;
  const forms = targetForms(propertySchema(branch, "target"), root);
  if (forms.includes("ref")) return "await desk.act({observationId: observation.observationId, steps:[{kind:\"click\",target:{ref: matched.ref}}]})";
  if (forms.includes("selector")) return "await desk.act({steps:[{kind:\"click\",target:{name:\"matched label\"}}]})";
  return undefined;
}

/**
 * Describe the exact action parameter combinations in a host-provided act
 * schema. This is documentation only: it does not broaden or replace the
 * validator, and it keeps each step variant's target/parameter constraints
 * separate.
 */
export function describeActParameters(schema: unknown, options: { readonly codeStyle?: boolean } = {}): string | undefined {
  if (!isRecord(schema)) return undefined;
  const codeStyle = options.codeStyle === true;
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const steps = properties && isRecord(properties.steps) ? properties.steps : undefined;
  const item = steps && isRecord(steps.items) ? steps.items : undefined;
  if (item === undefined) return undefined;
  const variants = schemaAlternatives(item, schema);
  const advertisedForms = new Set<string>();
  const actions = variants.map(branch => {
    const target = propertySchema(branch, "target");
    if (target !== undefined) targetForms(target, schema).forEach(form => advertisedForms.add(form));
    const kind = propertySchema(branch, "kind")?.const;
    if (kind === "drag") advertisedForms.add("point");
    return describeActionBranch(branch, schema, codeStyle);
  }).filter((description): description is string => description !== undefined);
  if (actions.length === 0) {
    const rootProperties = properties ?? {};
    const modes = [
      ...(isRecord(rootProperties.activate) ? ["activate=<application id> is the only available action until an app is active"] : []),
      ...(isRecord(rootProperties.navigate) ? ["navigate=<authorized URI> is available only after an app with navigation is active"] : []),
    ];
    return modes.length > 0 ? modes.join("; ") : undefined;
  }

  const limits: string[] = [];
  const minSteps = schemaNumber(steps, schema, "minItems");
  const maxSteps = schemaNumber(steps, schema, "maxItems");
  if (minSteps !== undefined || maxSteps !== undefined) {
    limits.push(`steps=${minSteps ?? 0}..${maxSteps ?? "unbounded"}`);
  }
  const textLimit = schemaNumber(schemaDefinition(schema, "text"), schema, "maxLength");
  const valueLimit = schemaNumber(schemaDefinition(schema, "literal"), schema, "maxLength");
  if (textLimit !== undefined) limits.push(`text maxLength=${textLimit}`);
  if (valueLimit !== undefined && valueLimit !== textLimit) limits.push(`value maxLength=${valueLimit}`);

  const example = codeStyle
    ? variants.map(branch => actionExample(branch, schema)).find((value): value is string => value !== undefined)
    : undefined;
  const guide = [codeStyle ? `steps (flat kind variants){${actions.join(" | ")}}` : `steps{${actions.join(" | ")}}`];
  const hasType = variants.some(branch => propertySchema(branch, "kind")?.const === "type");
  const hasSetValue = variants.some(branch => propertySchema(branch, "kind")?.const === "setValue");
  if (hasType || hasSetValue) {
    guide.push([
      ...(hasType ? ["type inserts at the current caret or selection"] : []),
      ...(hasSetValue ? ["setValue replaces the whole current value when advertised and the target accepts it"] : []),
    ].join("; "));
  }
  const hasForegroundType = variants.some(branch =>
    propertySchema(branch, "kind")?.const === "type"
    && propertySchema(branch, "delivery")?.const === "foreground"
    && targetForms(propertySchema(branch, "target"), schema).some(form => form === "selector" || form === "ref"));
  if (hasForegroundType && (maxSteps === undefined || maxSteps >= 2)
    && variants.some(branch => propertySchema(branch, "kind")?.const === "type"
      && targetForms(propertySchema(branch, "target"), schema).includes("focus"))
    && variants.some(branch => propertySchema(branch, "kind")?.const === "hotkey"
      && chordEnums(propertySchema(branch, "keys"), schema).chords.some(keys => keys.join("+") === "ctrl+a"))) {
    guide.push('To replace selected text after Ctrl+A, use type with target:{focusFromStep:<Ctrl+A step>} in the same act to preserve the selection.');
  }
  const hasEnterFocus = variants.some(branch =>
    propertySchema(branch, "kind")?.const === "keypress"
    && enumValues(propertySchema(branch, "key"), schema)?.includes("Enter") === true
    && targetForms(propertySchema(branch, "target"), schema).includes("focus"));
  if (hasForegroundType && hasEnterFocus && (maxSteps === undefined || maxSteps >= 2)) {
    guide.push(
      `native grid option (only for verified selected-cell replacement; do not start from an active editor caret): type directly at the exact selector or current ref with delivery:"foreground", then Enter using target:{focusFromStep:<one-based TYPE step>} in the same act. Example: [{kind:"type",target:{name:"<exact cell name>"},text:"<new value>",delivery:"foreground"},{kind:"keypress",target:{focusFromStep:1},key:"Enter"}]. Foreground type targets the cell itself; do not pre-click on this route because the extra activation can put the caret into old text. Read the cell back after Enter. ${hasSetValue ? "If setValue is target_not_actionable, it was not sent; switch only when this grid path is verified. " : ""}Never repeat a dispatched type to recover a refused Enter.`,
    );
  }
  const hasCommandClick = variants.some(branch =>
    propertySchema(branch, "kind")?.const === "click"
    && targetForms(propertySchema(branch, "target"), schema).some(form => form === "selector" || form === "ref"));
  const hasKeyboardAction = variants.some(branch => {
    const kind = propertySchema(branch, "kind")?.const;
    return kind === "keypress" || kind === "hotkey";
  });
  if (hasCommandClick && hasKeyboardAction) {
    guide.push(
      "For a named application command, if the focused receiver lacks the needed keyboard action, use its exact visible command control (such as a toolbar command) only when a fresh observation identifies its role/name and shows actions includes click. After unknown or partial delivery, verify the effect; never reissue the command.",
    );
  }
  if (example !== undefined) guide.push(`canonical example: ${example}; never use keyed steps such as {click:{...}}`);
  const shapes = ["selector", "ref", "point", "focus"]
    .filter(form => advertisedForms.has(form))
    .map(targetShapeDescription)
    .filter((shape): shape is string => shape !== undefined);
  if (shapes.length > 0) guide.push(`target shapes: ${shapes.join("; ")}`);
  if (advertisedForms.has("point")) {
    guide.push("point target is exactly target:{point:{x:integer,y:integer}}; use one observation's pixel pair, not an [x,y] array; keep each sibling as its own flat {kind,target,...} step");
  }
  if (limits.length > 0) guide.push(`limits: ${limits.join(", ")}`);
  const condition = schema.if;
  if (isRecord(schema.then) && containsRequired(schema.then, "observationId")
    && (containsConst(condition, "drag") || containsRequired(condition, "ref") || containsRequired(condition, "point"))) {
    guide.push("observationId is required when any step uses drag or a ref/point target");
  }
  const rootProperties = properties ?? {};
  if (isRecord(rootProperties.activate)) guide.push("activate=<application id> is a standalone switch; its successful receipt includes that app's actionParameters");
  if (isRecord(rootProperties.navigate)) guide.push("navigate=<authorized URI> is a standalone navigation");
  return guide.join("; ");
}

function describeObserveRead(value: AnyRecord, root: AnyRecord): string | undefined {
  const variants = Array.isArray(value.oneOf) ? value.oneOf.filter(isRecord) : [];
  const documentVariant = variants.find(variant => formatEnum(enumValues(variant, root)) !== undefined);
  const objectVariant = variants.find(variant => variant.type === "object" && isRecord(variant.properties));
  const documentText = documentVariant ? formatEnum(enumValues(documentVariant, root)) : undefined;
  if (!objectVariant) return documentText ? `read=${documentText}` : undefined;
  const query = propertySchema(objectVariant, "query");
  const cursor = propertySchema(objectVariant, "cursor");
  const queryLimit = schemaNumber(query, root, "maxLength");
  const cursorLimit = schemaNumber(cursor, root, "maxLength");
  const queryText = `query:string${queryLimit === undefined ? "" : ` maxLength=${queryLimit}`}`;
  const cursorText = `cursor:string${cursorLimit === undefined ? "" : ` maxLength=${cursorLimit}`}`;
  const objectText = `{${query ? queryText : ""}${query && cursor ? " XOR " : ""}${cursor ? cursorText : ""}}`;
  const resultText = "document.query echoes the query; matches are in document.matchCount and document.chunks[].text; continue with document.nextCursor";
  return `${documentText ? `read=${documentText}|${objectText}` : `read=${objectText}`} (${resultText})`;
}

/** Describe the exact observe shapes exposed by one secured host. */
export function describeObserveParameters(schema: unknown): string | undefined {
  if (!isRecord(schema)) return undefined;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const guide: string[] = [];
  const view = propertySchema(schema, "view");
  const viewValues = enumValues(view, schema);
  const supportedViews = viewValues?.filter(value => value === "controls" || value === "document");
  const views = formatEnum(supportedViews);
  if (views !== undefined) guide.push(`view=${views}`);
  if (viewValues?.some(value => value === "image" || value === "both")) guide.push("image/both views are unavailable inside run_code");
  let exactWhere: string[] = [];
  const where = propertySchema(schema, "where");
  if (where !== undefined) {
    const whereProperties = isRecord(where.properties) ? where.properties : {};
    const fields = ["role", "name", "within", "state"].filter(field => isRecord(whereProperties[field]));
    exactWhere = fields.filter(field => field === "name" || field === "within" || field === "state");
    const state = formatEnum(enumValues(propertySchema(where, "state"), schema));
    const fieldText = fields.map(field => field === "state" ? `state?${state ? `=${state}` : "=enum"}` : `${field}?:string`);
    guide.push(`where={${fieldText.join(",")}} (at least one field; string fields are literal, not regex; name is the control's own name, while within is an observed enclosing container/window, not a position, range, or leaf control name)`);
  }
  const read = propertySchema(schema, "read");
  if (read !== undefined) {
    const readGuide = describeObserveRead(read, schema);
    if (readGuide !== undefined) guide.push(`${readGuide} (only when rendered document text is advertised)`);
  } else {
    guide.push("read is not advertised");
  }
  if (where !== undefined) {
    const exactFilters = exactWhere.map(field => field === "state" ? 'where:{state:"focused"}' : `where:{${field}:<exact ${field}>}`).join(" or ");
    guide.push(`For a named actionable target, use an exact selector if its action advertises one; otherwise observe with ${exactFilters || "an exact where filter"} and use the current ref. Use read.query for prose when advertised. A scoped role or observed enclosing-container query is appropriate when a loop needs related items; avoid unscoped desktop dumps.`);
  }
  if (isRecord(properties.projection)) {
    guide.push('projection={mode:"compact",maxControls?,since?} or {mode:"full"}; for related-item enumeration, use a scoped where role or observed enclosing container and request full only when compact clips needed rows; filter inside the program and skip unscoped desktop dumps. maxControls is a requested upper bound and may also be clipped by host or byte limits. For compact results, check frame.projection.backendComplete and frame.projection.truncated: backendComplete:false means backend enumeration was incomplete; truncated:true means compact rows were clipped. For full results, check frame.complete. Use observationId only when complete and untruncated. Compare since:"previous" only against the same view/where/maxControls scope when backendComplete:true; it compares that scope and is not pagination for previously clipped rows; skip act-verified rechecks and use current refs or exact selectors');
  }
  if (isRecord(properties.workspace)) guide.push("workspace=true is a standalone inventory call (do not combine it with view/read/where/projection)");
  else guide.push("workspace is not advertised");
  return guide.length > 0 ? guide.join("; ") : "No scoped observe parameters are advertised.";
}
