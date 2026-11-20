import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDeskSession } from "desklatch";
import { createDeskCodeMode } from "desklatch/code-mode";
import { createLangChainTools } from "desklatch/langchain";
import { createDeskMcpServer } from "desklatch/mcp";
import { chromiumPath, createFixture } from "../examples/support/fixture.mjs";

const verified = { status: "completed", steps: [{ index: 1, kind: "type", status: "verified" }] };
const write = { steps: [{ kind: "type", target: { name: "Title" }, text: "draft" }] };

function makeHost(t, { observe = async () => ({ controls: [] }), act = async () => verified, limits } = {}) {
  const calls = [];
  const invoke = { observe, act };
  const source = {
    tools: ["observe", "act"].map(name => ({
      name, description: name, inputSchema: { type: "object" },
      async invoke(input, signal) { calls.push({ name, input }); return invoke[name](input, signal); },
    })),
    close() {},
  };
  const host = createDeskCodeMode(source, limits);
  t.after(() => host.close());
  return { host, source, calls };
}

test("one TypeScript program processes observations and runs only the chosen actions", async t => {
  const { host, source, calls } = makeHost(t, { observe: () => ({
    controls: [{ name: "Title" }, { name: "Notes" }],
    image: { mimeType: "image/png", dataBase64: "AQID", width: 1, height: 1 },
  }) });
  assert.deepEqual(source.tools.map(tool => tool.name), ["observe", "act"]);
  assert.deepEqual(host.tools.map(tool => tool.name), ["observe", "act", "run_code"]);
  const result = await host.runCode({ language: "typescript", code: `
    const observation = await desk.observe({ view: "controls" });
    const fields: string[] = [];
    for (const control of observation.controls) {
      if (control.name === "Notes") continue;
      const receipt = await desk.act({ steps: [{ kind: "type", target: { name: control.name }, text: "draft" }] });
      if (receipt.steps[0].status === "verified") fields.push(control.name);
    }
    inspect({ fields, pixels: observation.image?.dataBase64 ?? null });
    return;
  ` });
  assert.deepEqual(result, {
    status: "completed", calls: { observe: 1, act: 1 }, inspections: [{ fields: ["Title"], pixels: null }],
    actions: [{ call: 2, ...verified }],
  });
  assert.deepEqual(calls[1].input, write);
  assert.equal((await host.runCode({ code: `inspect("next run")` })).status, "completed");
});

test("the guest only sees its isolated JavaScript globals and the bounded SDK", async t => {
  const { host, calls } = makeHost(t);
  const result = await host.runCode({ code: `
    let moduleLoaded = false;
    try { await import("node:os"); moduleLoaded = true; } catch {}
    inspect({
      node: typeof process, require: typeof require, fetch: typeof fetch, moduleLoaded,
      sdk: Object.keys(desk).sort(), frozen: Object.isFrozen(desk),
    });
  ` });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.inspections, [{
    node: "undefined", require: "undefined", fetch: "undefined", moduleLoaded: false,
    sdk: ["act", "observe"], frozen: true,
  }]);
  assert.deepEqual(calls, []);
});

for (const [code, stepStatus] of [
  ["application_automation_blocked", "not_dispatched"], ["target_not_found", "partial"], ["stale_observation", "unknown"],
]) {
  test(`a ${stepStatus} act hard-stops even when the guest attempts to continue`, async t => {
    const uncertain = { status: "stopped", code, steps: [{ index: 1, kind: "type", status: stepStatus, code }] };
    const { calls, host } = makeHost(t, { act: () => calls.length === 1 ? verified : uncertain });
    const result = await host.runCode({ code: `
      await desk.act(${JSON.stringify(write)});
      inspect("first write verified");
      try { await desk.act(${JSON.stringify(write)}); } catch {}
      await desk.act(${JSON.stringify(write)});
    ` });
    assert.equal(result.status, "stopped");
    assert.equal(result.code, code);
    assert.deepEqual(result.inspections, ["first write verified"]);
    assert.deepEqual(result.actions, [{ call: 1, ...verified }, { call: 2, ...uncertain }]);
    assert.equal(calls.length, 2);
  });
}

