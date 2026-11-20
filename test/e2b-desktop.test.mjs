import assert from "node:assert/strict";
import test from "node:test";

const png1x1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);

function makeFixture() {
  let active = "100";
  const calls = [];
  const titles = new Map([["100", "Shanghai Museum"], ["200", "Untitled 1 - LibreOffice Writer"]]);
  const apps = new Map([["google-chrome", ["100"]], ["libreoffice", ["200"]]]);
  const worker = {
    async request(request) {
      assert.equal(request.op, "observe");
      return {
        ok: true,
        complete: true,
        windows: request.windows.map((window) => ({
          window_id: window.window_id,
          title: titles.get(window.window_id),
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          complete: true,
          controls: window.window_id === "200" ? [
            { id: "doc", role: "Document", name: "Writer document", editable: true, actions: ["text", "set_value"], rect: { x: 20, y: 80, width: 700, height: 450 } },
            { id: "save", role: "Button", name: "Save", actions: ["invoke"], rect: { x: 30, y: 30, width: 70, height: 24 } },
          ] : [
            { id: "page", role: "Document", name: "Museum page", actions: [], rect: { x: 20, y: 50, width: 700, height: 500 } },
          ],
        })),
      };
    },
    async close() { calls.push(["worker-close"]); },
  };
  const desktop = {
    async screenshot() { calls.push(["screenshot"]); return png1x1; },
    async getCurrentWindowId() { return active; },
    async getApplicationWindows(application) { return apps.get(application) ?? []; },
    async getWindowTitle(windowId) { return titles.get(windowId) ?? ""; },
    async activateWindow(windowId) { calls.push(["activate", active, windowId]); active = windowId; },
    async verifyPointOwnership(windowId, point) { calls.push(["verify-point", windowId, point.x, point.y]); return windowId === "200"; },
    async leftClick(x, y) { calls.push(["click", x, y]); },
    async doubleClick(x, y) { calls.push(["double-click", x, y]); },
    async write(text, options) { calls.push(["write", text, options]); },
    async press(keys) { calls.push(["press", keys]); },
    async scroll(direction, amount) { calls.push(["scroll", direction, amount]); },
  };
  return { desktop, worker, calls, titles };
}

test("E2B desktop backend binds exact windows and logs a model-originated switch", async () => {
  const { createE2BDesktopBackend } = await import("../dist/backends/e2b/desktop.js");
  const fixture = makeFixture();
  const events = [];
  const backend = await createE2BDesktopBackend(fixture.desktop, {
    windows: [
      { windowId: "100", application: "google-chrome", title: "Shanghai Museum" },
      { windowId: "200", application: "libreoffice", title: "Untitled 1 - LibreOffice Writer" },
    ],
    worker: fixture.worker,
    allowScreenshot: true,
    onWindowActivated: event => events.push(event),
  });
  try {
    const frame = await backend.observe({ view: "both" });
    assert.equal(frame.complete, true);
    assert.equal(frame.image.width, 1);
    assert.equal(frame.controls.some(control => control.role === "Window" && control.name === "Untitled 1 - LibreOffice Writer"), true);
    const writer = frame.controls.find(control => control.role === "Window" && control.name === "Untitled 1 - LibreOffice Writer");
    assert.ok(writer);
    const switched = await backend.dispatch({
      frame,
      target: writer,
      step: { kind: "click", target: { ref: writer.id } },
    });
    assert.deepEqual(switched, { status: "dispatched", code: "window_activated", focusId: writer.id });
    assert.deepEqual(events.map(event => [event.fromWindowId, event.windowId, event.source]), [["100", "200", "model-act"]]);
    assert.equal(backend.activationEvents.length, 1);
    assert.deepEqual(fixture.calls[0], ["screenshot"]);
    assert.deepEqual(fixture.calls.find(call => call[0] === "activate"), ["activate", "100", "200"]);
  } finally {
    await backend.close();
  }
  assert.deepEqual(fixture.calls.at(-1), ["worker-close"]);
});

