import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeskSession } from '../dist/index.js';
import { createWindowsDesktopBackend } from '../dist/backends/windows/index.js';

const target = { pid: 41021, hwnd: 0x100000000021n, title: 'Grid fixture' };
const bounds = { x: 100, y: 200, width: 500, height: 300 };
const cell = { x: 140, y: 240, width: 80, height: 24 };
const point = { x: 160, y: 252 };
const editorHwnd = target.hwnd + 1n;

async function makeGridFixture({ nativeProof = true, readOnly = false, authorizeCode, commitOutcome = { status: 'dispatched' }, denyApproval = false, moveFocusOnApproval = false } = {}) {
  let phase = 0;
  let foregroundMoved = false;
  const calls = { transport: [], anchors: [], contexts: [], authorizations: [], commits: [], broughtToFront: [], cleared: [], policy: [], approvals: [] };

  const selectedItem = {
    role: 'DataItem',
    name: 'Action',
    runtimeId: 'native-cell-action',
    bounds: cell,
  };
  const anchor = {
    selectedItem,
    gridRuntimeId: 'native-grid-1',
    gridPath: ['native-root-1', 'native-grid-1'],
    row: 8,
    column: 5,
  };
  const context = window => ({
    selectedItem: { ...selectedItem, selected: true },
    editor: {
      role: 'Pane',
      runtimeId: 'native-editor-pane',
      bounds: cell,
      hwnd: window.hwnd + 1n,
      caret: { x: point.x, y: point.y, width: 1, height: 16 },
    },
    focus: {
      target: window,
      focused: true,
      pid: window.pid,
      hwnd: window.hwnd,
      runtimeId: 'native-editor-pane',
      role: 'Pane',
      bounds: cell,
    },
  });

  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(window) {
      return {
        target: window,
        title: window.title,
        bounds,
        screenshotWidth: 500,
        screenshotHeight: 300,
        screenshotOrigin: { x: bounds.x, y: bounds.y },
        complete: true,
        elements: [
          { index: '0', depth: 0, role: 'Window', label: 'Grid fixture', actions: [], rect: bounds },
          phase === 0
            ? {
              index: '1', parentIndex: '0', depth: 1, role: 'DataItem', label: 'Action',
              actions: readOnly ? ['invoke'] : ['set_value'], enabled: true, editable: !readOnly,
              runtimeId: 'native-cell-action', token: 'cell-token', rect: cell,
            }
            : {
              index: '2', parentIndex: '0', depth: 1, role: 'Pane', label: 'Editor', actions: [], enabled: true,
              runtimeId: 'native-editor-pane', token: 'editor-token', rect: cell,
            },
        ],
      };
    },
    async observeDesktopImage() {
      return { mimeType: 'image/png', dataBase64: 'AA==', width: 500, height: 300 };
    },
    async authorizeForegroundGridEnter(window, query, options) {
      calls.authorizations.push({ window, query, signal: options.signal });
      return authorizeCode;
    },
    async dispatch(step, recipient) {
      calls.transport.push({ step, recipient });
      if (step.kind === 'type') phase = 1;
      return { status: 'dispatched' };
    },
    async bringToFront(window) {
      calls.broughtToFront.push(window);
      return { status: 'dispatched' };
    },
  };
  const inspector = {
    async read(window) {
      return {
        target: window,
        visible: true,
        minimized: false,
        bounds,
        foregroundHwnd: foregroundMoved ? target.hwnd + 10n : target.hwnd,
        foregroundPid: target.pid,
      };
    },
    async readFocused(window) {
      return phase === 0
        ? { target: window, focused: false, pid: window.pid, hwnd: window.hwnd }
        : context(window).focus;
    },
    ...(nativeProof ? {
      async readGridItemAnchor(window, query) {
        calls.anchors.push({ window, query });
        return anchor;
      },
      async readGridEditContext(window, query) {
        calls.contexts.push({ window, query });
        return context(window);
      },
      async dispatchGridEnter(window, query, signal) {
        calls.commits.push({ window, query, signal });
        if (typeof commitOutcome === 'function') return commitOutcome({ window, query, signal, calls });
        if (commitOutcome === 'throw') throw Object.assign(new Error('native worker failed after send'), { code: 'native_worker_error' });
        return commitOutcome;
      },
    } : {}),
  };
  const backend = await createWindowsDesktopBackend({
    authorization: {
      targets: [target],
      allowDesktopCapture: true,
      allowForegroundInput: true,
      background: { source: 'cua-uia-0.54' },
    },
    transport,
    inspector,
  });
  const actualBackend = backend;
  const originalClear = actualBackend.clearExecutionState.bind(actualBackend);
  actualBackend.clearExecutionState = signal => {
    calls.cleared.push(signal);
    originalClear(signal);
  };
  const policy = input => {
    calls.policy.push(input);
    if (input.step.kind === 'type') return { decision: 'allow', code: 'fixture_type' };
    if (input.step.kind === 'keypress' && input.step.key === 'Enter') {
      return input.hostEvidence?.kind === 'focus_handoff'
        ? { decision: 'approve', code: 'fixture_grid_commit' }
        : { decision: 'needs_evidence', code: 'grid_proof_required' };
    }
    return { decision: 'deny', code: 'unexpected_fixture_action' };
  };
  const session = createDeskSession(actualBackend, {
    allowModelImages: true,
    policy,
    onApprovalRequested(request) {
      calls.approvals.push(request);
      if (moveFocusOnApproval) foregroundMoved = true;
      return denyApproval ? 'deny' : 'approve';
    },
  });
  return { backend: actualBackend, session, calls, transport, inspector, context, anchor, selectedItem, setPhase(value) { phase = value; } };
}

