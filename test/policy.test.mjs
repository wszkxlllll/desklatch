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

test("scoped point-click delegation is opt-in and requires an exact host-verified target", async () => {
  const artifactRect = { x: 10, y: 20, width: 40, height: 30 };
  const target = control({
    id: "disposable-artifact-button",
    role: "button",
    name: "Opaque action",
    states: ["visible", "enabled"],
    actions: ["click"],
    effect: "unknown",
    rect: artifactRect,
  });
  const verifiedArtifact = { targetId: target.id, rect: artifactRect };
  const calls = [];
  const policy = createRiskPolicy({
    hostRules: {
      allowScopedPointClick(value) {
        calls.push(value);
        const point = value.step.kind === "click" && "point" in value.step.target ? value.step.target.point : undefined;
        return value.target.id === verifiedArtifact.targetId
          && JSON.stringify(value.target.rect) === JSON.stringify(verifiedArtifact.rect)
          && point?.x === 25 && point?.y === 30
          ? { targetId: verifiedArtifact.targetId, region: verifiedArtifact.rect, code: "artifact_scope_verified" }
          : false;
      },
    },
  });
  const result = await policy(input({ kind: "click", target: { point: { x: 25, y: 30 } } }, target));
  assert.deepEqual(result, { decision: "allow", code: "artifact_scope_verified" });
  assert.equal(calls.length, 1);

  const windowScoped = createRiskPolicy({
    hostRules: {
      allowScopedPointClick: () => ({ windowScope: "offline-canvas", region: artifactRect }),
    },
  });
  const windowResult = await windowScoped(input({ kind: "click", target: { point: { x: 25, y: 30 } } }, { ...target, id: "canvas-button", windowScope: "offline-canvas" }));
  assert.equal(windowResult.decision, "allow");

  const largeTarget = { ...target, rect: { x: 0, y: 0, width: 5000, height: 5000 } };
  const largeTargetPolicy = createRiskPolicy({
    hostRules: {
      allowScopedPointClick: () => ({ targetId: largeTarget.id, region: artifactRect }),
    },
  });
  assert.equal((await largeTargetPolicy(input({ kind: "click", target: { point: { x: 25, y: 30 } } }, largeTarget))).decision, "allow");

  const unchanged = await defaultRiskPolicy(input({ kind: "click", target: { point: { x: 25, y: 30 } } }, target));
  assert.equal(unchanged.decision, "needs_evidence");
});

test("scoped point-click delegation rejects outside points and other host scopes", async () => {
  const target = control({
    id: "disposable-artifact-button",
    role: "button",
    states: ["visible", "enabled"],
    actions: ["click"],
    effect: "unknown",
    rect: { x: 10, y: 20, width: 40, height: 30 },
  });
  const calls = [];
  const policy = createRiskPolicy({
    hostRules: {
      allowScopedPointClick(value) {
        calls.push(value.target.id);
        return value.target.id === "disposable-artifact-button"
          ? { targetId: "disposable-artifact-button", region: { x: 10, y: 20, width: 40, height: 30 } }
          : undefined;
      },
    },
  });
  const outside = await policy(input({ kind: "click", target: { point: { x: 100, y: 100 } } }, target));
  assert.equal(outside.decision, "needs_evidence");
  assert.deepEqual(calls, []);

  const otherApp = await policy(input({ kind: "click", target: { point: { x: 25, y: 30 } } }, { ...target, id: "other-app-button" }));
  assert.equal(otherApp.decision, "needs_evidence");
  assert.deepEqual(calls, ["other-app-button"]);

  const narrowRegion = createRiskPolicy({
    hostRules: {
      allowScopedPointClick: () => ({ targetId: "disposable-artifact-button", region: { x: 10, y: 20, width: 5, height: 5 } }),
    },
  });
  const outsideDelegatedRegion = await narrowRegion(input({ kind: "click", target: { point: { x: 25, y: 30 } } }, target));
  assert.equal(outsideDelegatedRegion.decision, "needs_evidence");
});

test("scoped point-click delegation cannot bypass structural, host, or gesture guards", async () => {
  const base = {
    kind: "click",
    target: { point: { x: 25, y: 30 } },
  };
  const target = control({
    id: "disposable-artifact-button",
    role: "button",
    states: ["visible", "enabled"],
    actions: ["click"],
    effect: "unknown",
    rect: { x: 10, y: 20, width: 40, height: 30 },
  });
  const make = hostRules => {
    let calls = 0;
    const policy = createRiskPolicy({
      hostRules: {
        ...hostRules,
        allowScopedPointClick: () => { calls += 1; return { targetId: "disposable-artifact-button", region: { x: 10, y: 20, width: 40, height: 30 } }; },
      },
    });
    return { policy, calls: () => calls };
  };

  const hardDenied = make({ hardDeny: () => true });
  assert.equal((await hardDenied.policy(input(base, target))).decision, "deny");
  assert.equal(hardDenied.calls(), 0);

  const wildcard = createRiskPolicy({ hostRules: { allowScopedPointClick: () => true } });
  assert.equal((await wildcard(input(base, target))).decision, "deny");

  const highRisk = make({});
  assert.equal((await highRisk.policy(input(base, { ...target, effect: "external" }))).decision, "approve");
  assert.equal(highRisk.calls(), 0);

  const concealedSensitive = make({});
  assert.equal((await concealedSensitive.policy(input(base, { ...target, sensitive: true }))).decision, "approve");
  assert.equal(concealedSensitive.calls(), 0);

  const hostApproval = make({ requireApproval: () => true });
  assert.equal((await hostApproval.policy(input(base, target))).decision, "approve");
  assert.equal(hostApproval.calls(), 0);

  const alternate = make({});
  assert.equal((await alternate.policy(input({ ...base, count: 2 }, target))).decision, "needs_evidence");
  assert.equal(alternate.calls(), 0);
});

