import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryVerifiedStepReuseStore,
  ReuseValidationError,
  createVerifiedStepReuse,
} from "../dist/reuse.js";

const capabilities = [
  { kind: "type", targets: ["selector"] },
  { kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] },
];
const limits = { maxSteps: 32, maxTextLength: 16_384, maxScrollAmount: 100 };

function typeRequest(text = "old value") {
  return {
    steps: [{
      kind: "type",
      target: { role: "textbox", name: "Title" },
      text,
      expect: { target: { role: "textbox", name: "Title" }, valueEquals: text },
    }],
  };
}

function verifiedResult(request) {
  return {
    status: "completed",
    steps: request.steps.map((step, index) => ({ index: index + 1, kind: step.kind, status: "verified" })),
  };
}

function fakeSession(resultFor = verifiedResult) {
  const calls = [];
  return {
    calls,
    session: {
      capabilities,
      limits,
      async act(request, signal) {
        const index = calls.length;
        calls.push({ request, signal });
        return resultFor(request, index);
      },
    },
  };
}

const titleParameter = {
  parameters: [{ name: "title", paths: ["steps.0.text", "steps.0.expect.valueEquals"] }],
  context: { application: "fixture", document: "one" },
  coverage: { target: "Title", expected: "readback" },
};

test("captures only verified selector steps and substitutes different parameters without persisting values", async () => {
  const fake = fakeSession();
  const store = new MemoryVerifiedStepReuseStore();
  const reuse = createVerifiedStepReuse({ session: fake.session, store });
  const request = typeRequest("private-old-value");
  const first = await reuse.act(request);
  const record = await reuse.remember("title-edit", request, first, titleParameter);

  assert.equal(JSON.stringify(record).includes("private-old-value"), false);
  assert.equal(JSON.stringify(record).includes('"$param":"title"'), true);
  assert.equal(JSON.stringify(record).includes('"ref"'), false);
  assert.equal(JSON.stringify(record).includes('"point"'), false);

  const run = await reuse.run("title-edit", {
    values: { title: "new-value" },
    context: { document: "one", application: "fixture" },
    coverage: { expected: "readback", target: "Title" },
  });
  assert.equal(run.status, "completed");
  assert.equal(run.succeeded, true);
  assert.equal(run.result.status, "completed");
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].request.steps[0].text, "private-old-value");
  assert.equal(fake.calls[1].request.steps[0].text, "new-value");
  assert.equal(fake.calls[1].request.steps[0].expect.valueEquals, "new-value");
  assert.equal(JSON.stringify(store.load()).includes("new-value"), false);
});

test("v1 binds the expected readback to the same selector and original payload", async () => {
  const fake = fakeSession();
  const reuse = createVerifiedStepReuse({ session: fake.session });
  const crossField = {
    steps: [{
      kind: "type",
      target: { role: "textbox", name: "Title" },
      text: "same-value",
      expect: { target: { role: "textbox", name: "Notes" }, valueEquals: "same-value" },
    }],
  };
  const crossResult = await reuse.act(crossField);
  await assert.rejects(() => reuse.remember("cross-field", crossField, crossResult, {
    parameters: [{ name: "value", paths: ["steps.0.text", "steps.0.expect.valueEquals"] }],
  }), ReuseValidationError);

  const unequalOriginals = {
    steps: [{
      kind: "setValue",
      target: { role: "textbox", name: "Title" },
      value: "actual-value",
      expect: { target: { role: "textbox", name: "Title" }, valueEquals: "different-value" },
    }],
  };
  const unequalResult = await reuse.act(unequalOriginals);
  await assert.rejects(() => reuse.remember("unequal-originals", unequalOriginals, unequalResult, {
    parameters: [{ name: "value", paths: ["steps.0.value", "steps.0.expect.valueEquals"] }],
  }), ReuseValidationError);

  const reversedKeys = {
    steps: [{
      kind: "type",
      target: { name: "Title", role: "textbox" },
      text: "reversed-order",
      expect: { valueEquals: "reversed-order", target: { role: "textbox", name: "Title" } },
    }],
  };
  const reversedResult = await reuse.act(reversedKeys);
  const reversedRecord = await reuse.remember("reversed-selector-keys", reversedKeys, reversedResult, {
    parameters: [{ name: "value", paths: ["steps.0.text", "steps.0.expect.valueEquals"] }],
  });
  assert.equal(reversedRecord.key, "reversed-selector-keys");
});

