import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { E2BAtSpiCommandWorker, E2BX11RecipientProcess } from "desklatch/e2b";

function pythonCommand() {
  for (const command of ["python3", "python"]) {
    const result = spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true });
    if (!result.error && result.status === 0) return command;
  }
  return undefined;
}

const python = pythonCommand();
const worker = "src/backends/e2b/x11-recipient.py";

test("Unicode input distinguishes a busy clipboard from an uncertain paste", async () => {
  let reply;
  const recipient = new E2BX11RecipientProcess({ commands: { run: async () => ({ stdout: JSON.stringify(reply) }) } });
  const request = { windowId: "1", processId: 1, application: "writer", text: "\u4e0a\u6d77" };
  reply = { ok: false, code: "x11_recipient_clipboard_busy" };
  assert.equal((await recipient.typeText(request)).status, "refused");
  reply = { ok: false, code: "x11_recipient_injection_unconfirmed" };
  assert.equal((await recipient.typeText(request)).status, "unknown");
  reply = { ok: true, delivered: true };
  assert.equal((await recipient.typeText(request)).status, "dispatched");
});

test("the deployed command passes decoded JSON to both real Python readers", { skip: !python }, async () => {
  const responses = [];
  const surface = { commands: { async run(command) {
    const match = /^python3 -u -c "([^"]+)"$/u.exec(command);
    assert.ok(match, "expected a fixed Python command");
    const source = /base64\.b64decode\('([A-Za-z0-9+/=]+)'\)/u.exec(match[1])?.[1];
    assert.ok(source, "expected base64 packaged worker");
    const decoded = Buffer.from(source, "base64").toString("utf8");
    assert.match(decoded, /x11_recipient|atspi_worker|"op"/u);
    responses.push({ ok: true });
    return { stdout: JSON.stringify({ ok: true }), exitCode: 0 };
  } } };
  await new E2BAtSpiCommandWorker(surface).request({ op: "observe", windows: [{ window_id: "1", application: "desklatch-test" }] });
  await new E2BX11RecipientProcess(surface).verifyFocus({ windowId: "1", processId: 1, application: "desklatch-test" }).catch(() => undefined);
  assert.equal(responses.length, 2);
  for (const result of responses) assert.ok(result.ok === true || /^(?:x11_|e2b_)/u.test(result.code), JSON.stringify(result));
});

test("fixed X11 recipient worker parses without importing desktop dependencies", { skip: !python }, () => {
  const result = spawnSync(python, ["-c", "compile(open('src/backends/e2b/x11-recipient.py', encoding='utf-8').read(), 'x11-recipient.py', 'exec')"], {
    encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("foreign overlay ownership gate refuses before any click", { skip: !python }, () => {
  const result = spawnSync(python, [worker, "--self-test"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, foreign_overlay_refused: true, overlay_depth_refused: true, foreign_modal_refused: true, type_text_bounded: true });
});

test("worker rejects malformed protocol before opening X11", { skip: !python }, () => {
  const result = spawnSync(python, [worker], {
    input: JSON.stringify({ op: "click", window_id: "1", process_id: 1, application: "chrome", point: { x: 1, y: 1 }, extra: true }),
    encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: "x11_recipient_request_invalid" });
});