function actRequest(observationId, extraSteps = []) {
  return {
    observationId,
    steps: [
      { kind: 'type', target: { point }, text: 'ready', delivery: 'foreground' },
      { kind: 'keypress', target: { focusFromStep: 1 }, key: 'Enter' },
      ...extraSteps,
    ],
  };
}

async function observeGrid(fixture) {
  return fixture.session.observe({ view: 'both' });
}

test('one same-act foreground grid type and Enter carries readonly native proof only to host policy', async () => {
  const fixture = await makeGridFixture();
  try {
    const observed = await observeGrid(fixture);
    const forged = await fixture.session.act({
      ...actRequest(observed.observationId),
      hostEvidence: { kind: 'focus_handoff', binding: 'model-chosen' },
    });
    assert.equal(forged.status, 'rejected');
    assert.equal(fixture.calls.transport.length, 0);

    const result = await fixture.session.act(actRequest(observed.observationId));
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(result.steps.map(step => step.status), ['dispatched', 'dispatched']);
    assert.deepEqual(fixture.calls.transport.map(entry => entry.step.kind), ['type']);
    assert.equal(fixture.calls.anchors.length, 1);
    assert.equal(fixture.calls.contexts.length, 1);
    assert.equal(fixture.calls.authorizations.length, 1);
    assert.equal(fixture.calls.commits.length, 1);
    assert.equal(fixture.calls.broughtToFront.length, 0);

    const enterPolicyCalls = fixture.calls.policy.filter(input => input.step.kind === 'keypress');
    assert.equal(enterPolicyCalls.length, 2, 'policy rechecks the same private evidence before approval resumes');
    const evidence = enterPolicyCalls[0].hostEvidence;
    assert.equal(evidence.kind, 'focus_handoff');
    assert.equal(evidence.sourceStep, 1);
    assert.equal(evidence.commitStep, 2);
    assert.ok(evidence.sourceControlId);
    assert.equal(evidence.proof.sourceControlId, evidence.sourceControlId);
    assert.equal(evidence.focusControlId, enterPolicyCalls[0].target.id);
    assert.equal(evidence.windowScope, `hwnd:${target.pid}:${target.hwnd}`);
    assert.equal(evidence.proof.kind, 'windows_grid_commit');
    assert.equal(evidence.proof.selectedItem.runtimeId, evidence.proof.anchor.selectedItem.runtimeId);
    assert.equal(evidence.proof.anchor.gridPath.at(-1), evidence.proof.anchor.gridRuntimeId);
    assert.equal(evidence.proof.context.selectedItem.selected, true);
    assert.equal(Object.isFrozen(evidence), true);
    assert.equal(Object.isFrozen(evidence.proof), true);
    assert.equal(Object.isFrozen(evidence.proof.anchor.gridPath), true);

    const publicText = JSON.stringify({ result, approval: fixture.calls.approvals[0] });
    assert.equal(publicText.includes(evidence.binding), false);
    assert.equal(publicText.includes('native-grid-1'), false);
    assert.equal(publicText.includes('native-cell-action'), false);
    assert.equal(publicText.includes('windowScope'), false);
    assert.equal(fixture.calls.cleared.length, 1);
  } finally {
    await fixture.session.close();
  }
});

