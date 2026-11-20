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
  const seams = {
    async readWindowsProductGrants() { return grants; },
    async listWindowsAppWindows() { return windows; },
    async verifyWindowsAppWindow(window) { return windows.some(candidate => candidate.id === window.id && candidate.hwnd === window.hwnd); },
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
          async bringToFront() {
            return { status: 'dispatched' };
          },
        },
        inspector: {
          async read(target) {
            const bounds = target.hwnd === 10001n
              ? { x: 20, y: 30, width: 400, height: 260 }
              : { x: 500, y: 30, width: 400, height: 260 };
            return { target, visible: true, minimized: false, bounds };
          },
        },
      };
    },
    policy: () => ({ decision: 'allow', code: 'product_test' }),
  };
  return { seams, windows, contexts, dispatches, imageCaptures, windowImageCaptures, setGrants(value) { grants = value; } };
}

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

test('optional Windows OCR uses a fresh guarded desktop capture and preserves approval freshness', async () => {
  const fixture = makeHostFixture();
  fixture.setGrants({ version: 1, apps: [{ id: 'editor', name: 'Editor' }], allowDesktopCapture: true, allowForegroundInput: false });
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
  await workspace.close();
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

test('OCR remains unavailable without the explicit desktop-capture grant', async () => {
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
