import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeskSession } from '../dist/index.js';
import { createWindowsDesktopBackend, CuaWindowsTransport, createWindowsForegroundActivator } from '../dist/backends/windows/index.js';
import { User32Inspector, nativeHotkeyScope, shouldIgnoreLayeredOccluder } from '../dist/backends/windows/native.js';

const targetA = { pid: 41001, hwnd: 0x100000000001n, title: 'Fixture A' };
const targetB = { pid: 41002, hwnd: 0x100000000002n, title: 'Fixture B' };

test('native hotkey scope keeps selection control-bound and save chords window-bound', () => {
  assert.equal(nativeHotkeyScope(['ctrl', 'a']), 'control');
  assert.equal(nativeHotkeyScope(['ctrl', 's']), 'window');
  assert.equal(nativeHotkeyScope(['ctrl', 'shift', 's']), 'window');
  assert.equal(nativeHotkeyScope(['ctrl', 'x']), undefined);
  assert.equal(nativeHotkeyScope(['ctrl', 'ctrl']), undefined);
});

function nativeHotkeyFixture({ beforeRuntime = 'runtime-1', afterRuntime = beforeRuntime, rootAfter = targetA.hwnd } = {}) {
  const calls = { sendInput: 0, focus: 0, gui: 0 };
  const guiStates = [
    { active: targetA.hwnd, focus: 0x200000000001n, root: targetA.hwnd },
    { active: targetA.hwnd, focus: 0x200000000001n, root: targetA.hwnd },
    { active: targetA.hwnd, focus: 0x200000000001n, root: rootAfter },
  ];
  let currentGuiState = guiStates[0];
  const focusWorker = {
    async request() {
      calls.focus += 1;
      return {
        pid: targetA.pid,
        window_id: targetA.hwnd.toString(),
        focused: true,
        focused_within_target: true,
        focused_runtime_id: calls.focus === 1 ? beforeRuntime : afterRuntime,
        focused_role: 'Document',
      };
    },
  };
  const api = {
    isWindow() { return 1; },
    isWindowVisible() { return 1; },
    isIconic() { return 0; },
    isWindowEnabled() { return 1; },
    getForegroundWindow() { return targetA.hwnd; },
    getWindowThreadProcessId(_hwnd, pid) { pid.writeUInt32LE(targetA.pid, 0); return 7001; },
    getWindowRect(_hwnd, rect) { rect.writeInt32LE(0, 0); rect.writeInt32LE(0, 4); rect.writeInt32LE(1200, 8); rect.writeInt32LE(900, 12); return 1; },
    getWindowLongPtr() { return 0n; },
    getWindow() { return 0n; },
    getAncestor(hwnd) {
      return hwnd === currentGuiState.focus ? currentGuiState.root : hwnd;
    },
    getGuiThreadInfo(_thread, info) {
      currentGuiState = guiStates[Math.min(calls.gui, guiStates.length - 1)];
      calls.gui += 1;
      info.writeUInt32LE(72, 0);
      info.writeUInt32LE(0, 4);
      info.writeBigUInt64LE(currentGuiState.active, 8);
      info.writeBigUInt64LE(currentGuiState.focus, 16);
      return 1;
    },
    getAsyncKeyState() { return 0; },
    sendInput(count) { calls.sendInput += 1; return count; },
    windowFromPoint() { return targetA.hwnd; },
    getSystemMetrics(index) { return index === 0 ? 1200 : 900; },
    setThreadDpiAwarenessContext() { return 1n; },
  };
  return { api, calls, inspector: new User32Inspector(api, focusWorker) };
}

test('native window-point delivery uses physical pixels without consulting UIA', async () => {
  const { api, calls, inspector } = nativeHotkeyFixture();
  const bounds = { x: 0, y: 0, width: 1200, height: 900 };
  const display = { width: 1200, height: 900 };
  const point = { x: 420, y: 270 };
  const click = { kind: 'click', target: { point } };
  const batches = [];
  let maximumQueued = 3;
  api.getClientRect = (_hwnd, rect) => {
    rect.writeInt32LE(1190, 8);
    rect.writeInt32LE(840, 12);
    return 1;
  };
  api.clientToScreen = (_hwnd, origin) => {
    origin.writeInt32LE(5, 0);
    origin.writeInt32LE(50, 4);
    return 1;
  };
  api.sendInput = (count, input) => {
    batches.push(Array.from({ length: count }, (_, i) => ({
      x: input.readInt32LE(40 * i + 8), y: input.readInt32LE(40 * i + 12),
      data: input.readInt32LE(40 * i + 16), flags: input.readUInt32LE(40 * i + 20),
    })));
    return Math.min(count, maximumQueued);
  };
  const clickResult = await inspector.dispatchWindowPoint(targetA, click, bounds, display);
  assert.deepEqual(clickResult, { status: 'dispatched', suppressFocusHandoff: true });
  assert.deepEqual(batches[0].map(event => event.flags), [0x8001, 2, 4]);
  assert.equal(Math.floor(batches[0][0].x * display.width / 65536), point.x);
  assert.equal(Math.floor(batches[0][0].y * display.height / 65536), point.y);
  assert.equal(calls.focus, 0);
  const scroll = { kind: 'scroll', target: { point }, direction: 'down', amount: 2 };
  assert.equal((await inspector.dispatchWindowPoint(targetA, scroll, bounds, display)).status, 'dispatched');
  assert.deepEqual(batches[1][1], { x: 0, y: 0, data: -240, flags: 0x0800 });

  await inspector.dispatchWindowPoint(targetA, { ...click, target: { point: { x: 100, y: 20 } } }, bounds, display);
  assert.equal(batches.length, 2, 'caption and system buttons are outside the client area');
  api.windowFromPoint = () => targetB.hwnd;
  assert.equal((await inspector.dispatchWindowPoint(targetA, click, bounds, display)).status, 'refused');
  assert.equal(batches.length, 2, 'the other window receives no input');
  api.windowFromPoint = () => targetA.hwnd;
  api.getAsyncKeyState = key => key === 0x11 ? -32768 : 0;
  assert.equal((await inspector.dispatchWindowPoint(targetA, click, bounds, display)).code, 'window_point_input_busy');
  assert.equal(batches.length, 2, 'a held Ctrl must not transform the gesture');
  api.getAsyncKeyState = () => 0;
  maximumQueued = 2;
  assert.equal((await inspector.dispatchWindowPoint(targetA, click, bounds, display)).status, 'partial');
  assert.deepEqual(batches[3].map(event => event.flags), [4], 'partial input only releases the button, it does not replay');
  await inspector.close();
});

test('native hotkey refuses before SendInput when the pre-send UIA RuntimeId changed', async () => {
  const fixture = nativeHotkeyFixture({ beforeRuntime: 'runtime-changed' });
  const result = await fixture.inspector.dispatchHotkey(targetA, ['ctrl', 's'], {
    target: targetA,
    focused: true,
    pid: targetA.pid,
    hwnd: targetA.hwnd,
    runtimeId: 'runtime-1',
  });
  assert.deepEqual(result, { status: 'refused', code: 'native_hotkey_focus_changed' });
  assert.equal(fixture.calls.sendInput, 0);
});

test('native window hotkey reports unknown when the enrolled root changes after the full batch', async () => {
  const fixture = nativeHotkeyFixture({ afterRuntime: 'editor-closed', rootAfter: 0x300000000001n });
  const result = await fixture.inspector.dispatchHotkey(targetA, ['ctrl', 's'], {
    target: targetA,
    focused: true,
    pid: targetA.pid,
    hwnd: targetA.hwnd,
    runtimeId: 'runtime-1',
  });
  assert.deepEqual(result, { status: 'unknown', code: 'native_hotkey_focus_changed' });
  assert.equal(fixture.calls.sendInput, 1);
});

test('native window hotkey accepts a focused-child transition only with the enrolled root intact', async () => {
  const fixture = nativeHotkeyFixture({ afterRuntime: 'editor-closed' });
  const result = await fixture.inspector.dispatchHotkey(targetA, ['ctrl', 's'], {
    target: targetA,
    focused: true,
    pid: targetA.pid,
    hwnd: targetA.hwnd,
    runtimeId: 'runtime-1',
  });
  assert.deepEqual(result, { status: 'dispatched', suppressFocusHandoff: true });
  assert.equal(fixture.calls.sendInput, 1);
});

test('layered overlay exception requires native target root/PID proof and keeps ordinary popups blocking', () => {
  const common = {
    candidateEnabled: true,
    candidateStyle: 0x80000n,
    targetIsTopLevel: true,
    nativeRoot: targetA.hwnd,
    nativePid: targetA.pid,
    authorizedRoot: targetA.hwnd,
    authorizedPid: targetA.pid,
  };
  assert.equal(shouldIgnoreLayeredOccluder(common), true);
  assert.equal(shouldIgnoreLayeredOccluder({ ...common, candidateStyle: 0n }), false);
  assert.equal(shouldIgnoreLayeredOccluder({ ...common, candidateStyle: 0x80020n }), false);
  assert.equal(shouldIgnoreLayeredOccluder({ ...common, nativeRoot: targetB.hwnd, nativePid: targetB.pid }), false);
  assert.equal(shouldIgnoreLayeredOccluder({ ...common, candidateEnabled: false }), false);
  assert.equal(shouldIgnoreLayeredOccluder({ ...common, targetIsTopLevel: false }), false);
});

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

