import assert from "node:assert/strict";
import test from "node:test";

import { createDeskCodeMode } from "desklatch/code-mode";
import { createDeskSession, createDeskTools } from "desklatch";

const capabilities = [
  { kind: "type", targets: ["selector"] },
  { kind: "keypress", targets: ["selector"], keys: ["Enter"] },
];

const checkedType = {
  kind: "type",
  target: { name: "Title" },
  text: "draft",
  expect: { target: { name: "Title" }, valueEquals: "draft" },
};
const followingEnter = { kind: "keypress", target: { name: "Title" }, key: "Enter" };
const HINT = "The step identified by atStep was dispatched. Its check ran before the next step and failed, so later steps were not sent. Do not repeat the delivered step. If the intended condition depends on a later action, put the check on that action or read afterward.";

function makeSession(t, { value = "before", includeTitle = true } = {}) {
  const calls = { observe: 0, dispatch: [] };
  const control = {
    id: "title-control",
    role: "Edit",
    name: "Title",
    states: ["visible", "enabled", "editable"],
    actions: ["type", "keypress"],
    value,
    effect: "edit",
  };
  const backend = {
    capabilities,
    async observe() {
      calls.observe += 1;
      return { scope: "expectation-fixture", complete: true, controls: includeTitle ? [control] : [] };
    },
    async dispatch(request) {
      calls.dispatch.push(request);
      return { status: "dispatched", focusId: "title-control" };
    },
    async close() {},
  };
  const session = createDeskSession(backend, {
    capabilities,
    policy: () => ({ decision: "allow", code: "test_allow" }),
    expectTimeoutMs: 0,
  });
  t.after(() => session.close());
  return { session, calls };
}

test("expectation feedback appears only after a delivered failure with unreached steps", async t => {
  const failed = makeSession(t);
  const result = await failed.session.act({ steps: [checkedType, followingEnter] });
  assert.equal(result.status, "stopped");
  assert.equal(result.code, "expect_value_failed");
  assert.equal(result.atStep, 1);
  assert.equal(result.recoveryHint, HINT);
  assert.deepEqual(result.steps.map(step => [step.index, step.status]), [[1, "dispatched"], [2, "not_dispatched"]]);
  assert.equal(failed.calls.dispatch.length, 1);

  const success = makeSession(t, { value: "draft" });
  const verified = await success.session.act({ steps: [checkedType, followingEnter] });
  assert.equal(verified.status, "completed");
  assert.equal(verified.recoveryHint, undefined);

  const predispatch = makeSession(t, { includeTitle: false });
  const notSent = await predispatch.session.act({ steps: [checkedType, followingEnter] });
  assert.equal(notSent.status, "stopped");
  assert.equal(notSent.steps[0].status, "not_dispatched");
  assert.equal(notSent.recoveryHint, undefined);
  assert.equal(predispatch.calls.dispatch.length, 0);

  const terminal = makeSession(t);
  const finalCheck = await terminal.session.act({ steps: [checkedType] });
  assert.equal(finalCheck.status, "stopped");
  assert.equal(finalCheck.code, "expect_value_failed");
  assert.equal(finalCheck.recoveryHint, undefined);
});

test("Code Mode preserves only the fixed safe expectation hint on its action receipt", async t => {
  const { session, calls } = makeSession(t);
  const host = createDeskCodeMode({ tools: createDeskTools(session), close: () => session.close() });
  t.after(() => host.close());

  const code = `await desk.act({ steps: [
    { kind: "type", target: { name: "Title" }, text: "draft", expect: { target: { name: "Title" }, valueEquals: "draft" } },
    { kind: "keypress", target: { name: "Title" }, key: "Enter" },
  ] });`;
  const result = await host.runCode({ code });
  assert.equal(result.status, "stopped");
  assert.equal(result.code, "expect_value_failed");
  assert.equal(result.actions[0].atStep, 1);
  assert.equal(result.actions[0].recoveryHint, HINT);
  assert.deepEqual(result.actions[0].steps.map(step => [step.index, step.status]), [[1, "dispatched"], [2, "not_dispatched"]]);
  assert.equal(calls.dispatch.length, 1);
});
