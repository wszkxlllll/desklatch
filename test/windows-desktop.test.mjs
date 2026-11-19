import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeskSession } from '../dist/index.js';
import { createWindowsDesktopBackend, CuaWindowsTransport } from '../dist/backends/windows/index.js';

const targetA = { pid: 41001, hwnd: 0x100000000001n, title: 'Fixture A' };
const targetB = { pid: 41002, hwnd: 0x100000000002n, title: 'Fixture B' };

function snapshot(target, title, x, y, tokenPrefix = title) {
  return {
    target,
    title,
    bounds: { x, y, width: 420, height: 280 },
    complete: true,
    elements: [
      { index: '0', depth: 0, role: 'Window', label: title, actions: [], token: `${tokenPrefix}-window`, rect: { x, y, width: 420, height: 280 } },
      { index: '1', depth: 1, role: 'Button', label: 'Go', actions: ['invoke'], token: `${tokenPrefix}-button`, rect: { x: x + 20, y: y + 30, width: 100, height: 36 }, enabled: true },
      { index: '2', depth: 1, role: 'Edit', label: 'Name', actions: ['text', 'set_value'], token: `${tokenPrefix}-edit`, rect: { x: x + 20, y: y + 90, width: 180, height: 30 }, enabled: true },
    ],
  };
}

function fakeDesktopTransport() {
  const calls = [];
  return {
    calls,
    transport: {
      source: 'cua-uia-0.54',
      async observeWindow(target) {
        calls.push({ kind: 'observeWindow', target });
        return target.hwnd === targetA.hwnd ? snapshot(target, 'Fixture A', 20, 30, 'a') : snapshot(target, 'Fixture B', 500, 30, 'b');
      },
      async dispatch(step, target) {
        calls.push({ kind: 'dispatch', step, target });
        assert.equal(target.foreground, false);
        return { status: 'dispatched' };
      },
    },
    inspector: {
      occluder: undefined,
      async read(target, point) {
        const bounds = target.hwnd === targetA.hwnd
          ? { x: 20, y: 30, width: 420, height: 280 }
          : { x: 500, y: 30, width: 420, height: 280 };
        return { target, visible: true, minimized: false, bounds, ...(this.occluder && point ? { occludingHwnd: this.occluder } : {}) };
      },
    },
  };
}

test('controls-only full desktop observation never requests or returns an image', async () => {
  const fake = fakeDesktopTransport();
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA, targetB], version: 'fixture-1', background: { source: 'cua-uia-0.54' } },
    transport: fake.transport,
    inspector: fake.inspector,
  });
  const frame = await backend.observe({ view: 'controls' });
  assert.equal(frame.image, undefined);
  assert.equal(frame.complete, true);
  assert.equal(frame.controls.filter(control => control.name === 'Go').length, 2);
  assert.notEqual(frame.controls.find(control => control.name === 'Go')?.id, frame.controls.filter(control => control.name === 'Go')[1]?.id);
  assert.equal(fake.calls.filter(call => call.kind === 'observeDesktopImage').length, 0);
  await backend.close();
});

test('whole-desktop image capture requires a separate host grant', async () => {
  const fake = fakeDesktopTransport();
  const backend = await createWindowsDesktopBackend({ authorization: { targets: [targetA] }, transport: fake.transport, inspector: fake.inspector });
  await assert.rejects(backend.observe({ view: 'image' }), error => error?.code === 'desktop_image_not_authorized');
  assert.equal(fake.calls.some(call => call.kind === 'observeDesktopImage'), false);
  await backend.close();
});

test('background UIA delivery requires a matching host source grant', async () => {
  const fake = fakeDesktopTransport();
  const backend = await createWindowsDesktopBackend({ authorization: { targets: [targetA] }, transport: fake.transport, inspector: fake.inspector });
  assert.equal(backend.capabilities.length, 0);
  const frame = await backend.observe({ view: 'controls' });
  const editor = frame.controls.find(control => control.name === 'Name');
  const result = await backend.dispatch({ frame, step: { kind: 'type', target: { ref: editor.id }, text: 'must-refuse' } });
  assert.deepEqual(result, { status: 'refused', code: 'background_delivery_not_authorized' });
  assert.equal(fake.calls.filter(call => call.kind === 'dispatch').length, 0);
  await backend.close();
});

test('selector type and desktop point click stay in the authorized background route', async () => {
  const fake = fakeDesktopTransport();
  const backend = await createWindowsDesktopBackend({ authorization: { targets: [targetA, targetB], background: { source: 'cua-uia-0.54' } }, transport: fake.transport, inspector: fake.inspector });
  const frame = await backend.observe({ view: 'controls' });
  const type = await backend.dispatch({ frame, step: { kind: 'type', target: { role: 'Edit', name: 'Name', within: 'Fixture B' }, text: 'hello' } });
  assert.equal(type.status, 'dispatched');
  const click = await backend.dispatch({ frame, step: { kind: 'click', target: { point: { x: 60, y: 75 } } } });
  assert.equal(click.status, 'dispatched');
  const dispatches = fake.calls.filter(call => call.kind === 'dispatch');
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[0].target.window.hwnd, targetB.hwnd);
  assert.equal(dispatches[1].target.window.hwnd, targetA.hwnd);
  assert.equal(dispatches.every(call => call.target.foreground === false), true);
  await backend.close();
});

