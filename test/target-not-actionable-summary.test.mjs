import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeskSession } from '../dist/session.js';

const capabilities = [
  { kind: 'click', targets: ['ref', 'selector', 'point'], buttons: ['left'], counts: [1] },
  { kind: 'type', targets: ['ref', 'selector'] },
  { kind: 'keypress', targets: ['ref', 'selector', 'point'], keys: ['Enter'] },
];

function cell(overrides = {}) {
  return {
    id: 'backend-cell-id',
    role: 'DataItem',
    name: 'B4',
    within: 'worksheet',
    windowScope: 'hwnd:41001:10001',
    states: ['visible', 'enabled', 'editable'],
    actions: ['click', 'type'],
    rect: { x: 20, y: 30, width: 80, height: 24 },
    effect: 'unknown',
    ...overrides,
  };
}

function makeBackend({ control = cell(), complete = true, image = undefined, hitTest = undefined } = {}) {
  const calls = { observe: [], dispatch: [] };
  return {
    calls,
    capabilities,
    ...(hitTest ? { hitTest } : {}),
    async observe(options) {
      calls.observe.push(options);
      return { scope: 'authorized-observation-scope', complete, controls: [control], ...(image ? { image } : {}) };
    },
    async dispatch(request) {
      calls.dispatch.push(request);
      return { status: 'dispatched' };
    },
    async close() {},
  };
}

test('unsupported action on a published non-sensitive ref returns its existing authorized actions', async t => {
  const backend = makeBackend();
  const session = createDeskSession(backend, { policy: () => ({ decision: 'allow', code: 'test' }) });
  t.after(() => session.close());

  const observation = await session.observe({ view: 'controls' });
  const published = observation.controls[0];
  const result = await session.act({
    observationId: observation.observationId,
    steps: [{ kind: 'keypress', target: { ref: published.ref }, key: 'Enter' }],
  });

  assert.equal(result.status, 'stopped');
  assert.equal(result.code, 'target_not_actionable');
  assert.equal(backend.calls.dispatch.length, 0);
  assert.equal(result.candidates?.length, 1);
  assert.deepEqual(result.candidates[0].actions, ['click', 'type']);
  assert.equal(result.candidates[0].ref, published.ref, 'the response reuses the published ref');
  assert.equal(result.candidates[0].observationId, observation.observationId);
});

test('unsupported action on a unique complete exact selector returns actions without issuing a ref', async t => {
  const backend = makeBackend();
  const session = createDeskSession(backend, { policy: () => ({ decision: 'allow', code: 'test' }) });
  t.after(() => session.close());

  const result = await session.act({
    steps: [{ kind: 'keypress', target: { role: 'DataItem', name: 'B4', within: 'worksheet' }, key: 'Enter' }],
  });

  assert.equal(result.status, 'stopped');
  assert.equal(result.code, 'target_not_actionable');
  assert.equal(backend.calls.dispatch.length, 0);
  assert.equal(result.candidates?.length, 1);
  assert.deepEqual(result.candidates[0].actions, ['click', 'type']);
  assert.equal(result.candidates[0].ref, undefined);
  assert.equal(result.candidates[0].observationId, undefined);
});

test('target_not_actionable exposes no candidate summary for sensitive, incomplete, or coordinate targets', async t => {
  const sensitiveBackend = makeBackend({ control: cell({ name: 'Password', sensitive: true }) });
  const sensitiveSession = createDeskSession(sensitiveBackend, { policy: () => ({ decision: 'allow', code: 'test' }) });
  t.after(() => sensitiveSession.close());
  const sensitiveObservation = await sensitiveSession.observe({ view: 'controls' });
  const sensitive = await sensitiveSession.act({
    observationId: sensitiveObservation.observationId,
    steps: [{ kind: 'keypress', target: { ref: sensitiveObservation.controls[0].ref }, key: 'Enter' }],
  });
  assert.equal(sensitive.code, 'target_not_actionable');
  assert.equal(sensitive.candidates, undefined);

  const incompleteBackend = makeBackend({ complete: false });
  const incompleteSession = createDeskSession(incompleteBackend, { policy: () => ({ decision: 'allow', code: 'test' }) });
  t.after(() => incompleteSession.close());
  const incompleteObservation = await incompleteSession.observe({ view: 'controls' });
  const incomplete = await incompleteSession.act({
    observationId: incompleteObservation.observationId,
    steps: [{ kind: 'keypress', target: { ref: incompleteObservation.controls[0].ref }, key: 'Enter' }],
  });
  assert.equal(incomplete.code, 'target_not_actionable');
  assert.equal(incomplete.candidates, undefined);

  const image = { mimeType: 'image/png', dataBase64: 'fixture', width: 120, height: 100 };
  const pointBackend = makeBackend({
    control: cell({ actions: ['type'] }),
    image,
    hitTest: async (_frame, point) => point.x === 40 && point.y === 40 ? cell({ actions: ['type'] }) : undefined,
  });
  const pointSession = createDeskSession(pointBackend, { allowModelImages: true, policy: () => ({ decision: 'allow', code: 'test' }) });
  t.after(() => pointSession.close());
  const pointObservation = await pointSession.observe({ view: 'both' });
  const point = await pointSession.act({
    observationId: pointObservation.observationId,
    steps: [{ kind: 'click', target: { point: { x: 40, y: 40 } }, button: 'left', count: 1 }],
  });
  assert.equal(point.code, 'target_not_actionable');
  assert.equal(point.candidates, undefined);
});
