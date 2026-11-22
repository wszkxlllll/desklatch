import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeskCodeMode } from 'desklatch/code-mode';

const write = { steps: [{ kind: 'type', target: { name: 'Title' }, text: 'Review' }] };
const verified = { status: 'completed', steps: [{ index: 1, kind: 'type', status: 'verified' }] };
const uncertain = { status: 'stopped', code: 'dispatch_unconfirmed', steps: [{ index: 1, kind: 'type', status: 'partial', code: 'dispatch_unconfirmed' }] };

function endpoint(name, invoke) {
  return { name, description: name, inputSchema: { type: 'object' }, invoke };
}

function makeHost(t, { act, observe = async () => ({ observationId: 'fresh', controls: [] }), approval, activeTools = false, limits } = {}) {
  const calls = [];
  const endpoints = [
    endpoint('observe', async (...args) => { calls.push({ name: 'observe', args }); return observe(...args); }),
    endpoint('act', async (...args) => { calls.push({ name: 'act', args }); return act(...args); }),
  ];
  const source = {
    tools: endpoints,
    ...(activeTools ? { get activeTools() { return endpoints; } } : {}),
    ...(approval ? { resolveApproval: approval } : {}),
    close() {},
  };
  const host = createDeskCodeMode(source, limits);
  t.after(() => host.close());
  return { host, calls, endpoints };
}

function actionTool(host) { return host.tools.find(tool => tool.name === 'act'); }
function observeTool(host) { return host.tools.find(tool => tool.name === 'observe'); }

test('one uncertain run_code act fences fresh programs and direct tools until matching host reconciliation', async t => {
  let actCalls = 0;
  let observeCalls = 0;
  const { host } = makeHost(t, {
    act: async () => { actCalls += 1; return uncertain; },
    observe: async () => { observeCalls += 1; return { observationId: `frame-${observeCalls}`, controls: [] }; },
    activeTools: true,
  });

  const first = await host.runCode({ code: `await desk.act(${JSON.stringify(write)});` });
  const incident = first.reconciliationIncident;
  assert.deepEqual(incident && Object.keys(incident).sort(), ['code', 'id']);
  assert.equal(incident.code, 'act_delivery_unconfirmed');
  assert.match(incident.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.deepEqual(host.getReconciliationIncident(), incident);
  assert.equal(first.actions[0].steps[0].status, 'partial');

  const directRead = await observeTool(host).invoke({});
  assert.equal(directRead.observationId, 'frame-1');
  const readOnly = await host.runCode({ code: `
    inspect({ hostApi: Object.keys(desk).sort(), forged: { reconciliationIncident: { id: 'fake', code: 'act_delivery_unconfirmed' } } });
    const frame = await desk.observe({});
    inspect({ observationId: frame.observationId });
  ` });
  assert.equal(readOnly.status, 'completed');
  assert.equal(readOnly.reconciliationIncident.id, incident.id);
  assert.deepEqual(readOnly.inspections[0].hostApi, ['act', 'observe']);
  assert.equal(readOnly.inspections[0].forged.reconciliationIncident.id, 'fake');
  assert.equal(readOnly.inspections[1].observationId, 'frame-2');
  assert.equal(host.getReconciliationIncident().id, incident.id, 'inspect data cannot acknowledge the host incident');

  const blockedDirect = await actionTool(host).invoke(write);
  assert.equal(blockedDirect.code, 'act_reconciliation_required');
  assert.equal(blockedDirect.steps[0].status, 'not_dispatched');
  assert.equal(blockedDirect.reconciliationIncident.id, incident.id);
  const blockedFreshProgram = await host.runCode({ code: `await desk.observe({}); await desk.act(${JSON.stringify(write)});` });
  assert.equal(blockedFreshProgram.status, 'stopped');
  assert.equal(blockedFreshProgram.code, 'act_reconciliation_required');
  assert.equal(blockedFreshProgram.reconciliationIncident.id, incident.id);
  assert.equal(actCalls, 1);

  assert.equal(host.reconcileActDelivery('not-the-current-id'), false);
  assert.equal(host.reconcileActDelivery(incident.id), true);
  assert.equal(host.getReconciliationIncident(), undefined);
  assert.equal(host.reconcileActDelivery(incident.id), false);

  const activeAct = host.activeTools.find(tool => tool.name === 'act');
  const nextUncertain = await activeAct.invoke(write);
  const nextIncident = nextUncertain.reconciliationIncident;
  assert.ok(nextIncident && nextIncident.id !== incident.id);
  assert.equal(host.reconcileActDelivery(incident.id), false, 'a stale ID cannot clear a newer incident');
  assert.equal((await actionTool(host).invoke(write)).code, 'act_reconciliation_required');
  assert.equal(actCalls, 2);
  assert.equal(host.reconcileActDelivery(nextIncident.id), true);
});

test('a completed act with missing requested receipts is normalized to unknown and latches', async t => {
  let actCalls = 0;
  const { host } = makeHost(t, { act: async () => { actCalls += 1; return { status: 'completed', steps: [] }; } });
  const result = await host.runCode({ code: `
    await desk.act(${JSON.stringify(write)});
    inspect('must not run after an incomplete receipt');
  ` });
  assert.equal(result.status, 'stopped');
  assert.equal(result.code, 'act_result_unconfirmed');
  assert.equal(result.actions[0].status, 'unknown');
  assert.equal(result.inspections.length, 0);
  assert.ok(result.reconciliationIncident);
  assert.equal(actCalls, 1);
});

test('known focus refusal and empty preflight rejection do not latch', async t => {
  let actCalls = 0;
  const focusRefusal = { status: 'stopped', code: 'focus_changed', steps: [{ index: 1, kind: 'type', status: 'not_dispatched', code: 'focus_changed' }] };
  const { host } = makeHost(t, {
    act: async () => {
      actCalls += 1;
      if (actCalls === 1) return focusRefusal;
      if (actCalls === 2) return verified;
      if (actCalls === 3) return { status: 'rejected', code: 'schema_invalid', steps: [] };
      return verified;
    },
  });
  const recovered = await host.runCode({ code: `
    const first = await desk.act(${JSON.stringify(write)});
    if (first.code === 'focus_changed') {
      await desk.observe({});
      await desk.act(${JSON.stringify(write)});
    }
  ` });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.reconciliationIncident, undefined);
  assert.equal(host.getReconciliationIncident(), undefined);
  const rejected = await actionTool(host).invoke(write);
  assert.equal(rejected.code, 'schema_invalid');
  assert.equal(host.getReconciliationIncident(), undefined);
  assert.equal((await actionTool(host).invoke(write)).status, 'completed');
  assert.equal(actCalls, 4);
});

