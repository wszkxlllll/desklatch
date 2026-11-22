import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeskCodeMode } from "desklatch/code-mode";

const verified = { status: "completed", steps: [{ index: 1, kind: "type", status: "verified" }] };

function makeHost(t, onEvaluation) {
  const source = {
    tools: ["observe", "act"].map(name => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      async invoke() { return name === "observe" ? { controls: [] } : verified; },
    })),
    close() {},
  };
  const host = createDeskCodeMode(source, { onEvaluation });
  t.after(() => host.close());
  return host;
}

test("control-flow evaluation records actual branch and loop counters privately", async t => {
  const evaluations = [];
  const host = makeHost(t, evaluation => evaluations.push(evaluation));
  const code = `
    let sum = 0;
    for (const value of [1, 2, 3]) {
      if (value % 2 === 0) sum += value;
    }
    let index = 0;
    while (index < 2) { index += 1; }
    const label = sum > 0 ? "hit" : "miss";
    inspect({ sum, index, label });
  `;
  const result = await host.runCode({ code });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.inspections, [{ sum: 2, index: 2, label: "hit" }]);
  assert.equal(Object.hasOwn(result, "controlFlow"), false);
  assert.equal(evaluations.length, 1);
  const evidence = evaluations[0];
  assert.equal(evidence.source.code, code);
  assert.equal(evidence.source.language, "javascript");
  assert.equal(evidence.controlFlow.status, "instrumented");
  assert.equal(evidence.controlFlow.fixedWrapper, false);

  const forOf = evidence.controlFlow.loops.find(loop => loop.kind === "for_of");
  const whileLoop = evidence.controlFlow.loops.find(loop => loop.kind === "while");
  assert.equal(forOf?.iterations, 3);
  assert.equal(whileLoop?.iterations, 2);
  const ifBranch = evidence.controlFlow.branches.find(branch => branch.kind === "if");
  const conditional = evidence.controlFlow.branches.find(branch => branch.kind === "conditional");
  const whileCondition = evidence.controlFlow.branches.find(branch => branch.kind === "loop_condition" && branch.evaluations === 3);
  assert.deepEqual(
    { evaluations: ifBranch?.evaluations, taken: ifBranch?.taken, notTaken: ifBranch?.notTaken },
    { evaluations: 3, taken: 1, notTaken: 2 },
  );
  assert.equal(conditional?.taken, 1);
  assert.deepEqual(
    { evaluations: whileCondition?.evaluations, taken: whileCondition?.taken, notTaken: whileCondition?.notTaken },
    { evaluations: 3, taken: 2, notTaken: 1 },
  );
});

test("straight-line authored wrappers are explicitly marked fixed", async t => {
  const evaluations = [];
  const host = makeHost(t, evaluation => evaluations.push(evaluation));
  const result = await host.runCode({ code: `inspect("fixed");` });
  assert.equal(result.status, "completed");
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].controlFlow.fixedWrapper, true);
  assert.deepEqual(evaluations[0].controlFlow.branches, []);
  assert.deepEqual(evaluations[0].controlFlow.loops, []);
});

test("instrumented code keeps bootstrap bindings out of the guest", async t => {
  const evaluations = [];
  const host = makeHost(t, evaluation => evaluations.push(evaluation));
  const result = await host.runCode({ code: `
    inspect({ observe: typeof observe, act: typeof act, emit: typeof emit, source: typeof source, scope: typeof scope });
  ` });
  assert.deepEqual(result.inspections, [{ observe: "undefined", act: "undefined", emit: "undefined", source: "undefined", scope: "undefined" }]);
  assert.equal(evaluations[0].controlFlow.status, "instrumented");
});

test("arguments-dependent source falls back without changing its arity", async t => {
  const evaluations = [];
  const host = makeHost(t, evaluation => evaluations.push(evaluation));
  const result = await host.runCode({ code: `inspect(arguments.length);` });
  assert.deepEqual(result.inspections, [2]);
  assert.equal(evaluations[0].controlFlow.status, "fallback");
  assert.deepEqual(evaluations[0].controlFlow.unsupported, ["arguments_binding"]);
});

test("a pending evaluation sink keeps the host busy until it drains", async t => {
  const sink = Promise.withResolvers();
  const host = makeHost(t, () => sink.promise);
  const first = await host.runCode({ code: `inspect("first");` });
  assert.deepEqual(first.inspections, ["first"]);
  assert.equal((await host.runCode({ code: `inspect("blocked");` })).code, "code_mode_busy");
  sink.resolve();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await host.runCode({ code: `inspect("second");` })).status, "completed");
});
