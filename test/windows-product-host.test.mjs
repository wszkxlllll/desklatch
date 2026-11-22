import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowsProductHost } from '../dist/product/windows-host.js';

function fixtureState(target, title) {
  return {
    target,
    title,
    bounds: target.hwnd === 10001n ? { x: 20, y: 30, width: 400, height: 260 } : { x: 500, y: 30, width: 400, height: 260 },
    complete: true,
    elements: [
      { index: '0', depth: 0, role: 'Window', label: title, actions: [], rect: target.hwnd === 10001n ? { x: 20, y: 30, width: 400, height: 260 } : { x: 500, y: 30, width: 400, height: 260 } },
      { index: '1', depth: 1, role: 'Button', label: 'Go', actions: ['invoke'], token: `uia1.${target.hwnd.toString()}button`, rect: target.hwnd === 10001n ? { x: 40, y: 60, width: 100, height: 30 } : { x: 520, y: 60, width: 100, height: 30 }, enabled: true },
      { index: '2', depth: 1, role: 'Edit', label: 'Value', actions: ['set_value'], token: `uia1.${target.hwnd.toString()}edit`, rect: target.hwnd === 10001n ? { x: 40, y: 110, width: 180, height: 30 } : { x: 520, y: 110, width: 180, height: 30 }, enabled: true },
    ],
  };
}

function makeHostFixture() {
  let foreground;
  let grants = {
    version: 1,
    apps: [{ id: 'editor', name: 'Editor' }, { id: 'browser', name: 'Browser' }],
    allowDesktopCapture: false,
    allowForegroundInput: false,
  };
  const windows = [
    { id: 'editor-main', appId: 'editor', appName: 'Editor', title: 'Editor Main', pid: 1001, hwnd: 10001n, processStartedAt: 'editor-start' },
    { id: 'editor-dialog', appId: 'editor', appName: 'Editor', title: 'Editor Dialog', pid: 1001, hwnd: 10002n, processStartedAt: 'editor-start', ownerHwnd: 10001n },
    { id: 'browser-main', appId: 'browser', appName: 'Browser', title: 'Browser Main', pid: 1002, hwnd: 20001n, processStartedAt: 'browser-start' },
    { id: 'unknown-main', appId: 'unknown', appName: 'Unknown', title: 'Unknown Main', pid: 1003, hwnd: 30001n, processStartedAt: 'unknown-start' },
  ];
  const contexts = [];
  const dispatches = [];
  const imageCaptures = [];
  const windowImageCaptures = [];
  const restored = [];
  const seams = {
    async readWindowsProductGrants() { return grants; },
    async listWindowsAppWindows({ includeMinimized = false } = {}) {
      return windows.filter(window => includeMinimized || !window.minimized);
    },
    async verifyWindowsAppWindow(window) {
      return windows.some(candidate => candidate.id === window.id && candidate.hwnd === window.hwnd && !candidate.minimized);
    },
    async restoreMinimizedWindow(window) {
      restored.push(window.hwnd);
      window.minimized = false;
      return true;
    },
    async transportFactory(context) {
      contexts.push(context);
      return {
        transport: {
          source: 'cua-uia-0.54',
          async observeWindow(target) {
            const window = context.windows.find(candidate => candidate.hwnd === target.hwnd);
            return fixtureState(target, window?.title ?? target.title ?? 'Window');
          },
          async dispatch(step, target) {
            dispatches.push({ appId: context.app.id, step, target });
            return { status: 'dispatched' };
          },
          async observeDesktopImage() {
            imageCaptures.push({ appId: context.app.id });
            return { mimeType: 'image/png', dataBase64: 'AA==', width: 1000, height: 1000 };
          },
          async observeWindowImage(target) {
            windowImageCaptures.push({ appId: context.app.id, target });
            return { mimeType: 'image/png', dataBase64: 'AA==', width: 1000, height: 1000 };
          },
          async bringToFront(target) {
            foreground = target;
            return { status: 'dispatched' };
          },
        },
        inspector: {
          async read(target) {
            const bounds = target.hwnd === 10001n
              ? { x: 20, y: 30, width: 400, height: 260 }
              : { x: 500, y: 30, width: 400, height: 260 };
            const minimized = context.windows.find(window => window.hwnd === target.hwnd)?.minimized === true;
            return { target, visible: !minimized, minimized, bounds, foregroundHwnd: foreground?.hwnd, foregroundPid: foreground?.pid };
          },
        },
      };
    },
    policy: () => ({ decision: 'allow', code: 'product_test' }),
  };
  return { seams, windows, contexts, dispatches, imageCaptures, windowImageCaptures, restored, setGrants(value) { grants = value; } };
}