test("E2B desktop backend performs bounded native text and key delivery", async () => {
  const { createE2BDesktopBackend } = await import("../dist/backends/e2b/desktop.js");
  const fixture = makeFixture();
  const backend = await createE2BDesktopBackend(fixture.desktop, {
    windows: [{ windowId: "200", application: "libreoffice", title: "Untitled 1 - LibreOffice Writer" }],
    worker: fixture.worker,
  });
  try {
    const frame = await backend.observe({ view: "controls" });
    const writerWindow = frame.controls.find(control => control.role === "Window");
    assert.ok(writerWindow);
    const activated = await backend.dispatch({ frame, target: writerWindow, step: { kind: "click", target: { ref: writerWindow.id } } });
    assert.equal(activated.status, "dispatched");
    const document = frame.controls.find(control => control.name === "Writer document");
    assert.ok(document);
    const nonAscii = await backend.dispatch({ frame, target: document, step: { kind: "type", target: { ref: document.id }, text: "第二行" } });
    assert.deepEqual(nonAscii, { status: "refused", code: "e2b_desktop_unicode_input_unavailable" });
    const written = await backend.dispatch({ frame, target: document, step: { kind: "type", target: { ref: document.id }, text: "Museum note\nSecond line" } });
    assert.equal(written.status, "dispatched");
    const set = await backend.dispatch({ frame: await backend.observe({ view: "controls" }), target: document, step: { kind: "setValue", target: { ref: document.id }, value: "Replaced note" } });
    assert.equal(set.status, "dispatched");
    const beforeScroll = fixture.calls.filter(call => call[0] === "scroll").length;
    const unboundScroll = await backend.dispatch({ frame, target: document, step: { kind: "scroll", target: { ref: document.id }, direction: "down", amount: 1 } });
    assert.deepEqual(unboundScroll, { status: "refused", code: "e2b_desktop_action_unsupported" });
    assert.equal(backend.capabilities.some(capability => capability.kind === "scroll"), false);
    assert.equal(fixture.calls.filter(call => call[0] === "scroll").length, beforeScroll);
    assert.deepEqual(fixture.calls.filter(call => call[0] === "press").at(-1), ["press", ["ctrl", "a"]]);
    assert.equal(fixture.calls.some(call => call[0] === "write" && call[1] === "Museum note\nSecond line"), true);
    const denied = await backend.dispatch({ frame, target: document, step: { kind: "keypress", target: { ref: document.id }, key: "ctrl" } });
    assert.deepEqual(denied, { status: "refused", code: "e2b_desktop_key_unsupported" });
  } finally {
    await backend.close();
  }
});

test("point capability is withheld when no fixed ownership proof exists", async () => {
  const { createE2BDesktopBackend } = await import("../dist/backends/e2b/desktop.js");
  const fixture = makeFixture();
  const { verifyPointOwnership: _unused, ...withoutPointProof } = fixture.desktop;
  const backend = await createE2BDesktopBackend(withoutPointProof, {
    windows: [{ windowId: "200", application: "libreoffice", title: "Untitled 1 - LibreOffice Writer" }],
    worker: fixture.worker,
    allowPointActions: true,
  });
  try {
    assert.equal(backend.capabilities.some(capability => capability.targets.includes("point")), false);
  } finally {
    await backend.close();
  }
});

test("E2B desktop backend refuses a changed exact window grant", async () => {
  const { createE2BDesktopBackend } = await import("../dist/backends/e2b/desktop.js");
  const fixture = makeFixture();
  const backend = await createE2BDesktopBackend(fixture.desktop, {
    windows: [{ windowId: "200", application: "libreoffice", title: "Untitled 1 - LibreOffice Writer" }],
    worker: fixture.worker,
  });
  try {
    const frame = await backend.observe({ view: "controls" });
    const writer = frame.controls.find(control => control.role === "Window");
    assert.ok(writer);
    fixture.titles.set("200", "A different application");
    const result = await backend.dispatch({ frame, target: writer, step: { kind: "click", target: { ref: writer.id } } });
    assert.deepEqual(result, { status: "refused", code: "e2b_desktop_target_stale" });
    assert.equal(fixture.calls.some(call => call[0] === "activate"), false);
  } finally {
    await backend.close();
  }
});

