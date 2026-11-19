import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeUiAutomationWindowsTransport } from '../dist/backends/windows/dialog-transport.js';
import { createDeskSession } from 'desklatch';
import { createWindowsDesktopBackend } from 'desklatch/windows';

const target = { pid: 41001, hwnd: 0x100000000001n, title: 'Fixture dialog' };
const editToken = 'uia1.ZWRpdA';
const buttonToken = 'uia1.YnV0dG9u';
const contextToken = `uia-material-v1.${'a'.repeat(64)}`;

function fakeWorker() {
  const requests = [];
  return {
    requests,
    worker: {
      async request(request) {
        requests.push(request);
        if (request.op === 'observe') {
          return {
            ok: true,
            pid: target.pid,
            window_id: String(target.hwnd),
            window_title: target.title,
            window_bounds: { x: 10, y: 20, width: 300, height: 200 },
            elements_complete: true,
            elements: [
              {
                element_index: '0', depth: 0, role: 'Window', label: target.title,
                actions: [], frame: { x: 10, y: 20, width: 300, height: 200 }, token: buttonToken,
              },
              {
                element_index: '1', depth: 1, role: 'Edit', label: 'File name', value: 'draft.docx',
                actions: ['set_value'], enabled: true, frame: { x: 20, y: 40, width: 180, height: 24 }, token: editToken,
                approval_context_token: contextToken,
              },
              {
                element_index: '2', depth: 1, role: 'Edit', label: 'Password', value: 'secret',
                actions: ['set_value'], enabled: true, is_password: true, frame: { x: 20, y: 80, width: 180, height: 24 }, token: 'uia1.c2Vuc2l0aXZl',
              },
            ],
          };
        }
        return { ok: true, status: 'dispatched' };
      },
    },
  };
}

test('the native dialog session exposes its real actions and invalidates consent when the destination changes', async () => {
  const fake = fakeWorker();
  let material = contextToken;
  const transport = new NativeUiAutomationWindowsTransport({ worker: {
    async request(input) {
      const result = await fake.worker.request(input);
      if (input.op === 'observe') result.elements.push({
        element_index: '3', depth: 1, role: 'Button', label: 'Replace', enabled: true,
        actions: ['invoke'], frame: { x: 40, y: 120, width: 90, height: 24 },
        token: buttonToken, approval_context_token: material,
      });
      return result;
    },
  } });
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [target], background: { source: 'native-uia-v1' } }, transport,
    inspector: { async read(window) { return { target: window, visible: true, minimized: false,
      bounds: { x: 10, y: 20, width: 300, height: 200 } }; } },
  });
  const session = createDeskSession(backend);
  try {
    assert.deepEqual(session.capabilities.map(capability => capability.kind), ['click', 'setValue']);
    const observation = await session.observe();
    assert.equal(JSON.stringify(observation).includes(contextToken), false);
    const pending = await session.act({ steps: [{ kind: 'click', target: { role: 'Button', name: 'Replace' } }] });
    assert.equal(pending.code, 'approval_required');
    material = 'uia-material-v1.' + 'b'.repeat(64);
    const resumed = await session.resolveApproval(pending.requestId, 'approve');
    assert.equal(resumed.code, 'approval_stale');
    assert.equal(fake.requests.filter(item => item.op === 'dispatch').length, 0);
  } finally { await session.close(); }
});

test('native UIA transport exposes only actual patterns and protects password controls', async () => {
  const fake = fakeWorker();
  const transport = new NativeUiAutomationWindowsTransport({ worker: fake.worker });
  await transport.open();
  const snapshot = await transport.observeWindow(target, {});
  assert.equal(snapshot.complete, true);
  const edit = snapshot.elements.find(element => element.role === 'Edit' && element.label === 'File name');
  assert.deepEqual(edit?.actions, ['set_value']);
  assert.equal(edit?.token, editToken);
  assert.equal(edit?.value, 'draft.docx');
  assert.equal(edit?.approvalContext?.token, contextToken);
  const password = snapshot.elements.find(element => element.label === undefined && element.password === true);
  assert.ok(password);
  assert.deepEqual(password.actions, []);
  assert.equal(password.token, undefined);
  assert.equal(password.value, undefined);
  await transport.close();
});