test('selector type stays background while an explicit desktop point cannot downgrade without foreground grant', async () => {
  const fake = fakeDesktopTransport();
  const backend = await createWindowsDesktopBackend({ authorization: { targets: [targetA, targetB], background: { source: 'cua-uia-0.54' } }, transport: fake.transport, inspector: fake.inspector });
  const frame = await backend.observe({ view: 'controls' });
  const type = await backend.dispatch({ frame, step: { kind: 'type', target: { role: 'Edit', name: 'Name', within: 'Fixture B' }, text: 'hello' } });
  assert.equal(type.status, 'dispatched');
  const click = await backend.dispatch({ frame, step: { kind: 'click', target: { point: { x: 60, y: 75 } } } });
  assert.deepEqual(click, { status: 'refused', code: 'foreground_input_not_authorized' });
  const dispatches = fake.calls.filter(call => call.kind === 'dispatch');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].target.window.hwnd, targetB.hwnd);
  assert.equal(dispatches[0].target.foreground, false);
  await backend.close();
});

test('Windows type hitTest resolves only a unique editable token control', async () => {
  const fake = fakeDesktopTransport();
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA], allowForegroundInput: true, allowDesktopCapture: true, background: { source: 'cua-uia-0.54' } },
    transport: fake.transport,
    inspector: fake.inspector,
  });
  const frame = await backend.observe({ view: 'controls' });
  const editor = frame.controls.find(control => control.name === 'Name');
  assert.ok(editor?.rect);
  const resolved = await backend.hitTest(frame, { x: editor.rect.x + 10, y: editor.rect.y + 10 }, undefined, 'type');
  assert.equal(resolved?.id, editor.id);
  const canvasOnly = await backend.hitTest(frame, { x: 430, y: 300 }, undefined, 'type');
  assert.equal(canvasOnly, undefined);
  await backend.close();
});

test('Windows hitTest treats one editable document/grid surface as primary pointer focus, not its scroll ancestor', async () => {
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const bounds = { x: 100, y: 200, width: 500, height: 300 };
  const point = { x: 180, y: 270 };
  const dispatches = [];
  let proofEnabled = true;
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(window) {
      return {
        target: window,
        bounds,
        complete: false,
        elements: [
          { index: '0', depth: 0, role: 'Window', label: 'native editor', actions: [], rect: bounds },
          { index: '1', depth: 1, role: 'Pane', label: 'viewport', actions: ['scroll'], token: 'viewport-token', rect: bounds, parentIndex: '0' },
          { index: '2', depth: 2, role: 'Document', label: 'page', actions: ['text', 'scroll'], editable: true, token: 'document-token', rect: { x: 140, y: 230, width: 300, height: 180 }, parentIndex: '1' },
        ],
      };
    },
    async dispatch(step, recipient) { dispatches.push({ step, recipient }); return { status: 'dispatched' }; },
  };
  const inspector = {
    async read(window) { return { target: window, visible: true, minimized: false, bounds, foregroundHwnd: window.hwnd, foregroundPid: window.pid }; },
    async readPointerSurface(window) { return proofEnabled ? { target: window, kind: 'text', runtimeId: 'native-document-surface', role: 'Document', bounds: { x: 140, y: 230, width: 300, height: 180 }, leaf: { runtimeId: 'native-document-leaf', role: 'Edit', bounds: { x: 150, y: 240, width: 280, height: 160 } } } : undefined; },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [target], allowForegroundInput: true, allowDesktopCapture: true, background: { source: 'cua-uia-0.54' } },
    transport,
    inspector,
  });
  const frame = await backend.observe({ view: 'controls' });
  const document = frame.controls.find(control => control.role === 'Document');
  assert.ok(document);
  const hit = await backend.hitTest(frame, point, undefined, 'click');
  assert.equal(hit?.id, document.id);
  assert.equal(hit?.actions.includes('click'), true);
  assert.equal(hit?.pointInteraction?.kind, 'placeCaret');
  assert.equal(typeof hit?.pointInteraction?.binding, 'string');
  assert.equal((await backend.hitTest(frame, point))?.id, document.id);
  const dispatched = await backend.dispatch({ frame, target: hit, step: { kind: 'click', target: { point } } });
  assert.deepEqual(dispatched, { status: 'dispatched' });
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].recipient.coordinate, true);
  assert.deepEqual(dispatches[0].recipient.point, point);

  // A pointer-focus surface is never downgraded to a semantic Invoke when
  // addressed by selector/ref; coordinate grounding is mandatory.
  const selectorClick = await backend.dispatch({ frame, step: { kind: 'click', target: { role: 'Document', name: 'page' } } });
  assert.deepEqual(selectorClick, { status: 'refused', code: 'pointer_focus_requires_point' });
  proofEnabled = false;
  const fallbackHit = await backend.hitTest(frame, point, undefined, 'click');
  assert.equal(fallbackHit?.actions.includes('click'), true);
  assert.equal(fallbackHit?.pointInteraction, undefined);
  await backend.close();
});

test('Windows grid pointer focus stays ambiguous or blocked when evidence is not unique/owned', async () => {
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const bounds = { x: 100, y: 200, width: 500, height: 300 };
  const point = { x: 180, y: 270 };
  let duplicate = true;
  let owner = target;
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(window) {
      return {
        target: window,
        bounds,
        complete: true,
        elements: [
          { index: '0', depth: 0, role: 'Window', label: 'grid', actions: [], rect: bounds },
          { index: '1', depth: 1, role: 'DataGrid', label: 'table', actions: ['scroll'], token: 'grid-token', rect: bounds, parentIndex: '0' },
          { index: '2', depth: 2, role: 'DataItem', label: 'A1', actions: ['invoke', 'set_value'], editable: true, token: 'a1-token', rect: { x: 140, y: 240, width: 120, height: 60 }, parentIndex: '1' },
          ...(duplicate ? [{ index: '3', depth: 2, role: 'DataItem', label: 'B1', actions: ['invoke', 'set_value'], editable: true, token: 'b1-token', rect: { x: 140, y: 240, width: 120, height: 60 }, parentIndex: '1' }] : []),
        ],
      };
    },
    async dispatch() { return { status: 'dispatched' }; },
  };
  const inspector = {
    async read(window) { return { target: owner, visible: true, minimized: false, bounds }; },
    async readPointerSurface(window) { return { target: window, kind: 'grid', runtimeId: 'native-grid-cell', role: 'DataItem', name: 'A1', bounds: { x: 140, y: 240, width: 120, height: 60 }, leaf: { runtimeId: 'native-grid-leaf', role: 'DataItem', name: 'A1', bounds: { x: 140, y: 240, width: 120, height: 60 } } }; },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [target], background: { source: 'cua-uia-0.54' } },
    transport,
    inspector,
  });
  const ambiguousFrame = await backend.observe({ view: 'controls' });
  assert.equal(await backend.hitTest(ambiguousFrame, point, undefined, 'click'), undefined);
  duplicate = false;
  const uniqueFrame = await backend.observe({ view: 'controls' });
  assert.ok(await backend.hitTest(uniqueFrame, point, undefined, 'click'));
  const selectorClick = await backend.dispatch({ frame: uniqueFrame, step: { kind: 'click', target: { role: 'DataItem', name: 'A1' } } });
  assert.deepEqual(selectorClick, { status: 'dispatched' });
  owner = { pid: target.pid + 1, hwnd: target.hwnd };
  assert.equal(await backend.hitTest(uniqueFrame, point, undefined, 'click'), undefined);
  await backend.close();
});

test('CUA exposes setValue only for generic editable ValuePattern roles and retains the text fallback', async () => {
  const fake = fakeDesktopTransport();
  const backend = await createWindowsDesktopBackend({ authorization: { targets: [targetA], background: { source: 'cua-uia-0.54' } }, transport: fake.transport, inspector: fake.inspector });
  assert.equal(backend.capabilities.some(capability => capability.kind === 'setValue'
    && capability.targets.join(',') === 'selector,ref'), true);
  const frame = await backend.observe({ view: 'controls' });
  const editor = frame.controls.find(control => control.name === 'Name');
  assert.ok(editor?.actions.includes('type'));
  assert.equal(editor?.actions.includes('setValue'), true);
  const result = await backend.dispatch({ frame, step: { kind: 'setValue', target: { ref: editor.id }, value: 'replacement' } });
  assert.deepEqual(result, { status: 'dispatched' });
  assert.equal(fake.calls.filter(call => call.kind === 'dispatch').at(-1)?.step.kind, 'setValue');
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

test('parent-root geometry-less CUA controls cannot cross an owned child HWND, while an independently enrolled child can dispatch', async () => {
  const child = { ...targetB, pid: targetA.pid, title: 'Fixture child' };
  const owned = [{ target: targetA, hwnd: child.hwnd, pid: child.pid, ownerHwnd: targetA.hwnd,
    ownerChain: [targetA.hwnd], bounds: { x: 20, y: 30, width: 420, height: 280 } }];
  const dispatches = [];
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(target) {
      return {
        target,
        title: target.hwnd === targetA.hwnd ? 'Fixture A' : 'Fixture child',
        bounds: { x: 20, y: 30, width: 420, height: 280 },
        complete: true,
        elements: [
          { index: '0', depth: 0, role: 'Window', label: 'Root', actions: [], rect: { x: 20, y: 30, width: 420, height: 280 } },
          { index: '1', depth: 1, role: 'Button', label: 'Close child', actions: ['invoke'], enabled: true, token: 'close-child' },
        ],
      };
    },
    async dispatch(step, target) {
      dispatches.push({ step, target });
      return { status: 'dispatched' };
    },
  };
  const inspector = { async read(target) { return { target, visible: true, minimized: false, bounds: { x: 20, y: 30, width: 420, height: 280 } }; } };
  const ownedDialogInspector = { async findOwnedDialogs(target) { return target.hwnd === targetA.hwnd ? owned : []; } };
  const parentBackend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA], background: { source: 'cua-uia-0.54' } },
    transport, inspector, ownedDialogInspector,
  });
  const parentFrame = await parentBackend.observe({ view: 'controls' });
  const parentControl = parentFrame.controls.find(control => control.name === 'Close child');
  assert.ok(parentControl);
  const refused = await parentBackend.dispatch({ frame: parentFrame, target: parentControl,
    step: { kind: 'click', target: { ref: parentControl.id } } });
  assert.deepEqual(refused, { status: 'refused', code: 'window_scope_unverified' });
  assert.equal(dispatches.length, 0);
  await parentBackend.close();

  const childBackend = await createWindowsDesktopBackend({
    authorization: { targets: [child], background: { source: 'cua-uia-0.54' } },
    transport, inspector, ownedDialogInspector,
  });
  const childFrame = await childBackend.observe({ view: 'controls' });
  const childControl = childFrame.controls.find(control => control.name === 'Close child');
  assert.ok(childControl);
  const dispatched = await childBackend.dispatch({ frame: childFrame, target: childControl,
    step: { kind: 'click', target: { ref: childControl.id } } });
  assert.deepEqual(dispatched, { status: 'dispatched' });
  assert.equal(dispatches.at(-1).target.window.hwnd, child.hwnd);
  await childBackend.close();

  const failingInspectorBackend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA], background: { source: 'cua-uia-0.54' } },
    transport, inspector,
    ownedDialogInspector: { async findOwnedDialogs() { throw new Error('owned_dialog_probe_failed'); } },
  });
  const failingFrame = await failingInspectorBackend.observe({ view: 'controls' });
  const failingControl = failingFrame.controls.find(control => control.name === 'Close child');
  const strictRefusal = await failingInspectorBackend.dispatch({ frame: failingFrame, target: failingControl,
    step: { kind: 'click', target: { ref: failingControl.id } } });
  assert.deepEqual(strictRefusal, { status: 'refused', code: 'window_scope_unverified' });
  assert.equal(dispatches.length, 1);
  await failingInspectorBackend.close();
});

