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
  assert.equal(noReviewer.decision, "needs_evidence");
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

test("a review timeout leaves the step unsent without requesting consent", async () => {
  const policy = createRiskPolicy({
    timeoutMs: 10,
    reviewer: () => new Promise(() => {}),
  });
  const result = await policy(input({ kind: "click", target: { role: "button", name: "Continue" } }, control({ role: "button", name: "Continue", actions: ["click"] })));
  assert.equal(result.decision, "needs_evidence");
  assert.equal(result.code, "review_timeout");
});

test("each ambiguous step can be cleared, and an explicit cumulative budget is respected", async () => {
  const step = input({ kind: "click", target: { name: "Continue" } },
    control({ role: "button", name: "Continue", effect: "unknown", actions: ["click"] }));
  let reviews = 0;
  const reviewer = () => { reviews++; return { classification: "low" }; };
  const policy = createRiskPolicy({ reviewer });
  for (let index = 0; index < 4; index++) assert.equal((await policy(step)).decision, "allow");
  assert.equal(reviews, 4);

  const metered = createRiskPolicy({ reviewer, maxExternalRequests: 1 });
  const results = await Promise.all([metered(step), metered(step)]);
  assert.deepEqual(results.map(result => result.decision).sort(), ["allow", "needs_evidence"]);
  assert.equal(results.find(result => result.decision === "needs_evidence").code, "review_budget_exhausted");
  assert.equal(reviews, 5);
});

test("review distinguishes an identifiable risk, insufficient evidence and a definite refusal", async () => {
  const step = input({ kind: "click", target: { name: "Continue" } },
    control({ role: "button", name: "Continue", effect: "unknown", actions: ["click"] }));
  for (const [review, expected] of [
    [{ classification: "high" }, "approve"],
    [{ classification: "suspicious" }, "needs_evidence"],
    [{ classification: "unclear" }, "needs_evidence"],
    [{ classification: "unknown" }, "needs_evidence"],
    [{ decision: "deny" }, "deny"],
  ]) {
    assert.equal((await createRiskPolicy({ reviewer: () => review })(step)).decision, expected);
  }
});

test("a failed OCR crop can fall back to text; an inconclusive crop by itself never opens approval", async () => {
  const step = input({ kind: "click", target: { name: "Continue" } },
    control({ role: "button", name: "Continue", effect: "unknown", rect: { x: 0, y: 0, width: 52, height: 24 } }));
  const ocr = { localOnly: true, recognize: async () => ({ lines: [] }) };
  const missingCrop = createRiskPolicy({ ocr, ocrRegion() { throw Error("unavailable"); },
    reviewer: () => ({ classification: "low" }) });
  assert.equal((await missingCrop(step)).decision, "allow");
  assert.equal((await createRiskPolicy({ ocr })(step)).decision, "needs_evidence");
});

test("field editing, activation, and drag destinations are assessed separately", async () => {
  const editor = control({ effect: "edit", actions: ["type", "keypress"] });
  const target = { name: editor.name };
  assert.equal((await defaultRiskPolicy(input({ kind: "type", target, text: "draft" }, editor))).decision, "allow");
  assert.equal((await defaultRiskPolicy(input({ kind: "keypress", target, key: "ArrowLeft" }, editor))).decision, "allow");
  assert.equal((await defaultRiskPolicy(input({ kind: "keypress", target, key: "Enter" }, editor))).decision, "needs_evidence");

  const neverReview = createRiskPolicy({ reviewer() { assert.fail("known risks must not reach the reviewer"); } });
  const named = control({ role: "button", name: "Send", effect: "unknown" });
  assert.equal((await neverReview(input({ kind: "click", target: { name: "Send" } }, named))).decision, "approve");
  assert.equal((await neverReview(input({ kind: "type", target, text: "test" },
    control({ sensitive: true, effect: "unknown" })))).decision, "approve");
  const dragged = input({ kind: "drag", from: { x: 2, y: 3 }, to: { x: 5, y: 7 } }, control({ effect: "read" }),
    { destination: control({ id: "dest", effect: "destructive" }) });
  assert.equal((await neverReview(dragged)).decision, "approve");
});
