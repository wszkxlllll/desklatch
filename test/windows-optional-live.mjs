import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { listWindowsAppWindows } from '../dist/product/windows-inventory.js';
import { writeWindowsProductGrants, windowsProductGrantsFile } from '../dist/product/windows-grants.js';
import { readOfficeText } from '../examples/support/cloud-desktop.mjs';

// Opt-in acceptance against installed packages in disposable E: directories.
// The owned fixture has a painted caption and writes only a local click event.
if (process.platform !== 'win32' || process.env.DESKLATCH_WINDOWS_LIVE !== '1') {
  console.log('SKIP the installed optional feature acceptance');
  process.exit(0);
}

const route = process.argv[2];
const mode = process.argv[3] ?? 'ocr';
assert.ok(route === 'mcp' || route === 'dsh');
assert.ok(mode === 'ocr' || mode === 'ocr-point' || mode === 'cloud' || mode === 'skip');
const testRoot = await realpath(process.env.DESKLATCH_ACCEPTANCE_ROOT);
const installRoot = await realpath(process.env.DESKLATCH_ACCEPTANCE_INSTALL);
assert.match(basename(testRoot), /^(?:native-dev2|desklatch-test)-/iu);
function assertWithinTestRoot(path) {
  const local = relative(testRoot, path);
  assert.ok(local && !isAbsolute(local) && !local.startsWith('..'), 'use an isolated installation under the test directory');
}
assertWithinTestRoot(installRoot);
const grantsFile = windowsProductGrantsFile(installRoot);
const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function runPowerShell(source, options = {}) {
  return spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(source, 'utf16le').toString('base64')], options);
}

async function until(check, message, timeoutMs = 10000) {
  const expires = Date.now() + timeoutMs;
  while (Date.now() < expires) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(message);
}

function decode(result) {
  assert.notEqual(result.isError, true, 'tool returned an error');
  const block = result.content?.find(item => item.type === 'text');
  assert.ok(block, 'missing JSON tool output');
  const images = result.content.filter(item => item.type === 'image');
  return { result: JSON.parse(block.text), images: images.length, image: images[0] };
}

async function openClient(onDecision) {
  if (route === 'mcp') {
    const manifest = JSON.parse(await readFile(join(installRoot, 'desklatch.mcp.json'), 'utf8'));
    const client = new Client({ name: 'desklatch-installed-optional-acceptance', version: '1.0.0' });
    const server = manifest.mcpServers.desklatch;
    const transport = new StdioClientTransport(server);
    try {
      await client.connect(transport);
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['act', 'observe']);
      return {
        pid: transport.pid,
        async call(name, args) { return decode(await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 })); },
        close: () => client.close(),
      };
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  process.env.DESKLATCH_WINDOWS_GRANTS_FILE = grantsFile;
  const dsh = new Context();
  try {
    await dsh.plugin(SystemPrompt, { includeRuntimeContext: false }).await();
    await dsh.plugin(ToolsService).await();
    dsh.provide('approval', { async request(request) { return onDecision(request); } });
    const entryPath = await realpath(process.env.DESKLATCH_ACCEPTANCE_DSH_ENTRY);
    assertWithinTestRoot(entryPath);
    const plugin = (await import(pathToFileURL(entryPath).href)).default;
    await dsh.plugin(plugin).await();
    return {
      async call(name, args) {
        const tool = dsh.tools.get('desklatch_' + name);
        assert.ok(tool);
        return decode(await tool.execute(args, {
          name: tool.name,
          callId: 'optional-acceptance-' + name,
          agent: { session: { requestHeader: () => undefined }, options: {} },
          signal: AbortSignal.timeout(90000),
        }));
      },
      close: () => dsh.fiber.dispose(),
    };
  } catch (error) {
    await dsh.fiber.dispose();
    throw error;
  }
}