test('explicit activation restores a granted minimized window on first switch and when returning to the active app', async () => {
  const fixture = makeHostFixture();
  fixture.setGrants({ version: 1, apps: [{ id: 'browser', name: 'Browser' }], allowDesktopCapture: false, allowForegroundInput: true });
  const browser = fixture.windows.find(window => window.appId === 'browser');
  browser.minimized = true;
  const workspace = await createWindowsProductHost({ authorizationFile: 'ignored-for-seams', test: fixture.seams });
  try {
    assert.deepEqual((await workspace.observe({ workspace: true })).applications.map(app => app.id), ['browser']);
    assert.deepEqual(fixture.restored, []);
    assert.equal((await workspace.act({ activate: 'browser' })).code, 'activated');
    assert.deepEqual(fixture.restored, [browser.hwnd]);
    assert.equal((await workspace.observe({ view: 'controls' })).controls.some(control => control.name === 'Go'), true);

    browser.minimized = true;
    await workspace.observe({ workspace: true });
    assert.deepEqual(fixture.restored, [browser.hwnd]);
    assert.equal((await workspace.act({ activate: 'browser' })).code, 'activated');
    assert.deepEqual(fixture.restored, [browser.hwnd, browser.hwnd]);
    assert.equal((await workspace.act({ activate: 'browser' })).code, 'already_active');
  } finally {
    await workspace.close();
  }
});

test('minimized activation requires current application and foreground permissions', async () => {
  const fixture = makeHostFixture();
  fixture.windows.find(window => window.appId === 'browser').minimized = true;
  const workspace = await createWindowsProductHost({ authorizationFile: 'ignored-for-seams', test: fixture.seams });
  try {
    assert.equal((await workspace.act({ activate: 'browser' })).code, 'application_window_unavailable');
    assert.deepEqual(fixture.restored, []);

    const grant = { version: 1, apps: [{ id: 'browser', name: 'Browser' }], allowDesktopCapture: false, allowForegroundInput: true };
    fixture.setGrants(grant);
    const list = fixture.seams.listWindowsAppWindows;
    fixture.seams.listWindowsAppWindows = async options => {
      if (options?.includeMinimized) fixture.setGrants({ ...grant, apps: [] });
      return list(options);
    };
    assert.equal((await workspace.act({ activate: 'browser' })).code, 'application_automation_blocked');
    assert.deepEqual(fixture.restored, []);
  } finally {
    await workspace.close();
  }
});

test('product host exposes only granted apps and includes owned child windows under the app grant', async () => {
  const fixture = makeHostFixture();
  const workspace = await createWindowsProductHost({
    authorizationFile: 'ignored-for-seams',
    onApprovalRequested: () => 'allow',
    test: fixture.seams,
  });
  const inventory = await workspace.observe({ workspace: true });
  assert.deepEqual(inventory.applications.map(app => app.id), ['editor', 'browser']);
  assert.equal(inventory.applications.some(app => app.id === 'unknown'), false);

  const activatedEditor = await workspace.act({ activate: 'editor' });
  assert.equal(activatedEditor.status, 'completed', JSON.stringify({ activatedEditor, contexts: fixture.contexts.map(context => ({ app: context.app, windows: context.windows.map(window => window.id) })) }));
  const editorObservation = await workspace.observe({ view: 'controls' });
  const editorAct = await workspace.act({
    observationId: editorObservation.observationId,
    steps: [{ kind: 'click', target: { role: 'Button', name: 'Go', within: 'Editor Main' } }],
  });
  assert.equal(editorAct.status, 'completed', JSON.stringify(editorAct));
  assert.equal(fixture.contexts.find(context => context.app.id === 'editor').windows.length, 2);
  assert.equal(fixture.dispatches.at(-1).appId, 'editor');

  assert.equal((await workspace.act({ activate: 'browser' })).status, 'completed');
  const browserObservation = await workspace.observe({ view: 'controls' });
  const browserAct = await workspace.act({
    observationId: browserObservation.observationId,
    steps: [{ kind: 'click', target: { role: 'Button', name: 'Go', within: 'Browser Main' } }],
  });
  assert.equal(browserAct.status, 'completed');
  assert.equal(fixture.dispatches.at(-1).appId, 'browser');

  fixture.setGrants({ version: 1, apps: [{ id: 'editor', name: 'Editor' }], allowDesktopCapture: false, allowForegroundInput: false });
  const revoked = await workspace.act({
    observationId: browserObservation.observationId,
    steps: [{ kind: 'click', target: { role: 'Button', name: 'Go', within: 'Browser Main' } }],
  });
  assert.equal(revoked.status, 'stopped');
  assert.equal(revoked.code, 'application_automation_blocked');
  await workspace.close();
});