test('no native grid proof and read-only cells never fall back to a generic Enter/type action', async () => {
  const noProof = await makeGridFixture({ nativeProof: false });
  try {
    const observed = await observeGrid(noProof);
    const result = await noProof.session.act(actRequest(observed.observationId));
    assert.equal(result.code, 'focus_unavailable');
    assert.equal(result.steps[0].status, 'dispatched');
    assert.deepEqual(noProof.calls.transport.map(entry => entry.step.kind), ['type']);
    assert.equal(noProof.calls.commits.length, 0);
    assert.equal(noProof.calls.policy.some(input => input.step.kind === 'keypress'), false);
  } finally {
    await noProof.session.close();
  }

  const readOnly = await makeGridFixture({ readOnly: true });
  try {
    const observed = await observeGrid(readOnly);
    const result = await readOnly.session.act(actRequest(observed.observationId));
    assert.equal(result.status, 'stopped');
    assert.equal(readOnly.calls.transport.length, 0);
    assert.equal(readOnly.calls.policy.length, 0);
  } finally {
    await readOnly.session.close();
  }
});

test('approval denial clears the same-signal one-shot binding after preserving the dispatched type', async () => {
  const fixture = await makeGridFixture({ denyApproval: true });
  try {
    const observed = await observeGrid(fixture);
    const result = await fixture.session.act(actRequest(observed.observationId));
    assert.equal(result.code, 'approval_denied');
    assert.equal(result.steps[0].status, 'dispatched');
    assert.equal(fixture.calls.commits.length, 0);
    assert.deepEqual(fixture.calls.transport.map(entry => entry.step.kind), ['type']);
    assert.equal(fixture.calls.cleared.length, 1);

    const evidence = fixture.calls.policy.find(input => input.step.kind === 'keypress').hostEvidence;
    const frame = await fixture.backend.observe({ view: 'controls' });
    const focused = frame.controls.find(control => control.states.includes('focused'));
    assert.ok(focused);
    const attemptedReuse = await fixture.backend.dispatch({
      frame,
      target: focused,
      focusBinding: evidence.binding,
      signal: fixture.calls.policy.find(input => input.step.kind === 'keypress').signal,
      step: { kind: 'keypress', target: { focusFromStep: 1 }, key: 'Enter' },
    });
    assert.deepEqual(attemptedReuse, { status: 'refused', code: 'grid_commit_proof_expired' });
    assert.equal(fixture.calls.commits.length, 0);
  } finally {
    await fixture.session.close();
  }
});