test("context, coverage, and parameters fail closed without invoking act", async () => {
  const fake = fakeSession();
  const reuse = createVerifiedStepReuse({ session: fake.session });
  const request = typeRequest();
  const first = await reuse.act(request);
  await reuse.remember("title-edit", request, first, titleParameter);

  assert.deepEqual(await reuse.run("title-edit", { values: { title: "x" }, context: { application: "other", document: "one" }, coverage: titleParameter.coverage }), {
    status: "miss", reused: false, key: "title-edit", code: "context_mismatch",
  });
  assert.deepEqual(await reuse.run("title-edit", { values: { title: "x" }, context: titleParameter.context, coverage: { expected: "different" } }), {
    status: "miss", reused: false, key: "title-edit", code: "coverage_mismatch",
  });
  assert.deepEqual(await reuse.run("title-edit", { context: titleParameter.context, coverage: titleParameter.coverage }), {
    status: "miss", reused: false, key: "title-edit", code: "parameter_missing",
  });
  assert.equal(fake.calls.length, 1);
});

test("target changes and missing targets are delegated to live act as conservative execution results", async () => {
  const fake = fakeSession((request, index) => index === 0 ? verifiedResult(request) : ({
    status: "stopped",
    atStep: 1,
    code: "target_not_found",
    steps: [{ index: 1, kind: "type", status: "not_dispatched", code: "target_not_found" }],
  }));
  const reuse = createVerifiedStepReuse({ session: fake.session });
  const request = typeRequest();
  const first = await reuse.act(request);
  await reuse.remember("title-edit", request, first, titleParameter);
  const run = await reuse.run("title-edit", { values: { title: "new" }, context: titleParameter.context, coverage: titleParameter.coverage });
  assert.equal(run.status, "stopped");
  assert.equal(run.succeeded, false);
  assert.equal(run.result.code, "target_not_found");
  assert.equal(fake.calls.length, 2);
});

test("approval remains on the same public act call and is never cached", async () => {
  const fake = fakeSession((request, index) => index === 0 ? verifiedResult(request) : ({
    status: "stopped",
    atStep: 1,
    code: "approval_required",
    requestId: "approval-1",
    steps: [{ index: 1, kind: "type", status: "not_dispatched", code: "approval_required" }],
  }));
  const reuse = createVerifiedStepReuse({ session: fake.session });
  const request = typeRequest("send-note");
  // Capture is based on a previously completed, independently verified run.
  const first = await reuse.act(request);
  await reuse.remember("send", request, first, { parameters: [{ name: "title", paths: ["steps.0.text", "steps.0.expect.valueEquals"] }], context: { application: "fixture" } });
  const run = await reuse.run("send", { values: { title: "send-note-2" }, context: { application: "fixture" } });
  assert.equal(run.status, "stopped");
  assert.equal(run.succeeded, false);
  assert.equal(run.result.code, "approval_required");
  assert.equal(fake.calls.length, 2);
  assert.equal(JSON.stringify(await reuse.get("send")).includes("approval"), false);
});

test("wrapper approval resume preserves capture provenance without re-running the request", async () => {
  const calls = [];
  const request = typeRequest("send-note");
  const session = {
    capabilities,
    limits,
    async act(value) {
      calls.push({ kind: "act", value });
      return { status: "stopped", atStep: 1, code: "approval_required", requestId: "approval-2", steps: [{ index: 1, kind: "type", status: "not_dispatched", code: "approval_required" }] };
    },
    async resolveApproval(requestId, decision) {
      calls.push({ kind: "approval", requestId, decision });
      return { status: "completed", requestId, steps: [{ index: 1, kind: "type", status: "verified" }] };
    },
  };
  const reuse = createVerifiedStepReuse({ session });
  const pending = await reuse.act(request);
  assert.equal(pending.code, "approval_required");
  const approved = await reuse.resolveApproval("approval-2", "approve");
  assert.equal(approved.status, "completed");
  const record = await reuse.remember("send", request, approved, { parameters: [{ name: "title", paths: ["steps.0.text", "steps.0.expect.valueEquals"] }] });
  assert.equal(record.key, "send");
  assert.deepEqual(calls.map((call) => call.kind), ["act", "approval"]);
});

