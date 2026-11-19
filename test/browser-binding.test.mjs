import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserBackend } from "../dist/backends/browser/index.js";

function rawControl(id, name, overrides = {}) {
  return {
    path: `body>button#${id}`,
    key: `id:${id}`,
    role: "button",
    name,
    labels: [],
    withinKeys: [],
    states: ["visible", "enabled"],
    actions: ["click"],
    rect: { x: 1, y: 1, width: 80, height: 24 },
    sensitive: false,
    href: undefined,
    filterAction: false,
    disclosure: false,
    formSubmitter: false,
    sameDocumentTab: false,
    enterMaySubmit: false,
    approvalCandidate: false,
    tagName: "button",
    type: "button",
    disabled: false,
    stableKind: "id",
    ...overrides,
  };
}

function makeHandle(label, disposed) {
  return {
    async dispose() { disposed.push(label); },
    async evaluate() { return true; },
  };
}

function documentResult(chunks, totalChars, url = "https://example.test/") {
  const attestation = {
    before: { href: url, baseURI: url, documentToken: "document-element" },
    after: { href: url, baseURI: url, documentToken: "document-element" },
    sameDocument: true,
  };
  return { chunks, totalChars, totalChunks: chunks.length, truncated: false, attestation, routeChanged: false };
}

test("managed binding keeps usable controls and page text when nodes vanish or are ambiguous", async () => {
  const disposed = [];
  let strictHandleCalls = 0;
  const handles = {
    "#vanished": [],
    "#ambiguous": [makeHandle("ambiguous-a", disposed), makeHandle("ambiguous-b", disposed)],
    "#material-ambiguous": [makeHandle("material-a", disposed), makeHandle("material-b", disposed)],
    "#usable": [makeHandle("usable", disposed)],
  };
  const controls = [
    rawControl("vanished", "Vanished"),
    rawControl("ambiguous", "Ambiguous"),
    rawControl("material-ambiguous", "Send", { approvalCandidate: true, formSubmitter: true }),
    rawControl("usable", "Usable"),
  ];
  const page = {
    async evaluate(_function, argument) {
      if (argument && typeof argument === "object" && "includePublicValues" in argument) {
        return { controls, total: controls.length };
      }
      if (argument && typeof argument === "object" && "maxChars" in argument) {
        return documentResult(["Shanghai Museum public page text"], 32);
      }
      throw new Error("unexpected_evaluate");
    },
    locator(selector) {
      return {
        async count() { return handles[selector]?.length ?? 0; },
        async elementHandles() { return [...(handles[selector] ?? [])]; },
        async elementHandle() {
          strictHandleCalls += 1;
          throw new Error("strict locator lookup must not be used for binding");
        },
      };
    },
    mouse: { async click() {} },
    url: () => "https://example.test/",
    on() {},
    off() {},
    async waitForTimeout() {},
    mainFrame: () => undefined,
    isClosed: () => false,
  };

  const backend = createBrowserBackend(page, { allowDocumentText: true });
  try {
    const frame = await backend.observe({ view: "controls", read: "document" });
    assert.deepEqual(frame.controls.map((control) => control.name), ["Usable"]);
    assert.equal(frame.complete, false);
    assert.deepEqual(frame.document?.chunks.map((chunk) => chunk.text), ["Shanghai Museum public page text"]);
    assert.equal(frame.document?.complete, true);
    assert.equal(strictHandleCalls, 0);
    assert.ok(disposed.includes("ambiguous-a"));
    assert.ok(disposed.includes("ambiguous-b"));
    assert.ok(disposed.includes("material-a"));
    assert.ok(disposed.includes("material-b"));
  } finally {
    await backend.close();
  }
  assert.ok(disposed.includes("usable"));
});

test("document-only observe bypasses control collection and all element-handle binding", async () => {
  let controlEvaluations = 0;
  let documentEvaluations = 0;
  const page = {
    async evaluate(_function, argument) {
      if (argument && typeof argument === "object" && "includePublicValues" in argument) {
        controlEvaluations += 1;
        throw new Error("control_collection_must_not_run");
      }
      if (argument && typeof argument === "object" && "maxChars" in argument) {
        documentEvaluations += 1;
        return documentResult(["Document-only public text"], 27);
      }
      throw new Error("unexpected_evaluate");
    },
    locator() { throw new Error("locator_must_not_run"); },
    mouse: { async click() {} },
    url: () => "https://example.test/",
    on() {},
    off() {},
    async waitForTimeout() {},
    mainFrame: () => undefined,
    isClosed: () => false,
  };
  const backend = createBrowserBackend(page, { allowDocumentText: true });
  try {
    const frame = await backend.observe({ read: "document" });
    assert.deepEqual(frame.controls, []);
    assert.equal(frame.complete, true);
    assert.deepEqual(frame.document?.chunks.map((chunk) => chunk.text), ["Document-only public text"]);
    assert.equal(controlEvaluations, 0);
    assert.equal(documentEvaluations, 1);
  } finally {
    await backend.close();
  }
});
