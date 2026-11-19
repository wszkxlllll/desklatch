import test from "node:test";
import assert from "node:assert/strict";
import { createRiskPolicy, defaultRiskPolicy } from "../dist/policy.js";

function control(overrides = {}) {
  return {
    id: "control-1",
    role: "textbox",
    name: "Message",
    states: ["visible", "enabled", "editable", "focused"],
    actions: ["type", "setValue"],
    ...overrides,
  };
}

function input(step, target = control(), extra = {}) {
  return { step, target, ...extra };
}

test("default policy allows ordinary structural typing without inspecting body text", async () => {
  const result = await defaultRiskPolicy(input({ kind: "type", target: { role: "textbox", name: "Message" }, text: "Please do not send this yet" }));
  assert.deepEqual(result, { decision: "allow", code: "structural_text_input" });
});

test("the action target, not a nearby label, determines send/payment approval", async () => {
  const send = await defaultRiskPolicy(input({ kind: "click", target: { role: "button", name: "Send" } }, control({ role: "button", name: "Send", actions: ["click"] })));
  assert.equal(send.decision, "approve");
  assert.match(send.code, /external/);

  const history = await defaultRiskPolicy(input({ kind: "click", target: { role: "link", name: "Payment history" } }, control({ role: "link", name: "Payment history", actions: ["click"], effect: "navigate" })));
  assert.equal(history.decision, "allow");
});

test("unknown actions do not silently allow and a clear text-only review may allow", async () => {
  let request;
  const policy = createRiskPolicy({
    reviewer: async (value) => {
      request = value;
      return { classification: "clear" };
    },
  });
  const result = await policy(input({ kind: "click", target: { role: "button", name: "Continue" } }, control({ role: "button", name: "Continue", actions: ["click"] })));
  assert.equal(result.decision, "allow");
  assert.equal(Object.hasOwn(request, "image"), false);
  assert.equal(Object.hasOwn(request, "imageBase64"), false);

  const noReviewer = await defaultRiskPolicy(input({ kind: "click", target: { role: "button", name: "Continue" } }, control({ role: "button", name: "Continue", actions: ["click"] })));
  assert.equal(noReviewer.decision, "approve");
});

test("host hard denial cannot be overridden by a reviewer", async () => {
  let reviewed = false;
  let ocrCalls = 0;
  const policy = createRiskPolicy({
    hostRules: { hardDeny: () => true },
    ocr: { localOnly: true, recognize: async () => { ocrCalls += 1; return { lines: [] }; } },
    reviewer: async () => {
      reviewed = true;
      return { classification: "clear" };
    },
  });
  const result = await policy(input({ kind: "click", target: { role: "button", name: "Continue" } }, control({ role: "button", name: "Continue", actions: ["click"] })));
  assert.equal(result.decision, "deny");
  assert.equal(reviewed, false);
  assert.equal(ocrCalls, 0);
});

test("review timeout fails closed to approval", async () => {
  const policy = createRiskPolicy({
    timeoutMs: 10,
    reviewer: () => new Promise(() => {}),
  });
  const result = await policy(input({ kind: "click", target: { role: "button", name: "Continue" } }, control({ role: "button", name: "Continue", actions: ["click"] })));
  assert.equal(result.decision, "approve");
  assert.equal(result.code, "review_timeout");
});
