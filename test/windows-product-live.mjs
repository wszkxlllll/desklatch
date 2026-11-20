import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import koffi from 'koffi';
import { listWindowsAppWindows, verifyWindowsAppWindow } from '../dist/product/windows-inventory.js';
import { createWindowsMcpHost } from '../dist/product/windows-mcp.js';

// Dedicated Windows windows, an isolated authorization file and test approvals.
// No user profile, network delivery, global registration or provider keys.
if (process.platform !== 'win32' || process.env.DESKLATCH_WINDOWS_LIVE !== '1') {
  console.log('SKIP Windows product test (set DESKLATCH_WINDOWS_LIVE=1 on Windows)');
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), 'desklatch-native-'));
const authorizationFile = join(root, 'grants.json');
const grantsBase = { version: 1, allowForegroundInput: false, allowDesktopCapture: false };
const system = join(process.env.SystemRoot, 'System32');
const powershell = join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const product = process.env.DESKLATCH_WINDOWS_LIVE_CORE ?? fileURLToPath(new URL('../dist', import.meta.url));
const authorizationCli = join(product, 'bin', 'windows-authorization.js');
const testText = 'DeskLatch native cross-application test';
const notePath = join(root, 'desk-latch-' + root.split('-').at(-1) + '.txt');

async function runAuthorization(operation, input) {
  const child = spawn(process.execPath, [authorizationCli, operation, authorizationFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', data => stdout.push(data));
  child.stderr.on('data', data => stderr.push(data));
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input), 'utf8');
  await new Promise((success, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? success() : reject(new Error(Buffer.concat(stderr).toString('utf8'))));
  });
  return JSON.parse(Buffer.concat(stdout).toString('utf8'));
}

async function grant(...windows) {
  const apps = windows.map(({ appId: id, appName: name }) => ({ id, name }));
  return runAuthorization('--save', { ...grantsBase, apps });
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(message);
}

function resultContent(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.content.length, 1, 'no image should have been transferred');
  return JSON.parse(result.content[0].text);
}

async function activate(call, window) {
  const result = await call('act', { activate: window.appId });
  assert.equal(result.status, 'completed', JSON.stringify(result));
}

async function click(call, name) {
  return call('act', { steps: [{ kind: 'click', target: { role: 'Button', name } }] });
}

async function checkCrossApp(call, first, second, text) {
  await activate(call, first);
  const before = await call('observe', { view: 'controls' });
  const previous = before.controls.find(control => control.name === 'Fixture editor')?.value ?? '';
  const expected = previous + text;
  const firstWrite = await call('act', { steps: [
    { kind: 'type', target: { name: 'Fixture editor' }, text, expect: { target: { name: 'Fixture editor' }, valueEquals: expected } },
    { kind: 'click', target: { role: 'Button', name: 'Search' } },
  ] });
  assert.deepEqual(firstWrite.steps.map(step => step.status), ['verified', 'dispatched'], JSON.stringify(firstWrite));

  await activate(call, second);
  const note = await call('observe', { view: 'controls' });
  const openNote = note.controls.find(control => control.value?.includes(testText));
  assert.ok(openNote, 'Notepad did not expose the test document through UIA.');
  await activate(call, first);
  const returned = await call('observe', { view: 'controls' });
  assert.equal(returned.controls.find(control => control.name === 'Fixture editor')?.value, expected);
}

const events = [];
const started = await listWindowsAppWindows();
const fixtureSource = await readFile(new URL('./fixtures/windows-desktop.ps1', import.meta.url), 'utf8');
const encodedFixture = Buffer.from('& {\n' + fixtureSource + '\n} -ProductFixture', 'utf16le').toString('base64');
const fixture = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
  encodedFixture], { windowsHide: false, stdio: ['ignore', 'pipe', 'inherit'] });