test('refusal, unsafe worker error, and partial delivery never replay the type or use CUA Enter', async () => {
  const cases = [
    { name: 'host refusal', authorizeCode: 'application_automation_blocked', status: 'not_dispatched', commitCalls: 0 },
    { name: 'explicit native refusal', commitOutcome: { status: 'refused', code: 'native_grid_stale' }, status: 'not_dispatched', commitCalls: 1 },
    { name: 'unsafe worker error', commitOutcome: 'throw', status: 'unknown', commitCalls: 1 },
    { name: 'partial native delivery', commitOutcome: { status: 'partial', code: 'native_grid_partial' }, status: 'partial', commitCalls: 1 },
  ];
  for (const item of cases) {
    const fixture = await makeGridFixture(item);
    try {
      const observed = await observeGrid(fixture);
      const result = await fixture.session.act(actRequest(observed.observationId));
      assert.equal(result.steps[0].status, 'dispatched', item.name);
      assert.equal(result.steps[1].status, item.status, item.name);
      assert.deepEqual(fixture.calls.transport.map(entry => entry.step.kind), ['type'], item.name);
      assert.equal(fixture.calls.commits.length, item.commitCalls, item.name);
      assert.equal(fixture.calls.broughtToFront.length, 0, item.name);
    } finally {
      await fixture.session.close();
    }
  }
});

test('a modal foreground change after approval refuses grid Enter without bringing the app back', async () => {
  const fixture = await makeGridFixture({ moveFocusOnApproval: true });
  try {
    const observed = await observeGrid(fixture);
    const result = await fixture.session.act(actRequest(observed.observationId));
    assert.equal(result.code, 'grid_commit_foreground_changed');
    assert.equal(result.steps[0].status, 'dispatched');
    assert.equal(result.steps[1].status, 'not_dispatched');
    assert.equal(fixture.calls.broughtToFront.length, 0);
    assert.equal(fixture.calls.commits.length, 0);
    assert.deepEqual(fixture.calls.transport.map(entry => entry.step.kind), ['type']);
  } finally {
    await fixture.session.close();
  }
});

test('a private grid focus binding is consumed once for its same-batch Enter', async () => {
  const fixture = await makeGridFixture();
  try {
    const observed = await observeGrid(fixture);
    const result = await fixture.session.act(actRequest(observed.observationId, [
      { kind: 'keypress', target: { focusFromStep: 1 }, key: 'Enter' },
    ]));
    assert.equal(result.code, 'focus_unavailable');
    assert.deepEqual(result.steps.map(step => step.status), ['dispatched', 'dispatched', 'not_dispatched']);
    assert.equal(fixture.calls.commits.length, 1);
    assert.deepEqual(fixture.calls.transport.map(entry => entry.step.kind), ['type']);
  } finally {
    await fixture.session.close();
  }
});

test('cancellation during native grid commit is unknown and clears its private binding', async () => {
  let signalAtCommit;
  let enteredCommit;
  const entered = new Promise(resolve => { enteredCommit = resolve; });
  const fixture = await makeGridFixture({
    commitOutcome: ({ signal }) => {
      signalAtCommit = signal;
      enteredCommit();
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('worker interrupted after possible send'), { code: 'worker_cancelled' }));
      }, { once: true }));
    },
  });
  const controller = new AbortController();
  try {
    const observed = await observeGrid(fixture);
    const run = fixture.session.act(actRequest(observed.observationId), controller.signal);
    await entered;
    controller.abort('cancelled');
    const result = await run;
    assert.equal(result.steps[0].status, 'dispatched');
    assert.equal(result.steps[1].status, 'unknown');
    assert.equal(fixture.calls.commits.length, 1);
    assert.equal(fixture.calls.transport.filter(entry => entry.step.kind === 'type').length, 1);
    assert.equal(fixture.calls.transport.some(entry => entry.step.kind === 'keypress'), false);
    assert.equal(signalAtCommit.aborted, true);
    assert.equal(fixture.calls.cleared.some(signal => signal === signalAtCommit), true);
  } finally {
    await fixture.session.close();
  }
});
