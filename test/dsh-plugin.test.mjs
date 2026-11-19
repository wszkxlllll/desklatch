import assert from "node:assert/strict";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as nativeExecutor from "@deepseek-ai/dsh-tool-executor-native";
import { executeModelToolFixture } from "@deepseek-ai/dsh-tool-testkit";
import { ToolsService } from "@deepseek-ai/dsh-tools";

import { createDeskSession } from "desklatch";
import { createDeskDshPlugin } from "desklatch/dsh";

async function createDshContext() {
  const ctx = new Context();
  const prompt = ctx.plugin(SystemPrompt, { includeRuntimeContext: false });
  await prompt.await();
  const tools = ctx.plugin(ToolsService);
  await tools.await();
  const executor = ctx.plugin(nativeExecutor);
  await executor.await();
  return { ctx, prompt, tools, executor };
}

function fixtureSession({ capabilities = [{ kind: "click", targets: ["selector"] }] } = {}) {
  const calls = [];
  let closes = 0;
  const session = {
    capabilities,
    allowModelImages: true,
    limits: { maxSteps: 4, maxTextLength: 1000, maxScrollAmount: 10 },
    async observe(input) {
      calls.push({ kind: "observe", input });
      return {
        observationId: "fixture-observation",
        view: input.view ?? "controls",
        complete: true,
        controls: [],
        image: { mimeType: "image/png", dataBase64: "AQID", width: 1, height: 1 },
      };
    },
    async act(input, signal) {
      calls.push({ kind: "act", input, signal });
      return { status: "completed", steps: [] };
    },
    async close() {
      closes += 1;
    },
  };
  return { session, calls, get closes() { return closes; } };
}

test("native Cordis plugin registers exact capability-filtered names and executes in process", async () => {
  const fixture = fixtureSession();
  const runtime = await createDshContext();
  const fiber = runtime.ctx.plugin(createDeskDshPlugin(async () => fixture.session));
  await fiber.await();

  try {
    const observe = runtime.ctx.tools.get("desklatch_observe");
    const act = runtime.ctx.tools.get("desklatch_act");
    assert.equal(observe?.name, "desklatch_observe");
    assert.equal(act?.name, "desklatch_act");
    assert.equal(runtime.ctx.tools.get("observe"), undefined);
    assert.equal(runtime.ctx.tools.get("approve"), undefined);
    assert.equal(runtime.ctx.tools.get("resolveApproval"), undefined);

    const signal = new AbortController().signal;
    const directObserved = await observe.execute({ view: "both" }, { signal });
    assert.deepEqual(directObserved.content.map((block) => block.type), ["text", "image"]);
    const observed = await executeModelToolFixture(runtime.ctx, {
      callId: "dsh-observe",
      name: "desklatch_observe",
      arguments: { view: "both" },
      signal,
    });
    assert.equal(JSON.stringify(observed.content).includes("AQID"), false);

    const acted = await executeModelToolFixture(runtime.ctx, {
      callId: "dsh-act",
      name: "desklatch_act",
      arguments: { steps: [{ kind: "click", target: { name: "Continue" } }] },
      signal,
    });
    assert.equal(acted.content[0].type, "text");
    assert.equal(fixture.calls.at(-1).kind, "act");
    assert.equal(fixture.calls.at(-1).signal, signal);
  } finally {
    await fiber.dispose();
    assert.equal(runtime.ctx.tools.get("desklatch_observe"), undefined);
    assert.equal(runtime.ctx.tools.get("desklatch_act"), undefined);
    await runtime.executor.dispose();
    await runtime.tools.dispose();
    await runtime.prompt.dispose();
  }
  assert.equal(fixture.closes, 1);
});

test("read-only host capabilities register observe only", async () => {
  const fixture = fixtureSession({ capabilities: [] });
  const runtime = await createDshContext();
  const fiber = runtime.ctx.plugin(createDeskDshPlugin(async () => fixture.session));
  await fiber.await();
  try {
    assert.ok(runtime.ctx.tools.get("desklatch_observe"));
    assert.equal(runtime.ctx.tools.get("desklatch_act"), undefined);
  } finally {
    await fiber.dispose();
    await runtime.executor.dispose();
    await runtime.tools.dispose();
    await runtime.prompt.dispose();
  }
  assert.equal(fixture.closes, 1);
});

