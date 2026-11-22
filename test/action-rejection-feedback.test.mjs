import assert from "node:assert/strict";
import test from "node:test";

import { createDeskCodeMode } from "desklatch/code-mode";
import { createDeskSession, createDeskTools } from "desklatch";
import { validateRequest } from "../src/request.ts";

const capabilities = [
  { kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] },
  { kind: "type", targets: ["selector"] },
  { kind: "hotkey", targets: ["selector"], keys: ["x"] },
];

const validClick = { kind: "click", target: { name: "Save" } };
const invalidSchemaBatch = {
  steps: [
    validClick,
    { kind: "hotkey", target: { name: "Save" }, keys: ["ctrl", "alt", "shift", "meta", "x", "z"] },
  ],
};
const invalidCapabilityBatch = {
  steps: [
    validClick,
    { kind: "type", target: { focusFromStep: 1 }, text: "private entry" },
  ],
};

function makeBackend() {
  const calls = { observe: 0, dispatch: [] };
  return {
    calls,
    capabilities,
    async observe() {
      calls.observe += 1;
      return {
        scope: "test",
        complete: true,
        controls: [{
          id: "save-button",
          role: "Button",
          name: "Save",
          states: ["visible", "enabled"],
          actions: ["click"],
          effect: "edit",
        }],
      };
    },
    async dispatch(request) {
      calls.dispatch.push(request);
      return { status: "dispatched", focusId: request.target.id };
    },
    async close() {},
  };
}

test("request validation reports one provable failing step and omits ambiguous or batch errors", () => {
  assert.deepEqual(validateRequest({ steps: [validClick] }, capabilities), { steps: [validClick] });

  assert.throws(() => validateRequest(invalidSchemaBatch, capabilities), error => {
    assert.equal(error.code, "schema_invalid");
    assert.equal(error.atStep, 2);
    assert.deepEqual(error.diagnostic?.allowedKeys, ["x"]);
    assert.equal(error.diagnostic?.kind, "hotkey");
    assert.equal(error.message.includes("private entry"), false);
    return true;
  });
  assert.throws(() => validateRequest(invalidCapabilityBatch, capabilities), error => {
    assert.equal(error.code, "capability_combination_invalid");
    assert.equal(error.atStep, 2);
    assert.equal(error.diagnostic?.kind, "type");
    assert.deepEqual(error.diagnostic?.targetForms, ["selector"]);
    assert.equal(error.message.includes("private entry"), false);
    return true;
  });

  assert.throws(() => validateRequest({ steps: [validClick, { kind: "click", target: { point: { x: 1, y: 1 } } }] }, capabilities), error => {
    assert.equal(error.code, "schema_invalid");
    assert.equal(error.atStep, 2);
    assert.equal(error.diagnostic?.constraint, "observation_id_required");
    assert.equal(error.diagnostic?.kind, "click");
    return true;
  });

  const pointCapabilities = [{ kind: "click", targets: ["point"], buttons: ["left"], counts: [1] }];
  assert.throws(() => validateRequest({ steps: [{ kind: "click", target: { point: { x: 1, y: 1 } } }] }, pointCapabilities), error => {
    assert.equal(error.code, "schema_invalid");
    assert.equal(error.atStep, 1);
    assert.equal(error.diagnostic?.constraint, "observation_id_required");
    assert.deepEqual(error.diagnostic?.targetForms, ["point"]);
    return true;
  });

  const selectorOnly = [{ kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] }];
  assert.throws(() => validateRequest({ observationId: "obs", steps: [{ kind: "click", target: { point: { x: 1, y: 1 } } }] }, selectorOnly), error => {
    assert.equal(error.code, "capability_combination_invalid");
    assert.deepEqual(error.diagnostic?.targetForms, ["selector"]);
    return true;
  });
  const enterOnly = [{ kind: "keypress", targets: ["selector"], keys: ["Enter"] }];
  assert.throws(() => validateRequest({ steps: [{ kind: "keypress", target: { name: "Cell" }, key: "Escape" }] }, enterOnly), error => {
    assert.equal(error.code, "capability_combination_invalid");
    assert.deepEqual(error.diagnostic?.allowedKeys, ["Enter"]);
    assert.equal(JSON.stringify(error.diagnostic).includes("Cell"), false);
    return true;
  });
});

test("direct act and Code Mode expose atStep for atomic rejections without dispatch", async t => {
  const backend = makeBackend();
  const session = createDeskSession(backend, { capabilities, policy: () => ({ decision: "allow", code: "test_allow" }) });
  const codeMode = createDeskCodeMode({ tools: createDeskTools(session), close: () => session.close() });
  t.after(() => codeMode.close());

  const schemaRejected = await session.act(invalidSchemaBatch);
  assert.equal(schemaRejected.status, "rejected");
  assert.equal(schemaRejected.code, "schema_invalid");
  assert.equal(schemaRejected.atStep, 2);
  assert.equal(schemaRejected.validation?.kind, "hotkey");
  assert.deepEqual(schemaRejected.validation?.allowedKeys, ["x"]);
  assert.deepEqual(schemaRejected.steps, []);

  const grantRejected = await session.act(invalidCapabilityBatch);
  assert.equal(grantRejected.status, "rejected");
  assert.equal(grantRejected.code, "capability_combination_invalid");
  assert.equal(grantRejected.atStep, 2);
  assert.equal(grantRejected.validation?.kind, "type");
  assert.deepEqual(grantRejected.steps, []);

  const codeResult = await codeMode.runCode({ code: `
    await desk.act({ steps: [
      { kind: "click", target: { name: "Save" } },
      { kind: "type", target: { focusFromStep: 1 }, text: "private entry" },
    ] });
  ` });
  assert.equal(codeResult.status, "stopped");
  assert.equal(codeResult.code, "capability_combination_invalid");
  assert.equal(codeResult.actions[0].status, "rejected");
  assert.equal(codeResult.actions[0].code, "capability_combination_invalid");
  assert.equal(codeResult.actions[0].atStep, 2);
  assert.equal(codeResult.actions[0].validation?.kind, "type");
  assert.deepEqual(codeResult.actions[0].steps, []);
  assert.equal(JSON.stringify({ schemaRejected, grantRejected, codeResult }).includes("private entry"), false);
  assert.equal(backend.calls.observe, 0);
  assert.equal(backend.calls.dispatch.length, 0);

  const valid = await session.act({ steps: [validClick] });
  assert.equal(valid.status, "completed", JSON.stringify(valid));
  assert.equal(valid.atStep, undefined);
  assert.equal(backend.calls.dispatch.length, 1);
});
