import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

import { createWindowsLocalBrowserApplication, parseLocalBrowserOrigins } from "../dist/product/local-browser.js";
import { findChromiumExecutable } from "../dist/backends/browser/local.js";
import { createWorkspace } from "../dist/workspace.js";

test("local browser origins are exact, bounded, and omitted when unset", () => {
  assert.equal(parseLocalBrowserOrigins(undefined), undefined);
  assert.deepEqual(parseLocalBrowserOrigins("https://example.test, http://localhost:4312"), [
    "https://example.test",
    "http://localhost:4312",
  ]);
  assert.deepEqual(parseLocalBrowserOrigins("https://example.test,https://example.test"), ["https://example.test"]);
  assert.throws(() => parseLocalBrowserOrigins("https://example.test/path"), /local_browser_origins_invalid/);
  assert.throws(() => parseLocalBrowserOrigins("https://user:pass@example.test"), /local_browser_origins_invalid/);
  assert.throws(() => parseLocalBrowserOrigins("file:///tmp/local"), /local_browser_origins_invalid/);
});

test("managed Chromium is registered lazily and omitted without operator origins", () => {
  assert.equal(createWindowsLocalBrowserApplication({ origins: undefined }), undefined);
  const application = createWindowsLocalBrowserApplication({ origins: ["https://example.test"] });
  assert.ok(application);
  assert.equal(application.id, "windows-local-browser");
  assert.equal(typeof application.open, "function");
});

test("the product workspace opens an isolated browser and performs a direct scoped edit", {
  skip: !findChromiumExecutable(),
}, async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end('<label>Reference <input autocomplete="off"></label>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const application = createWindowsLocalBrowserApplication({ origins: [origin] });
  const workspace = createWorkspace({ applications: [application] });
  try {
    assert.equal((await workspace.act({ activate: application.id })).status, "completed");
    const nav = await workspace.act({ navigate: origin });
    assert.equal(nav.status, "completed", JSON.stringify(nav));
    const field = { role: "textbox", name: "Reference" };
    const edited = await workspace.act({ steps: [{ kind: "setValue", target: field, value: "read-back", expect: { target: field, valueEquals: "read-back" } }] });
    assert.equal(edited.steps[0]?.status, "verified", JSON.stringify(edited));
    const outside = await workspace.act({ navigate: `http://localhost:${server.address().port}/` });
    assert.equal(outside.code, "unauthorized_origin");
  } finally {
    await workspace.close();
    await new Promise(resolve => server.close(resolve));
  }
});
