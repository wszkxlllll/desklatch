import assert from "node:assert/strict";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { LlmAdapter, LlmRuntime, createUserMessage } from "@deepseek-ai/dsh-llm";
import ApprovalService from "@deepseek-ai/dsh-user-approval";
import SessionStore from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as nativeExecutor from "@deepseek-ai/dsh-tool-executor-native";
import { ToolsService } from "@deepseek-ai/dsh-tools";

import { createDeskSession } from "desklatch";
import { createDeskDshApprovalBridge, createDeskDshPlugin } from "desklatch/dsh";

class DeterministicAdapter extends LlmAdapter {
  requests = [];

  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 16_384 }, inputModalities: ["text"], systemPromptUpdate: "in-history", toolUpdate: "in-history" };
  }

  async *stream(options) {
    this.requests.push(options);
    if (this.requests.length === 1) {
      yield { type: "tool-call-delta", index: 0, id: "offline-call-1", name: "desklatch_act", argumentsDelta: JSON.stringify({ steps: [{ kind: "type", target: { name: "Title" }, text: "loop proof" }] }) };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "text-delta", index: 0, text: "DeskLatch act dispatched by DSH AgentLoop." };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

function authorizedDeskSession() {
  let value = "";
  const calls = [];
  const backend = {
    capabilities: [{ kind: "type", targets: ["selector"] }],
    async observe() {
      calls.push({ kind: "observe" });
      return { scope: "dsh-loop-test", complete: true, controls: [{ id: "title", role: "Edit", name: "Title", states: ["visible", "enabled", "editable"], actions: ["type"], effect: "edit", value }] };
    },
    async dispatch({ step, target }) {
      calls.push({ kind: "dispatch", step, target });
      if (step.kind !== "type" || target.id !== "title") return { status: "refused" };
      value = step.text;
      return { status: "dispatched" };
    },
    async close() {},
  };
  return { session: createDeskSession(backend, { policy: () => ({ decision: "allow", code: "offline_smoke" }) }), calls, get value() { return value; } };
}

async function mount(ctx, plugin, config) {
  const fiber = ctx.plugin(plugin, config);
  await fiber.await();
  return fiber;
}

test("official DSH AgentLoop dispatches DeskLatch tools from an Agent-scoped plugin", async () => {
  const ctx = new Context();
  const fibers = [];
  let handle;
  let disposeAdapter;
  try {
    fibers.push(await mount(ctx, SessionProjectionRegistry));
    fibers.push(await mount(ctx, SessionStore));
    fibers.push(await mount(ctx, SystemPrompt, { includeRuntimeContext: false }));
    fibers.push(await mount(ctx, ToolsService));
    fibers.push(await mount(ctx, nativeExecutor));
    fibers.push(await mount(ctx, AgentRegistry));
    fibers.push(await mount(ctx, LlmRuntime));
    fibers.push(await mount(ctx, AgentLoop));

    const adapter = new DeterministicAdapter();
    disposeAdapter = ctx.llm.registerAdapter(["offline"], adapter);
    const desk = authorizedDeskSession();
    handle = await ctx.agents.create({
      sessionId: "dsh-loop-test",
      agentOptions: { provider: "offline", model: "deterministic" },
      setup: async (agentCtx) => {
        const fiber = agentCtx.plugin(createDeskDshPlugin(() => desk.session));
        await fiber.await();
      },
    });
    handle.agent.followup(createUserMessage({ content: [{ type: "text", text: "Type loop proof into the authorized Title field." }], source: { kind: "user" } }));
    await handle.agent.whenIdle();

    const eventTypes = handle.agent.session.snapshotEvents().map((event) => event.type);
    const modelTools = adapter.requests[0]?.tools?.map((tool) => tool.name) ?? [];
    assert.equal(adapter.requests.length, 2);
    assert.deepEqual([...modelTools].sort(), ["desklatch_act", "desklatch_observe"]);
    assert.equal(desk.calls.filter((call) => call.kind === "dispatch").length, 1);
    assert.equal(desk.value, "loop proof");
    assert.ok(eventTypes.includes("tool/call"));
    assert.ok(eventTypes.includes("tool/result"));
  } finally {
    if (handle) await handle.dispose();
    disposeAdapter?.();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

class ApprovalAdapter extends LlmAdapter {
  requests = [];

  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 16_384 }, inputModalities: ["text"], systemPromptUpdate: "in-history", toolUpdate: "in-history" };
  }

  async *stream(options) {
    this.requests.push(options);
    if (this.requests.length === 1 || this.requests.length === 3) {
      const text = this.requests.length === 1 ? "approved action" : "denied action";
      const steps = this.requests.length === 1
        ? [{ kind: "type", target: { name: "Title" }, text }, { kind: "type", target: { name: "Title" }, text: "approved action 2" }]
        : [{ kind: "type", target: { name: "Title" }, text }];
      yield { type: "tool-call-delta", index: 0, id: `approval-call-${this.requests.length}`, name: "desklatch_act", argumentsDelta: JSON.stringify({ steps }) };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "text-delta", index: 0, text: "approval turn complete" };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("approval test timed out"));
      setTimeout(poll, 1);
    };
    poll();
  });
}

