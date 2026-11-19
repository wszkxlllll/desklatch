import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const nodeMajor = Number(process.versions.node.split(".")[0]);

async function findCachedChromium(chromium) {
  const candidates = [process.env.DESKLATCH_CHROMIUM, chromium.executablePath()].filter(Boolean);
  const root = process.env.LOCALAPPDATA;
  if (root) {
    try {
      for (const name of await readdir(join(root, "ms-playwright"))) {
        candidates.push(join(root, "ms-playwright", name, "chrome-win64", "chrome.exe"));
      }
    } catch {
      // The positive test is optional when no browser cache is present.
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next local cache entry.
    }
  }
  return undefined;
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.error === undefined && result.status === 0;
}

function readLines(child, count) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const lines = [];
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error("bridge_test_timeout"));
    }, 5000);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      while (lines.length < count) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (lines.length >= count) {
        child.stdout.off("data", onData);
        clearTimeout(timer);
        resolve(lines);
      }
    };
    child.stdout.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      reject(error);
    });
  });
}

async function makeLocalCdpGuest(chromium, executablePath, options = {}) {
  const profile = await mkdtemp(join(tmpdir(), "desklatch-e2b-chrome-"));
  const child = spawn(executablePath, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const stopChild = async () => {
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    await rm(profile, { recursive: true, force: true });
  };
  let endpoint;
  try {
    endpoint = await new Promise((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(Error("local_chromium_start_timeout")), 10_000);
      const onData = (chunk) => {
        stderr += chunk.toString("utf8");
        const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/u);
        if (match) {
          clearTimeout(timer);
          child.stderr.off("data", onData);
          resolve(match[1]);
        }
      };
      child.stderr.on("data", onData);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        if (code !== null) { clearTimeout(timer); reject(Error(`local_chromium_exit_${code}`)); }
      });
    });
  } catch (error) {
    await stopChild();
    throw error;
  }
  const socket = new WebSocket(endpoint);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(Error("local_cdp_socket_error")), { once: true });
    });
  } catch (error) {
    socket.close();
    await stopChild();
    throw error;
  }
  let onStdout;
  let closed = false;
  const metrics = { sendCalls: 0, sendLines: 0, sendBytes: 0, maxBatchLines: 0 };
  let resolveWait;
  const waitPromise = new Promise((resolve) => { resolveWait = resolve; });
  let resolveReady;
  let rejectReady;
  let initialPageUrls;
  const targetReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyTimer = setTimeout(() => rejectReady(Error("local_cdp_target_timeout")), 5000);
  let targetProbeId = 1;
  const emit = (message) => {
    if (closed || !onStdout) return;
    onStdout(`${Buffer.from(JSON.stringify(message), "utf8").toString("base64")}\n`);
  };
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      if (!initialPageUrls && message.id === targetProbeId && message.result?.targetInfos) {
        // Chrome can publish other CDP target types before its initial page.
        // The runtime grants one Page in one context, so inspect that same unit.
        const pageUrls = message.result.targetInfos.filter(target => target.type === "page").map(target => target.url);
        if (pageUrls.includes("about:blank")) {
          initialPageUrls = pageUrls;
          clearTimeout(readyTimer);
          resolveReady();
        } else {
          targetProbeId += 1;
          setTimeout(() => socket.send(JSON.stringify({ id: targetProbeId, method: "Target.getTargets" })), 25);
        }
      }
      emit(message);
    }
    catch { rejectReady(Error("local_cdp_protocol_error")); }
  });
  socket.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
  try {
    await targetReady;
  } catch (error) {
    socket.close();
    await stopChild();
    throw error;
  }
  const closeOrigin = async () => {
    if (closed) return;
    closed = true;
    socket.close();
    await stopChild();
    resolveWait({ exitCode: 0 });
  };
  child.once("exit", () => { if (!closed) resolveWait({ exitCode: 0 }); });
  const handle = {
    async sendStdin(data) {
      if (closed) throw Error("local_cdp_closed");
      const lines = data.split("\n").filter(Boolean);
      metrics.sendCalls += 1;
      metrics.sendLines += lines.length;
      metrics.sendBytes += Buffer.byteLength(data, "utf8");
      metrics.maxBatchLines = Math.max(metrics.maxBatchLines, lines.length);
      for (const line of lines) {
        if (!line) continue;
        socket.send(line);
      }
      if (options.sendDelayMs) await new Promise(resolve => setTimeout(resolve, options.sendDelayMs));
    },
    closeStdin: closeOrigin,
    wait: async () => waitPromise,
    kill: async () => { await closeOrigin(); return true; },
  };
  const guest = {
    commands: {
      async run(_command, options) {
        onStdout = options.onStdout;
        return handle;
      },
    },
  };
  return { guest, close: closeOrigin, initialPageUrls, metrics };
}

