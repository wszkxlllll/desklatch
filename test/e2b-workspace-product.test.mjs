import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { createE2BProductWorkspace } from "../dist/product/e2b-workspace.js";

test("E2B product workspace resolves its pinned SDK without allocating until activation", async () => {
  const parent = await realpath(tmpdir());
  const prefix = "desklatch-e2b-product-";
  const root = await mkdtemp(join(parent, prefix));
  try {
    const sdkRoot = join(root, "node_modules", "@e2b", "desktop");
    await mkdir(sdkRoot, { recursive: true });
    await writeFile(join(root, "package.json"), "{\"name\":\"e2b-product-test\",\"private\":true}\n", "utf8");
    await writeFile(join(sdkRoot, "package.json"), "{\"name\":\"@e2b/desktop\",\"main\":\"index.js\"}\n", "utf8");
    await writeFile(join(sdkRoot, "index.js"), "module.exports = { Sandbox: class { static async create() { throw new Error('credential-must-not-escape'); } } };\n", "utf8");

    const product = createE2BProductWorkspace({ installationRoot: root, apiKey: "credential-must-not-escape" });
    assert.deepEqual(product.applications.map(application => application.id), ["e2b-writer", "e2b-browser"]);
    const writer = product.applications.find(application => application.id === "e2b-writer");
    assert.equal(writer.capabilities.some(capability => capability.kind === "type"), true);
    assert.equal(writer.capabilities.some(capability => capability.kind === "click" && capability.targets.includes("point")), true);
    assert.equal(writer.capabilities.some(capability => capability.kind === "type" && capability.targets.includes("focus")), true);
    assert.equal(product.applications.find(application => application.id === "e2b-browser").allowNavigation, true);
    await product.close();

    const retry = createE2BProductWorkspace({ installationRoot: root, apiKey: "credential-must-not-escape" });
    await assert.rejects(retry.applications[0].open(), error => error?.code === "guest_start_failed" && !String(error).includes("credential-must-not-escape"));
    await retry.close();
  } finally {
    const directory = await realpath(root);
    if (dirname(directory) === parent && basename(directory).startsWith(prefix)) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
