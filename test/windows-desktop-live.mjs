import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { CuaDriver, ListWindowsInput } from '@trycua/cua-driver';
import { createDeskSession } from '../dist/index.js';
import { createWindowsDesktopBackend } from '../dist/backends/windows/index.js';

/**
 * Opt-in only. This runner creates and owns the WinForms fixture, observes
 * controls without screenshots, then exercises click/type/popup refusal via
 * the public DeskSession boundary. It never selects an unrelated process.
 */
if (process.platform !== 'win32' || process.env.DESKLATCH_WINDOWS_LIVE !== '1') {
  console.log('SKIP windows live test (set DESKLATCH_WINDOWS_LIVE=1 on Windows)');
  process.exit(0);
}

const fixtureUrl = new URL('./fixtures/windows-desktop.ps1', import.meta.url);
const fixtureText = await readFile(fixtureUrl, 'utf8');
const encodedFixture = Buffer.from(fixtureText, 'utf16le').toString('base64');
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const fixture = spawn(powershell, [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', encodedFixture,
], { windowsHide: false, stdio: ['ignore', 'ignore', 'ignore'] });

const driver = CuaDriver.create(undefined);
let backend;
let session;
try {
  assert.ok(fixture.pid, 'fixture process did not start');
  let window;
  for (let attempt = 0; attempt < 80 && window === undefined; attempt += 1) {
    const listed = await driver.listWindows(ListWindowsInput.new({ pid: fixture.pid, onScreenOnly: true }));
    window = listed.windows.find(candidate => candidate.title === 'DeskLatch Desktop Fixture' && candidate.windowId > 0n);
    if (window === undefined) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(window, 'fixture window did not become visible');
  const target = { pid: fixture.pid, hwnd: window.windowId, title: window.title };
  await driver.callTool('bring_to_front', JSON.stringify({ pid: target.pid, window_id: Number(target.hwnd) }));
  backend = await createWindowsDesktopBackend({
    driver,
    authorization: {
      targets: [target],
      allowForegroundInput: true,
      background: { source: 'cua-uia-0.54' },
    },
  });
  session = createDeskSession(backend, {
    allowModelImages: false,
    policy: () => ({ decision: 'allow', code: 'live_fixture' }),
  });

  const initial = await session.observe({ view: 'controls' });
  assert.equal(initial.image, undefined);
  const editor = initial.controls.find(control => control.name === 'Fixture editor');
  const increment = initial.controls.find(control => control.name === 'Increment fixture counter');
  const popup = initial.controls.find(control => control.name === 'Open fixture popup');
  assert.ok(editor?.ref && increment?.ref && popup?.ref, 'fixture controls were not readable');

  const typed = await session.act({ observationId: initial.observationId, steps: [
    { kind: 'type', target: { ref: editor.ref }, text: 'live-value' },
  ] });
  assert.equal(typed.status, 'completed', JSON.stringify({ typed, capabilities: session.capabilities, editorActions: editor.actions }));
  const afterType = await session.observe({ view: 'controls' });
  const editorAfterType = afterType.controls.find(control => control.name === 'Fixture editor');
  const incrementAfterType = afterType.controls.find(control => control.name === 'Increment fixture counter');
  assert.equal(editorAfterType?.value, 'live-value');
  assert.ok(incrementAfterType?.ref, 'increment button disappeared after typing');

  const clicked = await session.act({ observationId: afterType.observationId, steps: [
    { kind: 'click', target: { ref: incrementAfterType.ref } },
  ] });
  assert.equal(clicked.status, 'completed', JSON.stringify(clicked));
  const afterClick = await session.observe({ view: 'controls' });
  const popupAfterClick = afterClick.controls.find(control => control.name === 'Open fixture popup');
  assert.ok(popupAfterClick?.ref, 'popup button disappeared after click');

  const opened = await session.act({ observationId: afterClick.observationId, steps: [
    { kind: 'click', target: { ref: popupAfterClick.ref } },
  ] });
  assert.equal(opened.status, 'completed');
  await new Promise(resolve => setTimeout(resolve, 150));
  const popupWindows = await driver.listWindows(ListWindowsInput.new({ pid: fixture.pid, onScreenOnly: true }));
  const popupCount = popupWindows.windows.filter(candidate => candidate.title === 'DeskLatch Fixture Popup').length;
  assert.equal(popupCount, 1);
  const nativeState = await readFixtureState(driver, target);
  assert.match(nativeState, /Open fixture popup/u);
  const withPopup = await session.observe({ view: 'controls' });
  const editorWithPopup = withPopup.controls.find(control => control.name === 'Fixture editor');
  assert.ok(editorWithPopup?.ref, 'editor disappeared after popup');
  const blocked = await session.act({ observationId: withPopup.observationId, steps: [
    { kind: 'type', target: { ref: editorWithPopup.ref }, text: 'must-not-land' },
  ] });
  assert.equal(blocked.status, 'stopped');
  assert.equal(blocked.code, 'target_occluded');

  console.log(JSON.stringify({
    ok: true,
    nativeRoute: 'cua-uia-0.54/background',
    pid: target.pid,
    hwnd: target.hwnd.toString(),
    windows: { authorized: 1, popup: popupCount },
    controlsOnly: initial.image === undefined,
    typed: { status: typed.status, receipt: typed.steps },
    clicked: { status: clicked.status, receipt: clicked.steps },
    popupGuard: { status: blocked.status, receipt: blocked.steps, code: blocked.code },
  }));
} finally {
  await session?.close().catch(() => undefined);
  await backend?.close().catch(() => undefined);
  await driver.shutdown().catch(() => undefined);
  driver.uniffiDestroy?.();
  if (!fixture.killed) fixture.kill();
}

async function readFixtureState(cua, target) {
  const result = await cua.callTool('get_window_state', JSON.stringify({
    pid: target.pid,
    window_id: Number(target.hwnd),
    include_accessibility_tree: true,
    include_screenshot: false,
    tree_format: 'both',
    full_output: true,
    max_elements: 512,
    max_depth: 32,
  }));
  assert.equal(result.isError, false, result.errorCode ?? 'fixture_read_failed');
  return result.structuredJson ?? result.text ?? '';
}