test("native DSH approval bridge holds act until consent and resumes or denies once", async () => {
  const ctx = new Context();
  const fibers = [];
  const questions = [];
  let handle;
  let disposeAdapter;
  const value = { current: "" };
  const calls = [];
  const resolveCalls = [];
  const backend = {
    capabilities: [{ kind: "type", targets: ["selector"] }],
    async observe() {
      return { scope: "dsh-approval-test", complete: true, controls: [{ id: "title", role: "Edit", name: "Title", states: ["visible", "enabled", "editable"], actions: ["type"], effect: "edit", value: value.current }] };
    },
    async dispatch({ step, target }) {
      calls.push({ step, target });
      value.current = step.text;
      return { status: "dispatched" };
    },
    async close() {},
  };
  try {
    fibers.push(await mount(ctx, SessionProjectionRegistry));
    fibers.push(await mount(ctx, SessionStore));
    fibers.push(await mount(ctx, SystemPrompt, { includeRuntimeContext: false }));
    fibers.push(await mount(ctx, ToolsService));
    fibers.push(await mount(ctx, nativeExecutor));
    fibers.push(await mount(ctx, AgentRegistry));
    fibers.push(await mount(ctx, LlmRuntime));
    fibers.push(await mount(ctx, ApprovalService));
    fibers.push(await mount(ctx, AgentLoop));
    ctx.on("approval/request", (request) => new Promise((resolve) => questions.push({ request, resolve })));

    const adapter = new ApprovalAdapter();
    disposeAdapter = ctx.llm.registerAdapter(["approval-offline"], adapter);
    handle = await ctx.agents.create({
      sessionId: "dsh-approval-test",
      agentOptions: { provider: "approval-offline", model: "deterministic" },
      setup: async (agentCtx) => {
        const bridge = createDeskDshApprovalBridge(agentCtx);
        const rawSession = createDeskSession(backend, {
          policy: () => ({ decision: "approve", code: "needs_user" }),
          onApprovalRequested: bridge.onApprovalRequested,
        });
        const session = {
          ...rawSession,
          async resolveApproval(requestId, decision) {
            resolveCalls.push([requestId, decision]);
            return rawSession.resolveApproval(requestId, decision);
          },
        };
        const fiber = agentCtx.plugin(createDeskDshPlugin(() => session, { approval: bridge }));
        await fiber.await();
      },
    });

    handle.agent.followup(createUserMessage({ content: [{ type: "text", text: "Do the approved action." }], source: { kind: "user" } }));
    const firstIdle = handle.agent.whenIdle();
    await waitFor(() => questions.length === 1);
    assert.equal(questions[0].request.toolName, "desklatch_act");
    assert.equal(calls.length, 0);
    questions.shift().resolve("allowed-once");
    await waitFor(() => questions.length === 1);
    assert.equal(calls.length, 1);
    questions.shift().resolve("allowed-once");
    await firstIdle;
    assert.equal(calls.length, 2);
    assert.equal(value.current, "approved action 2");
    assert.equal(resolveCalls.length, 2);
    assert.equal(resolveCalls[0][1], "approve");
    assert.equal(resolveCalls[1][1], "approve");

    handle.agent.followup(createUserMessage({ content: [{ type: "text", text: "Do the denied action." }], source: { kind: "user" } }));
    const secondIdle = handle.agent.whenIdle();
    await waitFor(() => questions.length === 1);
    assert.equal(calls.length, 2);
    questions.shift().resolve("rejected");
    await secondIdle;
    assert.equal(calls.length, 2);
    assert.equal(value.current, "approved action 2");
    assert.equal(resolveCalls.length, 3);
    assert.equal(resolveCalls[2][1], "deny");
    assert.equal(adapter.requests.length, 4);
  } finally {
    if (handle) await handle.dispose();
    disposeAdapter?.();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
