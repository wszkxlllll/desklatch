import assert from "node:assert/strict";
import test from "node:test";
import { NativeUiAutomationWindowsTransport } from "../dist/backends/windows/dialog-transport.js";

const target = { pid: 51001, hwnd: 0x100000000101n, title: "Selector dialog" };

function worker() {
  const requests = [];
  return {
    requests,
    worker: {
      async request(request) {
        requests.push(request);
        const allElements = [
          { element_index: "0", depth: 0, role: "Window", label: "Selector dialog", actions: [] },
          { element_index: "1", depth: 1, role: "Button", label: "Search", actions: ["invoke"], token: "uia1.c2VhcmNo" },
          { element_index: "2", depth: 1, role: "Button", label: "Search", actions: ["invoke"], token: "uia1.c2VhcmNoMg" },
        ];
        return {
          ok: true,
          pid: target.pid,
          window_id: String(target.hwnd),
          elements_complete: true,
          elements: request.where ? allElements.slice(1) : allElements,
        };
      },
    },
  };
}

test("canonical role+name selector is forwarded to the bounded worker", async () => {
  const fake = worker();
  const transport = new NativeUiAutomationWindowsTransport({ worker: fake.worker });
  await transport.open();
  const snapshot = await transport.observeWindow(target, { where: { role: " Button ", name: " Search " } });
  assert.deepEqual(fake.requests.at(-1).where, { role: " Button ", name: " Search " });
  assert.equal(snapshot.elements.length, 2);
  assert.equal(snapshot.complete, true);
  await transport.close();
});

test("noncanonical scope selectors stay on the existing full-tree path", async () => {
  const fake = worker();
  const transport = new NativeUiAutomationWindowsTransport({ worker: fake.worker });
  await transport.open();
  const snapshot = await transport.observeWindow(target, { where: { role: "Button", name: "Search", within: "other-window" } });
  assert.equal(Object.hasOwn(fake.requests.at(-1), "where"), false);
  assert.equal(snapshot.elements.length, 3);
  await transport.close();
});

test("selector ambiguity remains non-complete rather than selecting the first candidate", async () => {
  const fake = worker();
  fake.worker.request = async request => {
    fake.requests.push(request);
    return {
      ok: true,
      pid: target.pid,
      window_id: String(target.hwnd),
      elements_complete: false,
      selector_match_count: 2,
      elements: [{ element_index: "1", depth: 1, role: "Button", label: "Search", actions: ["invoke"] }, { element_index: "2", depth: 1, role: "Button", label: "Search", actions: ["invoke"] }],
    };
  };
  const transport = new NativeUiAutomationWindowsTransport({ worker: fake.worker });
  await transport.open();
  const snapshot = await transport.observeWindow(target, { where: { role: "Button", name: "Search" } });
  assert.equal(snapshot.elements.length, 2);
  assert.equal(snapshot.complete, false);
  await transport.close();
});