async function answerMcpApproval(pid, approved, signal) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AcceptanceDialog {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string caption);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string caption);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, StringBuilder text, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@
$caption = 'DeskLatch ' + [char]0x5ba1 + [char]0x6279
$deadline = [DateTime]::UtcNow.AddSeconds(40)
while ([DateTime]::UtcNow -lt $deadline) {
  $dialog = [AcceptanceDialog]::FindWindow('#32770', $caption)
  if ($dialog -ne [IntPtr]::Zero) {
    $ownerId = 0
    [void][AcceptanceDialog]::GetWindowThreadProcessId($dialog, [ref]$ownerId)
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId AND ParentProcessId = ${pid} AND Name = 'powershell.exe'"
    if ($owner) {
      $buttonId = ${approved ? 6 : 7}
      $button = [AcceptanceDialog]::GetDlgItem($dialog, $buttonId)
      if ($button -ne [IntPtr]::Zero) {
        $label = [IntPtr]::Zero
        $message = New-Object Text.StringBuilder 4096
        do {
          $label = [AcceptanceDialog]::FindWindowEx($dialog, $label, 'Static', [NullString]::Value)
          [void]$message.Clear()
          if ($label -ne [IntPtr]::Zero) {
            $textLength = [IntPtr]::Zero
            [void][AcceptanceDialog]::SendMessageTimeout($label, 0x000D, [IntPtr]$message.Capacity, $message, 0x0002, 500, [ref]$textLength)
          }
        } until ($label -eq [IntPtr]::Zero -or $message.ToString() -match 'OCR')
        if ($label -eq [IntPtr]::Zero) { throw 'Expected an OCR-based approval reason.' }
        if (-not [AcceptanceDialog]::PostMessage($dialog, 0x111, [IntPtr]$buttonId, $button)) { throw 'Could not answer the owned test dialog.' }
        [Console]::WriteLine('ocr-approval-answered')
        exit 0
      }
    }
  }
  Start-Sleep -Milliseconds 150
}
throw 'No matching DeskLatch MCP OCR approval dialog opened.'
`;
  const process = runPowerShell(script, { windowsHide: true, signal, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  process.stdout.setEncoding('utf8').on('data', data => { output += data; });
  await new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('exit', code => code === 0 ? resolve() : reject(new Error('MCP approval dialog verification failed')));
  });
  assert.match(output, /ocr-approval-answered/u);
}

async function runOcr() {
  const usePoint = mode === 'ocr-point';
  const fixtureSource = await readFile(new URL('./fixtures/visual-only-action.ps1', import.meta.url), 'utf8');
  const fixture = runPowerShell(fixtureSource, {
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, DESKLATCH_TEST_VISUAL_POINT: usePoint ? '1' : '0' },
  });
  let events = '';
  fixture.stdout.setEncoding('utf8').on('data', chunk => { events += chunk; });
  let client;
  let approvals = 0;
  try {
    const fixtureWindow = await until(async () => (await listWindowsAppWindows()).find(window =>
      window.pid === fixture.pid && window.title === 'DeskLatch OCR Acceptance'), 'visual-only fixture not discovered');
    const pointData = await until(() => /point:(\d+),(\d+)/u.exec(events), 'fixture visual point missing');
    const point = { x: Number(pointData[1]), y: Number(pointData[2]) };
    await writeWindowsProductGrants(grantsFile, {
      version: 1,
      apps: [{ id: fixtureWindow.appId, name: fixtureWindow.appName }],
      allowForegroundInput: usePoint,
      allowDesktopCapture: true,
    });
    client = await openClient(request => {
      approvals += 1;
      assert.match(request.reason, /OCR/u);
      assert.doesNotMatch(events, /visual-click/u);
      return approvals === 1 ? 'rejected' : 'allowed-once';
    });
    const selected = (await client.call('act', { activate: fixtureWindow.appId })).result;
    assert.equal(selected.status, 'completed', JSON.stringify(selected));
    const observed = await client.call('observe', { view: 'both' });
    assert.equal(observed.images, 1);
    assert.ok(observed.result.controls.every(control => !/\bsend\b/iu.test(control.name ?? '')));
    const control = observed.result.controls.find(({ name, actions }) => name === 'Visual command' && actions?.includes('click'));
    if (usePoint) {
      assert.equal(control, undefined, 'the visual canvas must not provide an actionable UIA button');
      await assertScreenshotPoint(observed.image, point);
    } else assert.ok(control?.ref, 'fixture must have a clickable UIA button with a neutral name');
    for (const approved of [false, true]) {
      const fresh = await client.call('observe', { view: usePoint ? 'image' : 'controls' });
      const frame = fresh.result;
      const ref = frame.controls?.find(item => item.name === control?.name)?.ref;
      if (usePoint) assert.equal(frame.controls?.length ?? 0, 0, 'geometry of an image-only observation must stay private');
      else assert.ok(ref);
      const args = { observationId: frame.observationId,
        steps: [{ kind: 'click', target: usePoint ? { point } : { ref } }] };
      const dialog = new AbortController();
      const answer = route === 'mcp' ? answerMcpApproval(client.pid, approved, dialog.signal).then(() => true, () => false) : undefined;
      try {
        const result = (await client.call('act', args)).result;
        if (approved) assert.equal(result.status, 'completed', JSON.stringify(result));
        else assert.equal(result.code, 'approval_denied', JSON.stringify(result));
        if (answer) assert.equal(await answer, true);
      } finally {
        dialog.abort();
      }
      if (approved) await until(() => events.includes('visual-click'), 'approved OCR action was not dispatched');
      else assert.doesNotMatch(events, /visual-click/u);
    }
    assert.equal(events.match(/visual-click/gu)?.length, 1);
    if (route === 'dsh') assert.equal(approvals, 2);
    console.log(JSON.stringify({ route, mode, visualOnly: true, rejectedDispatches: 0, approvedDispatches: 1 }));
  } finally {
    await client?.close();
    fixture.kill();
  }
}

async function assertScreenshotPoint(image, { x, y }) {
  const config = JSON.parse(await readFile(join(installRoot, '.desklatch/windows/runtime.json'), 'utf8'));
  const matchPixel = 'import sys,io;from PIL import Image;i=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB"); x,y=map(int,sys.argv[1:]); r,g,b=i.getpixel((x,y));sys.exit(0 if r>150 and g<100 and b>150 else 2)';
  const check = spawn(config.ocr.pythonExecutable, ['-I', '-c', matchPixel, String(x), String(y)], {
    windowsHide: true, stdio: ['pipe', 'ignore', 'inherit'],
  });
  check.stdin.end(Buffer.from(image.data, 'base64'));
  await new Promise((resolve, reject) => {
    check.once('error', reject);
    check.once('close', code => code === 0 ? resolve() : reject(new Error('the captured pixel does not match the fixture at the action coordinate')));
  });
}

async function runCloud() {
  const { Sandbox } = await import('@e2b/desktop');
  const apiKey = parseEnv(await readFile(process.env.DESKLATCH_E2B_ACCEPTANCE_ENV, 'utf8')).E2B_API_KEY?.trim();
  assert.ok(apiKey, 'live cloud credential not configured');
  const list = () => Sandbox.list({ apiKey, query: { metadata: { product: 'desklatch', purpose: 'workspace' } },
    limit: 20, requestTimeoutMs: 12000 }).nextItems();
  const original = new Set((await list()).map(item => item.sandboxId));
  const newGuests = async () => (await list()).filter(item => !original.has(item.sandboxId));
  const marker = 'Verified DeskLatch native cloud document ' + randomUUID();
  const client = await openClient(() => 'rejected');
  let ownGuestId;
  try {
    const initial = (await client.call('observe', { workspace: true })).result;
    for (const id of ['e2b-browser', 'e2b-writer']) assert.ok(initial.applications.some(app => app.id === id));
    assert.equal((await newGuests()).length, 0, 'a cloud computer started during discovery');
    const browser = (await client.call('act', { activate: 'e2b-browser' })).result;
    assert.equal(browser.status, 'completed', JSON.stringify(browser));
    const opened = await newGuests();
    assert.equal(opened.length, 1);
    ownGuestId = opened[0].sandboxId;
    const navigated = (await client.call('act', { navigate: 'https://docs.python.org/3/library/pathlib.html' })).result;
    assert.equal(navigated.status, 'completed', JSON.stringify(navigated));
    const document = (await client.call('observe', { read: { query: 'PurePath' } })).result;
    assert.match(JSON.stringify(document.document), /PurePath/u);
    const refused = (await client.call('act', { navigate: 'https://example.com/' })).result;
    assert.equal(refused.status, 'stopped');

    const writer = (await client.call('act', { activate: 'e2b-writer' })).result;
    assert.equal(writer.status, 'completed', JSON.stringify(writer));
    assert.deepEqual((await newGuests()).map(item => item.sandboxId), [ownGuestId]);
    const frame = (await client.call('observe', { view: 'controls' })).result;
    const editor = findEditor(frame);
    const type = (await client.call('act', { observationId: frame.observationId,
      steps: [{ kind: 'type', target: { ref: editor.ref }, text: marker }] })).result;
    assert.equal(type.status, 'completed', JSON.stringify(type));
    const next = (await client.call('observe', { view: 'controls' })).result;
    const save = (await client.call('act', { observationId: next.observationId,
      steps: [{ kind: 'hotkey', target: { ref: findEditor(next).ref }, keys: ['ctrl', 's'] }] })).result;
    assert.equal(save.status, 'completed', JSON.stringify(save));

    const guest = await Sandbox.connect(ownGuestId, { apiKey, requestTimeoutMs: 12000 });
    const id = opened[0].metadata?.run;
    assert.match(id, /^[a-z0-9-]+$/iu);
    await until(async () => {
      const file = await guest.files.read(`/tmp/desklatch-product-writer-${id}/blank.odt`, { format: 'bytes', requestTimeoutMs: 12000 });
      return (await readOfficeText(file, 'odt')).includes(marker);
    }, 'the typed text was not saved in the cloud file', 10000);
    const returned = (await client.call('act', { activate: 'e2b-browser' })).result;
    assert.equal(returned.status, 'completed', JSON.stringify(returned));
    console.log(JSON.stringify({ route, mode, guestCount: 1, realDocumentRead: true, outsideOriginRefused: true, writerFileVerified: true }));
  } finally {
    await client.close();
    if (ownGuestId) {
      try { await until(async () => !(await newGuests()).some(item => item.sandboxId === ownGuestId), 'cloud guest not released', 16000); }
      catch (error) {
        await Sandbox.kill(ownGuestId, { apiKey, requestTimeoutMs: 12000 });
        throw error;
      }
    }
  }
  console.log(JSON.stringify({ route, mode, cleanupVerified: true }));
}

function findEditor(frame) {
  const candidates = frame.controls?.filter(control => control.ref && control.actions?.includes('type')) ?? [];
  const editor = candidates.find(control => control.states?.includes('focused'))
    ?? candidates.find(control => /^(?:document|paragraph|window)$/iu.test(control.role));
  assert.ok(editor, JSON.stringify(candidates.map(({ role, states, actions }) => ({ role, states, actions }))));
  return editor;
}

async function runSkipped() {
  const config = JSON.parse(await readFile(join(installRoot, '.desklatch/windows/runtime.json'), 'utf8'));
  assert.deepEqual(config, { version: 1 });
  await assert.rejects(access(join(installRoot, '.desklatch/ocr/ocr.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(installRoot, 'node_modules/@e2b/desktop/package.json')), { code: 'ENOENT' });
  const client = await openClient(() => 'rejected');
  try {
    const inventory = (await client.call('observe', { workspace: true })).result;
    assert.ok(inventory.applications.every(app => !app.id.startsWith('e2b-')));
    assert.equal((await client.call('act', { activate: 'e2b-writer' })).result.code, 'application_not_found');
    console.log(JSON.stringify({ route, mode, baseToolsReady: true, optionalSdkInstalled: false, cloudApplications: 0 }));
  } finally { await client.close(); }
}

await ({ ocr: runOcr, 'ocr-point': runOcr, cloud: runCloud, skip: runSkipped })[mode]();
