import assert from "node:assert/strict";
import test from "node:test";

import { createDeskCodeMode } from "desklatch/code-mode";
import { createDeskSession, createDeskTools } from "desklatch";

const capabilities = [{ kind: "click", targets: ["point"], buttons: ["left"], counts: [1] }];
const POINT_HINT = "Do not retry the same pixels with the same evidence. Locate an explicit control or focused target; stop if unresolved.";

function pointControl(overrides = {}) {
  return {
    id: "word:cancel",
    role: "Button",
    name: "Cancel",
    within: "word-document",
    windowScope: "hwnd:word:1",
    states: ["visible", "enabled"],
    actions: ["click"],
    rect: { x: 160, y: 430, width: 60, height: 40 },
    effect: "unknown",
    labels: ["Cancel"],
    approvalContext: { token: "opaque-risk-binding" },
    ...overrides,
  };
}

function makePointBackend(current, { policy, capabilities: grants = capabilities, sourceOverrides = {} } = {}) {
  const source = pointControl(sourceOverrides);
  const calls = { observe: 0, hitTest: [], dispatch: 0 };
  const backend = {
    capabilities: grants,
    async observe() {
      calls.observe += 1;
      if (calls.observe === 1) {
        return {
          scope: "word-scope",
          complete: true,
          controls: [source],
          image: { mimeType: "image/png", dataBase64: "opaque", width: 640, height: 480 },
        };
      }
      return { scope: "word-scope", complete: false, controls: [] };
    },
    async hitTest(frame, point, signal, kind) {
      calls.hitTest.push({ frame, point, signal, kind });
      return frame.controls.length > 0 ? source : current;
    },
    async dispatch() {
      calls.dispatch += 1;
      return { status: "dispatched" };
    },
    async close() {},
  };
  const session = createDeskSession(backend, {
    allowModelImages: true,
    ...(policy ? { policy } : {}),
  });
  return { session, calls, source };
}

async function runPoint(current, options = {}) {
  const fixture = makePointBackend(current, options);
  const observation = await fixture.session.observe({ view: "image" });
  const result = await fixture.session.act({
    observationId: observation.observationId,
    steps: [{ kind: "click", target: { point: { x: 190, y: 452 } } }],
  });
  return { ...fixture, observation, result };
}

test("default policy permits the proven local gesture, binding both reads to the same recipient", async t => {
  const observed = { role: "DataItem", name: "E9", pointInteraction: { kind: "select", binding: "receipt:cell-nine" } };
  const correct = await runPoint(pointControl(observed), { sourceOverrides: observed });
  t.after(() => correct.session.close());
  assert.equal(correct.result.steps[0].status, "dispatched");
  assert.equal(correct.calls.dispatch, 1);
  assert.equal(JSON.stringify(correct.observation).includes("receipt:cell-nine"), false);

  const changed = await runPoint(pointControl({ ...observed, pointInteraction: { kind: "select", binding: "receipt:other-leaf" } }), { sourceOverrides: observed });
  t.after(() => changed.session.close());
  assert.equal(changed.result.code, "stale_point");
  assert.equal(changed.calls.dispatch, 0);

  const sensitive = { ...observed, effect: "financial" };
  const protectedClick = await runPoint(pointControl(sensitive), { sourceOverrides: sensitive });
  t.after(() => protectedClick.session.close());
  assert.equal(protectedClick.result.code, "approval_required");
  assert.equal(protectedClick.calls.dispatch, 0);
});

test("point click ignores only transient keyboard capabilities from a private focus probe", async () => {
  const current = pointControl({ actions: ["click", "keypress", "hotkey"] });
  const fixture = await runPoint(current, { policy: () => ({ decision: "allow", code: "test_allow" }) });
  assert.equal(fixture.result.status, "completed", JSON.stringify(fixture.result));
  assert.equal(fixture.calls.dispatch, 1);
  assert.deepEqual(fixture.calls.hitTest.map(call => call.kind), ["click"]);
  await fixture.session.close();
});

test("point click still stops before dispatch for changed risk, replacement, or lost click", async t => {
  const cases = [
    ["changed risk", pointControl({ effect: "destructive" })],
    ["replacement", pointControl({ id: "word:replacement" })],
    ["lost click", pointControl({ actions: ["keypress", "hotkey"] })],
  ];
  for (const [label, current] of cases) {
    const fixture = await runPoint(current, { policy: () => ({ decision: "allow", code: "test_allow" }) });
    t.after(() => fixture.session.close());
    assert.equal(fixture.result.status, "stopped", label);
    assert.equal(fixture.result.code, "stale_point", label);
    assert.equal(fixture.result.steps[0].status, "not_dispatched", label);
    assert.equal(fixture.calls.dispatch, 0, label);
  }
});

