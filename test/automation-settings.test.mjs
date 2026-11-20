import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import http from "node:http";

import { startAutomationSettingsServer } from "../examples/automation-settings/server.mjs";

function jsonRequest(origin, path, token, options = {}) {
  const url = new URL(path, origin);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? "GET",
      headers: {
        Host: options.host ?? url.host,
        ...(body === undefined ? {} : {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        }),
        ...(options.origin === undefined ? {} : { Origin: options.origin }),
        ...(token === undefined ? {} : { "X-DeskLatch-Key": token }),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const encoded = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, body: encoded ? JSON.parse(encoded) : undefined });
      });
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test("automation settings host gates real workspace activation and persists preferences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desklatch-settings-"));
  const statePath = join(directory, "preview-state.json");
  const running = await startAutomationSettingsServer({ port: 0, statePath, includeMail: true });
  try {
    const missingKey = await jsonRequest(running.origin, "/api/settings", undefined);
    assert.equal(missingKey.status, 401);

    const initial = await jsonRequest(running.origin, "/api/settings", running.token);
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.groups.map((group) => group.id), ["browser", "editor", "mail"]);
    assert.deepEqual(initial.body.groups[0].windows.map((window) => window.id), ["browser-research", "browser-account"]);
    assert.equal(initial.body.groups[0].windows[0].title, "\u7f51\u9875\u8c03\u7814");
    assert.equal(initial.body.sampleOnly, true);

    const saved = await jsonRequest(running.origin, "/api/settings", running.token, {
      method: "PUT",
      body: {
        blockedApps: ["browser"],
        blockedWindows: ["editor-private"],
        browser: { mode: "sites", origins: ["https://example.com"] },
      },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.preferences, {
      blockedApps: ["browser"],
      blockedWindows: ["editor-private"],
      browser: { mode: "sites", origins: ["https://example.com"] },
    });

    let checked = await jsonRequest(running.origin, "/api/check", running.token, {
      method: "POST", body: { id: "browser-research" },
    });
    assert.deepEqual(checked.body, { id: "browser-research", allowed: false, code: "application_automation_blocked" });
    checked = await jsonRequest(running.origin, "/api/check", running.token, {
      method: "POST", body: { id: "editor-project" },
    });
    assert.deepEqual(checked.body, { id: "editor-project", allowed: true, code: "activated" });
    checked = await jsonRequest(running.origin, "/api/check", running.token, {
      method: "POST", body: { id: "editor-private" },
    });
    assert.deepEqual(checked.body, { id: "editor-private", allowed: false, code: "application_automation_blocked" });

    // Turning an app back on does not erase a separately selected window.
    const restored = await jsonRequest(running.origin, "/api/settings", running.token, {
      method: "PUT",
      body: { blockedApps: [], blockedWindows: ["editor-private"] },
    });
    assert.deepEqual(restored.body.preferences.blockedWindows, ["editor-private"]);
    checked = await jsonRequest(running.origin, "/api/check", running.token, {
      method: "POST", body: { id: "browser-research" },
    });
    assert.equal(checked.body.allowed, true);

    const wrongHost = await jsonRequest(running.origin, "/api/settings", running.token, { host: "evil.test" });
    assert.equal(wrongHost.status, 403);
    const wrongOrigin = await jsonRequest(running.origin, "/api/settings", running.token, { origin: "http://evil.test" });
    assert.equal(wrongOrigin.status, 403);
  } finally {
    await running.close();
  }

  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(persisted.preferences.blockedWindows, ["editor-private"]);
  const files = await readdir(directory);
  assert.deepEqual(files, ["preview-state.json"]);

  const reopened = await startAutomationSettingsServer({ port: 0, statePath, includeMail: true });
  try {
    const settings = await jsonRequest(reopened.origin, "/api/settings", reopened.token);
    assert.deepEqual(settings.body.preferences, persisted.preferences);
  } finally {
    await reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser check accepts one fixed id and serializes an optional host probe", async () => {
  let calls = 0;
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const running = await startAutomationSettingsServer({
    port: 0,
    statePath: null,
    checkSite: async ({ id, origin, preferences }) => {
      calls += 1;
      markStarted();
      assert.equal(id, "python-docs");
      assert.equal(origin, "https://docs.python.org");
      assert.equal(preferences.browser.mode, "sites");
      assert.deepEqual(preferences.browser.origins, ["https://docs.python.org"]);
      await new Promise((resolve) => { release = resolve; });
      return { allowed: true, code: "host_probe_allowed" };
    },
  });
  try {
    const configured = await jsonRequest(running.origin, "/api/settings", running.token, {
      method: "PUT", body: { browser: { mode: "sites", origins: ["https://docs.python.org"] } },
    });
    assert.equal(configured.status, 200);
    const first = jsonRequest(running.origin, "/api/check-site", running.token, {
      method: "POST", body: { id: "python-docs" },
    });
    await started;
    const second = jsonRequest(running.origin, "/api/check-site", running.token, {
      method: "POST", body: { id: "python-docs" },
    });
    // Let the second request reach the shared in-flight promise before the
    // first callback is released.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls, 1);
    release();
    assert.deepEqual((await first).body, { id: "python-docs", allowed: true, code: "host_probe_allowed" });
    assert.deepEqual((await second).body, { id: "python-docs", allowed: true, code: "host_probe_allowed" });

    const revoked = await jsonRequest(running.origin, "/api/settings", running.token, {
      method: "PUT", body: { browser: { mode: "sites", origins: [] } },
    });
    assert.equal(revoked.status, 200);
    const denied = await jsonRequest(running.origin, "/api/check-site", running.token, {
      method: "POST", body: { id: "python-docs" },
    });
    assert.deepEqual(denied.body, { id: "python-docs", allowed: false, code: "browser_site_not_granted" });
    assert.equal(calls, 1);

    const unknown = await jsonRequest(running.origin, "/api/check-site", running.token, {
      method: "POST", body: { id: "other" },
    });
    assert.equal(unknown.status, 400);
  } finally {
    await running.close();
  }
});