test("refs, points, drag, unverified receipts, and interrupted prefixes cannot be captured", async () => {
  const fake = fakeSession();
  const reuse = createVerifiedStepReuse({ session: fake.session });
  const expectState = { target: { role: "button", name: "Save" }, state: "present" };
  const refRequest = { observationId: "old-observation", steps: [{ kind: "click", target: { ref: "old-ref" }, expect: expectState }] };
  await assert.rejects(() => reuse.remember("ref", refRequest, verifiedResult(refRequest), { parameters: [] }), ReuseValidationError);
  const pointRequest = { observationId: "old-observation", steps: [{ kind: "click", target: { point: { x: 10, y: 20 } }, expect: expectState }] };
  await assert.rejects(() => reuse.remember("point", pointRequest, verifiedResult(pointRequest), { parameters: [] }), ReuseValidationError);
  const dragRequest = { steps: [{ kind: "drag", from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, expect: expectState }] };
  await assert.rejects(() => reuse.remember("drag", dragRequest, verifiedResult(dragRequest), { parameters: [] }), ReuseValidationError);

  const unverified = { steps: [{ kind: "click", target: { role: "button", name: "Save" } }] };
  await assert.rejects(() => reuse.remember("dispatched", unverified, { status: "completed", steps: [{ index: 1, kind: "click", status: "dispatched" }] }, { parameters: [] }), ReuseValidationError);
  const interrupted = {
    steps: [
      { kind: "click", target: { role: "button", name: "First" }, expect: expectState },
      { kind: "click", target: { role: "button", name: "Save" }, expect: expectState },
    ],
  };
  await assert.rejects(() => reuse.remember("prefix", interrupted, {
    status: "stopped",
    atStep: 2,
    code: "unknown",
    steps: [
      { index: 1, kind: "click", status: "verified" },
      { index: 2, kind: "click", status: "unknown", code: "dispatch_unknown" },
    ],
  }, { parameters: [] }), ReuseValidationError);
  const forged = typeRequest();
  await assert.rejects(() => reuse.remember("forged", forged, verifiedResult(forged), {
    parameters: [{ name: "title", paths: ["steps.0.text", "steps.0.expect.valueEquals"] }],
  }), ReuseValidationError);
  const unchangedPresence = { steps: [{ kind: "click", target: { role: "button", name: "Save" }, expect: { target: { role: "button", name: "Save" }, state: "present" } }] };
  const presenceResult = await reuse.act(unchangedPresence);
  await assert.rejects(() => reuse.remember("presence-only", unchangedPresence, presenceResult, { parameters: [] }), ReuseValidationError);
});

test("stored templates keep the same payload/expect invariants and discard tampered static values", async () => {
  const fake = fakeSession();
  const reuse = createVerifiedStepReuse({
    session: fake.session,
    store: {
      load: () => [{
        version: 1,
        key: "tampered",
        request: { steps: [{
          kind: "type",
          target: { role: "textbox", name: "Title" },
          text: "old-secret",
          expect: { target: { role: "textbox", name: "Title" }, valueEquals: "old-secret" },
        }] },
        parameterNames: [],
        verifiedAt: 1,
      }],
      save: () => {},
    },
  });
  assert.deepEqual(await reuse.run("tampered", { values: {} }), {
    status: "miss", reused: false, key: "tampered", code: "reuse_not_found",
  });
  const request = typeRequest();
  await assert.rejects(() => reuse.remember("bad-path", request, verifiedResult(request), {
    parameters: [{ name: "kind", paths: ["steps.0.kind"] }],
  }), ReuseValidationError);
});

test("recommended per-key stores preserve unrelated captures from concurrent reuse clients", async () => {
  const records = new Map();
  const sharedStore = {
    async get(key) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return records.get(key);
    },
    async put(record) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      records.set(record.key, structuredClone(record));
    },
    async delete(key) {
      return records.delete(key);
    },
    async list() {
      return [...records.values()].map((record) => structuredClone(record));
    },
  };
  const left = fakeSession();
  const right = fakeSession();
  const leftReuse = createVerifiedStepReuse({ session: left.session, store: sharedStore });
  const rightReuse = createVerifiedStepReuse({ session: right.session, store: sharedStore });
  const leftRequest = typeRequest("left");
  const rightRequest = typeRequest("right");
  const leftResult = await leftReuse.act(leftRequest);
  const rightResult = await rightReuse.act(rightRequest);
  await Promise.all([
    leftReuse.remember("left", leftRequest, leftResult, titleParameter),
    rightReuse.remember("right", rightRequest, rightResult, titleParameter),
  ]);
  assert.deepEqual((await leftReuse.list()).map((record) => record.key).sort(), ["left", "right"]);
});
