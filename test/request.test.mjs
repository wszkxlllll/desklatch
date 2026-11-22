import assert from "node:assert/strict";
import test from "node:test";

import { actToolSchema, describeActParameters, validateRequest } from "../dist/request.js";
import { createDeskTools } from "../dist/tools.js";

const selector = (name = "OK") => ({ role: "Button", name });

test("validates a request against one exact capability entry", () => {
  const capabilities = [{ kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] }];
  const request = { steps: [{ kind: "click", target: selector() }] };
  assert.deepEqual(validateRequest(request, capabilities), request);

  const schema = actToolSchema(capabilities);
  assert.equal(schema.$defs.step.anyOf.length, 1);
  assert.doesNotMatch(JSON.stringify(schema.$defs.step), /setValue|scroll|hotkey|drag/);
  assert.throws(
    () => validateRequest({ steps: [{ kind: "click", target: { point: { x: 1, y: 1 } } }], observationId: "o" }, capabilities),
    (error) => error.message === "capability_combination_invalid",
  );
});

test("keeps disjoint capability variants as alternatives", () => {
  const capabilities = [
    { kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] },
    { kind: "click", targets: ["ref"], buttons: ["right"], counts: [1] },
  ];
  assert.doesNotThrow(() => validateRequest({ steps: [{ kind: "click", target: selector() }] }, capabilities));
  assert.doesNotThrow(() => validateRequest({ observationId: "obs", steps: [{ kind: "click", target: { ref: "r1" }, button: "right" }] }, capabilities));
  assert.throws(
    () => validateRequest({ steps: [{ kind: "click", target: selector(), button: "right" }] }, capabilities),
    (error) => error.message === "capability_combination_invalid",
  );
});

test("reports schema, combination, budget, then focus-order failures in that order", () => {
  const capabilities = [{ kind: "type", targets: ["focus"] }];
  assert.throws(
    () => validateRequest({ steps: [{ kind: "type", target: { focusFromStep: 1 }, text: "x", secret: "no" }] }, capabilities, { maxSteps: 0 }),
    (error) => error.message === "schema_invalid",
  );
  assert.throws(
    () => validateRequest({ steps: [{ kind: "click", target: selector() }] }, capabilities, { maxSteps: 1 }),
    (error) => error.message === "capability_combination_invalid",
  );
  assert.throws(
    () => validateRequest({ steps: [{ kind: "type", target: { focusFromStep: 1 }, text: "xx" }] }, capabilities, { maxTextLength: 1 }),
    (error) => error.message === "budget_exceeded",
  );
  assert.throws(
    () => validateRequest({ steps: [{ kind: "type", target: { focusFromStep: 1 }, text: "x" }] }, capabilities),
    (error) => error.message === "focus_reference_order_invalid",
  );
});

test("requires an observation for refs, points and drags and rejects secret fields", () => {
  const capabilities = [
    { kind: "click", targets: ["ref", "point"] },
    { kind: "drag", targets: ["path"] },
  ];
  const drag = { kind: "drag", from: { x: 1, y: 1 }, to: { x: 2, y: 2 } };
  assert.doesNotThrow(() => validateRequest({ observationId: "obs", steps: [drag] }, capabilities));
  assert.throws(() => validateRequest({ steps: [drag] }, capabilities), error => error.message === "schema_invalid");
  assert.throws(
    () => validateRequest({ steps: [{ kind: "click", target: { ref: "r1" } }] }, capabilities),
    (error) => error.message === "schema_invalid",
  );
  assert.throws(
    () => validateRequest({ observationId: "obs", steps: [{ kind: "drag", from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, approval: true }] }, capabilities),
    (error) => error.message === "schema_invalid",
  );
});

test("point action guidance keeps the target shape and sibling steps explicit", () => {
  const schema = actToolSchema([
    { kind: "click", targets: ["point"], buttons: ["left"], counts: [1] },
  ]);
  const guide = describeActParameters(schema);
  assert.match(schema.$defs.point.description, /Screenshot pixel target/u);
  assert.match(schema.$defs.point.description, /exact fresh observationId/u);
  assert.match(guide, /point=\{point:\{x:integer,y:integer\}\}/u);
  assert.match(guide, /point target is exactly target:\{point:\{x:integer,y:integer\}\}/u);
  assert.match(guide, /not an \[x,y\] array/u);
  assert.match(guide, /each sibling as its own flat \{kind,target,\.\.\.\} step/u);
  assert.match(guide, /observationId is required when any step uses drag or a ref\/point target/u);
});

test("type points require an exact point capability and an observation", () => {
  const pointStep = { kind: "type", target: { point: { x: 579, y: 914 } }, text: "Review" };
  const ordinary = [{ kind: "type", targets: ["selector", "ref", "focus"] }];
  assert.throws(
    () => validateRequest({ observationId: "obs", steps: [pointStep] }, ordinary),
    (error) => error.message === "capability_combination_invalid",
  );
  const pointCapability = [{ kind: "type", targets: ["selector", "ref", "focus", "point"] }];
  assert.doesNotThrow(() => validateRequest({ observationId: "obs", steps: [pointStep] }, pointCapability));
  assert.throws(
    () => validateRequest({ steps: [pointStep] }, pointCapability),
    (error) => error.message === "schema_invalid",
  );
});