test("dispatch rejects a same-XID PID/application grant replacement", async () => {
  const { createE2BDesktopBackend } = await import("../dist/backends/e2b/desktop.js");
  const fixture = makeFixture();
  let livePid = 123;
  fixture.desktop.commands = {
    async run(command) {
      if (command.startsWith("xprop -id")) return { stdout: `_NET_WM_PID(CARDINAL) = ${livePid}\n` };
      throw Error(`unexpected:${command}`);
    },
  };
  fixture.worker.request = async request => ({
    ok: true,
    complete: true,
    windows: request.windows.map(window => ({
      window_id: window.window_id,
      process_id: livePid,
      title: fixture.titles.get(window.window_id),
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      complete: true,
      controls: [{ id: "doc", role: "Document", name: "Writer document", editable: true, actions: ["text", "set_value"], rect: { x: 20, y: 80, width: 700, height: 450 } }],
    })),
  });
  let discoveredPid = 123;
  const backend = await createE2BDesktopBackend(fixture.desktop, {
    windows: [{ windowId: "200", application: "libreoffice", processId: 123, title: "Untitled 1 - LibreOffice Writer" }],
    discoverWindows: async () => [{ windowId: "200", application: "libreoffice", processId: discoveredPid, title: "Untitled 1 - LibreOffice Writer" }],
    worker: fixture.worker,
  });
  try {
    const frame = await backend.observe({ view: "controls" });
    const document = frame.controls.find(control => control.name === "Writer document");
    assert.ok(document);
    livePid = 456;
    discoveredPid = 456;
    const result = await backend.dispatch({ frame, target: document, step: { kind: "setValue", target: { ref: document.id }, value: "must refuse" } });
    assert.deepEqual(result, { status: "refused", code: "e2b_desktop_window_grant_changed" });
  } finally {
    await backend.close();
  }
});

test("single keyboard grant cannot be dynamically transferred to a new PID", async () => {
  const { createE2BDesktopBackend } = await import("../dist/backends/e2b/desktop.js");
  const fixture = makeFixture();
  let livePid = 123;
  fixture.desktop.commands = {
    async run(command) {
      if (command.startsWith("xprop -id")) return { stdout: `_NET_WM_PID(CARDINAL) = ${livePid}\n` };
      throw Error(`unexpected:${command}`);
    },
  };
  const worker = { async request() { const error = Error("e2b_atspi_unavailable"); error.code = "e2b_atspi_unavailable"; throw error; } };
  const backend = await createE2BDesktopBackend(fixture.desktop, {
    windows: [{ windowId: "200", application: "libreoffice", processId: 123, title: "Untitled 1 - LibreOffice Writer" }],
    discoverWindows: async () => [{ windowId: "200", application: "libreoffice", processId: 456, title: "Untitled 1 - LibreOffice Writer" }],
    worker,
    allowDegradedScreenshot: true,
    allowKeyboardInput: true,
    keyboardRecipient: { async verifyFocus() { return true; } },
  });
  try {
    await assert.rejects(() => backend.observe({ view: "controls" }), error => error?.code === "e2b_desktop_keyboard_grant_changed");
  } finally {
    await backend.close();
  }
});

test("packaged AT-SPI worker carries only base64 request data to its fixed script", async () => {
  const { E2BAtSpiCommandWorker } = await import("../dist/backends/e2b/desktop.js");
  const commands = [];
  const worker = new E2BAtSpiCommandWorker({
    commands: {
      async run(command) {
        commands.push(command);
        return { stdout: JSON.stringify({ ok: true, windows: [], complete: true }) };
      },
    },
  });
  const title = "writer'; $(touch /tmp/not-allowed)";
  const value = await worker.request({ op: "observe", windows: [{ window_id: "200", application: "libreoffice", title }] });
  assert.deepEqual(value, { ok: true, windows: [], complete: true });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].includes(title), false);
  assert.match(commands[0], /^python3 -u -c "import base64,io,sys;/u);
});

test("fixed X11 recipient worker carries bounded proof requests to the packaged libX11 helper", async () => {
  const { E2BX11RecipientProcess } = await import("../dist/backends/e2b/desktop.js");
  const commands = [];
  const recipient = new E2BX11RecipientProcess({
    commands: {
      async run(command) {
        commands.push(command);
        return { stdout: JSON.stringify({ ok: true, op: "verify", window_id: "300", process_id: 123 }) };
      },
    },
  });
  assert.equal(await recipient.verify({ windowId: "300", processId: 123, application: "libreoffice", point: { x: 10, y: 20 } }), true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].includes("libreoffice"), false);
  assert.match(commands[0], /^python3 -u -c "import base64,io,sys;/u);
});