test('CUA logical element geometry is projected into exact physical HWND bounds', async () => {
  const dispatches = [];
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(target) {
      return {
        target,
        title: 'Scaled fixture',
        // Metadata window bounds intentionally use another coordinate space;
        // the top-level UIA Window frame below is the trusted basis.
        bounds: { x: 999, y: 999, width: 1, height: 1 },
        complete: true,
        elements: [
          { index: '0', depth: 0, role: 'Window', label: 'Scaled fixture', actions: [], rect: { x: 100, y: 100, width: 300, height: 200 } },
          { index: '1', depth: 1, role: 'Button', label: 'Scaled action', actions: ['invoke'], enabled: true, token: 'scaled-action', rect: { x: 120, y: 120, width: 60, height: 20 } },
        ],
      };
    },
    async dispatch(step, target) { dispatches.push({ step, target }); return { status: 'dispatched' }; },
  };
  const inspector = { async read(target) { return { target, visible: true, minimized: false, bounds: { x: 240, y: 240, width: 450, height: 300 } }; } };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA], background: { source: 'cua-uia-0.54' } },
    transport, inspector,
  });
  const frame = await backend.observe({ view: 'controls' });
  const control = frame.controls.find(item => item.name === 'Scaled action');
  assert.deepEqual(control?.rect, { x: 270, y: 270, width: 90, height: 30 });
  const result = await backend.dispatch({ frame, target: control, step: { kind: 'click', target: { ref: control.id } } });
  assert.deepEqual(result, { status: 'dispatched' });
  assert.deepEqual(dispatches[0].target.point, { x: 315, y: 285 });
  await backend.close();
});

test('CUA controls hide unproven geometry instead of exposing logical coordinates', async () => {
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(target) {
      return {
        target,
        title: 'Unmapped fixture',
        bounds: { x: 100, y: 100, width: 300, height: 200 },
        complete: true,
        elements: [
          { index: '0', depth: 0, role: 'Window', label: 'Unmapped fixture', actions: [], rect: { x: 100, y: 100, width: 300, height: 200 } },
          { index: '1', depth: 1, role: 'Button', label: 'Unmapped action', actions: ['invoke'], enabled: true, token: 'unmapped-action', rect: { x: 120, y: 120, width: 60, height: 20 } },
        ],
      };
    },
    async dispatch() { return { status: 'dispatched' }; },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA], background: { source: 'cua-uia-0.54' } },
    transport,
    inspector: { async read(target) { return { target, visible: true, minimized: false }; } },
  });
  const frame = await backend.observe({ view: 'controls' });
  assert.equal(frame.controls.find(control => control.name === 'Unmapped action')?.rect, undefined);
  await backend.close();
});

test('CUA controls-only reads retain bounded structural visibility without publishing unproven geometry', async () => {
  const dispatches = [];
  const bounds = { x: 100, y: 200, width: 420, height: 280 };
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(target) {
      return {
        target,
        title: 'Unprojected fixture',
        // Deliberately omit a Window root and screenshot-origin proof. The
        // token/frame remain from the exact controls-only UIA read.
        bounds: { x: 999, y: 999, width: 1, height: 1 },
        complete: true,
        elements: [
          { index: '1', depth: 1, role: 'Button', label: 'Search', actions: ['invoke'], enabled: true, token: 'search-token', rect: { x: 120, y: 240, width: 90, height: 28 } },
        ],
      };
    },
    async dispatch(step, recipient) {
      dispatches.push({ step, recipient });
      return { status: 'dispatched' };
    },
  };
  const inspector = {
    async read(target) { return { target, visible: true, minimized: false, bounds }; },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA], background: { source: 'cua-uia-0.54' } },
    transport,
    inspector,
    ownedDialogInspector: { async findOwnedDialogs() { return []; } },
  });
  const frame = await backend.observe({ view: 'controls' });
  const search = frame.controls.find(control => control.name === 'Search');
  assert.ok(search);
  assert.equal(search.rect, undefined);
  assert.ok(search.states.includes('visible'));
  assert.ok(search.states.includes('enabled'));
  const result = await backend.dispatch({ frame, step: { kind: 'click', target: { ref: search.id } } });
  assert.deepEqual(result, { status: 'dispatched' });
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].recipient.foreground, false);
  assert.equal(dispatches[0].recipient.control.token, 'search-token');
  await backend.close();
});

test('CUA removes only a geometry-less owned-dialog duplicate with shared native identity', async () => {
  const child = { pid: targetA.pid, hwnd: targetB.hwnd, title: 'Fixture child' };
  const bounds = { x: 20, y: 30, width: 420, height: 280 };
  const dispatches = [];
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(target) {
      return {
        target,
        title: target.hwnd === targetA.hwnd ? 'Fixture parent' : 'Fixture child',
        complete: true,
        elements: [{ index: '1', depth: 1, role: 'Button', label: 'Close popup', actions: ['invoke'], enabled: true,
          token: `${target.hwnd.toString()}-close`, runtimeId: 'native-close-runtime' }],
      };
    },
    async dispatch(step, recipient) { dispatches.push({ step, recipient }); return { status: 'dispatched' }; },
  };
  const inspector = { async read(target) { return { target, visible: true, minimized: false, bounds }; } };
  const ownedDialogInspector = {
    async findOwnedDialogs(target) {
      return target.hwnd === targetA.hwnd ? [{ target, hwnd: child.hwnd, pid: child.pid, ownerHwnd: targetA.hwnd,
        ownerChain: [targetA.hwnd], bounds }] : [];
    },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA, child], background: { source: 'cua-uia-0.54' } },
    transport, inspector, ownedDialogInspector,
  });
  const frame = await backend.observe({ view: 'controls' });
  assert.equal(frame.controls.filter(control => control.name === 'Close popup').length, 1);
  assert.equal(frame.controls[0].windowScope, `hwnd:${child.pid}:${child.hwnd.toString()}`);
  const result = await backend.dispatch({ frame, step: { kind: 'click', target: { name: 'Close popup' } } });
  assert.deepEqual(result, { status: 'dispatched' });
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].recipient.window.hwnd, child.hwnd);
  await backend.close();
});

test('CUA keeps geometry-less same-caption controls ambiguous without shared native identity', async () => {
  const child = { pid: targetA.pid, hwnd: targetB.hwnd, title: 'Fixture child' };
  const bounds = { x: 20, y: 30, width: 420, height: 280 };
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(target) {
      return {
        target, title: target.hwnd === targetA.hwnd ? 'Fixture parent' : 'Fixture child', complete: true,
        elements: [{ index: '1', depth: 1, role: 'Button', label: 'Close popup', actions: ['invoke'], enabled: true,
          token: `${target.hwnd.toString()}-close`, runtimeId: target.hwnd === targetA.hwnd ? 'runtime-parent' : 'runtime-child' }],
      };
    },
    async dispatch() { return { status: 'dispatched' }; },
  };
  const inspector = { async read(target) { return { target, visible: true, minimized: false, bounds }; } };
  const ownedDialogInspector = {
    async findOwnedDialogs(target) {
      return target.hwnd === targetA.hwnd ? [{ target, hwnd: child.hwnd, pid: child.pid, ownerHwnd: targetA.hwnd,
        ownerChain: [targetA.hwnd], bounds }] : [];
    },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA, child], background: { source: 'cua-uia-0.54' } },
    transport, inspector, ownedDialogInspector,
  });
  const frame = await backend.observe({ view: 'controls' });
  assert.equal(frame.controls.filter(control => control.name === 'Close popup').length, 2);
  await backend.close();
});