fixture.stdout.setEncoding('utf8').on('data', data => events.push(data));
const count = name => events.join('').split(/\r?\n/u).filter(line => line === 'clicked:' + name).length;
let note;
let nativeDsh;
let mcp;
let windowsMcp;
try {
  const a = await waitFor(async () => (await listWindowsAppWindows()).find(window => window.pid === fixture.pid && window.title === 'DeskLatch Native Acceptance'), 'Native fixture did not start.');
  await writeFile(notePath, testText, 'utf8');
  const noteProcess = spawn(join(system, 'notepad.exe'), [notePath], { windowsHide: false, stdio: 'ignore' });
  noteProcess.on('error', error => console.error(error.code));
  note = await waitFor(async () => (await listWindowsAppWindows()).find(window => window.appName.toLowerCase() === 'notepad'
    && !started.some(earlier => earlier.pid === window.pid) && window.title.includes(basename(notePath, '.txt'))), 'Dedicated Notepad did not start.');
  assert.notEqual(a.appId, note.appId);
  assert.ok(await verifyWindowsAppWindow(note));
  const user32 = koffi.load(join(system, 'user32.dll'));
  const move = user32.func('int __stdcall MoveWindow(uintptr_t, int, int, int, int, int)');
  // Create room for these two test windows. All app switches below use DeskLatch.
  assert.ok(move(note.hwnd, 675, 80, 540, 560, 1));

  const state = await runAuthorization('--snapshot');
  assert.equal(state.grants.apps.length, 0);
  assert.ok(state.applications.some(app => app.id === a.appId && app.windows === 1));
  await grant(a);

  mcp = new Client({ name: 'windows-product-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(product, 'bin', 'mcp.js'), '--windows', authorizationFile] });
  await mcp.connect(transport);
  assert.deepEqual((await mcp.listTools()).tools.map(tool => tool.name).sort(), ['act', 'observe']);
  const mcpCall = async (name, args) => resultContent(await mcp.callTool({ name, arguments: args }));
  const beforeGrant = await mcpCall('observe', { workspace: true });
  assert.deepEqual(beforeGrant.applications.map(app => app.id), [a.appId]);
  const blocked = await mcpCall('act', { activate: note.appId });
  assert.equal(blocked.status, 'stopped');
  assert.match(blocked.code, /^(application_not_found|application_automation_blocked)$/u);
  await grant(a, note);
  await checkCrossApp(mcpCall, a, note, 'mcp-native-value');
  const unclear = await click(mcpCall, 'Continue');
  assert.equal(unclear.status, 'stopped');
  assert.equal(unclear.steps[0].status, 'not_dispatched');
  assert.equal(count('Continue'), 0);

  assert.equal((await click(mcpCall, 'Open fixture popup')).status, 'completed');
  const popup = await waitFor(async () => (await listWindowsAppWindows()).find(window => window.ownerHwnd === a.hwnd
    && window.title === 'DeskLatch Fixture Popup'), 'Same-application popup did not appear.');
  assert.equal(popup.appId, a.appId);
  assert.equal((await runAuthorization('--snapshot')).applications.find(app => app.id === a.appId)?.windows, 1);
  const closedPopup = await click(mcpCall, 'Close popup');
  assert.equal(closedPopup.status, 'completed', JSON.stringify(closedPopup));
  await waitFor(async () => !(await verifyWindowsAppWindow(popup)), 'Same-application popup did not close.');
  await mcp.close();
  mcp = undefined;

  const dsh = new Context();
  nativeDsh = dsh;
  await dsh.plugin(SystemPrompt, { includeRuntimeContext: false }).await();
  await dsh.plugin(ToolsService).await();
  const dshDecisions = ['rejected', 'allowed-once'];
  dsh.provide('approval', { async request(request) {
    assert.match(request.reason, /Send message/u);
    assert.equal(count('Send message'), 0);
    return dshDecisions.shift();
  } });
  process.env.DESKLATCH_WINDOWS_GRANTS_FILE = authorizationFile;
  const entry = process.env.DESKLATCH_WINDOWS_LIVE_DSH;
  const plugin = (await import(entry ? pathToFileURL(resolve(entry)).href : '../distribution/dsh/plugin.mjs')).default;
  await dsh.plugin(plugin).await();
  const signal = new AbortController().signal;
  const dshCall = async (name, args) => {
    const tool = dsh.tools.get('desklatch_' + name);
    assert.ok(tool);
    return resultContent(await tool.execute(args, { name: tool.name, callId: 'desktop-acceptance-' + name, agent: {}, signal }));
  };
  await checkCrossApp(dshCall, a, note, 'dsh-native-value');
  assert.equal((await click(dshCall, 'Send message')).code, 'approval_denied');
  assert.equal((await click(dshCall, 'Send message')).status, 'completed');
  await waitFor(() => count('Send message') === 1, 'The approved native UIA callback did not run.');
  assert.deepEqual(dshDecisions, []);
  await dsh.fiber.dispose();
  nativeDsh = undefined;

  const mcpDecisions = ['deny', 'approve', 'revoke'];
  windowsMcp = await createWindowsMcpHost(authorizationFile, async request => {
    assert.match(request.summary, /Send message/u);
    const decision = mcpDecisions.shift();
    if (decision === 'revoke') {
      await grant(note);
      return 'approve';
    }
    return decision;
  });
  const localCall = (name, args) => windowsMcp.tools.find(tool => tool.name === name).invoke(args);
  await activate(localCall, a);
  assert.equal((await click(localCall, 'Send message')).code, 'approval_denied');
  assert.equal(count('Send message'), 1);
  assert.equal((await click(localCall, 'Send message')).status, 'completed');
  await waitFor(() => count('Send message') === 2, 'MCP approval did not dispatch.');
  assert.equal((await click(localCall, 'Send message')).code, 'application_automation_blocked');
  assert.equal(count('Send message'), 2);
  assert.equal((await localCall('observe', { workspace: true })).applications.some(app => app.id === a.appId), false);
  assert.equal(await readFile(notePath, 'utf8'), testText);
  console.log(JSON.stringify({ windows: ['native WinForms', 'Notepad'], switchedThroughBothHosts: true,
    blockedBeforeGrant: true, sameAppOwnedPopup: true, ordinarySearches: count('Search'), ambiguousDispatches: count('Continue'),
    nativeApprovedDispatches: count('Send message'), revokedBeforeApproval: true, images: 0 }));
} finally {
  await nativeDsh?.fiber.dispose().catch(() => undefined);
  await mcp?.close().catch(() => undefined);
  await windowsMcp?.close().catch(() => undefined);
  fixture.kill();
  if (note && await verifyWindowsAppWindow(note)) process.kill(note.pid);
}