test("scoped point-click delegation preserves OCR and reviewer fail-closed behavior", async () => {
  const target = control({
    id: "disposable-artifact-button",
    role: "button",
    states: ["visible", "enabled"],
    actions: ["click"],
    effect: "unknown",
    rect: { x: 10, y: 20, width: 40, height: 30 },
  });
  const step = { kind: "click", target: { point: { x: 25, y: 30 } } };
  const unavailableCalls = [];
  const unavailable = createRiskPolicy({
    ocr: { localOnly: true, recognize: async () => { throw new Error("ocr unavailable"); } },
    hostRules: { allowScopedPointClick: () => { unavailableCalls.push(true); return { targetId: "disposable-artifact-button", region: { x: 10, y: 20, width: 40, height: 30 } }; } },
  });
  assert.equal((await unavailable(input(step, target))).decision, "needs_evidence");
  assert.deepEqual(unavailableCalls, []);

  const budgetCalls = [];
  const budgetEmpty = createRiskPolicy({
    maxExternalRequests: 0,
    ocr: { localOnly: true, recognize: async () => ({ lines: [] }) },
    hostRules: { allowScopedPointClick: () => { budgetCalls.push(true); return { targetId: "disposable-artifact-button", region: { x: 10, y: 20, width: 40, height: 30 } }; } },
  });
  assert.equal((await budgetEmpty(input(step, target))).decision, "needs_evidence");
  assert.deepEqual(budgetCalls, []);

  const safeOcrCalls = [];
  const safeOcr = createRiskPolicy({
    ocr: { localOnly: true, recognize: async () => ({ lines: [] }) },
    hostRules: { allowScopedPointClick: () => { safeOcrCalls.push(true); return { targetId: "disposable-artifact-button", region: { x: 10, y: 20, width: 40, height: 30 } }; } },
  });
  assert.equal((await safeOcr(input(step, target))).decision, "allow");
  assert.deepEqual(safeOcrCalls, [true]);

  let ocrRiskRuleCalls = 0;
  const ocrRisk = createRiskPolicy({
    ocr: { localOnly: true, recognize: async () => ({ lines: [{ text: "Send", confidence: 0.99 }] }) },
    hostRules: { allowScopedPointClick: () => { ocrRiskRuleCalls += 1; return { targetId: "disposable-artifact-button", region: { x: 10, y: 20, width: 40, height: 30 } }; } },
  });
  assert.equal((await ocrRisk(input(step, target))).decision, "approve");
  assert.equal(ocrRiskRuleCalls, 0);

  for (const [review, expected] of [
    [{ decision: "deny" }, "deny"],
    [{ decision: "approve" }, "approve"],
    [{ classification: "unclear" }, "needs_evidence"],
  ]) {
    const reviewerCalls = [];
    const policy = createRiskPolicy({
      reviewer: () => review,
      hostRules: { allowScopedPointClick: () => { reviewerCalls.push(true); return { targetId: "disposable-artifact-button", region: { x: 10, y: 20, width: 40, height: 30 } }; } },
    });
    assert.equal((await policy(input(step, target))).decision, expected);
    assert.deepEqual(reviewerCalls, []);
  }

  let clearRuleCalls = 0;
  const reviewerClear = createRiskPolicy({
    ocr: { localOnly: true, recognize: async () => { throw new Error("ocr unavailable"); } },
    reviewer: () => ({ classification: "clear" }),
    hostRules: { allowScopedPointClick: () => { clearRuleCalls += 1; return { targetId: "disposable-artifact-button", region: { x: 10, y: 20, width: 40, height: 30 } }; } },
  });
  assert.equal((await reviewerClear(input(step, target))).decision, "allow");
  assert.equal(clearRuleCalls, 0);
});

test("native controls with untyped effects use local evidence before review", async () => {
  const reviewed = [];
  const policy = createRiskPolicy({ reviewer(request) { reviewed.push(request.target.name); return { classification: "unclear" }; } });
  const click = (name, role = "Button", count = 1) => policy(input(
    { kind: "click", target: { ref: "native" }, count },
    control({ name, role, states: ["visible", "enabled"], effect: "unknown", actions: ["click"] }),
  ));

  for (const name of ["Search", "Open settings panel", "Find next", "Find...", "保存草稿", "查看付款记录", "不发送"]) {
    assert.equal((await click(name)).decision, "allow", name);
  }
  assert.equal((await click("Details", "TabItem")).decision, "allow");
  assert.equal((await click("File", "MenuItem")).decision, "allow");
  assert.equal((await policy(input({ kind: "type", target: { ref: "editor" }, text: "Do not submit" }, control({ effect: "unknown" })))).decision, "allow");
  assert.equal((await policy(input({ kind: "scroll", target: { ref: "list" }, direction: "down", amount: 1 },
    control({ role: "List", effect: "unknown", actions: ["scroll"] })))).decision, "allow");

  for (const name of ["Send message", "Checkout", "确认付款", "覆盖现有文件", "取消预约", "启用宏"]) {
    assert.equal((await click(name)).decision, "approve", name);
  }
  assert.deepEqual(reviewed, []);
  assert.equal((await click("Continue")).decision, "needs_evidence");
  assert.equal((await click("Confirm")).decision, "needs_evidence");
  assert.equal((await click("Search", "Button", 2)).decision, "needs_evidence");
  assert.deepEqual(reviewed, ["Continue", "Confirm", "Search"]);
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
