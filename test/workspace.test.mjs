import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspace, createWorkspaceTools } from "desklatch/workspace";

function fakeSession(id, options = {}) {
  let observation = 0;
  const calls = { observe: [], act: [], resolve: [], correct: 0, cancel: 0, close: 0 };
  const pending = options.pending === true;
  const session = {
    capabilities: [{ kind: "click", targets: ["selector"] }],
    allowModelImages: false,
    allowModelDocumentText: false,
    limits: { maxSteps: 8, maxTextLength: 100, maxScrollAmount: 10 },
    async observe(input) {
      calls.observe.push(input);
      observation += 1;
      return {
        observationId: `${id}-observation-${observation}`,
        view: "controls",
        complete: true,
        controls: [{ ref: `${id}-ref-${observation}`, role: "Button", name: id, states: ["visible", "enabled"], actions: ["click"] }],
      };
    },
    async act(input, signal) {
      calls.act.push(input);
      if (options.deferAct && !calls.deferredAct) {
        calls.deferredAct = true;
        await new Promise((resolve) => {
          calls.releaseAct = resolve;
          signal?.addEventListener("abort", resolve, { once: true });
        });
        return { status: "completed", steps: [{ index: 1, status: "verified", code: "first_dispatch" }] };
      }
      if (options.candidate && !calls.candidateReturned) {
        calls.candidateReturned = true;
        return {
          status: "stopped",
          code: "target_ambiguous",
          candidates: [{ observationId: `${id}-candidate-observation`, role: "Button", name: id, states: ["visible", "enabled"], actions: ["click"] }],
          steps: [],
        };
      }
      if (options.sequential && !calls.pendingRequest) {
        calls.pendingRequest = `approval-${id}-a`;
        return { status: "stopped", code: "approval_required", requestId: calls.pendingRequest, steps: [] };
      }
      if (pending && !calls.resolved) {
        calls.pendingRequest = `approval-${id}`;
        return { status: "stopped", code: "approval_required", requestId: calls.pendingRequest, steps: [] };
      }
      return { status: "completed", steps: [{ index: 1, status: "verified" }] };
    },
    async resolveApproval(requestId, decision) {
      calls.resolve.push([requestId, decision]);
      if (options.deferResolve && requestId === `approval-${id}-b`) {
        await new Promise((resolve) => { calls.releaseResolve = resolve; });
        return { requestId, status: "completed", steps: [{ index: 1, status: "verified", code: "resumed_dispatch" }] };
      }
      if (options.sequential && requestId === `approval-${id}-a`) {
        return { status: "stopped", code: "approval_required", requestId: `approval-${id}-b`, steps: [] };
      }
      if (options.sequential && requestId === `approval-${id}-b`) {
        calls.resolved = true;
        return calls.resolution ??= { requestId, status: "completed", steps: [] };
      }
      calls.resolved = true;
      return calls.resolution ??= { requestId, status: "completed", steps: [] };
    },
    correct() { calls.correct += 1; },
    cancel() { calls.cancel += 1; calls.releaseResolve?.(); },
    async close() { calls.close += 1; },
  };
  return { session, calls };
}

function app(id, session, extra = {}) {
  return { id, name: id.toUpperCase(), description: `${id} app`, session, ...extra };
}

test("workspace discovery works before activation and exposes exactly observe/act", async () => {
  const first = fakeSession("one");
  const second = fakeSession("two");
  const workspace = createWorkspace({ applications: [app("one", first.session), app("two", second.session)] });
  const tools = createWorkspaceTools(workspace);
  assert.deepEqual(tools.map((tool) => tool.name), ["observe", "act"]);
  assert.deepEqual(await tools[0].invoke({ workspace: true }), {
    active: null,
    applications: [
      { id: "one", name: "ONE", description: "one app" },
      { id: "two", name: "TWO", description: "two app" },
    ],
  });
  assert.equal(first.calls.observe.length, 0);
  await workspace.close();
});

test("workspace schemas retain the active DeskSession capability and delivery gates", async () => {
  const source = fakeSession("source");
  const secondary = fakeSession("secondary");
  source.session.capabilities = [
    { kind: "type", targets: ["selector"] },
  ];
  secondary.session.capabilities = [
    { kind: "setValue", targets: ["selector"] },
  ];
  const workspace = createWorkspace({ applications: [app("source", source.session), app("secondary", secondary.session, { navigate: async () => ({ status: "completed", steps: [] }) })], initialActive: "source" });
  const [observe, act] = workspace.tools;
  assert.deepEqual(observe.inputSchema.properties.view.enum, ["controls"]);
  const schemaText = JSON.stringify(act.inputSchema);
  assert.match(schemaText, /"const"\s*:\s*"type"/u);
  assert.match(schemaText, /"const"\s*:\s*"setValue"/u);
  assert.match(schemaText, /"target"/u);
  assert.match(schemaText, /"navigate"/u);
  assert.equal(act.inputSchema.properties.activate, undefined);
  await workspace.close();
});

