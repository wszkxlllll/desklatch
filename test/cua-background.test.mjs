import assert from "node:assert/strict";
import test from "node:test";

import { ActionDeliveryMode, ActionEffect, ActionRoute } from "@trycua/cua-driver";

import { createDeskSession } from "../dist/session.js";
import { createDeskTools } from "../dist/tools.js";
import {
  CUA_DRIVER_VERSION,
  createCuaBackgroundBackend,
} from "../dist/backends/cua-background/index.js";

const target = { pid: 157, windowId: 9_007_199_254_740_999n };
const buttonName = "Export";
const editorName = "Editor";
const paneName = "List";

function nativeOk() {
  return {
    isError: false,
    degraded: false,
    images: [],
    action: {
      effect: ActionEffect.Confirmed,
      route: ActionRoute.Accessibility,
      delivery: { mode: ActionDeliveryMode.Background },
    },
  };
}

function stringifyNative(value) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

function fixture() {
  const f = {
    requests: [],
    closes: [],
    version: CUA_DRIVER_VERSION,
    seq: 0,
    rawPatch: {},
    identity: "wpf:157:9007199254740999:HwndWrapper[fixture-1]",
    act: nativeOk,
  };
  f.driver = {
    async metadata() {
      return { driverVersion: f.version };
    },
    async startSession({ session }) {
      f.session = session;
      return { active: true };
    },
    async endSession({ session }) {
      f.closes.push(session);
      return { active: false };
    },
    async callTool(name, json) {
      const args = JSON.parse(json, (key, value, context) => {
        if (key === "window_id" && context?.source && /^\d+$/u.test(context.source)) return BigInt(context.source);
        if (key === "window_id" && typeof value === "string" && /^\d+$/u.test(value)) return BigInt(value);
        return value;
      });
      f.requests.push({ name, args });
      if (name !== "get_window_state") return f.act(name, args);

      const snapshotId = "s" + ++f.seq;
      const rows = [
        { role: "Button", label: buttonName, actions: ["invoke"], screenshot_frame: { x: 2, y: 3, w: 8, h: 7 } },
        { role: "Edit", label: editorName, actions: ["text", "set_value"], value: "PRIVATE-VALUE" },
        { role: "Button", label: "Disabled", enabled: false, actions: ["invoke"] },
        { role: "Pane", label: paneName, actions: ["scroll"] },
        { role: "TitleBar", label: "Caption" },
        { role: "Button", label: "Close", parent_index: 4, depth: 2, actions: ["invoke"] },
      ];
      const elements = f.rawPatch.elements ?? rows.map((row, index) => ({
        enabled: true,
        element_index: index,
        depth: 1,
        element_token: snapshotId + ":" + index,
        ...row,
      }));
      const state = {
        pid: target.pid,
        window_id: target.windowId,
        snapshot_id: snapshotId,
        capture_id: "capture-" + f.seq,
        screenshot_width: 48,
        screenshot_height: 32,
        elements_complete: true,
        truncated: false,
        ...f.rawPatch,
        elements,
      };
      return {
        ...nativeOk(),
        images: args.include_screenshot ? [{ mimeType: "image/png", dataBase64: "ZmFrZQ==" }] : [],
        structuredJson: stringifyNative(state),
      };
    },
  };
  f.sent = () => f.requests.filter((request) => request.name !== "get_window_state");
  return f;
}

async function opened(t, options = {}) {
  const f = fixture();
  const backend = await createCuaBackgroundBackend({
    driver: f.driver,
    target,
    identifyWindow: async () => f.identity,
    ...options,
  });
  t.after(() => backend.close());
  return { f, backend };
}