test('product host supports a first load with no enrolled apps without opening CUA', async () => {
  const fixture = makeHostFixture();
  fixture.setGrants({ version: 1, apps: [], allowDesktopCapture: false, allowForegroundInput: false });
  let opened = false;
  const seams = { ...fixture.seams, async transportFactory(context) { opened = true; return fixture.seams.transportFactory(context); } };
  const workspace = await createWindowsProductHost({ authorizationFile: 'ignored-for-seams', test: { ...seams } });
  const inventory = await workspace.observe({ workspace: true });
  assert.deepEqual(inventory.applications, []);
  assert.equal(opened, false);
  await workspace.close();
});

test('an explicit window scope restricts selector and reference refresh to that authorized window', async t => {
  const fixture = makeHostFixture();
  const read = [];
  const workspace = await createWindowsProductHost({ authorizationFile: 'ignored-for-seams', test: {
    ...fixture.seams,
    async transportFactory(context) {
      const opened = await fixture.seams.transportFactory(context);
      const observe = opened.transport.observeWindow;
      opened.transport.observeWindow = (window, options) => {
        read.push({ hwnd: window.hwnd, where: options.where });
        return observe(window, options);
      };
      return opened;
    },
  } });
  t.after(() => workspace.close());
  assert.equal((await workspace.act({ activate: 'editor' })).status, 'completed');
  const snapshot = await workspace.observe({ view: 'controls' });
  const selected = snapshot.controls.find(control => control.name === 'Go' && control.windowScope === 'hwnd:1001:10001');
  assert.ok(selected?.ref);
  read.length = 0;
  const targeted = await workspace.act({ steps: [{ kind: 'click', target: {
    role: 'Button', name: 'Go', within: selected.windowScope,
  } }] });
  assert.equal(targeted.status, 'completed');
  assert.ok(read.length > 0);
  assert.ok(read.every(({ hwnd, where }) => hwnd === 10001n && where?.name === 'Go'));
  read.length = 0;
  const referenced = await workspace.act({ observationId: snapshot.observationId, steps: [{ kind: 'click', target: { ref: selected.ref } }] });
  assert.equal(referenced.status, 'completed');
  assert.ok(read.length > 0 && read.every(({ hwnd }) => hwnd === 10001n));
  assert.equal(fixture.dispatches.at(-1).target.window.hwnd, 10001n);
});