test("the private Python bridge preserves multiple CDP frames and retires on EOF", { skip: process.platform !== "linux" || !commandExists("python3") }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "desklatch-e2b-"));
  const fakeChromium = join(directory, "chromium");
  const bridge = join(process.cwd(), "src", "backends", "e2b", "chromium_pipe.py");
  const fakeSource = [
    "#!/usr/bin/env python3",
    "import os",
    "pending = b''",
    "while True:",
    "    chunk = os.read(3, 65536)",
    "    if not chunk:",
    "        break",
    "    pending += chunk",
    "    while b'\\0' in pending:",
    "        message, pending = pending.split(b'\\0', 1)",
    "        os.write(4, message + b'\\0')",
  ].join("\n");
  await writeFile(fakeChromium, `${fakeSource}\n`, "utf8");
  await chmod(fakeChromium, 0o755);
  const child = spawn("python3", [bridge], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    child.stdin.write('{"id":1,"method":"Browser.getVersion"}\n{"id":2,"method":"Target.getTargets"}\n');
    const [firstLine, secondLine] = await readLines(child, 2);
    const first = JSON.parse(Buffer.from(firstLine, "base64").toString("utf8"));
    const second = JSON.parse(Buffer.from(secondLine, "base64").toString("utf8"));
    assert.deepEqual(first, { id: 1, method: "Browser.getVersion" });
    assert.deepEqual(second, { id: 2, method: "Target.getTargets" });
    child.stdin.end();
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    assert.equal(exitCode, 0);
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed-page startup abort uses the host-owned command and retires its handle", { skip: nodeMajor < 22 }, async () => {
  const { openE2BManagedPage } = await import("../dist/backends/e2b/index.js");
  const controller = new AbortController();
  const sent = [];
  let runOptions;
  let stdinClosed = 0;
  let killed = 0;
  const attached = Promise.withResolvers();
  const exited = Promise.withResolvers();
  const handle = {
    async sendStdin(data) { sent.push(data); },
    async closeStdin() { stdinClosed += 1; exited.resolve({ exitCode: 0 }); },
    async wait() { attached.resolve(); return exited.promise; },
    async kill() { killed += 1; return true; },
  };
  const guest = {
    commands: {
      async run(command, options) {
        runOptions = { command, options };
        return handle;
      },
    },
  };
  const pending = openE2BManagedPage(guest, { startupTimeoutMs: 5000, processTimeoutMs: 1000, signal: controller.signal });
  await attached.promise;
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof Error && error.message === "guest_aborted");
  assert.equal(runOptions.options.background, true);
  assert.equal(runOptions.options.stdin, true);
  assert.equal(runOptions.options.retainOutput, false);
  assert.equal(runOptions.options.signal, controller.signal);
  assert.match(runOptions.command, /^exec python3 -u -c /);
  assert.equal(stdinClosed, 1);
  assert.equal(killed, 0);
  for (const line of sent) assert.doesNotThrow(() => JSON.parse(line));
});