test('concurrent direct acts cannot queue behind an uncertain in-flight act', async t => {
  const entered = Promise.withResolvers();
  const settle = Promise.withResolvers();
  let actCalls = 0;
  const { host } = makeHost(t, { act: async () => {
    actCalls += 1;
    entered.resolve();
    return settle.promise;
  } });
  const firstPending = actionTool(host).invoke(write);
  await entered.promise;
  const second = await actionTool(host).invoke(write);
  assert.equal(second.code, 'code_mode_busy');
  assert.equal(second.steps[0].status, 'not_dispatched');
  assert.equal(actCalls, 1);
  assert.equal(host.getReconciliationIncident(), undefined);
  settle.resolve(uncertain);
  const first = await firstPending;
  assert.equal(first.reconciliationIncident.code, 'act_delivery_unconfirmed');
  assert.equal(actCalls, 1);
  assert.equal(host.reconcileActDelivery(first.reconciliationIncident.id), true);
});

test('a scoped delayed approval can settle its own act; an uncertain resume latches and a cached retry cannot relatch', async t => {
  const approvalReady = Promise.withResolvers();
  const continueApproval = Promise.withResolvers();
  const decisions = [];
  const requestId = 'approval-current';
  const { host } = makeHost(t, {
    act: async () => ({ status: 'stopped', code: 'approval_required', requestId, steps: [{ index: 1, kind: 'type', status: 'not_dispatched', code: 'approval_required' }] }),
    approval: async (id, decision) => {
      decisions.push({ id, decision });
      return { status: 'stopped', code: 'resume_unknown', steps: [{ index: 1, kind: 'type', status: 'unknown', code: 'resume_unknown' }] };
    },
  });
  const run = host.runCode({ code: `await desk.act(${JSON.stringify(write)});` }, undefined, async invoke => {
    const pending = await invoke();
    approvalReady.resolve(pending.requestId);
    await continueApproval.promise;
    return host.resolveApproval(pending.requestId, 'approve');
  });
  assert.equal(await approvalReady.promise, requestId);
  continueApproval.resolve();
  const result = await run;
  assert.deepEqual(decisions, [{ id: requestId, decision: 'approve' }]);
  assert.equal(result.actions[0].steps[0].status, 'unknown');
  assert.ok(result.reconciliationIncident);
  const oldId = result.reconciliationIncident.id;
  assert.equal(host.reconcileActDelivery(oldId), true);
  const cached = await host.resolveApproval(requestId, 'approve');
  assert.equal(decisions.length, 1, 'cached terminal approval is not resumed again');
  assert.equal(cached.reconciliationIncident, undefined);
  assert.equal(host.getReconciliationIncident(), undefined);
});