test('foreign popup occlusion is checked immediately before dispatch', async () => {
  const fake = fakeDesktopTransport();
  const backend = await createWindowsDesktopBackend({ authorization: { targets: [targetA], background: { source: 'cua-uia-0.54' } }, transport: fake.transport, inspector: fake.inspector });
  const frame = await backend.observe({ view: 'controls' });
  fake.inspector.occluder = 0x300000000003n;
  const result = await backend.dispatch({ frame, step: { kind: 'click', target: { point: { x: 60, y: 75 } } } });
  assert.deepEqual(result, { status: 'refused', code: 'target_occluded' });
  assert.equal(fake.calls.filter(call => call.kind === 'dispatch').length, 0);
  await backend.close();
});

test('foreground desktop point lane switches only after explicit host grant and recheck', async () => {
  const calls = [];
  let foreground = targetB.hwnd;
  const transport = {
    async observeWindow(target) { return snapshot(target, 'Fixture A', 20, 30, 'foreground'); },
    async bringToFront(target) { calls.push({ kind: 'bringToFront', target }); foreground = target.hwnd; return { status: 'dispatched' }; },
    async dispatch(step, target) { calls.push({ kind: 'dispatch', step, target }); return { status: 'dispatched' }; },
  };
  const inspector = {
    async read(target, point) {
      return { target, visible: true, minimized: false, bounds: { x: 20, y: 30, width: 420, height: 280 }, foregroundHwnd: foreground };
    },
  };
  const backend = await createWindowsDesktopBackend({ authorization: { targets: [targetA], allowForegroundInput: true, allowDesktopCapture: true }, transport, inspector });
  const frame = await backend.observe({ view: 'controls' });
  const result = await backend.dispatch({ frame, step: { kind: 'click', target: { point: { x: 300, y: 220 } } } });
  assert.equal(result.status, 'dispatched');
  assert.deepEqual(calls.map(call => call.kind), ['bringToFront', 'dispatch']);
  assert.equal(calls[1].target.foreground, true);
  assert.deepEqual(calls[1].target.point, { x: 300, y: 220 });
  await backend.close();
});

test('public DeskSession can dispatch a granted foreground point on a visible canvas', async () => {
  const calls = [];
  let foreground = targetB.hwnd;
  const transport = {
    async observeWindow(target) { return snapshot(target, 'Fixture A', 20, 30, 'canvas'); },
    async observeDesktopImage() { return { mimeType: 'image/png', dataBase64: 'ZmFrZQ==', width: 900, height: 500 }; },
    async bringToFront(target) { calls.push({ kind: 'bringToFront', target }); foreground = target.hwnd; return { status: 'dispatched' }; },
    async dispatch(step, target) { calls.push({ kind: 'dispatch', step, target }); return { status: 'dispatched' }; },
  };
  const inspector = {
    async read(target) { return { target, visible: true, minimized: false, bounds: { x: 20, y: 30, width: 420, height: 280 }, foregroundHwnd: foreground }; },
  };
  const backend = await createWindowsDesktopBackend({ authorization: { targets: [targetA], allowForegroundInput: true, allowDesktopCapture: true }, transport, inspector });
  const session = createDeskSession(backend, { allowModelImages: true, policy: () => ({ decision: 'allow', code: 'test' }) });
  const observation = await session.observe({ view: 'both' });
  assert.ok(session.capabilities.some(capability => capability.kind === 'click' && capability.targets.includes('point')));
  const result = await session.act({ observationId: observation.observationId, steps: [{ kind: 'click', target: { point: { x: 300, y: 220 } } }] });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(calls.map(call => call.kind), ['bringToFront', 'dispatch']);
  assert.equal(calls[1].target.foreground, true);
  await session.close();
});

test('public DeskSession switches between two host-authorized nonmaximized windows', async () => {
  const fake = fakeDesktopTransport();
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA, targetB], background: { source: 'cua-uia-0.54' } },
    transport: fake.transport,
    inspector: fake.inspector,
  });
  const session = createDeskSession(backend, { policy: () => ({ decision: 'allow', code: 'test' }) });
  const result = await session.act({ steps: [
    { kind: 'type', target: { role: 'Edit', name: 'Name', within: 'Fixture B' }, text: 'window-b' },
    { kind: 'click', target: { role: 'Button', name: 'Go', within: 'Fixture A' } },
  ] });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const dispatches = fake.calls.filter(call => call.kind === 'dispatch');
  assert.deepEqual(dispatches.map(call => call.target.window.hwnd), [targetB.hwnd, targetA.hwnd]);
  await session.close();
});