test('CUA geometry accepts an actionable-only tree when window bounds share a proven screenshot origin', async () => {
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(target) {
      return {
        target,
        bounds: { x: 100, y: 200, width: 500, height: 300 },
        screenshotWidth: 500,
        screenshotHeight: 300,
        screenshotOrigin: { x: 100, y: 200 },
        complete: false,
        elements: [
          { index: '7', depth: 1, role: 'Pane', actions: [], rect: { x: 100, y: 200, width: 500, height: 300 }, parentIndex: undefined },
          { index: '8', depth: 2, role: 'DataItem', label: 'E8', actions: ['set_value'], enabled: true, token: 'e8-token', rect: { x: 140, y: 240, width: 20, height: 20 }, screenshotRect: { x: 40, y: 40, width: 20, height: 20 }, parentIndex: '7' },
        ],
      };
    },
    async dispatch() { return { status: 'dispatched' }; },
  };
  const inspector = { async read(target) { return { target, visible: true, minimized: false, bounds: { x: 100, y: 200, width: 500, height: 300 } }; } };
  const backend = await createWindowsDesktopBackend({ authorization: { targets: [targetA], background: { source: 'cua-uia-0.54' } }, transport, inspector });
  const frame = await backend.observe({ view: 'controls', where: { role: 'DataItem', name: 'E8' } });
  const e8 = frame.controls.find(control => control.name === 'E8');
  assert.deepEqual(e8?.rect, { x: 140, y: 240, width: 20, height: 20 });
  assert.equal(e8?.actions.includes('setValue'), false);
  await backend.close();
});

test('only a natively verified owned dialog can remove the duplicate under its owner', async () => {
  const dialog = { ...targetB, pid: targetA.pid };
  const bounds = { x: 20, y: 30, width: 420, height: 280 };
  const fake = fakeDesktopTransport();
  fake.transport.observeWindow = async target => snapshot(target, target.title, bounds.x, bounds.y);
  fake.inspector.read = async (target, point) => ({ target, visible: true, minimized: false, bounds,
    ...(point && target.hwnd === targetA.hwnd ? { occludingHwnd: dialog.hwnd } : {}) });
  let verified = false;
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA, dialog], background: { source: 'cua-uia-0.54' } },
    transport: fake.transport,
    inspector: fake.inspector,
    ownedDialogInspector: { async findOwnedDialogs(target) {
      return verified && target.hwnd === targetA.hwnd ? [{ target, hwnd: dialog.hwnd, pid: dialog.pid,
        ownerHwnd: targetA.hwnd, ownerChain: [targetA.hwnd], bounds }] : [];
    } },
  });
  const where = { name: 'Go' };
  assert.equal((await backend.observe({ view: 'controls', where })).controls.length, 2);
  verified = true;
  const frame = await backend.observe({ view: 'controls', where });
  assert.equal(frame.controls.length, 1);
  const delivery = await backend.dispatch({ frame, step: { kind: 'click', target: where } });
  assert.equal(delivery.status, 'dispatched');
  assert.equal(fake.calls.at(-1).target.window.hwnd, dialog.hwnd);
  await backend.close();
});

test('CUA select-only ListItems remain read-only without a semantic-to-coordinate click fallback', async () => {
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(target) {
      return {
        ...snapshot(target, 'Fixture A', 20, 30, 'select-only'),
        elements: [
          { index: '0', depth: 0, role: 'Window', label: 'Fixture A', actions: [], rect: { x: 20, y: 30, width: 420, height: 280 } },
          { index: '1', depth: 1, role: 'ListItem', label: 'Save As', actions: ['select'], enabled: true, rect: { x: 40, y: 70, width: 120, height: 30 }, parentIndex: '0' },
        ],
      };
    },
    async dispatch() { return { status: 'dispatched' }; },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA], allowForegroundInput: true, allowDesktopCapture: true },
    transport,
    inspector: { async read(target) { return { target, visible: true, minimized: false, bounds: { x: 20, y: 30, width: 420, height: 280 }, foregroundHwnd: target.hwnd }; } },
  });
  const frame = await backend.observe({ view: 'controls' });
  const saveAs = frame.controls.find(control => control.role === 'ListItem');
  assert.ok(saveAs);
  assert.deepEqual(saveAs.actions, []);
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

test('foreground point rechecks a newly covering window after activation before dispatch', async () => {
  const calls = [];
  let foreground = targetB.hwnd;
  let occluder;
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(target) { return snapshot(target, 'Fixture A', 20, 30, 'post-activation-cover'); },
    async bringToFront(target) { calls.push({ kind: 'bringToFront', target }); foreground = target.hwnd; occluder = targetB.hwnd; return { status: 'dispatched' }; },
    async dispatch(step, target) { calls.push({ kind: 'dispatch', step, target }); return { status: 'dispatched' }; },
  };
  const inspector = {
    async read(target, point) {
      return { target, visible: true, minimized: false, bounds: { x: 20, y: 30, width: 420, height: 280 }, foregroundHwnd: foreground, foregroundPid: foreground === target.hwnd ? target.pid : targetB.pid, ...(point && occluder ? { occludingHwnd: occluder } : {}) };
    },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA], allowForegroundInput: true, allowDesktopCapture: true },
    transport,
    inspector,
  });
  const frame = await backend.observe({ view: 'controls' });
  const result = await backend.dispatch({ frame, step: { kind: 'click', target: { point: { x: 300, y: 220 } } } });
  assert.deepEqual(result, { status: 'refused', code: 'target_occluded' });
  assert.deepEqual(calls.map(call => call.kind), ['bringToFront']);
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

test('the Windows session can click and scroll when UIA returns no controls', async t => {
  const bounds = { x: 20, y: 30, width: 420, height: 280 };
  const image = { mimeType: 'image/png', dataBase64: 'AA==', width: 900, height: 600 };
  let foreground = targetA;
  let covered = false;
  let revoked = false;
  const gestures = [];
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow() { throw Error('fixture has no accessible controls'); },
    async observeDesktopImage() { return image; },
    async authorizeWindowPoint() { return revoked ? 'window_scope_changed' : undefined; },
    async dispatch() { assert.fail('opaque points should not need a CUA element token'); },
  };
  const inspector = {
    async read(target, point) {
      return { target, bounds, visible: true, minimized: false, foregroundHwnd: foreground.hwnd, foregroundPid: foreground.pid,
        ...(covered && point ? { occludingHwnd: targetB.hwnd } : {}) };
    },
    async dispatchWindowPoint(target, step, actualBounds, display) {
      gestures.push({ target, step });
      assert.deepEqual(actualBounds, bounds);
      assert.equal(display, image);
      return { status: 'dispatched', suppressFocusHandoff: true };
    },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA, targetB], allowDesktopCapture: true, allowForegroundInput: true }, inspector, transport,
  });
  const session = createDeskSession(backend, { allowModelImages: true });
  t.after(() => session.close());
  const { observationId, controls } = await session.observe({ view: 'image' });
  assert.deepEqual(controls, []);
  const point = { x: 300, y: 220 };
  const run = async (step, source) => {
    const id = source ?? (await session.observe({ view: 'image' })).observationId;
    return session.act({ observationId: id, steps: [{ ...step, target: { point } }] });
  };
  for (const step of [{ kind: 'click' }, { kind: 'scroll', direction: 'down', amount: 2 }]) {
    const result = await run(step);
    assert.equal(result.steps[0].status, 'dispatched', JSON.stringify(result));
  }
  assert.equal((await run({ kind: 'click', button: 'right' })).code, 'window_point_gesture_unavailable');
  assert.equal((await run({ kind: 'type', text: 'do not type into the canvas' })).code, 'point_not_unique');
  const plain = await session.observe({ view: 'controls' });
  assert.equal((await session.act({ observationId: plain.observationId, steps: [{ kind: 'click', target: { point } }] })).code, 'point_evidence_required');
  revoked = true;
  assert.equal((await run({ kind: 'click' })).code, 'window_scope_changed');
  revoked = false;
  const beforePopup = await session.observe({ view: 'image' });
  covered = true;
  assert.equal((await run({ kind: 'click' }, beforePopup.observationId)).steps[0].status, 'not_dispatched');
  covered = false;
  const beforeSwitch = await session.observe({ view: 'image' });
  foreground = targetB;
  assert.equal((await run({ kind: 'click' }, beforeSwitch.observationId)).steps[0].status, 'not_dispatched');
  assert.deepEqual(gestures.map(event => [event.target.hwnd, event.step.kind]), [[targetA.hwnd, 'click'], [targetA.hwnd, 'scroll']]);
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
  await transport.observeWindow(target, { includeScreenshot: true });
  assert.equal(calls[1].args.include_screenshot, true);
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