test("activation calls the real activator and independently verifies repeated switches", async () => {
  const first = fakeSession("one");
  const second = fakeSession("two");
  const activations = [];
  const workspace = createWorkspace({
    applications: [
      app("one", first.session, { activate: () => { activations.push("one"); }, verifyFront: async () => true }),
      app("two", second.session, { activate: () => { activations.push("two"); }, verifyFront: async () => true }),
    ],
    initialActive: "one",
  });
  assert.equal(workspace.activeApplicationId, "one");
  assert.equal((await workspace.act({ activate: "two" })).code, "activated");
  assert.equal((await workspace.act({ activate: "one" })).code, "activated");
  assert.deepEqual(activations, ["two", "one"]);
  assert.equal((await workspace.act({ activate: "one" })).code, "already_active");
  await workspace.close();
});

test("failed verification does not change the actual current application", async () => {
  const first = fakeSession("one");
  const second = fakeSession("two");
  let activateCalls = 0;
  const workspace = createWorkspace({
    applications: [
      app("one", first.session),
      app("two", second.session, { activate: () => { activateCalls += 1; }, verifyFront: async () => false }),
    ],
    initialActive: "one",
  });
  const result = await workspace.act({ activate: "two" });
  assert.equal(result.code, "activation_not_verified");
  assert.equal(activateCalls, 1);
  assert.equal(workspace.activeApplicationId, null);
  await workspace.close();
});

test("navigation delegates allowlisting to the adapter and reports unsupported adapters", async () => {
  const browser = fakeSession("browser");
  const calls = [];
  const workspace = createWorkspace({ applications: [
    app("browser", browser.session, {
      navigate: async ({ url }) => { calls.push(url); throw Object.assign(new Error("blocked"), { code: "navigation_not_authorized" }); },
    }),
    app("plain", fakeSession("plain").session),
  ], initialActive: "browser" });
  assert.equal((await workspace.act({ navigate: "https://example.test/private" })).code, "navigation_not_authorized");
  assert.deepEqual(calls, ["https://example.test/private"]);
  assert.equal((await workspace.act({ activate: "plain" })).code, "activation_unsupported");
  await workspace.close();
});

test("observation IDs cannot cross apps or activation generations", async () => {
  const first = fakeSession("one");
  const second = fakeSession("two");
  const workspace = createWorkspace({
    applications: [
      app("one", first.session, { activate: () => {}, verifyFront: () => true }),
      app("two", second.session, { activate: () => {}, verifyFront: () => true }),
    ], initialActive: "one",
  });
  const old = await workspace.observe({});
  await workspace.act({ activate: "two" });
  const crossed = await workspace.act({ observationId: old.observationId, steps: [{ kind: "click", target: { name: "one" } }] });
  assert.equal(crossed.code, "stale_observation");
  assert.equal(second.calls.act.length, 0);
  await workspace.act({ activate: "one" });
  const reentry = await workspace.act({ observationId: old.observationId, steps: [{ kind: "click", target: { name: "one" } }] });
  assert.equal(reentry.code, "stale_observation");
  await workspace.close();
});

test("candidate observation IDs are tracked, then invalidated across app re-entry", async () => {
  const first = fakeSession("one", { candidate: true });
  const second = fakeSession("two");
  const workspace = createWorkspace({ applications: [
    app("one", first.session, { activate: () => {}, verifyFront: () => true }),
    app("two", second.session, { activate: () => {}, verifyFront: () => true }),
  ], initialActive: "one" });
  const ambiguous = await workspace.act({ steps: [{ kind: "click", target: { name: "one" } }] });
  const candidateObservationId = ambiguous.candidates[0].observationId;
  await workspace.act({ activate: "two" });
  await workspace.act({ activate: "one" });
  const stale = await workspace.act({ observationId: candidateObservationId, steps: [{ kind: "click", target: { ref: "one-ref" } }] });
  assert.equal(stale.code, "stale_observation");
  assert.equal(first.calls.act.length, 1);
  await workspace.close();
});

