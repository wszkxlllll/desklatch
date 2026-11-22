import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeskCodeMode } from "desklatch/code-mode";

function makeHost(t, handlers) {
  const tools = ["observe", "act"].map(name => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    invoke(input, signal) { return handlers[name](input, signal); },
  }));
  const host = createDeskCodeMode({ tools, close() {} });
  t.after(() => host.close());
  return host;
}

test("Code Mode adds fixed hints only for uninspected read-only results and oversized observe replies", async t => {
  const handlers = {
    observe: async () => ({ controls: [{ role: "Button", name: "OK" }] }),
    act: async () => ({ status: "completed", steps: [{ index: 1, kind: "click", status: "dispatched" }] }),
  };
  const host = makeHost(t, handlers);

  const uninspected = await host.runCode({ code: `
    const value = await desk.observe({});
    return JSON.stringify(value);
  ` });
  assert.equal(uninspected.status, "completed");
  assert.deepEqual(uninspected.calls, { observe: 1, act: 0 });
  assert.deepEqual(uninspected.inspections, []);
  assert.match(uninspected.hint, /inspect\(value\).*before returning/u);

  const inspected = await host.runCode({ code: `
    const value = await desk.observe({});
    inspect(value);
  ` });
  assert.equal(inspected.status, "completed");
  assert.equal(inspected.inspections.length, 1);
  assert.equal(inspected.hint, undefined);

  handlers.observe = async () => ({ controls: [{ role: "Button", name: "x".repeat(160_000) }] });
  const oversizedObserve = await host.runCode({ code: `
    const value = await desk.observe({});
    inspect(value);
  ` });
  assert.equal(oversizedObserve.code, "tool_result_too_large");
  assert.match(oversizedObserve.hint, /narrow by an observed role\/container or exact name/u);
  assert.match(oversizedObserve.hint, /Guest-side slicing is too late/u);
  assert.doesNotMatch(oversizedObserve.hint, /x{100}/u);

  handlers.act = async () => ({
    status: "completed",
    steps: [{ index: 1, kind: "click", status: "dispatched" }],
    detail: "x".repeat(160_000),
  });
  const oversizedAct = await host.runCode({ code: `
    await desk.act({ steps: [{ kind: "click", target: { name: "Command" } }] });
  ` });
  assert.equal(oversizedAct.code, "tool_result_too_large");
  assert.equal(oversizedAct.hint, undefined);
});