test("ref, drag, and point key actions retain strict material action matching", async t => {
  const source = pointControl();
  const current = pointControl({ actions: ["click", "keypress", "hotkey"] });
  const destination = pointControl({
    id: "word:destination",
    role: "List",
    name: "Destination",
    actions: ["drag"],
    rect: { x: 260, y: 430, width: 60, height: 40 },
  });
  const currentDestination = { ...destination, actions: ["drag", "keypress", "hotkey"] };
  const calls = { dispatch: 0 };
  let sourceFrame;
  const backend = {
    capabilities: [
      { kind: "click", targets: ["ref", "point"], buttons: ["left"], counts: [1] },
      { kind: "keypress", targets: ["ref"], keys: ["Enter"] },
      { kind: "drag", targets: ["path"] },
    ],
    async observe() {
      const frame = {
        scope: "strict-scope",
        complete: true,
        controls: sourceFrame ? [current, currentDestination] : [source, destination],
        image: { mimeType: "image/png", dataBase64: "opaque", width: 640, height: 480 },
      };
      sourceFrame ??= frame;
      return frame;
    },
    async hitTest(frame, point, _signal, kind) {
      if (kind === "drag") return point.x < 200
        ? (frame === sourceFrame ? source : current)
        : (frame === sourceFrame ? destination : currentDestination);
      return frame === sourceFrame ? source : current;
    },
    async dispatch() {
      calls.dispatch += 1;
      return { status: "dispatched" };
    },
    async close() {},
  };
  const session = createDeskSession(backend, { allowModelImages: true, policy: () => ({ decision: "allow", code: "test_allow" }) });
  t.after(() => session.close());
  const observation = await session.observe({ view: "image" });

  const ref = await session.act({ observationId: observation.observationId, steps: [{ kind: "click", target: { ref: observation.controls[0].ref } }] });
  assert.equal(ref.code, "stale_reference");
  const key = await session.act({ observationId: observation.observationId, steps: [{ kind: "keypress", target: { ref: observation.controls[0].ref }, key: "Enter" }] });
  assert.equal(key.code, "stale_reference");
  const drag = await session.act({ observationId: observation.observationId, steps: [{ kind: "drag", from: { x: 190, y: 452 }, to: { x: 280, y: 452 } }] });
  assert.equal(drag.code, "stale_point");
  assert.equal(calls.dispatch, 0);
});

test("grounded point click needs_evidence carries one safe hint and remains unsent", async t => {
  const fixture = await runPoint(pointControl({ name: "Mystery", role: "Pane" }), {
    policy: undefined,
    sourceOverrides: { name: "Mystery", role: "Pane" },
  });
  t.after(() => fixture.session.close());
  assert.equal(fixture.result.status, "stopped");
  assert.equal(fixture.result.code, "risk_evidence_required");
  assert.equal(fixture.result.recoveryHint, POINT_HINT);
  assert.equal(fixture.result.steps[0].status, "not_dispatched");
  assert.equal(fixture.calls.dispatch, 0);
  assert.deepEqual(Object.keys(fixture.result).sort(), ["atStep", "code", "recoveryHint", "status", "steps"]);
  assert.equal(JSON.stringify(fixture.result).includes("opaque-risk-binding"), false);
});

test("Code Mode carries the allowlisted point hint and hard-stops after the refusal", async t => {
  const fixture = await runPoint(pointControl({ name: "Mystery", role: "Pane" }), {
    policy: undefined,
    sourceOverrides: { name: "Mystery", role: "Pane" },
  });
  const host = createDeskCodeMode({ tools: createDeskTools(fixture.session), close: () => fixture.session.close() });
  t.after(() => host.close());
  const observationId = fixture.observation.observationId;
  const result = await host.runCode({ code: `
    await desk.act(${JSON.stringify({ observationId, steps: [{ kind: "click", target: { point: { x: 190, y: 452 } } }] })});
    inspect({ shouldNotRun: true });
  ` });
  assert.equal(result.status, "stopped");
  assert.equal(result.code, "risk_evidence_required");
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].recoveryHint, POINT_HINT);
  assert.equal(result.actions[0].steps[0].status, "not_dispatched");
  assert.equal(result.inspections.length, 0);
  assert.equal(fixture.calls.dispatch, 0);
});
