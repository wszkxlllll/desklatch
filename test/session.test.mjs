import test from "node:test";
import assert from "node:assert/strict";
import { createDeskSession } from "../dist/session.js";
import { createDeskTools, createRiskPolicy } from "desklatch";

const capabilities = [
  { kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] },
  { kind: "type", targets: ["selector"] },
];

function makeBackend({ image = true, complete = true } = {}) {
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
        complete,
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

test("compact observation projection is opt-in with an explicit full escape", async () => {
  const backend = makeBackend();
  const session = createDeskSession(backend, { defaultObservationProjection: "compact" });
  assert.equal(session.supportsObservationProjection, true);
  const compact = await session.observe();
  assert.equal(compact.projection?.mode, "compact");
  assert.equal(compact.projection?.kind, "snapshot");
  assert.equal(compact.projection?.observedControls, backend.controls.length);
  const clipped = await session.observe({ projection: { mode: "compact", maxControls: 1 } });
  assert.equal(clipped.projection?.backendComplete, true);
  assert.equal(clipped.projection?.truncated, true);
  assert.equal(clipped.projection?.guidance, undefined);
  const full = await session.observe({ projection: { mode: "full" } });
  assert.equal(full.projection, undefined);
  session.invalidateObservationSnapshots();
  await session.close();
});

test("only incomplete broad compact controls include a suggestion to narrow the query", async t => {
  const backend = makeBackend({ complete: false });
  const session = createDeskSession(backend, { allowModelImages: true, defaultObservationProjection: "compact" });
  t.after(() => session.close());
  const [observe] = createDeskTools(session);

  const broad = await observe.invoke({});
  assert.equal(broad.complete, false);
  assert.equal(broad.projection.backendComplete, false);
  assert.match(broad.projection.guidance, /\bwhere\b/u);
  assert.equal(broad.image, undefined);
  assert.deepEqual(backend.calls.observe.map(call => call.view), ["controls"]);

  const scoped = await observe.invoke({ where: { name: "Save" } });
  assert.equal(scoped.projection.backendComplete, false);
  assert.equal(scoped.projection.guidance, undefined);
  assert.deepEqual(backend.calls.observe.at(-1).where, { name: "Save" });
  const image = await observe.invoke({ view: "image" });
  assert.equal(image.projection.guidance, undefined);
  const full = await observe.invoke({ projection: { mode: "full" } });
  assert.equal(full.projection, undefined);
});

test("incremental default compares repeated broad observations while preserving the current ref boundary", async () => {
  const backend = makeBackend();
  const session = createDeskSession(backend, { defaultObservationProjection: "incremental" });
  assert.equal(session.defaultObservationProjection, "incremental");
  const first = await session.observe();
  assert.equal(first.projection?.kind, "snapshot");
  const second = await session.observe();
  assert.equal(second.projection?.kind, "unchanged");
  assert.equal(second.projection?.basis, "published_controls");
  assert.equal(second.controls.length, 0);
  assert.ok(second.projection?.base === first.observationId);
  await session.close();
});

test("broad compact previews bound model output while exact actions check every matching control", async t => {
  const backend = makeBackend();
  backend.controls.splice(0, backend.controls.length, ...Array.from({ length: 12 }, (_, index) => ({
    id: `button-${index}`, name: index === 0 || index === 9 ? "Repeat" : `Button ${index}`,
    role: "Button", within: "Toolbar", states: ["visible", "enabled"], actions: ["click"], effect: "read",
  })));
  const session = createDeskSession(backend, {
    defaultObservationProjection: "compact", allowModelImages: true,
    policy: () => ({ decision: "allow", code: "test" }),
  });
  t.after(() => session.close());
  const [observe, act] = createDeskTools(session);
  const overview = await observe.invoke({});
  assert.equal(overview.image, undefined);
  assert.equal(overview.controls.length, 6);
  assert.equal(overview.projection.observedControls, 12);
  assert.equal(overview.projection.backendComplete, true);
  assert.equal(overview.complete, false);
  assert.equal(overview.projection.truncated, true);
  assert.equal(overview.controls.filter(control => control.name === "Repeat").length, 1);
  const ambiguous = await act.invoke({ steps: [{ kind: "click", target: { name: "Repeat" } }] });
  assert.equal(ambiguous.code, "target_ambiguous");
  assert.equal(backend.calls.dispatch.length, 0);

  const byRole = await observe.invoke({ view: "both", where: { role: "Button" } });
  assert.equal(byRole.controls.length, 6);
  assert.ok(byRole.image);
  const scoped = await observe.invoke({ where: { within: "Toolbar" } });
  assert.equal(scoped.controls.length, 12);
  const expanded = await observe.invoke({ projection: { mode: "compact", maxControls: 9 } });
  assert.equal(expanded.controls.length, 9);
  const full = await observe.invoke({ projection: { mode: "full" } });
  assert.equal(full.controls.length, 12);
});

test("incremental default keeps compact output for targeted and image observations", async () => {
  const backend = makeBackend();
  const session = createDeskSession(backend, {
    allowModelImages: true,
    defaultObservationProjection: "incremental",
  });
  const targeted = await session.observe({ view: "controls", where: { role: "Button" } });
  assert.equal(targeted.projection?.mode, "compact");
  assert.equal(targeted.projection?.kind, "snapshot");
  const repeatedTarget = await session.observe({ view: "controls", where: { role: "Button" } });
  assert.equal(repeatedTarget.projection?.mode, "compact");
  assert.equal(repeatedTarget.projection?.kind, "snapshot");
  assert.equal(repeatedTarget.projection?.base, undefined);
  const image = await session.observe({ view: "image" });
  assert.equal(image.projection?.mode, "compact");
  assert.equal(image.projection?.kind, "snapshot");
  assert.equal(image.image?.dataBase64, "pixels");
  await session.close();
});

test("correct invalidates a compact baseline and an observation already in flight", async t => {
  const backend = makeBackend({ image: false });
  const read = backend.observe.bind(backend);
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let hold = false;
  backend.observe = async options => {
    if (hold) {
      entered.resolve();
      await resume.promise;
    }
    return read(options);
  };
  const session = createDeskSession(backend, { defaultObservationProjection: "compact" });
  t.after(() => session.close());
  const base = await session.observe();
  hold = true;
  const pending = session.observe({ projection: { mode: "compact", since: base.observationId } });
  await entered.promise;
  session.correct();
  hold = false;
  resume.resolve();
  await assert.rejects(pending, /observe_failed/u);
  const fresh = await session.observe({ projection: { mode: "compact", since: base.observationId } });
  assert.equal(fresh.projection.kind, "snapshot");
  assert.equal(fresh.projection.fallback, "since_invalid");
  assert.equal(backend.calls.dispatch.length, 0);
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

test("an immediate denial remains final when the host retries the approval", async () => {
  const backend = makeBackend();
  let requestId;
  const session = createDeskSession(backend, {
    policy: () => ({ decision: "approve", code: "needs_host" }),
    onApprovalRequested(request) { requestId = request.requestId; return "deny"; },
  });
  try {
    const result = await session.act({ steps: [{ kind: "click", target: { role: "Button", name: "Save" } }] });
    assert.equal(result.code, "approval_denied");
    assert.deepEqual(await session.resolveApproval(requestId, "approve"), { ...result, requestId });
    assert.equal(backend.calls.dispatch.length, 0);
  } finally {
    await session.close();
  }
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
  const session = createDeskSession(backend, {
    policy: () => ({ decision: "approve", code: "needs_host" }),
  });
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

test("browser-scoped ref refresh narrows by exact material selector and rejects replacement", async () => {
  const original = {
    id: "scoped-ref-target",
    role: "Button",
    name: "Target",
    states: ["visible", "enabled"],
    actions: ["click"],
    effect: "edit",
  };
  let replaced = false;
  let broadObserves = 0;
  const scopedObserves = [];
  let dispatches = 0;
  const backend = {
    capabilities: [{ kind: "click", targets: ["selector", "ref"], buttons: ["left"], counts: [1] }],
    supportsScopedRefRefresh: true,
    async observe(options) {
      if (options.where) scopedObserves.push(options.where);
      else broadObserves += 1;
      return {
        scope: "scoped-ref-scope",
        complete: true,
        controls: [{ ...original, ...(replaced ? { name: "Replacement" } : {}) }],
      };
    },
    async dispatch() {
      dispatches += 1;
      return { status: "dispatched" };
    },
    async close() {},
  };
  const session = createDeskSession(backend, { policy: () => ({ decision: "allow", code: "test" }) });
  const observation = await session.observe();
  const first = await session.act({
    observationId: observation.observationId,
    steps: [{ kind: "click", target: { ref: observation.controls[0].ref } }],
  });
  assert.equal(first.status, "completed");
  assert.equal(dispatches, 1);
  assert.deepEqual(scopedObserves.at(-1), { role: "Button", name: "Target" });
  replaced = true;
  const stale = await session.act({
    observationId: observation.observationId,
    steps: [{ kind: "click", target: { ref: observation.controls[0].ref } }],
  });
  assert.equal(stale.status, "stopped");
  assert.equal(stale.code, "stale_reference");
  assert.equal(dispatches, 1, "replacement must not dispatch");
  assert.equal(broadObserves, 1, "only the initial observation may be broad");
  assert.equal(scopedObserves.length, 2);
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
  const calls = { dispatch: [] };
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
      calls.dispatch.push(request);
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
  assert.equal(calls.dispatch.length, 2);
  assert.equal(calls.dispatch[0].captureFocus, true);
  assert.equal(calls.dispatch[1].captureFocus, undefined);
  await session.close();
});

test("focus capture hint is retained when the first step resumes after approval", async () => {
  const button = { id: "button", role: "Button", name: "Focus", states: ["visible", "enabled"], actions: ["click"] };
  const input = { id: "input", role: "Edit", name: "Field", states: ["visible", "enabled", "editable", "focused"], actions: ["type"] };
  const dispatches = [];
  const backend = {
    capabilities: [
      { kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] },
      { kind: "type", targets: ["focus"] },
    ],
    async observe(options) {
      if (options.where) return { scope: "approval-focus-scope", complete: true, controls: [button] };
      return { scope: "approval-focus-scope", complete: true, controls: [button, input], focusId: "input" };
    },
    async dispatch(request) {
      dispatches.push(request);
      return request.step.kind === "click" ? { status: "dispatched", focusId: "input" } : { status: "dispatched" };
    },
    async close() {},
  };
  const session = createDeskSession(backend, {
    policy: ({ step }) => step.kind === "click"
      ? { decision: "approve", code: "needs_host" }
      : { decision: "allow", code: "test" },
  });
  const pending = await session.act({ steps: [
    { kind: "click", target: { role: "Button", name: "Focus" } },
    { kind: "type", target: { focusFromStep: 1 }, text: "ok" },
  ] });
  assert.equal(pending.code, "approval_required");
  const resumed = await session.resolveApproval(pending.requestId, "approve");
  assert.equal(resumed.status, "completed");
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[0].captureFocus, true);
  assert.equal(dispatches[1].captureFocus, undefined);
  await session.close();
});

test("focus handoff rejects a changed recipient even when scope is unchanged", async () => {
  const button = { id: "button", role: "Button", name: "Focus", states: ["visible", "enabled"], actions: ["click"] };
  const input = { id: "input", role: "Edit", name: "Field", states: ["visible", "enabled", "editable", "focused"], actions: ["type"] };
  const replacement = { ...input, id: "replacement-input" };
  let dispatched = false;
  const dispatches = [];
  const backend = {
    capabilities: [
      { kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] },
      { kind: "type", targets: ["focus"] },
    ],
    async observe(options) {
      if (options.where) return { scope: "changed-focus-scope", complete: true, controls: [button] };
      return { scope: "changed-focus-scope", complete: true, controls: [button, dispatched ? replacement : input], focusId: dispatched ? "replacement-input" : "input" };
    },
    async dispatch(request) {
      dispatches.push(request);
      dispatched = true;
      return { status: "dispatched", focusId: "input" };
    },
    async close() {},
  };
  const session = createDeskSession(backend, { policy: () => ({ decision: "allow", code: "test" }) });
  const result = await session.act({ steps: [
    { kind: "click", target: { role: "Button", name: "Focus" } },
    { kind: "type", target: { focusFromStep: 1 }, text: "ok" },
  ] });
  assert.equal(result.status, "stopped");
  assert.equal(result.code, "focus_changed");
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].captureFocus, true);
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