test("pending approvals stay with their originating session and correction is safe to repeat", async () => {
  const first = fakeSession("one", { pending: true });
  const second = fakeSession("two");
  const workspace = createWorkspace({ applications: [
    app("one", first.session),
    app("two", second.session, { activate: () => {}, verifyFront: () => true }),
  ], initialActive: "one" });
  const pending = await workspace.act({ steps: [{ kind: "click", target: { name: "one" } }] });
  assert.equal(pending.code, "approval_required");
  await workspace.act({ activate: "two" });
  workspace.correct();
  workspace.correct();
  const resolved = await workspace.resolveApproval(pending.requestId, "approve");
  const repeated = await workspace.resolveApproval(pending.requestId, "deny");
  assert.equal(resolved.code, "stale_activation");
  assert.equal(first.calls.resolve.length, 1);
  assert.deepEqual(repeated, resolved);
  assert.equal(second.calls.resolve.length, 0);
  assert.equal(first.calls.correct, 2);
  await workspace.close();
});

test("sequential approvals keep the settled request idempotent without duplicating dispatch", async () => {
  const first = fakeSession("one", { sequential: true });
  const workspace = createWorkspace({ applications: [app("one", first.session)], initialActive: "one" });
  const firstPending = await workspace.act({ steps: [{ kind: "click", target: { name: "one" } }] });
  const secondPending = await workspace.resolveApproval(firstPending.requestId, "approve");
  assert.equal(secondPending.requestId, "approval-one-b");
  assert.deepEqual(await workspace.resolveApproval(firstPending.requestId, "deny"), secondPending);
  const completed = await workspace.resolveApproval(secondPending.requestId, "approve");
  assert.equal(completed.status, "completed");
  assert.deepEqual(await workspace.resolveApproval(secondPending.requestId, "deny"), completed);
  assert.deepEqual(first.calls.resolve, [["approval-one-a", "approve"], ["approval-one-b", "approve"]]);
  await workspace.close();
});

test("cancellation after child dispatch preserves its authoritative receipt", async () => {
  const first = fakeSession("one", { deferAct: true });
  const workspace = createWorkspace({ applications: [app("one", first.session)], initialActive: "one" });
  const running = workspace.act({ steps: [{ kind: "click", target: { name: "one" } }] });
  await new Promise((resolve) => setImmediate(resolve));
  workspace.cancel();
  const result = await running;
  assert.equal(result.code, "cancelled");
  assert.equal(result.steps[0].status, "verified");
  assert.equal(result.steps[0].code, "first_dispatch");
  await workspace.close();
});

test("cancellation after resumed approval preserves the resumed receipt without replay", async () => {
  const first = fakeSession("one", { sequential: true, deferResolve: true });
  const workspace = createWorkspace({ applications: [app("one", first.session)], initialActive: "one" });
  const initial = await workspace.act({ steps: [{ kind: "click", target: { name: "one" } }] });
  const next = await workspace.resolveApproval(initial.requestId, "approve");
  const resuming = workspace.resolveApproval(next.requestId, "approve");
  await new Promise((resolve) => setImmediate(resolve));
  workspace.cancel();
  const result = await resuming;
  assert.equal(result.code, "cancelled");
  assert.equal(result.steps[0].status, "verified");
  assert.equal(result.steps[0].code, "resumed_dispatch");
  assert.deepEqual(first.calls.resolve, [["approval-one-a", "approve"], ["approval-one-b", "approve"]]);
  assert.deepEqual(await workspace.resolveApproval(next.requestId, "deny"), result);
  assert.deepEqual(first.calls.resolve, [["approval-one-a", "approve"], ["approval-one-b", "approve"]]);
  await workspace.close();
});

test("close prevents later navigation and cancel aborts an in-flight navigation before queued work", async () => {
  const closedSession = fakeSession("closed");
  let closedCalls = 0;
  const closedWorkspace = createWorkspace({ applications: [app("closed", closedSession.session, {
    navigate: async () => { closedCalls += 1; return { status: "completed", steps: [] }; },
  })], initialActive: "closed" });
  await closedWorkspace.close();
  assert.equal((await closedWorkspace.act({ navigate: "https://example.test/after-close" })).code, "closed");
  assert.equal(closedCalls, 0);

  const runningSession = fakeSession("running");
  let started;
  let release;
  let calls = 0;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const workspace = createWorkspace({ applications: [app("running", runningSession.session, {
    navigate: async ({ signal }) => {
      calls += 1;
      started();
      await new Promise((resolve) => { release = resolve; signal.addEventListener("abort", resolve, { once: true }); });
      if (signal.aborted) throw Object.assign(new Error("aborted"), { code: "aborted" });
      return { status: "completed", steps: [] };
    },
  })], initialActive: "running" });
  const running = workspace.act({ navigate: "https://example.test/first" });
  await startedPromise;
  const queued = workspace.act({ navigate: "https://example.test/second" });
  workspace.cancel();
  release();
  assert.equal((await running).code, "cancelled");
  assert.equal((await queued).code, "cancelled");
  assert.equal(calls, 1);
  await workspace.close();
});