test("a child loss after a verified point click is unknown, never not-dispatched", async () => {
  const { createE2BDesktopBackend } = await import("../dist/backends/e2b/desktop.js");
  const fixture = makeFixture();
  fixture.desktop.getCurrentWindowId = async () => "200";
  const workerRequest = fixture.worker.request.bind(fixture.worker);
  fixture.worker.request = async request => {
    const result = await workerRequest(request);
    return { ...result, windows: result.windows.map(window => ({ ...window, process_id: 123 })) };
  };
  const backend = await createE2BDesktopBackend(fixture.desktop, {
    windows: [{ windowId: "200", application: "libreoffice", processId: 123, title: "Untitled 1 - LibreOffice Writer" }],
    worker: fixture.worker,
    recipient: {
      async verify() { return true; },
      async click() { throw Error("child_stdout_lost_after_click"); },
    },
  });
  try {
    const frame = await backend.observe({ view: "controls" });
    const document = frame.controls.find(control => control.name === "Writer document");
    assert.ok(document);
    const result = await backend.dispatch({ frame, target: document, step: { kind: "click", target: { point: { x: 40, y: 100 } } } });
    assert.deepEqual(result, { status: "unknown", code: "e2b_desktop_point_delivery_unknown" });
  } finally {
    await backend.close();
  }
});

