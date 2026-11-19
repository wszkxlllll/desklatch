import assert from "node:assert/strict";
import test from "node:test";

import { actToolSchema, validateRequest } from "../dist/request.js";

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
