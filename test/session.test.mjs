import test from "node:test";
import assert from "node:assert/strict";
import { createDeskSession } from "../dist/session.js";
import { createDeskTools, createRiskPolicy } from "desklatch";

const capabilities = [
  { kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] },
  { kind: "type", targets: ["selector"] },
];

function makeBackend({ image = true } = {}) {
  const calls = { observe: [], dispatch: [], close: 0 };
  const controls = [
    {
      id: "backend-button-id",
      role: "Button",
      name: "Save",
      states: ["visible", "enabled"],
      actions: ["click"],
      effect: "external",
    },
    {
      id: "backend-password-id",
      role: "Edit",
      name: "Password",
      states: ["visible", "enabled", "editable"],
      actions: ["type"],
      sensitive: true,
      value: "do-not-leak",
      effect: "edit",
    },
  ];
  return {
    calls,
    controls,
    capabilities,
    async observe(options) {
      calls.observe.push(options);
      return {
        scope: "backend-scope-secret",
        complete: true,
        controls,
        ...(image ? { image: { mimeType: "image/png", dataBase64: "pixels", width: 10, height: 10 } } : {}),
      };
    },
    async dispatch(request) {
      calls.dispatch.push(request);
      return { status: "dispatched", focusId: request.target.id };
    },
    async close() {
      calls.close += 1;
    },
  };
}

test("default observations are text-only and redact sensitive values", async () => {
  const backend = makeBackend();
  const session = createDeskSession(backend, {
    capabilities: [{ kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] }],
  });
  const observation = await session.observe();
  assert.equal(observation.view, "controls");
  assert.equal(observation.image, undefined);
  assert.equal(observation.controls[1].value, undefined);
  assert.equal(observation.controls[1].valueRedacted, true);
  assert.deepEqual(observation.controls[1].actions, []);
  assert.equal(JSON.stringify(observation).includes("backend-button-id"), false);
  assert.equal(JSON.stringify(observation).includes("backend-scope-secret"), false);
  await session.close();
});

test("approval handoff returns promptly and resume is idempotent", async () => {
  const backend = makeBackend();
  const session = createDeskSession(backend, {
    policy: () => ({ decision: "approve", code: "needs_host" }),
  });
  const pending = await session.act({ steps: [{ kind: "click", target: { role: "Button", name: "Save" } }] });
  assert.equal(pending.status, "stopped");
  assert.equal(pending.code, "approval_required");
  assert.equal(typeof pending.requestId, "string");
  assert.equal(backend.calls.dispatch.length, 0);
  const resumed = await session.resolveApproval(pending.requestId, "approve");
  assert.equal(resumed.status, "completed");
  assert.equal(backend.calls.dispatch.length, 1);
  const repeated = await session.resolveApproval(pending.requestId, "approve");
  assert.deepEqual(repeated, resumed);
  assert.equal(backend.calls.dispatch.length, 1);
  await session.close();
});

test("synchronous host approval can continue in the same act call", async () => {
  const backend = makeBackend();
  const session = createDeskSession(backend, {
    policy: () => ({ decision: "approve", code: "needs_host" }),
    onApprovalRequested: () => "approve",
  });
  const result = await session.act({ steps: [{ kind: "click", target: { role: "Button", name: "Save" } }] });
  assert.equal(result.status, "completed");
  assert.equal(backend.calls.dispatch.length, 1);
  await session.close();
});

test("a cap-one text-reviewed approval dispatches once without repeating the reviewer", async () => {
  const backend = makeBackend();
  backend.controls[0] = { ...backend.controls[0], name: "Continue", effect: "unknown" };
  let reviews = 0;
  const session = createDeskSession(backend, {
    policy: createRiskPolicy({
      maxExternalRequests: 1,
      reviewer: () => {
        reviews += 1;
        return { classification: "high" };
      },
    }),
    onApprovalRequested: () => "approve",
  });
  const result = await session.act({ steps: [{ kind: "click", target: { role: "Button", name: "Continue" } }] });
  assert.equal(result.status, "completed");
  assert.equal(reviews, 1);
  assert.equal(backend.calls.dispatch.length, 1);
  await session.close();
});