test("public sessions use complete-frame point evidence and withdraw degraded coordinates", async () => {
  const { createE2BDesktopBackend } = await import("../dist/backends/e2b/desktop.js");
  const { createDeskSession } = await import("../dist/index.js");

  const fixture = makeFixture();
  fixture.desktop.getCurrentWindowId = async () => "200";
  fixture.desktop.screenshot = async () => {
    const image = Uint8Array.from(png1x1);
    const dimensions = new DataView(image.buffer);
    dimensions.setUint32(16, 800);
    dimensions.setUint32(20, 600);
    return image;
  };
  let changedPoint = false;
  const workerRequest = fixture.worker.request.bind(fixture.worker);
  fixture.worker.request = async request => {
    const result = await workerRequest(request);
    return { ...result, windows: result.windows.map(window => ({
      ...window,
      process_id: 123,
      controls: window.controls?.map(control => control.id === "save"
        ? { ...control, ...(changedPoint ? { id: "save-replacement", name: "Save replacement" } : {}), effect: "read" }
        : control),
    })) };
  };
  const backend = await createE2BDesktopBackend(fixture.desktop, {
    windows: [{ windowId: "200", application: "libreoffice", processId: 123, title: "Untitled 1 - LibreOffice Writer" }],
    worker: fixture.worker,
    allowScreenshot: true,
    allowPointActions: true,
  });
  const session = createDeskSession(backend, { allowModelImages: true });
  try {
    assert.equal(backend.hitTestSnapshot, true);
    assert.equal(session.capabilities.some(capability => capability.targets.includes("point")), true);
    const observation = await session.observe({ view: "both" });
    const delivered = await session.act({ observationId: observation.observationId, steps: [{ kind: "click", target: { point: { x: 40, y: 40 } } }] });
    assert.equal(delivered.status, "completed", JSON.stringify(delivered));
    const beforeClicks = fixture.calls.filter(call => call[0] === "click").length;
    changedPoint = true;
    const changed = await session.act({ observationId: observation.observationId, steps: [{ kind: "click", target: { point: { x: 40, y: 40 } } }] });
    assert.equal(changed.status, "stopped");
    assert.equal(changed.code, "stale_point");
    changedPoint = false;
    fixture.desktop.verifyPointOwnership = async () => false;
    const occluded = await session.act({ observationId: observation.observationId, steps: [{ kind: "click", target: { point: { x: 40, y: 40 } } }] });
    assert.equal(occluded.status, "stopped");
    assert.equal(fixture.calls.filter(call => call[0] === "click").length, beforeClicks);
  } finally {
    await session.close();
  }

  const degradedFixture = makeFixture();
  degradedFixture.desktop.commands = {
    async run(command) {
      if (command.startsWith("xprop -root")) return { stdout: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0xc8\n" };
      if (command.startsWith("xprop -id")) return { stdout: "_NET_WM_PID(CARDINAL) = 123\n" };
      if (command.startsWith("xdotool getwindowgeometry")) return { stdout: "WINDOW=200\nX=0\nY=0\nWIDTH=800\nHEIGHT=600\n" };
      throw Error(`unexpected:${command}`);
    },
  };
  const unavailable = { async request() { const error = Error("e2b_atspi_unavailable"); error.code = "e2b_atspi_unavailable"; throw error; } };
  const degraded = await createE2BDesktopBackend(degradedFixture.desktop, {
    windows: [{ windowId: "200", application: "libreoffice", processId: 123, title: "Untitled 1 - LibreOffice Writer" }],
    worker: unavailable,
    allowScreenshot: true,
    allowDegradedScreenshot: true,
    allowPointActions: true,
  });
  const degradedSession = createDeskSession(degraded, { allowModelImages: true });
  try {
    assert.equal(degraded.hitTestSnapshot, false);
    assert.equal(degradedSession.capabilities.some(capability => capability.targets.includes("point")), false);
    const observation = await degradedSession.observe({ view: "both" });
    const refused = await degradedSession.act({ observationId: observation.observationId, steps: [{ kind: "click", target: { point: { x: 400, y: 300 } } }] });
    assert.equal(refused.status, "rejected");
    assert.equal(degradedFixture.calls.some(call => call[0] === "click"), false);
  } finally {
    await degradedSession.close();
  }
});

test("E2B desktop backend can refresh a host-approved same-app dialog grant", async () => {
  const { createE2BDesktopBackend } = await import("../dist/backends/e2b/desktop.js");
  const fixture = makeFixture();
  let includeDialog = false;
  fixture.desktop.getApplicationWindows = async application => application === "libreoffice" ? (includeDialog ? ["200", "300"] : ["200"]) : [];
  fixture.desktop.getWindowTitle = async windowId => windowId === "300" ? "Save As" : (fixture.titles.get(windowId) ?? "");
  fixture.worker.request = async request => ({
    ok: true,
    complete: true,
    windows: request.windows.map(window => ({
      window_id: window.window_id,
      title: window.window_id === "300" ? "Save As" : fixture.titles.get(window.window_id),
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      complete: true,
      controls: window.window_id === "300" ? [{ id: "filename", role: "Edit", name: "File name", editable: true, actions: ["set_value"], rect: { x: 20, y: 40, width: 500, height: 24 } }] : [],
    })),
  });
  const backend = await createE2BDesktopBackend(fixture.desktop, {
    windows: [{ windowId: "200", application: "libreoffice", title: "Untitled 1 - LibreOffice Writer" }],
    discoverWindows: async () => includeDialog
      ? [{ windowId: "200", application: "libreoffice", title: "Untitled 1 - LibreOffice Writer" }, { windowId: "300", application: "libreoffice", title: "Save As" }]
      : [{ windowId: "200", application: "libreoffice", title: "Untitled 1 - LibreOffice Writer" }],
    worker: fixture.worker,
  });
  try {
    const first = await backend.observe({ view: "controls" });
    assert.equal(first.controls.some(control => control.name === "File name"), false);
    includeDialog = true;
    const second = await backend.observe({ view: "controls" });
    assert.equal(second.controls.some(control => control.name === "File name"), true);
  } finally {
    await backend.close();
  }
});

test("opt-in screenshot fallback exposes an incomplete Window canvas and requires ownership proof", async () => {
  const { createE2BDesktopBackend } = await import("../dist/backends/e2b/desktop.js");
  const calls = [];
  let pointOwned = true;
  const desktop = {
    async screenshot() { return png1x1; },
    async getApplicationWindows() { return ["300"]; },
    async getWindowTitle() { return "museum-note - LibreOffice Writer"; },
    async getScreenSize() { return { width: 800, height: 600 }; },
    async verifyPointOwnership(windowId, point) { calls.push(["verify-point", windowId, point.x, point.y]); return pointOwned; },
    async leftClick(x, y) { calls.push(["click", x, y]); },
    async write(text) { calls.push(["write", text]); },
    async press(keys) { calls.push(["press", keys]); },
    commands: {
      async run(command) {
        if (command.startsWith("xprop -root")) return { stdout: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x12c\n" };
        if (command.startsWith("xprop -id")) return { stdout: "_NET_WM_PID(CARDINAL) = 123\n" };
        if (command.startsWith("xdotool getwindowgeometry")) return { stdout: "WINDOW=300\nX=0\nY=0\nWIDTH=800\nHEIGHT=600\n" };
        if (command.startsWith("xdotool mousemove")) return { stdout: "X=400\nY=300\nSCREEN=0\nWINDOW=300\n" };
        throw Error(`unexpected:${command}`);
      },
    },
  };
  const worker = { async request() { const error = Error("e2b_atspi_unavailable"); error.code = "e2b_atspi_unavailable"; throw error; } };
  const backend = await createE2BDesktopBackend(desktop, {
    windows: [{ windowId: "300", application: "libreoffice", processId: 123, title: "museum-note - LibreOffice Writer" }],
    worker,
    allowScreenshot: true,
    allowDegradedScreenshot: true,
    allowPointActions: true,
  });
  try {
    const frame = await backend.observe({ view: "both" });
    assert.equal(backend.capabilityMode, "screenshot-point-degraded");
    assert.equal(frame.complete, false);
    assert.equal(backend.capabilities.some(capability => ["type", "setValue", "keypress", "hotkey", "scroll"].includes(capability.kind)), false);
    assert.deepEqual(frame.controls.map(control => ({ role: control.role, name: control.name, actions: control.actions, effect: control.effect })), [{
      role: "Window",
      name: "museum-note - LibreOffice Writer",
      actions: ["click"],
      effect: "unknown",
    }]);
    const target = frame.controls[0];
    const hit = await backend.hitTest(frame, { x: 400, y: 300 });
    assert.equal(hit?.id, target.id);
    const click = await backend.dispatch({ frame, target: hit, origin: frame, step: { kind: "click", target: { point: { x: 400, y: 300 } } } });
    assert.equal(click.status, "dispatched");
    pointOwned = false;
    assert.equal(await backend.hitTest(frame, { x: 400, y: 300 }), undefined);
    const foreign = await backend.dispatch({ frame, target, origin: frame, step: { kind: "click", target: { point: { x: 400, y: 300 } } } });
    assert.deepEqual(foreign, { status: "refused", code: "e2b_desktop_point_not_owned" });
    const typed = await backend.dispatch({ frame, target, step: { kind: "type", target: { ref: target.id }, text: "真实编辑器输入" } });
    assert.deepEqual(typed, { status: "refused", code: "e2b_desktop_control_not_editable" });
    assert.equal(calls.some(call => call[0] === "write"), false);
  } finally {
    await backend.close();
  }
});

test("focused-window keyboard input requires an explicit single-grant verifier", async () => {
  const { createE2BDesktopBackend } = await import("../dist/backends/e2b/desktop.js");
  const fixture = makeFixture();
  fixture.desktop.getCurrentWindowId = async () => "200";
  fixture.desktop.commands = {
    async run(command) {
      if (command.startsWith("xprop -root")) return { stdout: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0xc8\n" };
      if (command.startsWith("xprop -id")) return { stdout: "_NET_WM_PID(CARDINAL) = 123\n" };
      if (command.startsWith("xdotool getwindowgeometry")) return { stdout: "WINDOW=200\nX=0\nY=0\nWIDTH=800\nHEIGHT=600\n" };
      throw Error(`unexpected:${command}`);
    },
  };
  const worker = { async request() { const error = Error("e2b_atspi_unavailable"); error.code = "e2b_atspi_unavailable"; throw error; } };
  const keyboardCalls = [];
  const backend = await createE2BDesktopBackend(fixture.desktop, {
    windows: [{ windowId: "200", application: "libreoffice", processId: 123, title: "Untitled 1 - LibreOffice Writer" }],
    worker,
    allowScreenshot: true,
    allowDegradedScreenshot: true,
    allowKeyboardInput: true,
    keyboardRecipient: {
      async verifyFocus(request) { keyboardCalls.push(["verify-focus", request.windowId, request.processId, request.application]); return true; },
    },
  });
  try {
    const frame = await backend.observe({ view: "controls" });
    const target = frame.controls[0];
    assert.deepEqual(target.actions, ["click", "type", "hotkey"]);
    const typed = await backend.dispatch({ frame, target, step: { kind: "type", target: { ref: target.id }, text: "focused note" } });
    assert.equal(typed.status, "dispatched");
    const saved = await backend.dispatch({ frame, target, step: { kind: "hotkey", target: { ref: target.id }, keys: ["ctrl", "s"] } });
    assert.equal(saved.status, "dispatched");
    assert.equal(keyboardCalls.length, 2);
    assert.equal(fixture.calls.some(call => call[0] === "write" && call[1] === "focused note"), true);
    assert.equal(fixture.calls.some(call => call[0] === "press" && JSON.stringify(call[1]) === JSON.stringify(["ctrl", "s"])), true);
  } finally {
    await backend.close();
  }
});
