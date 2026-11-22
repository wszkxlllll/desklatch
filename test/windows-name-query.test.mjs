import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowsDesktopBackend, CuaWindowsTransport } from '../dist/backends/windows/index.js';

const targetA = { pid: 41001, hwnd: 0x100000000001n, title: 'Fixture A' };
const targetB = { pid: 41002, hwnd: 0x100000000002n, title: 'Fixture B' };

function elementsFor(target) {
  const prefix = target === targetA ? 'a' : 'b';
  return [
    { element_index: 0, depth: 0, role: 'Window', label: target.title, actions: [] },
    { element_index: 1, parent_index: 0, depth: 1, role: 'Button', label: 'Needle', enabled: true, actions: ['invoke'], element_token: `${prefix}-button` },
    { element_index: 2, parent_index: 0, depth: 1, role: 'Edit', label: prefix === 'a' ? 'needle' : 'Needle', enabled: true, editable: true, actions: ['text', 'set_value'], element_token: `${prefix}-edit` },
    { element_index: 3, parent_index: 0, depth: 1, role: 'Edit', label: 'Needle pad', enabled: true, editable: true, actions: ['text'], element_token: `${prefix}-prefix` },
  ];
}

test('Windows CUA pushes name-only discovery but retains exact local matching and target identity', async () => {
  const calls = [];
  const driver = {
    async metadata() { return { driverVersion: '0.54.0' }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async callTool(name, argumentsJson) {
      const args = JSON.parse(argumentsJson);
      calls.push({ name, args });
      if (name === 'get_window_state') {
        const target = [targetA, targetB].find(candidate => candidate.pid === args.pid
          && candidate.hwnd.toString() === String(args.window_id));
        assert.ok(target, 'CUA query must retain the enrolled HWND/PID pair');
        return {
          isError: false,
          structuredJson: JSON.stringify({
            pid: target.pid,
            window_id: target.hwnd.toString(),
            title: target.title,
            elements_complete: true,
            elements: elementsFor(target),
          }),
        };
      }
      if (name === 'set_value') {
        return { isError: false, action: { effect: 'confirmed', route: 'accessibility', delivery: { mode: 'background' } } };
      }
      return { isError: false };
    },
  };
  const transport = await CuaWindowsTransport.open(driver, 'name-only-observation-test');
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA, targetB], background: { source: 'cua-uia-0.54' } },
    transport,
    inspector: {
      async read(target) {
        return { target, visible: true, minimized: false, bounds: { x: 0, y: 0, width: 800, height: 600 } };
      },
    },
    ownedDialogInspector: { async findOwnedDialogs() { return []; } },
  });

  try {
    const broad = await backend.observe({ view: 'controls', where: { name: 'Needle' } });
    assert.equal(broad.complete, true);
    assert.deepEqual(calls.filter(call => call.name === 'get_window_state').map(({ args }) => [args.pid, String(args.window_id), args.query]), [
      [targetA.pid, targetA.hwnd.toString(), 'Needle'],
      [targetB.pid, targetB.hwnd.toString(), 'Needle'],
    ]);
    assert.equal(broad.controls.length, 4, 'same-name collisions remain visible for ambiguity handling');
    assert.deepEqual(broad.controls.map(control => control.role), ['Button', 'Edit', 'Button', 'Edit']);
    assert.equal(broad.controls.every(control => control.name.normalize('NFKC').trim().toLocaleLowerCase('en-US') === 'needle'), true);
    assert.equal(broad.controls.some(control => control.name === 'Needle pad'), false, 'CUA substring results are filtered locally');
    assert.equal(broad.controls.every(control => control.rect === undefined), true, 'name filtering does not invent geometry');

    const ambiguous = await backend.dispatch({ frame: broad, step: { kind: 'click', target: { name: 'Needle' } } });
    assert.deepEqual(ambiguous, { status: 'refused', code: 'control_ambiguous' });
    assert.equal(calls.some(call => call.name === 'click'), false);

    const scoped = await backend.observe({
      view: 'controls',
      where: { name: 'Needle', role: 'Edit', state: 'editable', within: 'Fixture A' },
    });
    assert.equal(scoped.complete, true);
    assert.equal(scoped.controls.length, 1);
    assert.equal(scoped.controls[0].name, 'needle');
    assert.equal(scoped.controls[0].windowScope, `hwnd:${targetA.pid}:${targetA.hwnd}`);
    assert.equal(scoped.controls[0].rect, undefined);
    assert.deepEqual(calls.filter(call => call.name === 'get_window_state').slice(2).map(({ args }) => args.query), [undefined, undefined]);

    const stale = await backend.dispatch({ frame: broad, step: { kind: 'setValue', target: { name: 'Needle', role: 'Edit', within: 'Fixture A' }, value: 'stale' } });
    assert.deepEqual(stale, { status: 'refused', code: 'stale_observation' });
    const targeted = await backend.dispatch({
      frame: scoped,
      step: { kind: 'setValue', target: { name: 'Needle', role: 'Edit', state: 'editable', within: 'Fixture A' }, value: 'current' },
    });
    assert.deepEqual(targeted, { status: 'dispatched' });
    const sent = calls.find(call => call.name === 'set_value');
    assert.equal(sent.args.pid, targetA.pid);
    assert.equal(sent.args.element_token, 'a-edit');
    assert.equal(sent.args.delivery_mode, 'background');
  } finally {
    await backend.close();
  }
});

test('name-only pushdown remains CUA-specific for native UIA transports', async () => {
  const target = { pid: 41003, hwnd: 0x100000000003n, title: 'Native Fixture' };
  const calls = [];
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [target], background: { source: 'native-uia-v1' } },
    transport: {
      source: 'native-uia-v1',
      async observeWindow(window, options) {
        calls.push({ window, options });
        return {
          target: window,
          title: target.title,
          complete: true,
          elements: [
            { index: '1', depth: 0, role: 'Button', label: 'Needle', actions: ['invoke'] },
            { index: '2', depth: 0, role: 'Button', label: 'Needle pad', actions: ['invoke'] },
          ],
        };
      },
      async close() {},
    },
    inspector: { async read(window) { return { target: window, visible: true, minimized: false }; } },
    ownedDialogInspector: { async findOwnedDialogs() { return []; } },
  });
  try {
    const frame = await backend.observe({ view: 'controls', where: { name: 'Needle' } });
    assert.equal(frame.complete, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.where, undefined, 'native UIA retains its existing unprojected query behavior');
    assert.deepEqual(frame.controls.map(control => control.name), ['Needle']);
  } finally {
    await backend.close();
  }
});