test('CUA forwards a scoped control name to the native query without widening window identity', async () => {
  const calls = [];
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const driver = {
    async metadata() { return { driverVersion: '0.54.0' }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async callTool(name, json) {
      const args = JSON.parse(json);
      calls.push({ name, args });
      if (name === 'get_window_state') {
        return { isError: false, structuredJson: JSON.stringify({
          pid: target.pid,
          window_id: target.hwnd.toString(),
          elements_complete: true,
          elements: [
            { element_index: 0, depth: 0, role: 'Window', label: 'Fixture', actions: [] },
            { element_index: 1, depth: 1, role: 'Edit', label: 'E8', value: 'Untriaged', actions: ['text', 'set_value'], element_token: 'e8-token' },
          ],
        }) };
      }
      if (name === 'set_value') {
        assert.deepEqual(Object.keys(args).sort(), ['delivery_mode', 'element_token', 'pid', 'session', 'value'].sort());
        assert.equal(args.pid, target.pid);
        assert.equal(args.element_token, 'e8-token');
        assert.equal(args.delivery_mode, 'background');
        return { isError: false, action: { effect: 'confirmed', route: 'accessibility', delivery: { mode: 'background' } } };
      }
      return { isError: false };
    },
  };
  const transport = await CuaWindowsTransport.open(driver, 'scoped-query-session');
  const observed = await transport.observeWindow(target, { where: { role: 'Edit', name: 'E8' } });
  assert.equal(calls[0].name, 'get_window_state');
  assert.equal(calls[0].args.query, 'E8');
  assert.equal(String(calls[0].args.window_id), String(target.hwnd));
  assert.equal(observed.target.pid, target.pid);
  assert.equal(observed.target.hwnd, target.hwnd);
  assert.equal(observed.complete, true);
  assert.equal(observed.elements.find(element => element.label === 'E8')?.token, 'e8-token');
  const replacement = await transport.dispatch({ kind: 'setValue', target: { ref: 'e8' }, value: 'Review' }, {
    window: target,
    control: {
      control: { id: 'e8', role: 'Edit', name: 'E8', within: 'Fixture', states: ['visible', 'enabled', 'editable'], actions: ['setValue'] },
      token: 'e8-token',
      window: target,
      source: observed.elements.find(element => element.label === 'E8'),
    },
    foreground: false,
  }, {});
  assert.deepEqual(replacement, { status: 'dispatched' });
  const setValueCall = calls.find(call => call.name === 'set_value');
  assert.equal(setValueCall?.args.value, 'Review');
  assert.equal(setValueCall?.args.target, undefined);
  await transport.observeWindow(target, { where: { role: 'Edit' } });
  assert.equal(calls.at(-1).args.query, undefined);
  await transport.close();
});

test('CUA exact-window OCR capture verifies HWND/PID and infers the logical screenshot origin', async () => {
  const calls = [];
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const pngHeader = Buffer.alloc(24);
  pngHeader.writeUInt32BE(0x89504e47, 0);
  pngHeader.writeUInt32BE(0x0d0a1a0a, 4);
  pngHeader.writeUInt32BE(427, 16);
  pngHeader.writeUInt32BE(261, 20);
  const driver = {
    async metadata() { return { driverVersion: '0.54.0' }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async callTool(name, json) {
      calls.push({ name, args: JSON.parse(json) });
      if (name !== 'get_window_state') return { isError: false };
      return {
        isError: false,
        images: [{ mimeType: 'image/png', dataBase64: pngHeader.toString('base64') }],
        structuredContent: {
          pid: target.pid,
          window_id: target.hwnd.toString(),
          screenshot_frame_valid: true,
          elements: [{ frame: { x: 228, y: 236, width: 220, height: 78 }, screenshot_frame: { x: 108, y: 116, width: 220, height: 78 } }],
        },
      };
    },
  };
  const transport = await CuaWindowsTransport.open(driver, 'ocr-capture-session');
  const image = await transport.observeWindowImage(target, {});
  assert.deepEqual(image, {
    mimeType: 'image/png',
    dataBase64: pngHeader.toString('base64'),
    width: 427,
    height: 261,
    origin: { x: 120, y: 120 },
  });
  const capture = calls.find(call => call.name === 'get_window_state');
  assert.equal(capture.args.include_screenshot, true);
  assert.equal(capture.args.include_accessibility_tree, true);
  assert.equal(String(capture.args.window_id), target.hwnd.toString());
  await transport.close();
});

test('CUA transport projects an explicitly foreground desktop point into window-local pixels', async () => {
  const calls = [];
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const bounds = { x: 100, y: 200, width: 500, height: 300 };
  let capture = { pid: target.pid, window_id: String(target.hwnd), window_bounds: bounds,
    screenshot_frame_valid: true, capture_id: 'local-capture', screenshot_width: 400, screenshot_height: 240,
    elements: [{ frame: { x: 100, y: 200, width: 40, height: 32 }, screenshot_frame: { x: 20, y: 40, width: 40, height: 32 } }] };
  const driver = {
    async metadata() { return { driverVersion: '0.54.0' }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async callTool(name, json) {
      calls.push({ name, args: JSON.parse(json) });
      if (name === 'get_window_state') return { isError: false, images: [{ mimeType: 'image/png', dataBase64: 'fixture' }], structuredContent: capture };
      return { isError: false, action: { effect: 'confirmed', route: 'global_input', delivery: { mode: 'foreground' } } };
    },
  };
  const transport = await CuaWindowsTransport.open(driver, 'foreground-session');
  const recipient = {
    window: target,
    point: { x: 150, y: 250 },
    windowBounds: bounds,
    foreground: true,
  };
  const action = { kind: 'click', target: { point: recipient.point } };
  const result = await transport.dispatch(action, recipient, {});
  assert.equal(result.status, 'dispatched');
  const click = calls.find(call => call.name === 'click');
  assert.deepEqual({ x: click.args.x, y: click.args.y }, { x: 40, y: 40 });
  assert.equal(click.args.delivery_mode, 'foreground');
  assert.equal(click.args.capture_id, 'local-capture');
  assert.equal(click.args.element_token, undefined);
  const scrollAction = { kind: 'scroll', target: { point: recipient.point }, direction: 'down', amount: 1 };
  const scrollResult = await transport.dispatch(scrollAction, recipient, {});
  assert.equal(scrollResult.status, 'dispatched');
  const scroll = calls.find(call => call.name === 'scroll');
  assert.deepEqual({ x: scroll.args.x, y: scroll.args.y }, { x: 40, y: 40 });
  assert.equal(scroll.args.delivery_mode, 'foreground');
  assert.equal(scroll.args.capture_id, undefined);
  capture = { ...capture, elements: [{ frame: { x: 90, y: 160, width: 40, height: 32 }, screenshot_frame: { x: 20, y: 30, width: 40, height: 32 } }] };
  assert.deepEqual(await transport.dispatch(action, recipient, {}), { status: 'refused', code: 'foreground_capture_stale' });
  capture = { ...capture, elements: [{ frame: { x: 100, y: 200, width: 40, height: 32 }, screenshot_frame: { x: 20, y: 40, width: 40, height: 32 } }] };
  capture = { ...capture, window_bounds: { ...bounds, x: bounds.x + 10 } };
  assert.deepEqual(await transport.dispatch(action, recipient, {}), { status: 'refused', code: 'foreground_capture_stale' });
  capture = { ...capture, window_bounds: bounds, capture_id: undefined };
  assert.deepEqual(await transport.dispatch(action, recipient, {}), { status: 'refused', code: 'foreground_capture_unavailable' });
  assert.equal(calls.filter(call => call.name === 'click').length, 1);
  await transport.close();
});

test('CUA refuses an explicit coordinate click without the foreground lane even when a matching UIA token exists', async () => {
  const calls = [];
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const bounds = { x: 100, y: 200, width: 500, height: 300 };
  const driver = {
    async metadata() { return { driverVersion: '0.54.0' }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async callTool(name, json) {
      calls.push({ name, args: JSON.parse(json) });
      if (name === 'click') return { isError: false, action: { effect: 'confirmed', route: 'accessibility', delivery: { mode: 'background' } } };
      return { isError: false };
    },
  };
  const transport = await CuaWindowsTransport.open(driver, 'background-coordinate-session');
  const point = { x: 173, y: 267 };
  const result = await transport.dispatch({ kind: 'click', target: { point } }, {
    window: target,
    point,
    windowBounds: bounds,
    foreground: false,
    control: {
      control: { id: 'cell', role: 'DataItem', name: 'E9', within: 'Grid', states: ['visible', 'enabled'], actions: ['click'], rect: { x: 140, y: 240, width: 120, height: 60 } },
      token: 'cell-token',
      window: target,
      source: { index: 'cell', depth: 2, role: 'DataItem', label: 'E9', actions: ['invoke'], token: 'cell-token' },
    },
  }, {});
  assert.deepEqual(result, { status: 'refused', code: 'foreground_input_required' });
  assert.equal(calls.some(call => call.name === 'click'), false);
  await transport.close();
});

test('CUA foreground point typing uses a fresh capture point and omits the stale element token', async () => {
  const calls = [];
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const bounds = { x: 100, y: 200, width: 500, height: 300 };
  const driver = {
    async metadata() { return { driverVersion: '0.54.0' }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async callTool(name, json) {
      const args = JSON.parse(json);
      calls.push({ name, args });
      if (name === 'get_window_state') return {
        isError: false,
        images: [{ mimeType: 'image/png', dataBase64: 'fixture' }],
        structuredContent: {
          pid: target.pid,
          window_id: String(target.hwnd),
          window_bounds: bounds,
          screenshot_frame_valid: true,
          capture_id: 'type-capture',
          screenshot_width: 500,
          screenshot_height: 300,
          elements: [{ frame: bounds, screenshot_frame: { x: 0, y: 0, width: 500, height: 300 } }],
        },
      };
      return { isError: false, action: { effect: 'confirmed', route: 'global_input', delivery: { mode: 'foreground' } } };
    },
  };
  const transport = await CuaWindowsTransport.open(driver, 'foreground-type-session');
  const result = await transport.dispatch({ kind: 'type', target: { point: { x: 150, y: 250 } }, text: 'Review' }, {
    window: target,
    point: { x: 150, y: 250 },
    windowBounds: bounds,
    foreground: true,
    control: {
      control: { id: 'e8', role: 'DataItem', name: 'E8', within: 'Fixture', states: ['visible', 'enabled', 'editable'], actions: ['type'], rect: { x: 140, y: 240, width: 20, height: 20 } },
      token: 'stale-e8-token',
      window: target,
      localRect: { x: 40, y: 40, width: 20, height: 20 },
      source: { index: 'e8', depth: 1, role: 'DataItem', label: 'E8', actions: ['type'], token: 'stale-e8-token' },
    },
  }, {});
  assert.deepEqual(result, { status: 'dispatched' });
  const typeCall = calls.find(call => call.name === 'type_text');
  assert.equal(typeCall?.args.x, 50);
  assert.equal(typeCall?.args.y, 50);
  assert.equal(typeCall?.args.element_token, undefined);
  assert.equal(typeCall?.args.capture_id, undefined);
  assert.equal(typeCall?.args.delivery_mode, 'foreground');
  await transport.close();
});

test('CUA explicit foreground type never falls back to a background token route', async () => {
  const calls = [];
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const driver = {
    async metadata() { return { driverVersion: '0.54.0' }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async callTool(name, json) { calls.push({ name, args: JSON.parse(json) }); return { isError: false }; },
  };
  const transport = await CuaWindowsTransport.open(driver, 'foreground-type-guard-session');
  const result = await transport.dispatch({ kind: 'type', target: { ref: 'edit' }, text: 'Review', delivery: 'foreground' }, {
    window: target,
    control: {
      control: { id: 'edit', role: 'Edit', name: 'Edit', states: ['visible', 'enabled', 'editable'], actions: ['type'] },
      token: 'edit-token',
      window: target,
      source: { index: 'edit', depth: 1, role: 'Edit', label: 'Edit', actions: ['text'], token: 'edit-token' },
    },
    foreground: false,
  }, {});
  assert.deepEqual(result, { status: 'refused', code: 'foreground_type_target_unavailable' });
  assert.equal(calls.some(call => call.name === 'type_text'), false);
  await transport.close();
});

test('CUA foreground point typing maps a DPI-scaled capture and accepts a bounded inset window frame', async () => {
  const calls = [];
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const physicalBounds = { x: 96, y: 347, width: 1920, height: 1117 };
  const driver = {
    async metadata() { return { driverVersion: '0.54.0' }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async callTool(name, json) {
      const args = JSON.parse(json);
      calls.push({ name, args });
      if (name === 'get_window_state') return {
        isError: false,
        images: [{ mimeType: 'image/png', dataBase64: 'fixture' }],
        structuredContent: {
          pid: target.pid,
          window_id: String(target.hwnd),
          window_bounds: { x: 105, y: 347, width: 1902, height: 1108 },
          screenshot_frame_valid: false,
          capture_id: 'scaled-type-capture',
          screenshot_width: 1280,
          screenshot_height: 745,
          elements: [{ frame: { x: 354, y: 600, width: 64, height: 19 }, screenshot_frame: { x: 290, y: 369, width: 64, height: 19 } }],
        },
      };
      return { isError: false, action: { effect: 'confirmed', route: 'global_input', delivery: { mode: 'foreground' } } };
    },
  };
  const transport = await CuaWindowsTransport.open(driver, 'foreground-scaled-session');
  const point = { x: 96 + 290 * 1.5, y: 347 + 369 * (1117 / 745) };
  const result = await transport.dispatch({ kind: 'type', target: { point }, text: 'Review' }, {
    window: target,
    point,
    windowBounds: physicalBounds,
    foreground: true,
    control: {
      control: { id: 'e8', role: 'DataItem', name: 'E8', within: 'Fixture', states: ['visible', 'enabled', 'editable'], actions: ['type'], rect: { x: 531, y: 900, width: 96, height: 29 } },
      token: 'stale-e8-token',
      window: target,
      source: { index: 'e8', depth: 1, role: 'DataItem', label: 'E8', actions: ['type'], token: 'stale-e8-token' },
    },
  }, {});
  assert.equal(result.status, 'dispatched');
  const typeCall = calls.find(call => call.name === 'type_text');
  assert.deepEqual({ x: typeCall?.args.x, y: typeCall?.args.y }, { x: 290, y: 369 });
  assert.equal(typeCall?.args.element_token, undefined);
  assert.equal(typeCall?.args.capture_id, undefined);
  await transport.close();
});

test('Windows backend permits foreground point type only for an observed writable control with explicit grants', async () => {
  const dispatches = [];
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(window) {
      return {
        target: window,
        bounds: { x: 100, y: 200, width: 500, height: 300 },
        complete: true,
        elements: [
          { index: '0', depth: 0, role: 'Window', label: 'Excel', actions: [], rect: { x: 100, y: 200, width: 500, height: 300 } },
          { index: '1', depth: 1, role: 'DataItem', label: 'E8', actions: ['set_value'], editable: true, token: 'e8-token', rect: { x: 140, y: 240, width: 20, height: 20 } },
        ],
      };
    },
    async dispatch(step, recipient) { dispatches.push({ step, recipient }); return { status: 'dispatched' }; },
  };
  const inspector = {
    async read(window) { return { target: window, visible: true, minimized: false, bounds: { x: 100, y: 200, width: 500, height: 300 }, foregroundHwnd: target.hwnd, foregroundPid: target.pid }; },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [target], allowForegroundInput: true, allowDesktopCapture: true, background: { source: 'cua-uia-0.54' } },
    transport,
    inspector,
  });
  assert.ok(backend.capabilities.some(capability => capability.kind === 'type' && capability.targets.includes('point')));
  const frame = await backend.observe({ view: 'controls' });
  const point = { x: 150, y: 250 };
  const result = await backend.dispatch({ frame, step: { kind: 'type', target: { point }, text: 'Review' } });
  assert.deepEqual(result, { status: 'dispatched' });
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].recipient.foreground, true);
  assert.deepEqual(dispatches[0].recipient.point, point);
  assert.equal(dispatches[0].recipient.window.hwnd, target.hwnd);
  await backend.close();
});

test('Windows backend advertises and dispatches explicit foreground selector/ref type through a fresh control center', async () => {
  const dispatches = [];
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(window) {
      return {
        target: window,
        bounds: { x: 100, y: 200, width: 500, height: 300 },
        complete: true,
        elements: [
          { index: '0', depth: 0, role: 'Window', label: 'Excel', actions: [], rect: { x: 100, y: 200, width: 500, height: 300 } },
          { index: '1', depth: 1, role: 'Edit', label: 'E8', actions: ['text'], editable: true, token: 'e8-token', rect: { x: 140, y: 240, width: 20, height: 20 } },
        ],
      };
    },
    async dispatch(step, recipient) { dispatches.push({ step, recipient }); return { status: 'dispatched' }; },
  };
  const inspector = {
    async read(window) {
      return { target: window, visible: true, minimized: false, bounds: { x: 100, y: 200, width: 500, height: 300 }, foregroundHwnd: target.hwnd, foregroundPid: target.pid };
    },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [target], allowForegroundInput: true, allowDesktopCapture: true, background: { source: 'cua-uia-0.54' } },
    transport,
    inspector,
  });
  const typeCapability = backend.capabilities.find(capability => capability.kind === 'type');
  assert.ok(typeCapability?.foreground);
  assert.equal(typeCapability?.targets.includes('selector'), true);
  assert.equal(typeCapability?.targets.includes('ref'), true);
  const frame = await backend.observe({ view: 'controls' });
  const editor = frame.controls.find(control => control.name === 'E8');
  assert.ok(editor?.rect);
  const result = await backend.dispatch({ frame, step: { kind: 'type', target: { ref: editor.id }, text: 'Review', delivery: 'foreground' } });
  assert.deepEqual(result, { status: 'dispatched' });
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].recipient.foreground, true);
  assert.deepEqual(dispatches[0].recipient.point, { x: 150, y: 250 });
  await backend.close();
});