test('the authorized Office host advertises focused saving and gates it through approval', async t => {
  const fixture = makeHostFixture();
  fixture.setGrants({ version: 1, apps: [{ id: 'editor', name: 'WINWORD' }], allowDesktopCapture: false, allowForegroundInput: true });
  const { policy: _ignored, ...seams } = fixture.seams;
  const workspace = await createWindowsProductHost({ authorizationFile: 'ignored-for-seams', test: {
    ...seams,
    async transportFactory(context) {
      const opened = await seams.transportFactory(context);
      const observe = opened.transport.observeWindow;
      opened.transport.observeWindow = async (window, options) => {
        const snapshot = await observe(window, options);
        return { ...snapshot, elements: snapshot.elements.map(element => element.label === 'Value'
          ? { ...element, role: 'Document', editable: true, runtimeId: 'document-focused' } : element) };
      };
      opened.inspector.readFocused = async target => ({ target, focused: true, runtimeId: 'document-focused', pid: target.pid, hwnd: target.hwnd });
      return opened;
    },
  } });
  t.after(() => workspace.close());
  const activation = await workspace.act({ activate: 'editor' });
  assert.ok(activation.capabilities.some(capability => capability.kind === 'hotkey'));
  assert.ok((await workspace.observe({ workspace: true })).activeCapabilities.some(capability => capability.kind === 'hotkey'));
  const target = {
    name: 'Value', role: 'Document', within: 'hwnd:1001:10001',
  };
  const select = await workspace.act({ steps: [{ kind: 'hotkey', keys: ['ctrl', 'a'], target }] });
  assert.equal(select.status, 'completed');
  assert.equal(fixture.dispatches.length, 1);
  const save = await workspace.act({ steps: [{ kind: 'hotkey', keys: ['ctrl', 's'], target }] });
  assert.equal(save.code, 'approval_required');
  assert.equal(fixture.dispatches.length, 1);
  assert.equal((await workspace.resolveApproval(save.requestId, 'approve')).status, 'completed');
  assert.equal(fixture.dispatches.length, 2);
});