test("an approval recheck applies a newly active hard denial", async () => {
  const backend = makeBackend();
  backend.controls[0] = { ...backend.controls[0], name: "Continue", effect: "unknown" };
  let denied = false;
  let reviews = 0;
  const session = createDeskSession(backend, {
    policy: createRiskPolicy({
      maxExternalRequests: 1,
      reviewer: () => {
        reviews += 1;
        return { classification: "high" };
      },
      hostRules: { hardDeny: () => denied ? { match: true, code: "new_hard_deny" } : false },
    }),
  });
  const pending = await session.act({ steps: [{ kind: "click", target: { role: "Button", name: "Continue" } }] });
  assert.equal(pending.code, "approval_required");
  denied = true;
  const result = await session.resolveApproval(pending.requestId, "approve");
  assert.equal(result.status, "stopped");
  assert.equal(result.code, "new_hard_deny");
  assert.equal(reviews, 1);
  assert.equal(backend.calls.dispatch.length, 0);
  await session.close();
});

test("tight OCR budgets do not create unusable approval", async () => {
  const backend = makeBackend();
  backend.controls[0] = { ...backend.controls[0], name: "Continue", effect: "unknown", rect: { x: 0, y: 0, width: 80, height: 24 } };
  let ocrCalls = 0;
  let approvals = 0;
  const session = createDeskSession(backend, {
    policy: createRiskPolicy({
      maxExternalRequests: 1,
      ocr: { localOnly: true, recognize: async () => { ocrCalls += 1; return { lines: [{ text: "Send" }] }; } },
    }),
    onApprovalRequested: () => { approvals += 1; return "approve"; },
  });
  const result = await session.act({ steps: [{ kind: "click", target: { role: "Button", name: "Continue" } }] });
  assert.equal(result.status, "stopped");
  assert.equal(result.code, "risk_evidence_required");
  assert.equal(ocrCalls, 1);
  assert.equal(approvals, 0);
  assert.equal(backend.calls.dispatch.length, 0);
  await session.close();
});

test("changed OCR evidence cannot authorize a pending approval", async () => {
  const backend = makeBackend();
  backend.controls[0] = { ...backend.controls[0], name: "Continue", effect: "unknown", rect: { x: 0, y: 0, width: 80, height: 24 } };
  let ocrCalls = 0;
  const session = createDeskSession(backend, {
    policy: createRiskPolicy({
      maxExternalRequests: 2,
      ocr: { localOnly: true, recognize: async () => ({ lines: [{ text: ocrCalls++ === 0 ? "Send" : "Pay" }] }) },
    }),
  });
  const pending = await session.act({ steps: [{ kind: "click", target: { role: "Button", name: "Continue" } }] });
  assert.equal(pending.code, "approval_required");
  const result = await session.resolveApproval(pending.requestId, "approve");
  assert.equal(result.status, "stopped");
  assert.equal(result.code, "risk_evidence_required");
  assert.equal(ocrCalls, 2);
  assert.equal(backend.calls.dispatch.length, 0);
  await session.close();
});

test("a newly active host approval requirement does not skip OCR revalidation", async () => {
  const backend = makeBackend();
  backend.controls[0] = { ...backend.controls[0], name: "Continue", effect: "unknown", rect: { x: 0, y: 0, width: 80, height: 24 } };
  let required = false;
  let ocrCalls = 0;
  const session = createDeskSession(backend, {
    policy: createRiskPolicy({
      maxExternalRequests: 2,
      ocr: { localOnly: true, recognize: async () => ({ lines: [{ text: ocrCalls++ === 0 ? "Send" : "Pay" }] }) },
      hostRules: { requireApproval: () => required },
    }),
  });
  const pending = await session.act({ steps: [{ kind: "click", target: { role: "Button", name: "Continue" } }] });
  assert.equal(pending.code, "approval_required");
  required = true;
  const result = await session.resolveApproval(pending.requestId, "approve");
  assert.equal(result.status, "stopped");
  assert.equal(result.code, "risk_evidence_required");
  assert.equal(ocrCalls, 2);
  assert.equal(backend.calls.dispatch.length, 0);
  await session.close();
});

