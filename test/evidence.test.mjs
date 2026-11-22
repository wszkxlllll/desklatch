import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createLocalPpOcrV5Mobile,
  createRapidOcrCpuRunner,
  EvidenceCapturingBackend,
  FilePrivateEvidenceStore,
  LocalEvidenceSink,
  MemoryPrivateEvidenceStore,
  RapidOcrError,
} from "../dist/evidence/index.js";
import { createDeskSession } from "../dist/session.js";
import { createDeskTools } from "../dist/tools.js";

test("PP-OCRv5 adapter is lazy, local-only, and does not download", async () => {
  let calls = 0;
  let imageCalls = 0;
  const provider = createLocalPpOcrV5Mobile({
    detectorModelPath: "models/det.onnx",
    recognizerModelPath: "models/rec.onnx",
    getImage: async () => { imageCalls += 1; return { local: true }; },
    runner: {
      async recognize(request) {
        calls += 1;
        assert.equal(request.region.width, 20);
        assert.deepEqual(request.image, { local: true });
        return [{ text: "Continue", confidence: 0.99 }];
      },
    },
  });
  assert.equal(calls, 0);
  assert.equal(imageCalls, 0);
  assert.equal(provider.localOnly, true);
  assert.equal(provider.model, "PP-OCRv5-mobile");
  const request = { input: { step: { kind: "click", target: { role: "button" } }, target: { id: "x", role: "button", states: [], actions: ["click"] } }, region: { x: 0, y: 0, width: 20, height: 20 }, signal: new AbortController().signal };
  const image = await provider.getImage(request);
  const result = await provider.recognize({ ...request, image });
  assert.equal(calls, 1);
  assert.equal(imageCalls, 1);
  assert.equal(result.lines[0].text, "Continue");
  assert.throws(() => createLocalPpOcrV5Mobile({ detectorModelPath: "https://example.invalid/det.onnx", recognizerModelPath: "models/rec.onnx", runner: { recognize: async () => [] } }));
  assert.throws(() => createLocalPpOcrV5Mobile({ detectorModelPath: "models/det.onnx", recognizerModelPath: "models/rec.onnx", allowDownloads: true, runner: { recognize: async () => [] } }));
});

test("local sink requires redaction and writes only to private storage", async () => {
  const store = new MemoryPrivateEvidenceStore();
  const sink = new LocalEvidenceSink({
    store,
    redactor: {
      redact(image) {
        return { ...image, bytes: new Uint8Array([9]), redacted: true };
      },
    },
  });
  const record = await sink.save({ mimeType: "image/png", bytes: new Uint8Array([1, 2]), width: 1, height: 2 }, { sessionId: "s1" });
  assert.equal(record.redacted, true);
  assert.equal(record.bytes, 1);
  assert.equal(store.readPrivate(record.evidenceId).image.bytes[0], 9);
  const noRedaction = new LocalEvidenceSink({ store, redactor: { redact: () => ({ mimeType: "image/png", bytes: new Uint8Array([1]), width: 1, height: 1 }) } });
  await assert.rejects(() => noRedaction.save({ mimeType: "image/png", bytes: new Uint8Array([1]), width: 1, height: 1 }, { sessionId: "s1" }));
});

test("concrete RapidOCR runner is lazy and reports unavailable assets with typed status", async () => {
  const runner = createRapidOcrCpuRunner({
    pythonExecutable: process.execPath,
    detectorModelPath: path.resolve("missing-det.onnx"),
    recognizerModelPath: path.resolve("missing-rec.onnx"),
    dictionaryPath: path.resolve("missing-dict.txt"),
  });
  const request = {
    input: { step: { kind: "click", target: { role: "button" } }, target: { id: "x", role: "button", states: [], actions: ["click"] } },
    region: { x: 0, y: 0, width: 1, height: 1 },
    image: { mimeType: "image/png", bytes: new Uint8Array([1]), width: 1, height: 1 },
    signal: new AbortController().signal,
  };
  await assert.rejects(() => runner.recognize(request), (error) => error instanceof RapidOcrError && error.code === "MODEL_NOT_FOUND");
  const status = await runner.check();
  assert.equal(status.available, false);
  assert.equal(status.code, "MODEL_NOT_FOUND");
  assert.throws(() => createRapidOcrCpuRunner({ pythonExecutable: process.execPath, detectorModelPath: "models/det.onnx", recognizerModelPath: path.resolve("rec.onnx"), dictionaryPath: path.resolve("dict.txt") }), (error) => error instanceof RapidOcrError && error.code === "INVALID_MODEL_PATH");
});