test("confirmed zero-dispatch grounding failure requires a fresh observation and allows one recovery", async t => {
  const stale = { status: "stopped", code: "stale_observation", steps: [{ index: 1, status: "not_dispatched" }] };
  const { calls, host } = makeHost(t, {
    act: () => stale,
    observe: () => ({ observationId: "fresh", controls: [] }),
  });
  const step = JSON.stringify(write);
  const ignored = await host.runCode({ code: `await desk.act(${step}); await desk.act(${step});` });
  assert.equal(ignored.code, "recovery_requires_observation");
  assert.deepEqual(calls.map(call => call.name), ["act"]);
  calls.length = 0;
  const recovered = await host.runCode({ code: `
    const first = await desk.act(${step});
    if (first.code === "stale_observation") {
      const frame = await desk.observe({});
      await desk.act({ ...${step}, observationId: frame.observationId });
    }
    await desk.act(${step});
  ` });
  assert.equal(recovered.code, "stale_observation");
  assert.deepEqual(recovered.actions.map(action => action.call), [1, 3]);
  assert.deepEqual(calls.map(call => call.name), ["act", "observe", "act"]);
  assert.equal(calls.at(-1).input.observationId, "fresh");
});

test("timeouts, unsettled promises and excess memory close the guest", async t => {
  const { host, calls } = makeHost(t, { limits: { timeoutMs: 1_500, memoryBytes: 2 * 1024 * 1024 } });
  const spin = await host.runCode({ code: "while (true) {}" });
  assert.equal(spin.status, "stopped");
  assert.equal(spin.code, "code_timeout");
  const pending = await host.runCode({ code: "await new Promise(() => {});" });
  assert.notEqual(pending.status, "completed");
  assert.match(pending.code, /^(code_stalled|code_timeout)$/u);
  const memory = await host.runCode({ code: `
    const values = [];
    for (let i = 0; i < 100; i++) values.push(new Array(32_768).fill(i));
    inspect("unreachable");
  ` });
  assert.equal(memory.status, "failed");
  assert.match(memory.code, /^(code_error|code_memory_limit)$/u);
  assert.deepEqual(memory.inspections, []);
  assert.deepEqual(calls, []);
});

test("guest execution budget pauses during a bounded host-tool wait", async t => {
  const { host } = makeHost(t, {
    limits: { timeoutMs: 100, toolWaitTimeoutMs: 500, overallTimeoutMs: 2_000 },
    act: async () => { await new Promise(resolve => setTimeout(resolve, 150)); return verified; },
  });
  const result = await host.runCode({ code: `await desk.act(${JSON.stringify(write)}); inspect("ok");` });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.inspections, ["ok"]);
});

test("tool wait budget is separate from guest execution budget", async t => {
  const { host } = makeHost(t, {
    limits: { timeoutMs: 100, toolWaitTimeoutMs: 100, overallTimeoutMs: 2_000 },
    act: async () => { await new Promise(resolve => setTimeout(resolve, 250)); return verified; },
  });
  const result = await host.runCode({ code: `await desk.act(${JSON.stringify(write)});` });
  assert.equal(result.status, "stopped");
  assert.equal(result.code, "act_result_unconfirmed");
  assert.deepEqual(result.actions, [{ call: 1, ...verified }]);
});

test("tool, input and inspect budgets stop excess work before delivery", async t => {
  const { host, calls } = makeHost(t, { limits: { maxCalls: 1, maxInspectBytes: 48 } });
  const overCalls = await host.runCode({ code: "await desk.observe({}); await desk.observe({});" });
  assert.equal(overCalls.code, "code_budget_exceeded");
  assert.deepEqual(overCalls.calls, { observe: 1, act: 0 });
  const overOutput = await host.runCode({ code: `inspect("ready"); inspect("x".repeat(80));` });
  assert.equal(overOutput.code, "inspect_budget_exceeded");
  assert.deepEqual(overOutput.inspections, ["ready"]);
  const overInput = await host.runCode({ code: `await desk.observe({where: {name: "x".repeat(17_000)}});` });
  assert.equal(overInput.code, "tool_input_too_large");
  const image = await host.runCode({ code: `await desk.observe({view: "both"});` });
  assert.equal(image.code, "code_images_not_supported");
  assert.equal(calls.length, 1);
});