test('a stale frame cannot reuse a previously authorized control', async () => {
  const fake = fakeDesktopTransport();
  const backend = await createWindowsDesktopBackend({ authorization: { targets: [targetA], background: { source: 'cua-uia-0.54' } }, transport: fake.transport, inspector: fake.inspector });
  const first = await backend.observe({ view: 'controls' });
  const second = await backend.observe({ view: 'controls' });
  const result = await backend.dispatch({ frame: first, step: { kind: 'click', target: { ref: first.controls.find(control => control.name === 'Go').id } } });
  assert.deepEqual(result, { status: 'refused', code: 'stale_observation' });
  assert.equal(second.scope, first.scope);
  await backend.close();
});

test('CUA transport sends controls-only UIA reads and explicit background delivery', async () => {
  const calls = [];
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const driver = {
    async metadata() { return { driverVersion: '0.54.0' }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async callTool(name, json) {
      const args = JSON.parse(json, (key, value, context) => key === 'window_id' && context?.source ? BigInt(context.source) : value);
      calls.push({ name, args });
      if (name === 'get_window_state') {
        const state = snapshot(target, 'Fixture', 20, 30, 'cua');
        return { isError: false, structuredJson: JSON.stringify({
          pid: target.pid,
          window_id: target.hwnd.toString(),
          window_bounds: state.bounds,
          elements_complete: true,
          elements: state.elements.map(element => ({ element_index: Number(element.index), depth: element.depth, role: element.role, label: element.label, actions: element.actions, element_token: element.token, frame: element.rect, enabled: element.enabled })),
        }) };
      }
      return { isError: false, action: { effect: 'confirmed', route: 'accessibility', delivery: { mode: 'background' } } };
    },
  };
  const transport = await CuaWindowsTransport.open(driver, 'fixture-session');
  const observed = await transport.observeWindow(target, {});
  assert.equal(observed.complete, true);
  assert.equal(calls[0].args.include_screenshot, false);
  assert.equal(calls[0].args.include_accessibility_tree, true);
  assert.equal(String(calls[0].args.window_id), target.hwnd.toString());
  assert.equal(observed.elements.some(element => element.token === 'cua-button'), true);
  const delivery = await transport.dispatch({ kind: 'click', target: { ref: 'unused' } }, {
    window: target,
    control: { control: { id: 'unused', role: 'Button', name: 'Go', within: 'w', states: ['visible', 'enabled'], actions: ['click'], rect: { x: 40, y: 60, width: 100, height: 30 } }, token: 'cua-button', window: target, source: observed.elements[1] },
    foreground: false,
  }, {});
  assert.equal(delivery.status, 'dispatched');
  const action = calls.find(call => call.name === 'click');
  assert.equal(action.args.delivery_mode, 'background');
  assert.equal(String(action.args.target.window_id), target.hwnd.toString());
  await transport.close();
});

test('CUA transport projects an explicitly foreground desktop point into window-local pixels', async () => {
  const calls = [];
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const driver = {
    async metadata() { return { driverVersion: '0.54.0' }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async callTool(name, json) {
      calls.push({ name, args: JSON.parse(json) });
      return { isError: false, action: { effect: 'confirmed', route: 'global_input', delivery: { mode: 'foreground' } } };
    },
  };
  const transport = await CuaWindowsTransport.open(driver, 'foreground-session');
  const result = await transport.dispatch({ kind: 'click', target: { point: { x: 150, y: 250 } } }, {
    window: target,
    point: { x: 150, y: 250 },
    windowBounds: { x: 100, y: 200, width: 500, height: 300 },
    foreground: true,
  }, {});
  assert.equal(result.status, 'dispatched');
  const click = calls.find(call => call.name === 'click');
  assert.deepEqual({ x: click.args.x, y: click.args.y }, { x: 50, y: 50 });
  assert.equal(click.args.delivery_mode, 'foreground');
  assert.equal(click.args.element_token, undefined);
  await transport.close();
});

test('CUA suspected-noop receipts are never reported as dispatched', async () => {
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const driver = {
    async metadata() { return { driverVersion: '0.54.0' }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async callTool() { return { isError: false, action: { effect: 'suspected_noop', route: 'accessibility', delivery: { mode: 'background' } } }; },
  };
  const transport = await CuaWindowsTransport.open(driver, 'noop-session');
  const result = await transport.dispatch({ kind: 'click', target: { ref: 'noop' } }, {
    window: target,
    control: {
      control: { id: 'noop', role: 'Button', name: 'Noop', within: 'w', states: ['visible', 'enabled'], actions: ['click'] },
      token: 'noop-token',
      window: target,
      source: { index: '1', depth: 1, role: 'Button', label: 'Noop', actions: ['invoke'], token: 'noop-token' },
    },
    foreground: false,
  }, {});
  assert.deepEqual(result, { status: 'unknown', code: 'driver_suspected_noop' });
  await transport.close();
});