test('CUA captures a verified post-type editor focus for a later focusFromStep handoff', async () => {
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const bounds = { x: 100, y: 200, width: 500, height: 300 };
  const cell = { x: 140, y: 240, width: 80, height: 24 };
  let phase = 0;
  const dispatches = [];
  const snapshot = window => ({
    target: window,
    title: 'Excel fixture',
    bounds,
    screenshotWidth: 500,
    screenshotHeight: 300,
    screenshotOrigin: { x: 100, y: 200 },
    complete: true,
    elements: phase === 0
      ? [
        { index: '0', depth: 0, role: 'Window', label: 'Excel', actions: [], rect: bounds },
        { index: '1', depth: 1, role: 'DataItem', label: 'E8', actions: ['set_value'], editable: true, token: 'e8-token', rect: cell },
      ]
      : [
        { index: '0', depth: 0, role: 'Window', label: 'Excel', actions: [], rect: bounds },
        { index: '2', depth: 1, role: 'Edit', label: 'E8 editor', actions: ['text'], editable: true, token: 'edit-token', rect: cell },
      ],
  });
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(window) { return snapshot(window); },
    async observeDesktopImage() { return { mimeType: 'image/png', dataBase64: 'fixture', width: 500, height: 300 }; },
    async dispatch(step, recipient) {
      dispatches.push({ step, recipient });
      if (step.kind === 'type') phase = 1;
      return { status: 'dispatched' };
    },
  };
  const inspector = {
    async read(window) {
      return { target: window, visible: true, minimized: false, bounds, foregroundHwnd: target.hwnd, foregroundPid: target.pid };
    },
    async readFocused(window) {
      return phase === 0
        ? { target: window, focused: false, pid: target.pid, hwnd: target.hwnd }
        : { target: window, focused: true, pid: target.pid, hwnd: target.hwnd, runtimeId: 'edit-runtime', role: 'Edit', bounds: cell };
    },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [target], allowForegroundInput: true, allowDesktopCapture: true, background: { source: 'cua-uia-0.54' } },
    transport, inspector,
  });
  const session = createDeskSession(backend, { allowModelImages: true, policy: () => ({ decision: 'allow', code: 'test' }) });
  const observed = await session.observe({ view: 'both' });
  const result = await session.act({
    observationId: observed.observationId,
    steps: [
      { kind: 'type', target: { point: { x: 180, y: 252 } }, text: 'Review' },
      { kind: 'keypress', target: { focusFromStep: 1 }, key: 'Enter' },
    ],
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(dispatches.map(entry => entry.step.kind), ['type', 'keypress']);
  await session.close();
});