test("rejects an old CUA driver before creating a session and requires the WPF fingerprint", async () => {
  const old = fixture();
  old.version = "0.22.2";
  await assert.rejects(createCuaBackgroundBackend({
    driver: old.driver,
    target,
    identifyWindow: async () => old.identity,
  }), /0\.54\.0/);
  assert.equal(old.session, undefined);

  const unverified = fixture();
  await assert.rejects(createCuaBackgroundBackend({
    driver: unverified.driver,
    target,
    identifyWindow: async () => undefined,
  }), /background_profile_unverified/);
  assert.equal(unverified.session, undefined);
});

test("controls-only observation asks CUA for no screenshot and publishes only narrow WPF actions", async (t) => {
  const { f, backend } = await opened(t);
  const frame = await backend.observe({ view: "controls" });
  const request = f.requests[0];
  assert.equal(request.name, "get_window_state");
  assert.equal(request.args.include_screenshot, false);
  assert.equal("image" in frame, false);
  assert.equal(frame.complete, true);
  assert.deepEqual(frame.controls.map((control) => control.actions), [["click"], ["type"], [], ["scroll"], [], []]);
  assert.equal(JSON.stringify(frame).includes("PRIVATE-VALUE"), false);
  assert.equal(request.args.window_id, target.windowId);
});

test("both view retains a native capture and preserves strict screenshot dimensions", async (t) => {
  const { f, backend } = await opened(t);
  const frame = await backend.observe({ view: "both" });
  const request = f.requests[0];
  assert.equal(request.args.include_screenshot, true);
  assert.equal(frame.profile, undefined);
  assert.equal(frame.image.width, 48);
  assert.equal(frame.image.height, 32);
  assert.equal(frame.complete, true);
});

test("dispatches only background click, single-line type, and vertical line scroll", async (t) => {
  const { f, backend } = await opened(t);
  const frame = await backend.observe({ view: "controls" });
  const clickControl = frame.controls.find((control) => control.name === buttonName);
  const pane = frame.controls.find((control) => control.name === paneName);
  assert.ok(clickControl && pane);

  const click = await backend.dispatch({ frame, target: clickControl, step: { kind: "click", target: { ref: "model-ref" } } });
  const typeFrame = await backend.observe({ view: "controls" });
  const editor = typeFrame.controls.find((control) => control.name === editorName);
  const type = await backend.dispatch({ frame: typeFrame, target: editor, step: { kind: "type", target: { ref: "model-ref" }, text: "single line" } });
  const scrollFrame = await backend.observe({ view: "controls" });
  const scrollControl = scrollFrame.controls.find((control) => control.name === paneName);
  const scroll = await backend.dispatch({ frame: scrollFrame, target: scrollControl, step: { kind: "scroll", target: { ref: "model-ref" }, direction: "down", amount: 2 } });
  assert.equal(click.status, "dispatched");
  assert.equal(type.status, "dispatched");
  assert.equal(scroll.status, "dispatched");
  assert.deepEqual(f.sent().map((request) => request.name), ["click", "type_text", "scroll"]);
  for (const request of f.sent()) {
    assert.equal(request.args.delivery_mode, "background");
    assert.deepEqual(request.args.target, { kind: "window", pid: target.pid, window_id: target.windowId });
    assert.equal(request.args.session, f.session);
  }
});

test("point click uses one native screenshot capture and rejects ambiguous or unsafe points", async (t) => {
  const { f, backend } = await opened(t);
  const frame = await backend.observe({ view: "both" });
  const button = frame.controls.find((control) => control.name === buttonName);
  assert.ok(button?.rect);
  const point = { x: 4, y: 6 };
  const hit = await backend.hitTest(frame, point);
  assert.equal(hit?.id, button.id);
  const dispatched = await backend.dispatch({ frame, target: button, step: { kind: "click", target: { point } } });
  assert.equal(dispatched.status, "dispatched");
  const captures = f.requests.filter((request) => request.name === "get_window_state" && request.args.include_screenshot === true);
  assert.equal(captures.length, 2);
  assert.equal(f.sent().length, 1);
  assert.equal(f.sent()[0].args.capture_id, "capture-2");

  const next = await backend.observe({ view: "both" });
  const bad = await backend.dispatch({ frame: next, target: next.controls.find((control) => control.name === buttonName), step: { kind: "click", target: { point: { x: 48, y: 0 } } } });
  assert.equal(bad.status, "refused");
  assert.equal(bad.code, "invalid_window_point");
  assert.equal(f.sent().length, 1);
});

