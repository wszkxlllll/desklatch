import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeskSession } from "desklatch";
import { createDeskCodeMode } from "desklatch/code-mode";

const firstWrite = { steps: [{ kind: "type", target: { name: "Title" }, text: "first" }] };
const revokedWrite = { steps: [{ kind: "type", target: { name: "Title" }, text: "revoked" }] };
const finallyWrite = { steps: [{ kind: "type", target: { name: "Title" }, text: "finally" }] };

function endpoint(name, invoke) {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    invoke,
  };
}

test("a revoked receipt between Code Mode calls blocks catch/finally continuation and keeps prior receipts", async t => {
  const calls = [];
  const confirmed = { status: "completed", steps: [{ index: 1, kind: "type", status: "verified" }] };
  const revoked = {
    status: "stopped",
    code: "application_automation_blocked",
    steps: [{ index: 1, kind: "type", status: "not_dispatched", code: "application_automation_blocked" }],
  };
  const source = {
    tools: [
      endpoint("observe", async () => ({ controls: [] })),
      endpoint("act", async input => {
        calls.push(input);
        return calls.length === 1 ? confirmed : revoked;
      }),
    ],
    close() {},
  };
  const host = createDeskCodeMode(source);
  t.after(() => host.close());

  const result = await host.runCode({ code: `
    try {
      await desk.act(${JSON.stringify(firstWrite)});
      await desk.act(${JSON.stringify(revokedWrite)});
    } catch {}
    finally {
      try { await desk.act(${JSON.stringify(finallyWrite)}); } catch {}
    }
  ` });

  assert.equal(result.status, "stopped");
  assert.equal(result.code, "application_automation_blocked");
  assert.deepEqual(result.actions, [
    { call: 1, status: "completed", steps: [{ index: 1, kind: "type", status: "verified" }] },
    { call: 2, status: "stopped", code: "application_automation_blocked", steps: [{ index: 1, kind: "type", status: "not_dispatched", code: "application_automation_blocked" }] },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].steps[0].text, "first");
  assert.equal(calls[1].steps[0].text, "revoked");
});

test("plain host approval waiting cannot be bypassed by catch/finally continuation", async t => {
  let value = "";
  const dispatches = [];
  const requests = [];
  const requestSeen = Promise.withResolvers();
  const approvalAnswer = Promise.withResolvers();
  const backend = {
    capabilities: [
      { kind: "type", targets: ["selector"] },
      { kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] },
    ],
    async observe() {
      return {
        scope: "plain-code-approval",
        complete: true,
        controls: [
          { id: "title", role: "Edit", name: "Title", states: ["visible", "enabled", "editable"], actions: ["type"], effect: "edit", value },
          { id: "send", role: "Button", name: "Send", states: ["visible", "enabled"], actions: ["click"], effect: "external" },
        ],
      };
    },
    async dispatch({ step, target }) {
      dispatches.push({ step, target });
      if (step.kind === "type") value = step.text;
      return { status: "dispatched" };
    },
    async close() {},
  };
  const session = createDeskSession(backend, {
    policy: input => input.step.kind === "click"
      ? { decision: "approve", code: "plain_send_requires_approval" }
      : { decision: "allow", code: "plain_edit_allowed" },
    onApprovalRequested(request) {
      requests.push(request);
      requestSeen.resolve(request);
      return approvalAnswer.promise;
    },
  });
  const host = createDeskCodeMode(session);
  t.after(async () => { await host.close(); });

  const result = await host.runCode({ code: `
    try {
      await desk.act(${JSON.stringify(firstWrite)});
      await desk.act({ steps: [{ kind: "click", target: { name: "Send" } }] });
    } catch {}
    finally {
      try { await desk.act(${JSON.stringify(finallyWrite)}); } catch {}
    }
  ` });
  const request = await requestSeen.promise;

  assert.equal(result.status, "stopped");
  assert.equal(result.code, "approval_required");
  assert.equal(requests.length, 1);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].step.text, "first");
  assert.deepEqual(result.actions, [
    { call: 1, status: "completed", steps: [{ index: 1, kind: "type", status: "dispatched" }] },
    { call: 2, status: "stopped", code: "approval_required", atStep: 1, requestId: request.requestId, steps: [{ index: 1, kind: "click", status: "not_dispatched", code: "approval_required" }] },
  ]);

  // This is the plain DeskSession pending approval path. The trusted DSH
  // bridge has a separate waiting/resume contract covered by dsh-agent-loop.
  host.cancel("plain_host_revoked");
  const cancelled = await session.resolveApproval(request.requestId, "approve");
  assert.equal(cancelled.status, "stopped");
  assert.equal(cancelled.code, "cancelled");
  approvalAnswer.resolve("approve");
  assert.equal(dispatches.length, 1);
  assert.equal(value, "first");
});