test('CUA preserves a dispatched type receipt when post-type focus is unrelated', async () => {
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const bounds = { x: 100, y: 200, width: 500, height: 300 };
  const cell = { x: 140, y: 240, width: 80, height: 24 };
  let phase = 0;
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(window) {
      return {
        target: window, bounds, screenshotWidth: 500, screenshotHeight: 300, screenshotOrigin: { x: 100, y: 200 }, complete: true,
        elements: [
          { index: '0', depth: 0, role: 'Window', label: 'Excel', actions: [], rect: bounds },
          phase === 0
            ? { index: '1', depth: 1, role: 'DataItem', label: 'E8', actions: ['set_value'], editable: true, token: 'e8-token', rect: cell }
            : { index: '9', depth: 1, role: 'Edit', label: 'unrelated editor', actions: ['text'], editable: true, token: 'other-token', rect: { x: 300, y: 240, width: 80, height: 24 } },
        ],
      };
    },
    async dispatch(step) { if (step.kind === 'type') phase = 1; return { status: 'dispatched' }; },
  };
  const inspector = {
    async read(window) { return { target: window, visible: true, minimized: false, bounds, foregroundHwnd: target.hwnd, foregroundPid: target.pid }; },
    async readFocused(window) {
      return phase === 0
        ? { target: window, focused: false, pid: target.pid, hwnd: target.hwnd }
        : { target: window, focused: true, pid: target.pid, hwnd: target.hwnd, runtimeId: 'other-runtime', role: 'Edit', bounds: { x: 300, y: 240, width: 80, height: 24 } };
    },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [target], allowForegroundInput: true, allowDesktopCapture: true, background: { source: 'cua-uia-0.54' } },
    transport, inspector,
  });
  const frame = await backend.observe({ view: 'both' });
  const result = await backend.dispatch({
    frame,
    captureFocus: true,
    step: { kind: 'type', target: { point: { x: 180, y: 252 } }, text: 'Review' },
  });
  assert.deepEqual(result, { status: 'dispatched' });
  await backend.close();
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

test('CUA transport dispatches bounded Word keyboard commands to the exact foreground window', async () => {
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
  const transport = await CuaWindowsTransport.open(driver, 'keyboard-session');
  const recipient = { window: target, foreground: true };
  assert.deepEqual(await transport.dispatch({ kind: 'keypress', target: { ref: 'focused' }, key: 'F12' }, recipient, {}), { status: 'dispatched' });
  assert.deepEqual(await transport.dispatch({ kind: 'hotkey', target: { ref: 'focused' }, keys: ['ctrl', 's'] }, recipient, {}), { status: 'dispatched' });
  assert.deepEqual(await transport.dispatch({ kind: 'hotkey', target: { ref: 'focused' }, keys: ['ctrl', 'shift', 's'] }, recipient, {}), { status: 'dispatched' });
  assert.deepEqual(calls.map(call => call.name), ['press_key', 'hotkey', 'hotkey']);
  assert.equal(calls[0].args.key, 'F12');
  assert.deepEqual(calls[1].args.keys, ['ctrl', 's']);
  assert.deepEqual(calls[2].args.keys, ['ctrl', 'shift', 's']);
  assert.deepEqual(calls.map(call => call.args.target), [
    { kind: 'window', pid: target.pid, window_id: calls[0].args.target.window_id },
    { kind: 'window', pid: target.pid, window_id: calls[1].args.target.window_id },
    { kind: 'window', pid: target.pid, window_id: calls[2].args.target.window_id },
  ]);
  assert.equal(String(calls[0].args.target.window_id), String(target.hwnd));
  assert.equal(String(calls[1].args.target.window_id), String(target.hwnd));
  assert.equal(String(calls[2].args.target.window_id), String(target.hwnd));
  assert.equal(calls.every(call => call.args.session === 'keyboard-session'), true);
  assert.equal(calls.every(call => call.args.delivery_mode === undefined), true);
  await transport.close();
});

test('CUA preserves target-bound synthetic keyboard sends as dispatched but unverified', async () => {
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const driver = {
    async metadata() { return { driverVersion: '0.54.0' }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async callTool(name) {
      if (name === 'hotkey') {
        return { isError: false, action: { effect: 2, route: 1, delivery: { mode: 3 } } };
      }
      return { isError: false };
    },
  };
  const transport = await CuaWindowsTransport.open(driver, 'keyboard-unverified-session');
  const result = await transport.dispatch({ kind: 'hotkey', target: { ref: 'focused' }, keys: ['ctrl', 'a'] }, {
    window: target,
    foreground: true,
  }, {});
  assert.deepEqual(result, { status: 'dispatched', code: 'effect_unverifiable' });
  await transport.close();
});

test('CUA preserves top-level native Tool error codes for keyboard refusals', async () => {
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const driver = {
    async metadata() { return { driverVersion: '0.54.0' }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async callTool(name) {
      if (name === 'hotkey') {
        const error = new Error('native tool rejected arguments');
        error.errorCode = 'invalid_arguments';
        throw error;
      }
      return { isError: false };
    },
  };
  const transport = await CuaWindowsTransport.open(driver, 'keyboard-error-session');
  const result = await transport.dispatch({ kind: 'hotkey', target: { ref: 'focused' }, keys: ['ctrl', 'a'] }, {
    window: target,
    foreground: true,
  }, {});
  assert.deepEqual(result, { status: 'refused', code: 'invalid_arguments' });
  await transport.close();
});

test('foreground keyboard dispatch requires observed focus and verifies HWND plus PID', async () => {
  const calls = [];
  let foreground = { hwnd: targetB.hwnd, pid: targetB.pid };
  const focusedSnapshot = {
    target: targetA,
    title: 'Word',
    bounds: { x: 20, y: 30, width: 420, height: 280 },
    complete: true,
    elements: [
      { index: '0', depth: 0, role: 'Window', label: 'Word', actions: [], rect: { x: 20, y: 30, width: 420, height: 280 } },
      { index: '1', depth: 1, role: 'Document', label: 'Document', actions: ['text'], focused: true, editable: true, runtimeId: 'doc-runtime-1', token: 'focused-document', rect: { x: 40, y: 70, width: 300, height: 180 }, parentIndex: '0' },
    ],
  };
  const transport = {
    source: 'cua-uia-0.54',
    activations: 0,
    async observeWindow() { return focusedSnapshot; },
    async bringToFront(target) {
      calls.push({ kind: 'bringToFront', target });
      this.activations += 1;
      foreground = { hwnd: target.hwnd, pid: target.pid };
      return { status: 'dispatched' };
    },
    async dispatch(step, target) {
      calls.push({ kind: 'dispatch', step, target });
      return { status: 'dispatched' };
    },
  };
  const inspector = {
    async read(target) {
      return { target, visible: true, minimized: false, bounds: { x: 20, y: 30, width: 420, height: 280 }, foregroundHwnd: foreground.hwnd, foregroundPid: foreground.pid };
    },
    async readFocused(target) {
      return { target, focused: true, pid: target.pid, hwnd: target.hwnd, runtimeId: 'doc-runtime-1', role: 'Document' };
    },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA], allowForegroundInput: true },
    transport,
    inspector,
  });
  const frame = await backend.observe({ view: 'controls' });
  const document = frame.controls.find(control => control.role === 'Document');
  assert.ok(document?.actions.includes('keypress'));
  assert.ok(document?.actions.includes('hotkey'));
  const result = await backend.dispatch({
    frame,
    target: document,
    step: { kind: 'hotkey', target: { ref: document.id }, keys: ['ctrl', 'shift', 's'] },
  });
  assert.deepEqual(result, { status: 'dispatched' });
  assert.deepEqual(calls.map(call => call.kind), ['bringToFront', 'dispatch']);
  assert.equal(transport.activations, 1);
  assert.equal(calls[1].target.foreground, true);
  assert.equal(calls[1].target.window.hwnd, targetA.hwnd);
  assert.equal(calls[1].target.window.pid, targetA.pid);
  await backend.close();
});

test('foreground activation rechecks native RuntimeId focus and rejects a replaced control', async () => {
  const calls = [];
  let foreground = { hwnd: targetB.hwnd, pid: targetB.pid };
  let focusRuntimeId = 'doc-runtime-1';
  const snapshot = {
    target: targetA,
    title: 'Word',
    bounds: { x: 20, y: 30, width: 420, height: 280 },
    complete: true,
    elements: [{ index: '1', depth: 0, role: 'Document', label: 'Document', actions: ['text'], runtimeId: 'doc-runtime-1', token: 'focused-document', rect: { x: 40, y: 70, width: 300, height: 180 } }],
  };
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow() { return snapshot; },
    async bringToFront(target) {
      calls.push({ kind: 'bringToFront', target });
      foreground = { hwnd: target.hwnd, pid: target.pid };
      focusRuntimeId = 'replacement-runtime';
      return { status: 'dispatched' };
    },
    async dispatch(step, target) {
      calls.push({ kind: 'dispatch', step, target });
      return { status: 'dispatched' };
    },
  };
  const inspector = {
    async read(target) {
      return { target, visible: true, minimized: false, bounds: { x: 20, y: 30, width: 420, height: 280 }, foregroundHwnd: foreground.hwnd, foregroundPid: foreground.pid };
    },
    async readFocused(target) {
      return { target, focused: true, pid: target.pid, hwnd: target.hwnd, runtimeId: focusRuntimeId, role: 'Document' };
    },
  };
  const backend = await createWindowsDesktopBackend({ authorization: { targets: [targetA], allowForegroundInput: true }, transport, inspector });
  const frame = await backend.observe({ view: 'controls' });
  const document = frame.controls.find(control => control.role === 'Document');
  assert.ok(document?.actions.includes('hotkey'));
  const result = await backend.dispatch({ frame, target: document, step: { kind: 'hotkey', target: { ref: document.id }, keys: ['ctrl', 's'] } });
  assert.deepEqual(result, { status: 'refused', code: 'keyboard_focus_not_confirmed' });
  assert.deepEqual(calls.map(call => call.kind), ['bringToFront']);
  await backend.close();
});