test("concurrent guest calls never dispatch a second operation", async t => {
  const { host, calls } = makeHost(t);
  const result = await host.runCode({ code: `await Promise.all([desk.act(${JSON.stringify(write)}), desk.act(${JSON.stringify(write)})]);` });
  assert.equal(result.code, "concurrent_tool_call");
  assert.ok(calls.length <= 1);
});

test("unawaited actions stop and guest errors keep earlier receipts", async t => {
  const { host } = makeHost(t);
  const error = await host.runCode({ code: `await desk.act(${JSON.stringify(write)}); throw new Error("unneeded detail");` });
  assert.equal(error.code, "code_error");
  assert.deepEqual(error.actions, [{ call: 1, ...verified }]);
  assert.equal(JSON.stringify(error).includes("unneeded detail"), false);
  const unawaited = await host.runCode({ code: `void desk.act(${JSON.stringify(write)});` });
  assert.equal(unawaited.status, "stopped");
  assert.equal(unawaited.code, "unawaited_tool_call");
});

test("cancellation conserves receipts and keeps the host busy until an in-flight act settles", async t => {
  const entered = Promise.withResolvers();
  const settleAct = Promise.withResolvers();
  const { host, calls } = makeHost(t, { act(_input, signal) {
    if (calls.length === 1) return verified;
    entered.resolve(signal);
    return settleAct.promise;
  } });
  const cancellation = new AbortController();
  const run = host.runCode({ code: `for (let i = 0; i < 3; i++) await desk.act(${JSON.stringify(write)});` }, cancellation.signal);
  try {
    const dispatchSignal = await Promise.race([entered.promise, run.then(result => { throw new Error(JSON.stringify(result)); })]);
    cancellation.abort("test_cancelled");
    const result = await run;
    assert.equal(result.code, "cancelled");
    assert.equal(dispatchSignal.aborted, true);
    assert.deepEqual(result.actions, [
      { call: 1, ...verified }, { call: 2, status: "unknown", code: "act_result_unconfirmed", steps: [] },
    ]);
    assert.equal((await host.runCode({ code: `inspect("blocked")` })).code, "code_mode_busy");
    await assert.rejects(host.tools[0].invoke({}), /code_mode_busy/u);
    assert.equal(calls.length, 2);
  } finally { settleAct.resolve(verified); }
});

test("MCP and LangChain expose the opted-in endpoint with the same receipt", async t => {
  const { host } = makeHost(t);
  const server = createDeskMcpServer(host.tools);
  const client = new Client({ name: "code-mode-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["observe", "act", "run_code"]);
  const code = `await desk.act(${JSON.stringify(write)}); inspect(42);`;
  const mcp = await client.callTool({ name: "run_code", arguments: { code } });
  const langchainTool = createLangChainTools(host.tools).find(tool => tool.name === "run_code");
  const langchain = await langchainTool.invoke({ code });
  assert.deepEqual(langchain, JSON.parse(mcp.content[0].text));
  assert.deepEqual(langchain.actions, [{ call: 1, ...verified }]);
});

test("a real browser operation awaits host approval and code cannot resume itself", {
  skip: chromiumPath() ? false : "installed Chromium required",
}, async t => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const requests = [];
  const session = createDeskSession(fixture.backend, { onApprovalRequested(request) { requests.push(request); } });
  const host = createDeskCodeMode(session);
  t.after(() => host.close());
  const result = await host.runCode({ code: `
    await desk.act({ steps: [{ kind: "type", target: { name: "Title" }, text: "Draft",
      expect: { target: { name: "Title" }, valueEquals: "Draft" } }] });
    await desk.act({ steps: [{ kind: "click", target: { name: "Send message" } }] });
    inspect("sent");
  ` });
  assert.equal(result.code, "approval_required");
  assert.equal(requests.length, 1);
  assert.equal(result.actions[1].requestId, requests[0].requestId);
  assert.equal(result.actions[0].steps[0].status, "verified");
  assert.equal(result.actions[1].steps[0].status, "not_dispatched");
  assert.deepEqual(result.inspections, []);
  assert.equal(await fixture.page.locator("#title").inputValue(), "Draft");
  assert.equal(await fixture.page.locator("#sends").textContent(), "0");
  assert.equal((await host.resolveApproval(requests[0].requestId, "deny")).code, "approval_denied");
  assert.equal(await fixture.page.locator("#sends").textContent(), "0");
  assert.equal(fixture.stats.dispatches, 1);
});