test('native UIA transport binds dispatch to the exact enrolled target and pattern', async () => {
  const fake = fakeWorker();
  const transport = new NativeUiAutomationWindowsTransport({ worker: fake.worker });
  await transport.open();
  const snapshot = await transport.observeWindow(target, {});
  const editElement = snapshot.elements.find(element => element.label === 'File name');
  const control = {
    control: {
      id: 'edit', role: 'Edit', name: 'File name', within: 'Fixture dialog',
      states: ['visible', 'enabled', 'editable'], actions: ['setValue'], value: 'draft.docx',
    },
    token: editElement.token,
    window: target,
    source: editElement,
  };
  const result = await transport.dispatch({ kind: 'setValue', target: { ref: 'edit' }, value: 'approved.docx' }, {
    window: target,
    control,
    foreground: false,
  }, {});
  assert.deepEqual(result, { status: 'dispatched' });
  assert.deepEqual(fake.requests.at(-1), {
    op: 'dispatch', pid: target.pid, hwnd: String(target.hwnd), token: editToken, action: 'setValue',
    max_elements: 512, max_depth: 32, value: 'approved.docx',
  });
  const type = await transport.dispatch({ kind: 'type', target: { ref: 'edit' }, text: 'must-not-append' }, {
    window: target,
    control,
    foreground: false,
  }, {});
  assert.deepEqual(type, { status: 'refused', code: 'native_uia_set_value_required' });
  const foreground = await transport.dispatch({ kind: 'click', target: { ref: 'edit' } }, {
    window: target,
    control: { ...control, source: { ...editElement, actions: ['invoke'] } },
    foreground: true,
  }, {});
  assert.deepEqual(foreground, { status: 'refused', code: 'native_uia_foreground_unsupported' });
  await transport.close();
});

test('native UIA dispatch reuses configured bounded observation limits', async () => {
  const fake = fakeWorker();
  const transport = new NativeUiAutomationWindowsTransport({ worker: fake.worker, maxElements: 5, maxDepth: 4 });
  await transport.open();
  const snapshot = await transport.observeWindow(target, {});
  const editElement = snapshot.elements.find(element => element.label === 'File name');
  const result = await transport.dispatch({ kind: 'setValue', target: { ref: 'edit' }, value: 'bounded.docx' }, {
    window: target,
    control: {
      control: { id: 'edit', role: 'Edit', name: 'File name', within: 'Fixture dialog', states: ['visible', 'enabled'], actions: ['setValue'] },
      token: editElement.token,
      window: target,
      source: editElement,
    },
    foreground: false,
  }, {});
  assert.deepEqual(result, { status: 'dispatched' });
  assert.equal(fake.requests.at(-1).max_elements, 5);
  assert.equal(fake.requests.at(-1).max_depth, 4);
  await transport.close();
});

test('native UIA transport preserves an incomplete bounded tree', async () => {
  const fake = fakeWorker();
  fake.worker.request = async request => {
    fake.requests.push(request);
    if (request.op === 'observe') return {
      ok: true,
      pid: target.pid,
      window_id: String(target.hwnd),
      elements_complete: false,
      elements: [{ element_index: '0', depth: 0, role: 'Window', actions: [], token: buttonToken }],
    };
    return { ok: true, status: 'dispatched' };
  };
  const transport = new NativeUiAutomationWindowsTransport({ worker: fake.worker, maxElements: 1, maxDepth: 1 });
  await transport.open();
  const snapshot = await transport.observeWindow(target, {});
  assert.equal(snapshot.complete, false);
  await transport.close();
});

test('native UIA transport refuses a changed identity without reporting delivery', async () => {
  const fake = fakeWorker();
  fake.worker.request = async request => {
    fake.requests.push(request);
    if (request.op === 'observe') return { ok: true, pid: target.pid, window_id: String(target.hwnd), elements_complete: true, elements: [] };
    return { ok: false, code: 'stale_uia_identity' };
  };
  const transport = new NativeUiAutomationWindowsTransport({ worker: fake.worker });
  await transport.open();
  const result = await transport.dispatch({ kind: 'click', target: { ref: 'button' } }, {
    window: target,
    control: {
      control: { id: 'button', role: 'Button', name: 'Save', within: 'Fixture dialog', states: ['visible', 'enabled'], actions: ['click'] },
      token: buttonToken,
      window: target,
      source: { index: '1', depth: 1, role: 'Button', actions: ['invoke'], token: buttonToken },
    },
    foreground: false,
  }, {});
  assert.deepEqual(result, { status: 'refused', code: 'stale_uia_identity' });
  await transport.close();
});

test('native UIA transport preserves unknown status after a pattern call cannot be confirmed', async () => {
  const fake = fakeWorker();
  fake.worker.request = async request => {
    fake.requests.push(request);
    if (request.op === 'observe') return {
      ok: true, pid: target.pid, window_id: String(target.hwnd), elements_complete: true,
      elements: [{ element_index: '1', depth: 1, role: 'Edit', label: 'File name', actions: ['set_value'], enabled: true, token: editToken }],
    };
    return { ok: false, status: 'unknown', code: 'native_uia_set_value_unknown' };
  };
  const transport = new NativeUiAutomationWindowsTransport({ worker: fake.worker });
  await transport.open();
  const result = await transport.dispatch({ kind: 'setValue', target: { ref: 'edit' }, value: 'possibly-issued.docx' }, {
    window: target,
    control: {
      control: { id: 'edit', role: 'Edit', name: 'File name', within: 'Fixture dialog', states: ['visible', 'enabled'], actions: ['setValue'] },
      token: editToken,
      window: target,
      source: { index: '1', depth: 1, role: 'Edit', actions: ['set_value'], token: editToken },
    },
    foreground: false,
  }, {});
  assert.deepEqual(result, { status: 'unknown', code: 'native_uia_set_value_unknown' });
  await transport.close();
});