test('CUA foreground hotkeys use an optional exact native chord route without transport fallback', async () => {
  const calls = [];
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(window) {
      return {
        target: window,
        bounds: { x: 20, y: 30, width: 420, height: 280 },
        complete: true,
        elements: [
          { index: '0', depth: 0, role: 'Window', label: 'Word', actions: [], rect: { x: 20, y: 30, width: 420, height: 280 } },
          { index: '1', depth: 1, role: 'Document', label: 'Document', actions: ['text'], focused: true, editable: true, runtimeId: 'doc-runtime-1', token: 'focused-document', rect: { x: 40, y: 70, width: 300, height: 180 } },
        ],
      };
    },
    async authorizeForegroundHotkey() { return undefined; },
    async dispatch() { throw new Error('transport_hotkey_must_not_run'); },
  };
  const inspector = {
    async read(window) { return { target: window, visible: true, minimized: false, bounds: { x: 20, y: 30, width: 420, height: 280 }, foregroundHwnd: window.hwnd, foregroundPid: window.pid }; },
    async readFocused(window) { return { target: window, focused: true, pid: window.pid, hwnd: window.hwnd, runtimeId: 'doc-runtime-1', role: 'Document' }; },
    async dispatchHotkey(window, keys, focused) {
      calls.push({ window, keys, focused });
      return { status: 'dispatched' };
    },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [targetA], allowForegroundInput: true },
    transport,
    inspector,
  });
  const frame = await backend.observe({ view: 'controls' });
  const document = frame.controls.find(control => control.role === 'Document');
  const result = await backend.dispatch({ frame, target: document, step: { kind: 'hotkey', target: { ref: document.id }, keys: ['ctrl', 's'] } });
  assert.deepEqual(result, { status: 'dispatched' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].window.hwnd, targetA.hwnd);
  assert.deepEqual(calls[0].keys, ['ctrl', 's']);
  assert.equal(calls[0].focused.runtimeId, 'doc-runtime-1');
  await backend.close();
});

test('native foreground hotkey partial or wrong-receiver results are terminal and never replayed', async () => {
  for (const outcome of [{ status: 'partial', code: 'native_hotkey_partial' }, { status: 'unknown', code: 'native_hotkey_focus_changed' }, { status: 'refused', code: 'native_hotkey_foreground_unconfirmed' }]) {
    const calls = [];
    const transport = {
      source: 'cua-uia-0.54',
      async observeWindow(window) {
        return {
          target: window,
          bounds: { x: 20, y: 30, width: 420, height: 280 },
          complete: true,
          elements: [
            { index: '0', depth: 0, role: 'Window', label: 'Word', actions: [], rect: { x: 20, y: 30, width: 420, height: 280 } },
            { index: '1', depth: 1, role: 'Document', label: 'Document', actions: ['text'], focused: true, editable: true, runtimeId: 'doc-runtime-1', token: 'focused-document', rect: { x: 40, y: 70, width: 300, height: 180 } },
          ],
        };
      },
      async authorizeForegroundHotkey() { return undefined; },
      async dispatch() { calls.push('transport'); return { status: 'dispatched' }; },
    };
    const inspector = {
      async read(window) { return { target: window, visible: true, minimized: false, bounds: { x: 20, y: 30, width: 420, height: 280 }, foregroundHwnd: window.hwnd, foregroundPid: window.pid }; },
      async readFocused(window) { return { target: window, focused: true, pid: window.pid, hwnd: window.hwnd, runtimeId: 'doc-runtime-1', role: 'Document' }; },
      async dispatchHotkey() { return outcome; },
    };
    const backend = await createWindowsDesktopBackend({ authorization: { targets: [targetA], allowForegroundInput: true }, transport, inspector });
    const frame = await backend.observe({ view: 'controls' });
    const document = frame.controls.find(control => control.role === 'Document');
    const result = await backend.dispatch({ frame, target: document, step: { kind: 'hotkey', target: { ref: document.id }, keys: ['ctrl', 's'] } });
    assert.deepEqual(result, outcome);
    assert.deepEqual(calls, []);
    await backend.close();
  }
});

test('CUA joins one native focused runtime ID to a unique geometry control as keyboard-only evidence', async () => {
  const dispatches = [];
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const bounds = { x: 100, y: 200, width: 500, height: 300 };
  const focusBounds = { x: 140, y: 240, width: 80, height: 24 };
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(window) {
      return {
        target: window,
        bounds,
        screenshotWidth: 500,
        screenshotHeight: 300,
        screenshotOrigin: { x: 100, y: 200 },
        complete: false,
        elements: [
          { index: '1', depth: 1, role: 'Pane', label: 'editor', actions: [], enabled: true, rect: focusBounds },
        ],
      };
    },
    async dispatch(step, recipient) { dispatches.push({ step, recipient }); return { status: 'dispatched' }; },
  };
  const inspector = {
    async read(window) { return { target: window, visible: true, minimized: false, bounds, foregroundHwnd: target.hwnd, foregroundPid: target.pid }; },
    async readFocused(window) { return { target: window, focused: true, pid: target.pid, hwnd: target.hwnd, runtimeId: 'native-pane-runtime', role: 'Pane', bounds: focusBounds }; },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [target], allowForegroundInput: true, background: { source: 'cua-uia-0.54' } },
    transport,
    inspector,
  });
  const frame = await backend.observe({ view: 'controls' });
  const focused = frame.controls.find(control => control.role === 'Pane');
  assert.ok(focused);
  assert.ok(focused.states.includes('focused'));
  assert.ok(focused.actions.includes('keypress'));
  assert.ok(focused.actions.includes('hotkey'));
  assert.equal(focused.actions.includes('click'), false);
  assert.equal(focused.actions.includes('type'), false);
  assert.equal(focused.actions.includes('setValue'), false);
  assert.equal(focused.effect, 'unknown');
  const result = await backend.dispatch({ frame, step: { kind: 'keypress', target: { ref: focused.id }, key: 'Enter' } });
  assert.deepEqual(result, { status: 'dispatched' });
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].recipient.foreground, true);
  await backend.close();
});

test('CUA exposes a synthetic keyboard-only focus ref when the native focused row is absent', async () => {
  const dispatches = [];
  const target = { pid: 41001, hwnd: 0x100000000001n };
  const bounds = { x: 100, y: 200, width: 500, height: 300 };
  const focusBounds = { x: 140, y: 240, width: 80, height: 24 };
  const transport = {
    source: 'cua-uia-0.54',
    async observeWindow(window) {
      return {
        target: window,
        bounds,
        screenshotWidth: 500,
        screenshotHeight: 300,
        screenshotOrigin: { x: 100, y: 200 },
        complete: false,
        elements: [
          { index: '1', depth: 1, role: 'Pane', label: 'worksheet', actions: [], enabled: true, rect: { x: 100, y: 200, width: 500, height: 80 } },
          { index: '2', depth: 2, role: 'Edit', label: 'cell-editor', actions: ['text'], enabled: true, rect: focusBounds },
        ],
      };
    },
    async dispatch(step, recipient) { dispatches.push({ step, recipient }); return { status: 'dispatched' }; },
  };
  const inspector = {
    async read(window) { return { target: window, visible: true, minimized: false, bounds, foregroundHwnd: target.hwnd, foregroundPid: target.pid }; },
    async readFocused(window) { return { target: window, focused: true, pid: target.pid, hwnd: target.hwnd, runtimeId: 'native-pane-runtime', role: 'Pane', bounds: focusBounds }; },
  };
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [target], allowForegroundInput: true, background: { source: 'cua-uia-0.54' } },
    transport,
    inspector,
  });
  const frame = await backend.observe({ view: 'controls' });
  const focused = frame.controls.find(control => control.role === 'Pane' && control.states.includes('focused'));
  assert.ok(focused);
  assert.equal(focused.rect, undefined);
  assert.deepEqual(focused.states, ['focused']);
  assert.deepEqual(focused.actions, ['keypress', 'hotkey']);
  assert.equal(focused.effect, 'unknown');
  const result = await backend.dispatch({ frame, step: { kind: 'keypress', target: { ref: focused.id }, key: 'Enter' } });
  assert.deepEqual(result, { status: 'dispatched' });
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].recipient.point, undefined);
  await backend.close();
});

test('host foreground activator refuses an HWND whose foreground PID does not match', async () => {
  let observed = { hwnd: targetB.hwnd, pid: targetB.pid };
  const activation = createWindowsForegroundActivator({
    async bringToFront() { return { status: 'dispatched' }; },
  }, {
    async read(target) {
      return { target, visible: true, minimized: false, foregroundHwnd: observed.hwnd, foregroundPid: observed.pid };
    },
  });
  const refused = await activation(targetA, {});
  assert.deepEqual(refused, { status: 'refused', code: 'foreground_not_confirmed' });
  observed = { hwnd: targetA.hwnd, pid: targetA.pid };
  assert.deepEqual(await activation(targetA, {}), { status: 'dispatched' });
});