test('the guarded Office backend forwards the type action kind to writable point hit testing', async t => {
  const fixture = makeHostFixture();
  fixture.setGrants({ version: 1, apps: [{ id: 'editor', name: 'EXCEL' }], allowDesktopCapture: true, allowForegroundInput: true });
  const { policy: _ignored, ...seams } = fixture.seams;
  const workspace = await createWindowsProductHost({ authorizationFile: 'ignored-for-seams', test: {
    ...seams,
    async transportFactory(context) {
      const opened = await seams.transportFactory(context);
      const observe = opened.transport.observeWindow;
      opened.transport.observeWindow = async (window, options) => {
        const snapshot = await observe(window, options);
        if (window.hwnd !== 10001n) return snapshot;
        const windowBounds = { x: 20, y: 30, width: 400, height: 260 };
        const cell = { x: 140, y: 120, width: 100, height: 28 };
        return {
          target: window,
          title: 'Excel grid',
          bounds: windowBounds,
          screenshotWidth: 400,
          screenshotHeight: 260,
          screenshotOrigin: { x: 20, y: 30 },
          complete: true,
          elements: [
            { index: '0', depth: 0, role: 'Window', label: 'Excel grid', actions: [], rect: windowBounds },
            { index: '1', parent_index: '0', depth: 1, role: 'DataItem', label: 'Action', actions: ['set_value'], enabled: true, editable: true, token: 'excel-action-cell', rect: cell },
          ],
        };
      };
      return opened;
    },
  } });
  t.after(() => workspace.close());
  const activated = await workspace.act({ activate: 'editor' });
  assert.equal(activated.status, 'completed');
  const observed = await workspace.observe({ view: 'both' });
  const result = await workspace.act({
    observationId: observed.observationId,
    steps: [{ kind: 'type', target: { point: { x: 160, y: 130 } }, text: 'accepted', delivery: 'foreground' }],
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(fixture.dispatches.length, 1);
  assert.equal(fixture.dispatches[0].step.kind, 'type');
  assert.equal(fixture.dispatches[0].target.foreground, true);
  assert.equal(fixture.dispatches[0].target.control.control.role, 'DataItem');
});

test('product foreground hotkey checkpoint rechecks revoked grants before native SendInput', async t => {
  const fixture = makeHostFixture();
  fixture.setGrants({ version: 1, apps: [{ id: 'editor', name: 'WINWORD' }], allowDesktopCapture: false, allowForegroundInput: true });
  let nativeHotkeys = 0;
  const { policy: _ignored, ...baseSeams } = fixture.seams;
  const workspace = await createWindowsProductHost({ authorizationFile: 'ignored-for-seams', onApprovalRequested: () => 'allow', test: {
    ...baseSeams,
    async transportFactory(context) {
      const opened = await baseSeams.transportFactory(context);
      const observe = opened.transport.observeWindow;
      opened.transport.observeWindow = async (window, options) => {
        const snapshot = await observe(window, options);
        return { ...snapshot, elements: snapshot.elements.map(element => element.label === 'Value'
          ? { ...element, role: 'Document', editable: true, runtimeId: 'document-focused' } : element) };
      };
      opened.transport.authorizeForegroundHotkey = async () => undefined;
      opened.inspector.readFocused = async target => ({ target, focused: true, runtimeId: 'document-focused', pid: target.pid, hwnd: target.hwnd });
      opened.inspector.dispatchHotkey = async () => { nativeHotkeys += 1; return { status: 'dispatched' }; };
      return opened;
    },
  } });
  t.after(() => workspace.close());
  await workspace.act({ activate: 'editor' });
  const target = { name: 'Value', role: 'Document', within: 'hwnd:1001:10001' };
  const select = await workspace.act({ steps: [{ kind: 'hotkey', keys: ['ctrl', 'a'], target }] });
  assert.equal(select.status, 'completed', JSON.stringify(select));
  assert.equal(nativeHotkeys, 1);
  const pending = await workspace.act({ steps: [{ kind: 'hotkey', keys: ['ctrl', 's'], target }] });
  assert.equal(pending.code, 'approval_required');
  fixture.setGrants({ version: 1, apps: [{ id: 'editor', name: 'WINWORD' }], allowDesktopCapture: false, allowForegroundInput: false });
  const revoked = await workspace.resolveApproval(pending.requestId, 'approve');
  assert.equal(revoked.status, 'stopped');
  assert.equal(nativeHotkeys, 1);
});

test('the public control list cap leaves named action grounding available', async t => {
  const fixture = makeHostFixture();
  const workspace = await createWindowsProductHost({ authorizationFile: 'ignored-for-seams', test: {
    ...fixture.seams,
    async transportFactory(context) {
      const opened = await fixture.seams.transportFactory(context);
      const observe = opened.transport.observeWindow;
      opened.transport.observeWindow = async (window, options) => {
        const frame = await observe(window, options);
        const item = frame.elements.find(element => element.label === 'Go');
        return { ...frame, elements: Array.from({ length: 140 }, (_, index) => ({
          ...item, index: String(index), label: `Choice ${index}`, token: `${item.token}-${index}`,
        })) };
      };
      return opened;
    },
  } });
  t.after(() => workspace.close());
  await workspace.act({ activate: 'editor' });
  const observed = await workspace.observe({ view: 'controls', where: { within: 'hwnd:1001:10001' } });
  assert.equal(observed.controls.length, 128);
  assert.equal(observed.complete, false);
  assert.equal(observed.controls.some(control => control.name === 'Choice 139'), false);
  const acted = await workspace.act({ steps: [{ kind: 'click', target: { role: 'Button', name: 'Choice 139', within: 'hwnd:1001:10001' } }] });
  assert.equal(acted.status, 'completed');
  assert.equal(fixture.dispatches.at(-1).target.control.control.name, 'Choice 139');
});

for (const refreshGrants of [false, true]) {
  test(`revoking during a later approval preserves earlier step receipts (refresh ${refreshGrants})`, async t => {
    const fixture = makeHostFixture();
    const workspace = await createWindowsProductHost({ authorizationFile: 'ignored-for-seams', test: {
      ...fixture.seams,
      policy: ({ step }) => ({ decision: step.kind === 'type' ? 'allow' : 'approve', code: 'fixture_policy' }),
    } });
    t.after(() => workspace.close());
    await workspace.act({ activate: 'editor' });
    const pending = await workspace.act({ steps: [
      { kind: 'type', target: { name: 'Value', within: 'hwnd:1001:10001' }, text: 'test draft' },
      { kind: 'click', target: { name: 'Go', within: 'hwnd:1001:10001' } },
    ] });
    assert.equal(pending.code, 'approval_required');
    assert.deepEqual(pending.steps.map(step => step.status), ['dispatched', 'not_dispatched']);
    fixture.setGrants({ version: 1, apps: [], allowForegroundInput: false, allowDesktopCapture: false });
    if (refreshGrants) await workspace.observe({ workspace: true });
    const denied = await workspace.resolveApproval(pending.requestId, 'approve');
    assert.equal(denied.code, 'application_automation_blocked');
    assert.deepEqual(denied.steps.map(step => step.status), ['dispatched', 'not_dispatched']);
    assert.equal(fixture.dispatches.length, 1);
  });
}

test('dynamic grant discovery and same-app window refresh require no host restart', async () => {
  const fixture = makeHostFixture();
  fixture.windows.splice(fixture.windows.findIndex(window => window.id === 'editor-dialog'), 1);
  fixture.setGrants({ version: 1, apps: [], allowDesktopCapture: false, allowForegroundInput: false });
  const workspace = await createWindowsProductHost({
    authorizationFile: 'ignored-for-seams',
    test: fixture.seams,
  });
  assert.deepEqual((await workspace.observe({ workspace: true })).applications, []);

  fixture.setGrants({ version: 1, apps: [{ id: 'editor', name: 'Editor' }], allowDesktopCapture: false, allowForegroundInput: false });
  assert.deepEqual((await workspace.observe({ workspace: true })).applications.map(app => app.id), ['editor']);
  assert.equal((await workspace.act({ activate: 'editor' })).status, 'completed');
  const first = await workspace.observe({ view: 'controls' });
  assert.equal((await workspace.act({ observationId: first.observationId, steps: [{ kind: 'click', target: { role: 'Button', name: 'Go', within: 'Editor Main' } }] })).status, 'completed');

  fixture.setGrants({ version: 1, apps: [{ id: 'editor', name: 'Editor' }], allowDesktopCapture: true, allowForegroundInput: true });
  await workspace.observe({ view: 'controls' });
  const refreshedGrantContext = fixture.contexts.at(-1);
  assert.equal(refreshedGrantContext.grants.allowDesktopCapture, true);
  assert.equal(refreshedGrantContext.grants.allowForegroundInput, true);

  fixture.windows.push({ id: 'editor-dialog', appId: 'editor', appName: 'Editor', title: 'Editor Dialog', pid: 1001, hwnd: 10002n, processStartedAt: 'editor-start', ownerHwnd: 10001n });
  const refreshed = await workspace.observe({ view: 'controls' });
  assert.ok(refreshed.controls.some(control => control.name === 'Go'));
  assert.ok(fixture.contexts.filter(context => context.app.id === 'editor').length >= 2);
  assert.equal(fixture.contexts.at(-1).windows.length, 2);
  const dialogAct = await workspace.act({ observationId: refreshed.observationId, steps: [{ kind: 'click', target: { role: 'Button', name: 'Go', within: 'Editor Dialog' } }] });
  assert.equal(dialogAct.status, 'completed', JSON.stringify(dialogAct));
  assert.equal(fixture.dispatches.at(-1).target.window.hwnd, 10002n);

  fixture.setGrants({ version: 1, apps: [], allowDesktopCapture: false, allowForegroundInput: false });
  assert.deepEqual((await workspace.observe({ workspace: true })).applications, []);
  const revoked = await workspace.act({ observationId: refreshed.observationId, steps: [{ kind: 'click', target: { role: 'Button', name: 'Go', within: 'Editor Dialog' } }] });
  assert.equal(revoked.status, 'stopped');
  assert.equal(revoked.code, 'application_automation_blocked');
  await workspace.close();
});

test('revocation and target identity are rechecked before approval dispatch', async () => {
  const fixture = makeHostFixture();
  const workspace = await createWindowsProductHost({
    authorizationFile: 'ignored-for-seams',
    test: { ...fixture.seams, policy: () => ({ decision: 'approve', code: 'product_test_approval' }) },
  });
  assert.equal((await workspace.act({ activate: 'editor' })).status, 'completed');
  const observation = await workspace.observe({ view: 'controls' });
  const pending = await workspace.act({
    observationId: observation.observationId,
    steps: [{ kind: 'click', target: { role: 'Button', name: 'Go', within: 'Editor Main' } }],
  });
  assert.equal(pending.status, 'stopped');
  assert.equal(pending.code, 'approval_required');
  assert.equal(fixture.dispatches.length, 0);

  fixture.setGrants({ version: 1, apps: [], allowDesktopCapture: false, allowForegroundInput: false });
  const revoked = await workspace.resolveApproval(pending.requestId, 'approve');
  assert.equal(revoked.status, 'stopped');
  assert.equal(revoked.code, 'application_automation_blocked');
  assert.equal(fixture.dispatches.length, 0);

  fixture.setGrants({ version: 1, apps: [{ id: 'editor', name: 'Editor' }], allowDesktopCapture: false, allowForegroundInput: false });
  const secondObservation = await workspace.observe({ view: 'controls' });
  const secondPending = await workspace.act({
    observationId: secondObservation.observationId,
    steps: [{ kind: 'click', target: { role: 'Button', name: 'Go', within: 'Editor Main' } }],
  });
  assert.equal(secondPending.code, 'approval_required');
  fixture.windows.splice(fixture.windows.findIndex(window => window.id === 'editor-main'), 1);
  const stale = await workspace.resolveApproval(secondPending.requestId, 'approve');
  assert.equal(stale.status, 'stopped');
  assert.ok(['window_scope_changed', 'observation_incomplete'].includes(stale.code));
  assert.equal(fixture.dispatches.length, 0);
  await workspace.close();
});

test('optional Windows OCR uses only the granted local window capture and preserves approval freshness', async () => {
  const fixture = makeHostFixture();
  fixture.setGrants({ version: 1, apps: [{ id: 'editor', name: 'Editor' }], allowDesktopCapture: false,
    allowLocalWindowEvidence: true, allowForegroundInput: false });
  const runnerCalls = [];
  const runner = {
    async recognize(request) {
      runnerCalls.push(request);
      assert.deepEqual(request.region, { x: 40, y: 60, width: 100, height: 30 });
      assert.equal(request.image.width, 1000);
      assert.equal(request.image.height, 1000);
      return [{ text: 'Send', confidence: 0.99 }];
    },
  };
  const { policy: _fixturePolicy, ...seams } = fixture.seams;
  const workspace = await createWindowsProductHost({
    authorizationFile: 'ignored-for-seams',
    ocr: {
      pythonExecutable: 'python',
      detectorModelPath: 'C:\\ocr\\detector.onnx',
      recognizerModelPath: 'C:\\ocr\\recognizer.onnx',
      dictionaryPath: 'C:\\ocr\\dict.txt',
    },
    test: { ...seams, ocrRunner: runner },
  });
  assert.equal((await workspace.act({ activate: 'editor' })).status, 'completed');
  await assert.rejects(() => workspace.observe({ view: 'image' }), /image_delivery_not_authorized/u);
  const observation = await workspace.observe({ view: 'controls' });
  const pending = await workspace.act({
    observationId: observation.observationId,
    steps: [{ kind: 'click', target: { role: 'Button', name: 'Go', within: 'Editor Main' } }],
  });
  assert.equal(pending.status, 'stopped');
  assert.equal(pending.code, 'approval_required');
  assert.equal(fixture.windowImageCaptures.length, 1);
  assert.equal(fixture.windowImageCaptures[0].target.hwnd, 10001n);
  assert.equal(runnerCalls.length, 1);

  const resumed = await workspace.resolveApproval(pending.requestId, 'approve');
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(fixture.windowImageCaptures.length, 2);
  assert.equal(runnerCalls.length, 2);
  assert.equal(fixture.dispatches.at(-1).appId, 'editor');
  const knownObservation = await workspace.observe({ view: 'controls' });
  const known = await workspace.act({
    observationId: knownObservation.observationId,
    steps: [{ kind: 'type', target: { role: 'Edit', name: 'Value', within: 'Editor Main' }, text: 'draft' }],
  });
  assert.equal(known.status, 'completed', JSON.stringify(known));
  assert.equal(fixture.windowImageCaptures.length, 2);
  assert.equal(runnerCalls.length, 2);
  assert.equal(fixture.imageCaptures.length, 0);
  await workspace.close();
});

test('the Windows product uses a bounded OCR crop for an opaque window point', async t => {
  const fixture = makeHostFixture();
  fixture.setGrants({
    version: 1, apps: [{ id: 'editor', name: 'Editor' }], allowDesktopCapture: true, allowForegroundInput: true,
  });
  const { policy: _testPolicy, transportFactory, ...seams } = fixture.seams;
  const actions = [];
  let caption = 'Options';
  const ocrCrops = [];
  const workspace = await createWindowsProductHost({
    authorizationFile: 'ignored-for-seams',
    ocr: {
      pythonExecutable: 'python',
      detectorModelPath: 'C:\\ocr\\detector.onnx',
      recognizerModelPath: 'C:\\ocr\\recognizer.onnx',
      dictionaryPath: 'C:\\ocr\\dict.txt',
    },
    test: {
      ...seams,
      async transportFactory(input) {
        const created = await transportFactory(input);
        created.transport.observeWindow = async () => { throw Error('no UIA provider'); };
        created.inspector.dispatchWindowPoint = async (target, step) => {
          actions.push({ target, step });
          return { status: 'dispatched', suppressFocusHandoff: true };
        };
        return created;
      },
      ocrRunner: {
        async recognize({ region, image }) {
          ocrCrops.push(region);
          assert.equal(image.width, 1000);
          return [{ text: caption, confidence: 0.99 }];
        },
      },
    },
  });
  t.after(() => workspace.close());
  assert.equal((await workspace.act({ activate: 'editor' })).status, 'completed');
  const point = { x: 150, y: 140 };
  const click = async () => {
    const { observationId } = await workspace.observe({ view: 'image' });
    return workspace.act({ observationId, steps: [{ kind: 'click', target: { point } }] });
  };
  assert.equal((await click()).steps[0].status, 'dispatched');
  assert.equal(actions[0].target.hwnd, 10001n);
  caption = 'Send message';
  const pending = await click();
  assert.equal(pending.code, 'approval_required');
  assert.equal((await workspace.resolveApproval(pending.requestId, 'deny')).code, 'approval_denied');
  assert.equal(actions.length, 1);
  assert.deepEqual(ocrCrops, Array(2).fill({ x: 22, y: 60, width: 256, height: 160 }));
  assert.equal(fixture.windowImageCaptures.length, 0, 'the fallback does not require CUA geometry or a window capture');
});

test('configured extra applications remain discoverable without Windows grants', async () => {
  const fixture = makeHostFixture();
  fixture.setGrants({ version: 1, apps: [], allowDesktopCapture: false, allowForegroundInput: false });
  const extra = {
    id: 'cloud-adapter',
    name: 'Cloud Adapter',
    capabilities: [],
    async open() { throw new Error('not opened in discovery test'); },
  };
  const workspace = await createWindowsProductHost({
    authorizationFile: 'ignored-for-seams',
    extraApplications: [extra],
    test: fixture.seams,
  });
  const inventory = await workspace.observe({ workspace: true });
  assert.deepEqual(inventory.applications.map(app => app.id), ['cloud-adapter']);
  await workspace.close();
});

test('OCR remains unavailable without an image or local evidence grant', async () => {
  const fixture = makeHostFixture();
  fixture.setGrants({ version: 1, apps: [{ id: 'editor', name: 'Editor' }], allowDesktopCapture: false, allowForegroundInput: false });
  const runnerCalls = [];
  const runner = { async recognize(request) { runnerCalls.push(request); return [{ text: 'Send', confidence: 0.99 }]; } };
  const { policy: _fixturePolicy, ...seams } = fixture.seams;
  const workspace = await createWindowsProductHost({
    authorizationFile: 'ignored-for-seams',
    ocr: {
      pythonExecutable: 'python',
      detectorModelPath: 'C:\\ocr\\detector.onnx',
      recognizerModelPath: 'C:\\ocr\\recognizer.onnx',
      dictionaryPath: 'C:\\ocr\\dict.txt',
    },
    test: { ...seams, ocrRunner: runner },
  });
  assert.equal((await workspace.act({ activate: 'editor' })).status, 'completed');
  const observation = await workspace.observe({ view: 'controls' });
  const refused = await workspace.act({
    observationId: observation.observationId,
    steps: [{ kind: 'click', target: { role: 'Button', name: 'Go', within: 'Editor Main' } }],
  });
  assert.equal(refused.status, 'stopped');
  assert.equal(refused.code, 'risk_evidence_required');
  assert.equal(fixture.windowImageCaptures.length, 0);
  assert.equal(runnerCalls.length, 0);
  await workspace.close();
});