test("foreground type delivery is advertised and accepted only by an explicit type grant", () => {
  const ordinary = [{ kind: "type", targets: ["selector", "ref"] }];
  const foreground = [{ kind: "type", targets: ["selector", "ref", "point"], foreground: true }];
  const ordinarySchema = actToolSchema(ordinary);
  const foregroundSchema = actToolSchema(foreground);
  assert.doesNotMatch(JSON.stringify(ordinarySchema.$defs.step), /delivery/iu);
  assert.match(JSON.stringify(foregroundSchema.$defs.step), /foreground/iu);
  const step = { kind: "type", target: { ref: "cell-ref" }, text: "Review", delivery: "foreground" };
  assert.throws(
    () => validateRequest({ observationId: "obs", steps: [step] }, ordinary),
    (error) => error.message === "capability_combination_invalid",
  );
  assert.doesNotThrow(() => validateRequest({ observationId: "obs", steps: [step] }, foreground));
  assert.doesNotThrow(() => validateRequest({ observationId: "obs", steps: [{ kind: "type", target: { ref: "cell-ref" }, text: "Review" }] }, foreground));
});

test("action guide exposes a bounded foreground grid type-and-commit recipe only when granted", () => {
  const capabilities = [
    { kind: "type", targets: ["selector", "ref"], foreground: true },
    { kind: "setValue", targets: ["selector", "ref"] },
    { kind: "keypress", targets: ["selector", "ref", "focus"], keys: ["Enter", "Tab"] },
  ];
  const twoStepGuide = describeActParameters(actToolSchema(capabilities, { maxSteps: 2 }));
  assert.match(twoStepGuide, /type inserts at the current caret or selection/u);
  assert.match(twoStepGuide, /setValue replaces the whole current value/u);
  assert.match(twoStepGuide, /native grid option.*delivery:"foreground"/u);
  assert.match(twoStepGuide, /focusFromStep:<one-based TYPE step>/u);
  assert.match(twoStepGuide, /do not start from an active editor caret/u);
  assert.match(twoStepGuide, /target:\{name:"<exact cell name>"\}.*focusFromStep:1/u);
  assert.match(twoStepGuide, /do not pre-click on this route.*put the caret into old text/u);
  assert.match(twoStepGuide, /read the cell back/iu);
  assert.match(twoStepGuide, /setValue is target_not_actionable/u);
  assert.doesNotMatch(twoStepGuide, /put the click before type/u);

  for (const target of ["selector", "ref"]) {
    const targetGuide = describeActParameters(actToolSchema([
      { kind: "type", targets: [target], foreground: true },
      { kind: "keypress", targets: ["focus"], keys: ["Enter"] },
    ]));
    assert.match(targetGuide, /native grid option/u, `${target} type targeting should expose the guide`);
  }
  const oneStepGuide = describeActParameters(actToolSchema(capabilities, { maxSteps: 1 }));
  assert.doesNotMatch(oneStepGuide, /native grid option/u);

  const act = createDeskTools({
    capabilities,
    allowModelImages: false,
    limits: { maxSteps: 3 },
    observe: async () => ({}),
    act: async () => ({}),
  }).find(tool => tool.name === "act");
  assert.match(act.description, /native grid option/u);
  assert.equal(act.description.split("type inserts at the current caret or selection").length - 1, 1);

  const noEnter = describeActParameters(actToolSchema([
    capabilities[0],
    { kind: "keypress", targets: ["selector", "ref", "focus"], keys: ["Tab"] },
  ]));
  assert.doesNotMatch(noEnter, /native grid option/u);
  const noForeground = describeActParameters(actToolSchema([
    { kind: "type", targets: ["selector", "ref"] },
    capabilities[2],
  ]));
  assert.doesNotMatch(noForeground, /native grid option/u);
});

test("action guide offers an observed command control only with click and keyboard grants", () => {
  const click = { kind: "click", targets: ["selector", "ref"], buttons: ["left"], counts: [1] };
  const hotkey = { kind: "hotkey", targets: ["selector", "ref", "focus"], chords: [["ctrl", "s"]] };
  const guide = describeActParameters(actToolSchema([click, hotkey]));
  assert.match(guide, /For a named application command/u);
  assert.match(guide, /fresh observation identifies its role\/name/u);
  assert.match(guide, /actions includes click/u);
  assert.match(guide, /After unknown or partial delivery, verify the effect; never reissue the command/u);

  const directAct = createDeskTools({
    capabilities: [click, hotkey],
    allowModelImages: false,
    observe: async () => ({}),
    act: async () => ({}),
  }).find(tool => tool.name === "act");
  assert.match(directAct.description, /For a named application command/u);

  assert.doesNotMatch(describeActParameters(actToolSchema([hotkey])), /named application command/u);
  assert.doesNotMatch(describeActParameters(actToolSchema([
    { ...click, targets: ["point"] },
    hotkey,
  ])), /named application command/u);
  assert.doesNotMatch(describeActParameters(actToolSchema([click])), /named application command/u);
});