test("concrete RapidOCR probe reports a typed unavailable status without leaking worker output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "desklatch-ocr-assets-"));
  try {
    const detector = path.join(root, "det.onnx");
    const recognizer = path.join(root, "rec.onnx");
    const dictionary = path.join(root, "dict.txt");
    await writeFile(detector, "synthetic-detector");
    await writeFile(recognizer, "synthetic-recognizer");
    await writeFile(dictionary, "blank\n");
    const runner = createRapidOcrCpuRunner({ pythonExecutable: "python", detectorModelPath: detector, recognizerModelPath: recognizer, dictionaryPath: dictionary, timeoutMs: 2_000 });
    const status = await runner.check();
    assert.equal(status.available, false);
    assert.ok(["RAPIDOCR_UNAVAILABLE", "PYTHON_UNAVAILABLE", "MODEL_LOAD_FAILED", "WORKER_FAILED"].includes(status.code));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled worker keeps modern RapidOCR enums and an ASCII-safe Windows wire protocol", async () => {
  const worker = await readFile(new URL("../dist/evidence/rapidocr_worker.py", import.meta.url), "utf8");
  assert.match(worker, /EngineType/);
  assert.match(worker, /OCRVersion/);
  assert.match(worker, /ensure_ascii=True/);
});

test("filesystem evidence store is private, atomic, and bounded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "desklatch-evidence-"));
  try {
    const store = new FilePrivateEvidenceStore({ rootDirectory: root, maxRecords: 1, maxBytes: 1000, retentionMs: 60_000 });
    const image = { mimeType: "image/png", bytes: new Uint8Array([9, 8, 7]), width: 3, height: 2, redacted: true };
    const first = await store.putPrivate(image, { sessionId: "session-1" });
    const second = await store.putPrivate(image, { sessionId: "session-1" });
    const files = await readdir(root);
    assert.equal(files.filter((name) => name.endsWith(".png")).length, 1);
    assert.equal(files.filter((name) => name.endsWith(".json")).length, 1);
    assert.equal((await store.readPrivate(second.evidenceId)).image.width, 3);
    assert.equal(await store.readPrivate(first.evidenceId), undefined);
    await store.close();
    assert.throws(() => new FilePrivateEvidenceStore({ rootDirectory: "relative-evidence-root" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execution wrapper archives only host-approved local before/after captures", async () => {
  const store = new MemoryPrivateEvidenceStore();
  const sink = new LocalEvidenceSink({
    store,
    redactor: { redact: (image) => ({ ...image, redacted: true }) },
  });
  const image = { mimeType: "image/png", dataBase64: Buffer.from([1, 2, 3]).toString("base64"), width: 2, height: 2 };
  const frame = { scope: "local-scope", controls: [], complete: true, image };
  const events = [];
  let observed = 0;
  let closed = false;
  const backend = {
    capabilities: [],
    async observe() { observed += 1; return frame; },
    async dispatch() { return { status: "dispatched" }; },
    async close() { closed = true; },
  };
  const wrapped = new EvidenceCapturingBackend(backend, {
    sessionId: "session-1",
    sink,
    capturePolicy: { localOnly: true, approve: (event) => { events.push(event.phase); return true; } },
    captureImage: async () => frame.image,
    captureBefore: true,
    captureAfter: true,
  });
  await wrapped.observe({ view: "controls" });
  const delivery = await wrapped.dispatch({
    step: { kind: "click", target: { role: "button", name: "Continue" } },
    frame,
    target: { id: "button-1", role: "button", name: "Continue", states: ["visible", "enabled"], actions: ["click"] },
  });
  await wrapped.close();
  assert.equal(delivery.status, "dispatched");
  assert.deepEqual(events, ["before", "after"]);
  assert.equal(store.size, 2);
  assert.equal(observed, 1);
  assert.equal(closed, true);
});

test("execution wrapper preserves optional point hit testing and action kind", async () => {
  const frame = {
    scope: "image-only-hit-test-scope",
    controls: [],
    complete: true,
    image: { mimeType: "image/png", dataBase64: Buffer.from([1, 2, 3]).toString("base64"), width: 20, height: 20 },
  };
  const privateTarget = {
    id: "private-button",
    role: "Button",
    name: "Private target",
    states: ["visible", "enabled"],
    actions: ["click"],
    rect: { x: 0, y: 0, width: 20, height: 20 },
    effect: "read",
  };
  const makeBackend = () => {
    const calls = { hitTest: [], dispatch: 0 };
    const backend = {
      capabilities: [{ kind: "click", targets: ["point"], buttons: ["left"], counts: [1] }],
      hitTestSnapshot: true,
      async observe() { return frame; },
      async hitTest(hitFrame, point, signal, kind) {
        calls.hitTest.push({ hitFrame, point, signal, kind });
        return kind === "click" ? privateTarget : undefined;
      },
      async dispatch(request) {
        assert.equal(request.target, privateTarget);
        calls.dispatch += 1;
        return { status: "dispatched" };
      },
      async close() {},
    };
    return { backend, calls };
  };
  const run = async (backend) => {
    const session = createDeskSession(backend, { allowModelImages: true, policy: () => ({ decision: "allow", code: "test" }) });
    const observation = await session.observe({ view: "image" });
    const result = await session.act({
      observationId: observation.observationId,
      steps: [{ kind: "click", target: { point: { x: 5, y: 5 } } }],
    });
    await session.close();
    return result;
  };

  const plain = makeBackend();
  const plainResult = await run(plain.backend);
  const store = new MemoryPrivateEvidenceStore();
  const wrappedFixture = makeBackend();
  const wrapped = new EvidenceCapturingBackend(wrappedFixture.backend, {
    sessionId: "image-only-hit-test-session",
    sink: new LocalEvidenceSink({ store, redactor: { redact: image => ({ ...image, redacted: true }) } }),
    capturePolicy: { localOnly: true, approve: () => true },
    captureImage: async () => frame.image,
    captureBefore: true,
    captureAfter: true,
  });
  assert.equal(wrapped.hitTestSnapshot, true);
  assert.equal(typeof wrapped.hitTest, "function");
  const wrappedResult = await run(wrapped);

  assert.equal(plainResult.status, "completed");
  assert.equal(wrappedResult.status, "completed");
  assert.equal(plain.calls.dispatch, 1);
  assert.equal(wrappedFixture.calls.dispatch, 1);
  assert.equal(plain.calls.hitTest.length, 2);
  assert.equal(wrappedFixture.calls.hitTest.length, 2);
  assert.deepEqual(plain.calls.hitTest.map(call => call.kind), ["click", "click"]);
  assert.deepEqual(wrappedFixture.calls.hitTest.map(call => call.kind), ["click", "click"]);
  assert.equal(store.size, 2);
});

test("execution wrapper does not manufacture hit testing for a backend without it", async () => {
  const frame = { scope: "no-hit-test-scope", controls: [], complete: true };
  const backend = {
    capabilities: [],
    async observe() { return frame; },
    async dispatch() { return { status: "dispatched" }; },
    async close() {},
  };
  const wrapped = new EvidenceCapturingBackend(backend, {
    sessionId: "no-hit-test-session",
    sink: { async save() { throw new Error("not expected"); } },
    capturePolicy: { localOnly: true, approve: () => true },
  });
  assert.equal(wrapped.hitTestSnapshot, undefined);
  assert.equal(wrapped.hitTest, undefined);
  assert.equal("hitTestSnapshot" in wrapped, false);
  assert.equal("hitTest" in wrapped, false);
  assert.equal(await wrapped.observe({ view: "controls" }), frame);
});

test("execution wrapper remains fail-closed when before capture fails", async () => {
  const frame = {
    scope: "failsafe-capture-scope",
    controls: [],
    complete: true,
    image: { mimeType: "image/png", dataBase64: Buffer.from([4, 5, 6]).toString("base64"), width: 2, height: 2 },
  };
  let dispatches = 0;
  const backend = {
    capabilities: [],
    async observe() { return frame; },
    async dispatch() { dispatches += 1; return { status: "dispatched" }; },
    async close() {},
  };
  const diagnostics = [];
  const wrapped = new EvidenceCapturingBackend(backend, {
    sessionId: "failsafe-capture-session",
    sink: { async save() { throw new Error("capture storage failed"); } },
    capturePolicy: { localOnly: true, approve: () => true },
    captureBefore: true,
    onDiagnostic: diagnostic => diagnostics.push(diagnostic),
  });
  const delivery = await wrapped.dispatch({
    step: { kind: "click", target: { point: { x: 1, y: 1 } } },
    frame,
    target: { id: "private-target", role: "Button", states: ["visible", "enabled"], actions: ["click"] },
  });
  assert.deepEqual(delivery, { status: "refused", code: "evidence_capture_failed" });
  assert.equal(dispatches, 0);
  assert.deepEqual(diagnostics, [{ phase: "before", code: "storage_failed" }]);
});

test("capture hooks never observe/rebind a strict dispatch frame and post-storage errors preserve delivery", async () => {
  const image = { mimeType: "image/png", dataBase64: Buffer.from([4, 5, 6]).toString("base64"), width: 2, height: 2 };
  const frame = { scope: "strict-scope", controls: [], complete: true, image };
  let dispatchCount = 0;
  let storageWrite = 0;
  const writtenImages = [];
  const diagnostics = [];
  const backend = {
    capabilities: [],
    async observe() { throw new Error("strict backend must not observe during dispatch"); },
    async dispatch(request) {
      assert.equal(request.frame, frame);
      dispatchCount += 1;
      return { status: "dispatched" };
    },
    async close() {},
  };
  const failingSink = {
    async save() {
      storageWrite += 1;
      writtenImages.push([4, 5, 6]);
      throw new Error("storage failed after write");
    },
  };
  const wrapped = new EvidenceCapturingBackend(backend, {
    sessionId: "strict-session",
    sink: failingSink,
    capturePolicy: { localOnly: true, approve: () => true },
    captureImage: async () => frame.image,
    captureAfter: true,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const delivery = await wrapped.dispatch({
    step: { kind: "click", target: { role: "button", name: "Search" } },
    frame,
    target: { id: "strict-button", role: "button", name: "Search", states: ["visible", "enabled"], actions: ["click"] },
  });
  assert.deepEqual(delivery, { status: "dispatched" });
  assert.equal(dispatchCount, 1);
  assert.equal(storageWrite, 1);
  assert.equal(writtenImages.length, 1);
  assert.deepEqual(diagnostics, [{ phase: "after", code: "storage_failed" }]);
});

test("public observe/act through createDeskSession keeps strict latest frame and sends zero images to the model", async () => {
  const store = new MemoryPrivateEvidenceStore();
  const sink = new LocalEvidenceSink({ store, redactor: { redact: (image) => ({ ...image, redacted: true }) } });
  const frame = {
    scope: "session-strict-scope",
    controls: [{ id: "search-button", role: "Button", name: "Search", states: ["visible", "enabled"], actions: ["click"], effect: "read" }],
    complete: true,
    image: { mimeType: "image/png", dataBase64: Buffer.from([7, 8, 9]).toString("base64"), width: 2, height: 2 },
  };
  const capabilities = [{ kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] }];
  let observeCount = 0;
  let dispatchCount = 0;
  const backend = {
    capabilities,
    async observe() { observeCount += 1; return frame; },
    async dispatch(request) {
      assert.equal(request.frame, frame);
      dispatchCount += 1;
      return { status: "dispatched" };
    },
    async close() {},
  };
  const wrapped = new EvidenceCapturingBackend(backend, {
    sessionId: "public-session",
    sink,
    capturePolicy: { localOnly: true, approve: () => true },
    captureImage: async () => frame.image,
    captureBefore: true,
    captureAfter: true,
  });
  const session = createDeskSession(wrapped, { allowModelImages: false, policy: () => ({ decision: "allow", code: "test" }) });
  const tools = createDeskTools(session);
  const observation = await tools[0].invoke({});
  assert.equal(observation.image, undefined);
  const result = await tools[1].invoke({ steps: [{ kind: "click", target: { name: "Search" } }] });
  assert.equal(result.status, "completed");
  assert.equal(observeCount, 2);
  assert.equal(dispatchCount, 1);
  assert.equal(store.size, 2);
  await session.close();
});