test("reserved actions, right/double clicks, unsafe text, horizontal/page scroll, and disabled controls never reach CUA", async (t) => {
  const { f, backend } = await opened(t);
  const frame = await backend.observe({ view: "controls" });
  const button = frame.controls.find((control) => control.name === buttonName);
  const editor = frame.controls.find((control) => control.name === editorName);
  const pane = frame.controls.find((control) => control.name === paneName);
  const disabled = frame.controls.find((control) => control.name === "Disabled");
  const pending = [
    { kind: "click", target: { ref: "model-ref" }, button: "right" },
    { kind: "click", target: { ref: "model-ref" }, count: 2 },
    { kind: "setValue", target: { ref: "model-ref" }, value: "replacement" },
    { kind: "keypress", target: { ref: "model-ref" }, key: "F15" },
    { kind: "hotkey", target: { ref: "model-ref" }, keys: ["ctrl", "F15"] },
    { kind: "drag", from: { x: 2, y: 3 }, to: { x: 8, y: 9 } },
    { kind: "type", target: { ref: "model-ref" }, text: "one\ntwo" },
    { kind: "type", target: { point: { x: 4, y: 6 } }, text: "point-target" },
    { kind: "scroll", target: { point: { x: 4, y: 6 } }, direction: "down", amount: 1 },
    { kind: "scroll", target: { ref: "model-ref" }, direction: "right", amount: 1 },
    { kind: "scroll", target: { ref: "model-ref" }, direction: "up", by: "page", amount: 1 },
  ];
  for (const [index, step] of pending.entries()) {
    const control = step.kind === "type" ? editor : step.kind === "scroll" ? pane : button;
    const result = await backend.dispatch({ frame, target: control, step });
    assert.equal(result.status, "refused", String(index));
  }
  const disabledResult = await backend.dispatch({ frame, target: disabled, step: { kind: "click", target: { ref: "model-ref" } } });
  assert.equal(disabledResult.code, "control_disabled");
  assert.deepEqual(f.sent(), []);
});

test("changed WPF identity refuses before native dispatch and never falls back foreground", async (t) => {
  const { f, backend } = await opened(t);
  const frame = await backend.observe({ view: "controls" });
  f.identity = "wpf:157:9007199254740999:HwndWrapper[different-window]";
  const button = frame.controls.find((control) => control.name === buttonName);
  const result = await backend.dispatch({ frame, target: button, step: { kind: "click", target: { ref: "model-ref" } } });
  assert.equal(result.status, "refused");
  assert.equal(result.code, "window_profile_changed");
  assert.deepEqual(f.sent(), []);
});

test("DeskLatch session and public tools bridge the background backend without exposing approval controls", async (t) => {
  const { f, backend } = await opened(t);
  const session = createDeskSession(backend, {
    allowModelImages: false,
    policy: () => ({ decision: "allow", code: "fixture_allow" }),
  });
  t.after(() => session.close());
  const tools = createDeskTools(session);
  assert.deepEqual(tools.map((tool) => tool.name), ["observe", "act"]);
  const observation = await tools[0].invoke({ view: "controls" });
  assert.equal(observation.view, "controls");
  assert.equal("image" in observation, false);
  const targetRef = observation.controls.find((control) => control.name === buttonName)?.ref;
  assert.ok(targetRef);
  const result = await tools[1].invoke({ observationId: observation.observationId, steps: [{ kind: "click", target: { ref: targetRef } }] });
  assert.equal(result.status, "completed");
  assert.equal(f.sent().filter((request) => request.name === "click").length, 1);
});