test("managed-page startup timeout retires a command handle that resolves late", { skip: nodeMajor < 22 }, async () => {
  const { openE2BManagedPage } = await import("../dist/backends/e2b/index.js");
  let stdinClosed = 0;
  let resolveStart;
  const handle = {
    async sendStdin() {},
    async closeStdin() { stdinClosed += 1; },
    async wait() { return { exitCode: 0 }; },
    async kill() { return true; },
  };
  const guest = { commands: { run: async () => new Promise((resolve) => { resolveStart = resolve; }) } };
  const pending = openE2BManagedPage(guest, { startupTimeoutMs: 20, processTimeoutMs: 1000 });
  await assert.rejects(pending, (error) => error instanceof Error && error.message === "guest_timeout");
  resolveStart(handle);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(stdinClosed, 1);
});

test("managed page uses ConnectOverCDPTransport with an owned cached Chromium", { skip: nodeMajor < 22 }, async (t) => {
  const e2b = await import("../dist/backends/e2b/index.js");
  const { chromium } = await import("playwright-core");
  const executablePath = await findCachedChromium(chromium);
  if (!executablePath) {
    t.skip("No cached local Chromium was found; this test never downloads one.");
    return;
  }
  const local = await makeLocalCdpGuest(chromium, executablePath);
  let managed;
  try {
    managed = await e2b.openE2BManagedPage(local.guest, { startupTimeoutMs: 10_000, processTimeoutMs: 30_000 });
    assert.equal(await managed.page.url(), "about:blank");
    await managed.page.evaluate(() => { document.title = "DeskLatch local CDP"; });
    assert.equal(await managed.page.title(), "DeskLatch local CDP");
  } finally {
    if (managed) await managed.close();
    else await local.close();
  }
});

test("managed CDP preserves real page flow while coalescing queued writes", { skip: nodeMajor < 22 }, async (t) => {
  const e2b = await import("../dist/backends/e2b/index.js");
  const { chromium } = await import("playwright-core");
  const executablePath = await findCachedChromium(chromium);
  if (!executablePath) {
    t.skip("No cached local Chromium was found; this test never downloads one.");
    return;
  }
  const local = await makeLocalCdpGuest(chromium, executablePath, { sendDelayMs: 2 });
  let backend;
  try {
    backend = await e2b.createE2BBrowserBackend(local.guest, {
      startupTimeoutMs: 10_000,
      processTimeoutMs: 30_000,
      browser: { allowBlank: true },
      prepare: async (page) => {
        await page.goto("data:text/html,<title>Coalesced CDP</title><main><button id='one'>One</button><button id='two'>Two</button><input aria-label='Field'></main>");
      },
    });
    const frame = await backend.observe({ view: "controls" });
    assert.equal(frame.controls.some((control) => control.name === "One"), true);
    assert.equal(frame.controls.some((control) => control.name === "Field"), true);
    assert.ok(local.metrics.sendLines > 0);
    assert.ok(local.metrics.sendCalls < local.metrics.sendLines, JSON.stringify(local.metrics));
    assert.ok(local.metrics.maxBatchLines >= 2, JSON.stringify(local.metrics));
  } finally {
    if (backend) await backend.close();
    else await local.close();
  }
});

test("E2B backend passes explicit browser origin grants to its scoped page", { skip: nodeMajor < 22 }, async (t) => {
  const e2b = await import("../dist/backends/e2b/index.js");
  const { chromium } = await import("playwright-core");
  const executablePath = await findCachedChromium(chromium);
  if (!executablePath) {
    t.skip("No cached local Chromium was found; this test never downloads one.");
    return;
  }
  const local = await makeLocalCdpGuest(chromium, executablePath);
  let backend;
  try {
    assert.deepEqual(local.initialPageUrls, ["about:blank"]);
    backend = await e2b.createE2BBrowserBackend(local.guest, {
      startupTimeoutMs: 10_000,
      processTimeoutMs: 30_000,
      browser: { authorizedOrigins: ["https://allowed.example"], allowBlank: false },
    });
    await assert.rejects(backend.observe({ view: "controls" }), (error) => error instanceof Error && error.message === "unauthorized_origin");
  } finally {
    if (backend) await backend.close();
    else await local.close();
  }
});
