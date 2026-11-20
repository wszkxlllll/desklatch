import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { checkOptionalSetup } = await import("../dist/setup/optional.js");
const {
  readE2BApiKey,
  readWindowsProductRuntimeConfig,
  writeWindowsProductRuntimeConfig,
} = await import("../dist/product/runtime-config.js");

test("optional setup checks only selected modules", async () => {
  const result = await checkOptionalSetup({ e2b: false });
  assert.deepEqual(result.reports, {});
  assert.equal(result.ready, true);
});

test("E2B setup resolves from the selected consumer and never exposes the API key", async () => {
  const root = await mkdtemp(join(tmpdir(), "desklatch-optional-e2b-"));
  const previousKey = process.env.E2B_API_KEY;
  try {
    delete process.env.E2B_API_KEY;
    const missing = await checkOptionalSetup({ rootDirectory: root, e2b: true });
    assert.equal(missing.reports.e2b.code, "E2B_PACKAGE_MISSING");
    assert.equal(missing.reports.e2b.status, "missing_dependency");
    assert.equal(missing.reports.e2b.packageAvailable, false);

    const packageRoot = join(root, "node_modules", "@e2b", "desktop");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"optional-consumer","private":true}\n', "utf8");
    await writeFile(join(packageRoot, "package.json"), '{"name":"@e2b/desktop","main":"index.js"}\n', "utf8");
    await writeFile(join(packageRoot, "index.js"), "module.exports = {};\n", "utf8");

    const noKey = await checkOptionalSetup({ rootDirectory: root, e2b: true });
    assert.equal(noKey.reports.e2b.code, "E2B_API_KEY_MISSING");
    assert.equal(noKey.reports.e2b.packageAvailable, true);
    assert.equal(noKey.reports.e2b.apiKeyConfigured, false);

    const privateEnv = join(root, "private.env");
    await writeFile(privateEnv, "E2B_API_KEY=file-secret-that-must-not-escape\n", "utf8");
    const fromFile = await checkOptionalSetup({ rootDirectory: root, e2b: true, e2bEnvFile: privateEnv });
    assert.equal(fromFile.reports.e2b.code, "ready");
    assert.equal(fromFile.reports.e2b.apiKeyConfigured, true);
    assert.equal(JSON.stringify(fromFile).includes("file-secret-that-must-not-escape"), false);

    process.env.E2B_API_KEY = "test-secret-that-must-not-escape";
    const ready = await checkOptionalSetup({ rootDirectory: root, e2b: true });
    assert.equal(ready.reports.e2b.code, "ready");
    assert.equal(ready.reports.e2b.apiKeyConfigured, true);
    assert.equal(JSON.stringify(ready).includes("test-secret-that-must-not-escape"), false);
  } finally {
    if (previousKey === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("OCR setup delegates to the local RapidOCR probe and preserves typed failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "desklatch-optional-ocr-"));
  try {
    const report = (await checkOptionalSetup({
      ocr: {
        pythonExecutable: process.execPath,
        detectorModelPath: join(root, "missing-detector.onnx"),
        recognizerModelPath: join(root, "missing-recognizer.onnx"),
        dictionaryPath: join(root, "missing-dictionary.txt"),
      },
    })).reports.ocr;
    assert.equal(report.code, "MODEL_NOT_FOUND");
    assert.equal(report.rapidOcr.code, "MODEL_NOT_FOUND");
    assert.equal(report.status, "missing_configuration");
    assert.equal(report.available, false);
    assert.match(report.guidance, /does not download/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OCR setup reports invalid local paths without installing or probing a package", async () => {
  const report = (await checkOptionalSetup({
    ocr: {
      pythonExecutable: process.execPath,
      detectorModelPath: "relative-detector.onnx",
      recognizerModelPath: "relative-recognizer.onnx",
      dictionaryPath: "relative-dictionary.txt",
    },
  })).reports.ocr;
  assert.equal(report.code, "INVALID_MODEL_PATH");
  assert.equal(report.status, "invalid_configuration");
  assert.equal(report.available, false);
});

test("Windows runtime config is atomic, local-path validated, and secret-free", async () => {
  const root = await mkdtemp(join(tmpdir(), "desklatch-runtime-config-"));
  const authorizationFile = join(root, ".desklatch", "windows", "grants.json");
  const envFile = join(root, ".desklatch", "e2b.env");
  const previousKey = process.env.E2B_API_KEY;
  try {
    await mkdir(join(root, ".desklatch"), { recursive: true });
    await writeFile(envFile, "E2B_API_KEY=runtime-test-secret\n", "utf8");
    delete process.env.E2B_API_KEY;
    assert.equal(readE2BApiKey(envFile), "runtime-test-secret");
    assert.equal(process.env.E2B_API_KEY, undefined);
    assert.deepEqual(await readWindowsProductRuntimeConfig(authorizationFile), { version: 1 });

    const config = {
      version: 1,
      ocr: {
        pythonExecutable: process.execPath,
        detectorModelPath: join(root, "models", "detector.onnx"),
        recognizerModelPath: join(root, "models", "recognizer.onnx"),
        dictionaryPath: join(root, "models", "dict.txt"),
      },
      e2b: { envFile },
    };
    await writeWindowsProductRuntimeConfig(authorizationFile, config);
    const serialized = await readFile(join(root, ".desklatch", "windows", "runtime.json"), "utf8");
    assert.equal(serialized.includes("runtime-test-secret"), false);
    assert.deepEqual(await readWindowsProductRuntimeConfig(authorizationFile), config);
    await assert.rejects(
      writeWindowsProductRuntimeConfig(authorizationFile, { version: 1, ocr: { ...config.ocr, detectorModelPath: "relative.onnx" } }),
      /windows_runtime_config_invalid/,
    );
  } finally {
    if (previousKey === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  }
});
