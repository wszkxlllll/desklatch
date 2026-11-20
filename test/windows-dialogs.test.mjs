import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowsDesktopBackend, createWindowsOwnedDialogInspector } from '../dist/backends/windows/index.js';

const target = { pid: 7001, hwnd: 0x70010001n, title: 'authorized parent' };

function fakeNativeWindows() {
  const windows = new Map([
    [target.hwnd, { pid: target.pid, owner: undefined, visible: true, iconic: false, style: 0, bounds: { x: 10, y: 20, width: 600, height: 400 } }],
    [0x70010002n, { pid: target.pid, owner: target.hwnd, visible: true, iconic: false, style: 0, bounds: { x: 90, y: 100, width: 280, height: 180 } }],
    [0x70010003n, { pid: target.pid, owner: 0x70010002n, visible: true, iconic: false, style: 0, bounds: { x: 110, y: 120, width: 160, height: 100 } }],
    [0x70010004n, { pid: target.pid, owner: target.hwnd, visible: true, iconic: false, style: 0x40000000, bounds: { x: 120, y: 130, width: 160, height: 100 } }],
    [0x70010005n, { pid: target.pid, owner: undefined, visible: true, iconic: false, style: 0, bounds: { x: 140, y: 150, width: 160, height: 100 } }],
    [0x70010006n, { pid: target.pid + 1, owner: target.hwnd, visible: true, iconic: false, style: 0, bounds: { x: 160, y: 170, width: 160, height: 100 } }],
    [0x70010007n, { pid: target.pid, owner: target.hwnd, visible: false, iconic: false, style: 0, bounds: { x: 180, y: 190, width: 160, height: 100 } }],
    [0x70010008n, { pid: target.pid, owner: target.hwnd, visible: true, iconic: true, style: 0, bounds: { x: 200, y: 210, width: 160, height: 100 } }],
    [0x70010009n, { pid: target.pid, owner: target.hwnd, visible: true, iconic: false, style: 0, bounds: { x: 0, y: 0, width: 0, height: 0 } }],
  ]);
  return {
    enumerateTopLevelWindows(visit) {
      for (const hwnd of windows.keys()) if (!visit(hwnd)) return false;
      return true;
    },
    isWindow(hwnd) { return windows.has(hwnd); },
    isWindowVisible(hwnd) { return windows.get(hwnd)?.visible ?? false; },
    isIconic(hwnd) { return windows.get(hwnd)?.iconic ?? false; },
    processId(hwnd) { return windows.get(hwnd)?.pid; },
    owner(hwnd) { return windows.get(hwnd)?.owner; },
    bounds(hwnd) { return windows.get(hwnd)?.bounds; },
    style(hwnd) { return windows.get(hwnd)?.style; },
  };
}

test('owned-dialog discovery returns visible bounded same-PID top-level owner-chain windows only', async () => {
  const inspector = createWindowsOwnedDialogInspector(fakeNativeWindows());
  const dialogs = await inspector.findOwnedDialogs(target);

  assert.deepEqual(dialogs.map((dialog) => dialog.hwnd), [0x70010002n, 0x70010003n]);
  assert.deepEqual(dialogs[0].ownerChain, [target.hwnd]);
  assert.deepEqual(dialogs[1].ownerChain, [0x70010002n, target.hwnd]);
  assert.equal(dialogs[0].bounds.width, 280);
});

test('owned-dialog discovery never widens to a foreign or unrelated same-PID window', async () => {
  const inspector = createWindowsOwnedDialogInspector(fakeNativeWindows());
  const dialogs = await inspector.findOwnedDialogs({ ...target, hwnd: 0x70010005n });
  assert.deepEqual(dialogs, []);
});

test('owned-dialog discovery can be cancelled without dispatching or changing windows', async () => {
  const controller = new AbortController();
  controller.abort();
  const inspector = createWindowsOwnedDialogInspector(fakeNativeWindows());
  await assert.rejects(inspector.findOwnedDialogs(target, { signal: controller.signal }), { name: 'AbortError' });
});

test('desktop backend exposes owned-dialog evidence only for an enrolled parent', async () => {
  const calls = [];
  const owned = [{ target, hwnd: 0x70010002n, pid: target.pid, ownerHwnd: target.hwnd, ownerChain: [target.hwnd], bounds: { x: 90, y: 100, width: 280, height: 180 } }];
  const backend = await createWindowsDesktopBackend({
    authorization: { targets: [target] },
    transport: {
      async observeWindow(enrolled) { return { target: enrolled, title: 'parent', complete: true, elements: [] }; },
      async dispatch() { return { status: 'dispatched' }; },
    },
    inspector: { async read(enrolled) { return { target: enrolled, visible: true, minimized: false }; } },
    ownedDialogInspector: {
      async findOwnedDialogs(enrolled) {
        calls.push(enrolled);
        return owned;
      },
    },
  });
  assert.deepEqual(await backend.findOwnedDialogs(target), owned);
  assert.deepEqual(await backend.findOwnedDialogs({ pid: target.pid, hwnd: target.hwnd + 1n }), []);
  assert.equal(calls.length, 1);
  await backend.close();
});