test("failed activation leaves no tools and late activation closes exactly once", async () => {
  const failed = await createDshContext();
  const failedFiber = failed.ctx.plugin(createDeskDshPlugin(async () => {
    throw new Error("host_open_failed");
  }));
  await assert.rejects(failedFiber.await(), /host_open_failed/);
  assert.equal(failed.ctx.tools.get("desklatch_observe"), undefined);
  await failedFiber.dispose();
  await failed.executor.dispose();
  await failed.tools.dispose();
  await failed.prompt.dispose();

  const fixture = fixtureSession();
  const late = await createDshContext();
  let release;
  let resolveOpenStarted;
  const openStarted = new Promise((resolve) => { resolveOpenStarted = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const lateFiber = late.ctx.plugin(createDeskDshPlugin(async () => {
    resolveOpenStarted();
    return pending;
  }));
  await openStarted;
  const disposing = lateFiber.dispose();
  release(fixture.session);
  await disposing;
  assert.equal(fixture.closes, 1);
  assert.equal(late.ctx.tools.get("desklatch_observe"), undefined);
  await late.tools.dispose();
  await late.executor.dispose();
  await late.prompt.dispose();
});

test("a collision during native plugin activation rolls back its first tool and preserves the existing registration", async () => {
  const runtime = await createDshContext();
  const reserved = { name: "desklatch_act", description: "Reserved by host", parameters: { type: "object", properties: {} },
    output: { schema: { type: "object", properties: {} }, render: () => [] }, execute: async () => ({}) };
  const other = runtime.ctx.plugin({ inject: ["tools"], apply(ctx) { ctx.tools.register(reserved); } });
  await other.await();
  const fixture = fixtureSession();
  const fiber = runtime.ctx.plugin(createDeskDshPlugin(() => fixture.session));
  try {
    await assert.rejects(fiber.await());
    await fiber.dispose();
    assert.equal(runtime.ctx.tools.get("desklatch_observe"), undefined);
    assert.equal(runtime.ctx.tools.get("desklatch_act"), reserved);
    assert.equal(fixture.closes, 1);
  } finally {
    await other.dispose();
    await runtime.executor.dispose();
    await runtime.tools.dispose();
    await runtime.prompt.dispose();
  }
});

test("native DSH plugin writes and reads an isolated Chromium fixture", async (t) => {
  if (Number(process.versions.node.split(".")[0]) < 20) {
    t.skip("Node 20+ required by Playwright");
    return;
  }
  const { chromiumPath, createFixture } = await import("../examples/support/fixture.mjs");
  if (!chromiumPath()) {
    t.skip("installed Chromium required");
    return;
  }
  const fixture = await createFixture();
  const session = createDeskSession(fixture.backend);
  const runtime = await createDshContext();
  const fiber = runtime.ctx.plugin(createDeskDshPlugin(async () => session));
  await fiber.await();
  try {
    const act = runtime.ctx.tools.get("desklatch_act");
    const observe = runtime.ctx.tools.get("desklatch_observe");
    assert.ok(act && observe);
    const signal = new AbortController().signal;
    const edited = await executeModelToolFixture(runtime.ctx, {
      callId: "dsh-real-act",
      name: "desklatch_act",
      arguments: { steps: [{ kind: "type", target: { name: "Title" }, text: "Native DSH",
        expect: { target: { name: "Title" }, valueEquals: "Native DSH" } }] },
      signal,
    });
    assert.equal(JSON.parse(edited.content[0].text).steps[0].status, "verified");
    assert.equal(await fixture.page.locator("#title").inputValue(), "Native DSH");
    const result = await executeModelToolFixture(runtime.ctx, {
      callId: "dsh-real-observe",
      name: "desklatch_observe",
      arguments: { view: "controls" },
      signal,
    });
    assert.match(result.content[0].text, /Title/u);
    const stopped = await executeModelToolFixture(runtime.ctx, {
      callId: "dsh-confirm", name: "desklatch_act",
      arguments: { steps: [{ kind: "click", target: { name: "Send message" } }] }, signal,
    });
    const approval = JSON.parse(stopped.content[0].text);
    assert.equal(approval.code, "approval_required");
    assert.equal(runtime.ctx.tools.get("desklatch_resolveApproval"), undefined);
    await session.resolveApproval(approval.requestId, "deny");
    assert.equal(await fixture.page.locator("#sends").textContent(), "0");
  } finally {
    await fiber.dispose();
    await runtime.executor.dispose();
    await runtime.tools.dispose();
    await runtime.prompt.dispose();
    await fixture.close();
  }
});