test("async approval callback and repeated host decisions dispatch once", async () => {
  const backend = makeBackend();
  let release;
  let handlerCalls = 0;
  const session = createDeskSession(backend, {
    policy: () => ({ decision: "approve", code: "needs_host" }),
    onApprovalRequested: async () => {
      handlerCalls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const pending = await session.act({ steps: [{ kind: "click", target: { role: "Button", name: "Save" } }] });
  release("approve");
  const resumed = await session.resolveApproval(pending.requestId, "approve");
  assert.equal(resumed.status, "completed");
  assert.equal(handlerCalls, 1);
  assert.equal(backend.calls.dispatch.length, 1);
  const repeated = await session.resolveApproval(pending.requestId, "deny");
  assert.deepEqual(repeated, resumed);
  assert.equal(backend.calls.dispatch.length, 1);
  await session.close();
});

test("cancel while awaiting approval prevents dispatch", async () => {
  const backend = makeBackend();
  const session = createDeskSession(backend, {
    policy: () => ({ decision: "approve", code: "needs_host" }),
  });
  const pending = await session.act({ steps: [{ kind: "click", target: { role: "Button", name: "Save" } }] });
  session.cancel();
  const cancelled = await session.resolveApproval(pending.requestId, "approve");
  assert.equal(cancelled.status, "stopped");
  assert.equal(cancelled.code, "cancelled");
  assert.equal(backend.calls.dispatch.length, 0);
  await session.close();
});

test("cancel while risk policy is in flight returns without dispatch", async () => {
  const backend = makeBackend();
  let policyStarted;
  const started = new Promise((resolve) => { policyStarted = resolve; });
  const session = createDeskSession(backend, {
    policy: (_input) => {
      policyStarted();
      return new Promise(() => {});
    },
  });
  const running = session.act({ steps: [{ kind: "click", target: { role: "Button", name: "Save" } }] });
  await started;
  session.cancel();
  const result = await running;
  assert.equal(result.status, "stopped");
  assert.equal(result.code, "cancelled");
  assert.equal(backend.calls.dispatch.length, 0);
  await session.close();
});

test("a host tool-call cancellation invalidates only that batch's pending approval", async () => {
  const backend = makeBackend();
  const session = createDeskSession(backend, { policy: () => ({ decision: "approve", code: "needs_host" }) });
  const first = new AbortController();
  const [, act] = createDeskTools(session);
  const request = { steps: [{ kind: "click", target: { name: "Save" } }] };
  try {
    const a = await act.invoke(request, first.signal);
    const b = await act.invoke(request);
    assert.equal(a.code, "approval_required");
    assert.equal(b.code, "approval_required");
    first.abort();
    assert.equal((await session.resolveApproval(a.requestId, "approve")).code, "cancelled");
    assert.equal((await session.resolveApproval(b.requestId, "approve")).status, "completed");
    assert.equal(backend.calls.dispatch.length, 1);
  } finally { await session.close(); }
});

test("approval binding rejects a material context-token change", async () => {
  const backend = makeBackend();
  backend.controls[0].approvalContext = { token: "recipient-a", summary: "recipient redacted" };
  const session = createDeskSession(backend, {
    policy: () => ({ decision: "approve", code: "needs_host" }),
  });
  const pending = await session.act({ steps: [{ kind: "click", target: { role: "Button", name: "Save" } }] });
  backend.controls[0].approvalContext = { token: "recipient-b", summary: "recipient redacted" };
  const result = await session.resolveApproval(pending.requestId, "approve");
  assert.equal(result.status, "stopped");
  assert.equal(result.code, "approval_stale");
  assert.equal(backend.calls.dispatch.length, 0);
  await session.close();
});

test("invalid later step preflights before any dispatch", async () => {
  const backend = makeBackend();
  const session = createDeskSession(backend, { policy: () => ({ decision: "allow", code: "test" }) });
  const result = await session.act({
    steps: [
      { kind: "type", target: { role: "Edit", name: "Password" }, text: "x" },
      { kind: "keypress", target: { role: "Edit", name: "Password" }, key: "Enter" },
    ],
  });
  assert.equal(result.status, "rejected");
  assert.equal(backend.calls.dispatch.length, 0);
  await session.close();
});

test("ambiguous scoped matches return usable fresh refs", async () => {
  const backend = makeBackend();
  backend.capabilities[0].targets = ["selector", "ref"];
  const originalObserve = backend.observe;
  backend.observe = async (options) => {
    const frame = await originalObserve(options);
    if (options.where?.name === "Save") {
      frame.controls = frame.controls.concat({
        id: "backend-second-button-id",
        role: "Button",
        name: "Save",
        states: ["visible", "enabled"],
        actions: ["click"],
        effect: "edit",
      });
    }
    return frame;
  };
  const session = createDeskSession(backend, { policy: () => ({ decision: "allow", code: "test" }) });
  const ambiguous = await session.act({ steps: [{ kind: "click", target: { role: "Button", name: "Save" } }] });
  assert.equal(ambiguous.code, "target_ambiguous");
  assert.equal(typeof ambiguous.observationId, "string");
  assert.equal(typeof ambiguous.candidates?.[0]?.ref, "string");
  assert.equal(ambiguous.candidates?.[0]?.observationId, ambiguous.observationId);
  const resolved = await session.act({
    observationId: ambiguous.observationId,
    steps: [{ kind: "click", target: { ref: ambiguous.candidates[0].ref } }],
  });
  assert.equal(resolved.status, "completed");
  assert.equal(backend.calls.dispatch.length, 1);
  await session.close();
});

test("a ref from another session is rejected even on identical layout", async () => {
  const firstBackend = makeBackend();
  const secondBackend = makeBackend();
  firstBackend.capabilities[0].targets = ["selector", "ref"];
  secondBackend.capabilities[0].targets = ["selector", "ref"];
  const first = createDeskSession(firstBackend, { policy: () => ({ decision: "allow", code: "test" }) });
  const second = createDeskSession(secondBackend, { policy: () => ({ decision: "allow", code: "test" }) });
  const observation = await first.observe();
  const result = await second.act({
    observationId: observation.observationId,
    steps: [{ kind: "click", target: { ref: observation.controls[0].ref } }],
  });
  assert.equal(result.status, "stopped");
  assert.equal(secondBackend.calls.dispatch.length, 0);
  await first.close();
  await second.close();
});

test("refs survive a truncated general frame only through positive scoped identity", async () => {
  const original = {
    id: "backend-ref-target",
    role: "Button",
    name: "Target",
    states: ["visible", "enabled"],
    actions: ["click"],
    effect: "edit",
  };
  let first = true;
  let changed = false;
  const calls = { dispatch: 0 };
  const backend = {
    capabilities: [{ kind: "click", targets: ["selector", "ref"], buttons: ["left"], counts: [1] }],
    async observe(options) {
      if (first) {
        first = false;
        return { scope: "ref-scope", complete: true, controls: [original] };
      }
      if (options.where) {
        return {
          scope: "ref-scope",
          complete: false,
          controls: [{ ...original, ...(changed ? { name: "Replacement" } : {}) }],
        };
      }
      return { scope: "ref-scope", complete: false, controls: [] };
    },
    async dispatch() {
      calls.dispatch += 1;
      return { status: "dispatched" };
    },
    async close() {},
  };
  const session = createDeskSession(backend, { policy: () => ({ decision: "allow", code: "test" }) });
  const observation = await session.observe();
  const positive = await session.act({
    observationId: observation.observationId,
    steps: [{ kind: "click", target: { ref: observation.controls[0].ref } }],
  });
  assert.equal(positive.status, "completed");
  assert.equal(calls.dispatch, 1);
  changed = true;
  const replacement = await session.act({
    observationId: observation.observationId,
    steps: [{ kind: "click", target: { ref: observation.controls[0].ref } }],
  });
  assert.equal(replacement.status, "stopped");
  assert.equal(replacement.code, "stale_reference");
  assert.equal(calls.dispatch, 1);
  await session.close();
});

test("point ownership compares pinned origin with fresh hits under truncation", async () => {
  const origin = {
    id: "origin-button",
    role: "Button",
    name: "Origin",
    states: ["visible", "enabled"],
    actions: ["click"],
    rect: { x: 0, y: 0, width: 20, height: 20 },
    effect: "edit",
  };
  const replacement = { ...origin, id: "replacement-button" };
  let first = true;
  let replaceHit = false;
  const calls = { dispatch: 0 };
  const backend = {
    capabilities: [{ kind: "click", targets: ["point"] }],
    async observe({ view }) {
      if (first) {
        first = false;
        return { scope: "point-scope", complete: true, controls: [origin], image: { mimeType: "image/png", dataBase64: "x", width: 40, height: 40 } };
      }
      return { scope: "point-scope", complete: false, controls: [] };
    },
    async hitTest() {
      return replaceHit ? replacement : origin;
    },
    async dispatch() {
      calls.dispatch += 1;
      return { status: "dispatched" };
    },
    async close() {},
  };
  const session = createDeskSession(backend, { allowModelImages: true, policy: () => ({ decision: "allow", code: "test" }) });
  const observation = await session.observe({ view: "image" });
  const positive = await session.act({
    observationId: observation.observationId,
    steps: [{ kind: "click", target: { point: { x: 5, y: 5 } } }],
  });
  assert.equal(positive.status, "completed");
  assert.equal(calls.dispatch, 1);
  replaceHit = true;
  const replacementResult = await session.act({
    observationId: observation.observationId,
    steps: [{ kind: "click", target: { point: { x: 5, y: 5 } } }],
  });
  assert.equal(replacementResult.status, "stopped");
  assert.equal(replacementResult.code, "stale_point");
  assert.equal(calls.dispatch, 1);
  await session.close();
});

test("drag compares both origin and destination endpoints", async () => {
  const source = { id: "drag-source", role: "ListItem", name: "Source", states: ["visible", "enabled"], actions: ["drag"], rect: { x: 0, y: 0, width: 20, height: 20 } };
  const destination = { id: "drag-destination", role: "List", name: "Destination", states: ["visible", "enabled"], actions: ["drag"], rect: { x: 30, y: 0, width: 20, height: 20 } };
  const changedDestination = { ...destination, id: "replacement-destination" };
  let first = true;
  let replaceDestination = false;
  const calls = { dispatch: 0 };
  const backend = {
    capabilities: [{ kind: "drag", targets: ["path"] }],
    async observe() {
      if (first) {
        first = false;
        return { scope: "drag-scope", complete: true, controls: [source, destination], image: { mimeType: "image/png", dataBase64: "x", width: 60, height: 30 } };
      }
      return { scope: "drag-scope", complete: false, controls: [] };
    },
    async hitTest(_frame, point) {
      return point.x < 20 ? source : (replaceDestination ? changedDestination : destination);
    },
    async dispatch() {
      calls.dispatch += 1;
      return { status: "dispatched" };
    },
    async close() {},
  };
  const session = createDeskSession(backend, { allowModelImages: true, policy: () => ({ decision: "allow", code: "test" }) });
  const observation = await session.observe({ view: "image" });
  const positive = await session.act({
    observationId: observation.observationId,
    steps: [{ kind: "drag", from: { x: 5, y: 5 }, to: { x: 35, y: 5 } }],
  });
  assert.equal(positive.status, "completed");
  replaceDestination = true;
  const changed = await session.act({
    observationId: observation.observationId,
    steps: [{ kind: "drag", from: { x: 5, y: 5 }, to: { x: 35, y: 5 } }],
  });
  assert.equal(changed.status, "stopped");
  assert.equal(changed.code, "stale_point");
  assert.equal(calls.dispatch, 1);
  await session.close();
});

test("focusFromStep works without an external observation", async () => {
  const button = { id: "button", role: "Button", name: "Focus", states: ["visible", "enabled"], actions: ["click"] };
  const input = { id: "input", role: "Edit", name: "Field", states: ["visible", "enabled", "editable", "focused"], actions: ["type"] };
  const calls = { dispatch: 0 };
  const backend = {
    capabilities: [
      { kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] },
      { kind: "type", targets: ["focus"] },
    ],
    async observe(options) {
      if (options.where) return { scope: "focus-scope", complete: true, controls: [button] };
      return { scope: "focus-scope", complete: true, controls: [button, input], focusId: "input" };
    },
    async dispatch(request) {
      calls.dispatch += 1;
      return request.step.kind === "click" ? { status: "dispatched", focusId: "input" } : { status: "dispatched" };
    },
    async close() {},
  };
  const session = createDeskSession(backend, { policy: () => ({ decision: "allow", code: "test" }) });
  const result = await session.act({ steps: [
    { kind: "click", target: { role: "Button", name: "Focus" } },
    { kind: "type", target: { focusFromStep: 1 }, text: "ok" },
  ] });
  assert.equal(result.status, "completed");
  assert.equal(calls.dispatch, 2);
  await session.close();
});

test("model image denial removes point capabilities", async () => {
  const backend = makeBackend();
  backend.capabilities.push({ kind: "click", targets: ["point"], buttons: ["left"], counts: [1] });
  const session = createDeskSession(backend);
  assert.deepEqual(session.capabilities.find((capability) => capability.kind === "click")?.targets, ["selector", "ref"]);
  const result = await session.act({ observationId: "not-used", steps: [{ kind: "click", target: { point: { x: 1, y: 1 } } }] });
  assert.equal(result.status, "rejected");
  assert.equal(backend.calls.dispatch.length, 0);
  await session.close();
});
