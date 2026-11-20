import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import test from "node:test";
import { createWorkspaceNavigator } from "../dist/backends/browser/index.js";

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
const chromium = nodeMajor >= 20 ? (await import("playwright-core")).chromium : undefined;

function executablePath() {
  const candidates = [
    process.env.DESKLATCH_CHROMIUM,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

test("workspace navigation guards top-level redirects and preserves host resource routes", async (t) => {
  const executable = executablePath();
  if (!chromium || !executable) {
    t.skip("No locally installed Chromium was found; this test never downloads one.");
    return;
  }
  let deniedResourceRequests = 0;
  let foreignRequests = 0;
  let foreignOrigin;
  const foreignServer = createServer((_request, response) => {
    foreignRequests += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>foreign</title><main>foreign</main>");
  });
  foreignOrigin = await listen(foreignServer);
  const trustedServer = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `${foreignOrigin}/escaped` });
      response.end();
      return;
    }
    if (request.url === "/slow") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<title>slow</title>");
      }, 1_000);
      return;
    }
    if (request.url === "/asset") {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end("window.hostAssetLoaded = true;");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>trusted</title><script src='/asset'></script><main>museum</main>");
  });
  const trustedOrigin = await listen(trustedServer);
  const browser = await chromium.launch({ headless: true, executablePath: executable });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/asset", async (route) => {
    deniedResourceRequests += 1;
    await route.abort("blockedbyclient");
  });
  const navigator = createWorkspaceNavigator(page, { authorizedOrigins: [trustedOrigin] });
  try {
    const first = await navigator.navigate(`${trustedOrigin}/?secret=omit#top`);
    assert.equal(first.finalUrl, `${trustedOrigin}/?secret=omit#top`);
    assert.equal(first.sourceUrl, `${trustedOrigin}/`);
    assert.equal(await page.title(), "trusted");
    assert.equal(deniedResourceRequests, 1);

    await assert.rejects(
      () => navigator.navigate(`${trustedOrigin}/redirect`),
      (error) => error?.code === "redirect_blocked",
    );
    assert.equal(foreignRequests, 0);
    // Chromium can keep the prior document or commit its own network-error page.
    const afterBlock = new URL(page.url());
    assert.ok(afterBlock.origin === trustedOrigin || afterBlock.href === "chrome-error://chromewebdata/" || afterBlock.href === "about:blank", afterBlock.href);

    for (const url of [
      "data:text/html,blocked",
      `${trustedOrigin.replace("http://", "http://user:pass@")}/bad`,
      `${foreignOrigin}/direct`,
      `${trustedOrigin}/${"x".repeat(2_100)}`,
    ]) {
      await assert.rejects(() => navigator.navigate(url));
    }
    const afterInvalid = await navigator.navigate(`${trustedOrigin}/after-invalid`);
    assert.equal(new URL(afterInvalid.finalUrl).origin, trustedOrigin);

    const controller = new AbortController();
    const pending = navigator.navigate(`${trustedOrigin}/slow`, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error) => error?.code === "aborted");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const afterAbort = await navigator.navigate(`${trustedOrigin}/after-abort`);
    assert.equal(new URL(afterAbort.finalUrl).origin, trustedOrigin);
  } finally {
    await navigator.close();
    assert.equal(page.isClosed(), false);
    await context.close();
    await browser.close();
    await closeServer(trustedServer);
    await closeServer(foreignServer);
  }
});

test("workspace navigation validation and pre-abort do not lock a trusted page adapter", async () => {
  const listeners = new Map();
  const calls = [];
  let currentUrl = "about:blank";
  const session = {
    on(event, listener) { listeners.set(event, listener); },
    off(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); },
    async send(method, params) {
      calls.push([method, params]);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      return {};
    },
  };
  const page = {
    url: () => currentUrl,
    context: () => ({ newCDPSession: async () => session }),
    async goto(url) {
      currentUrl = url;
      listeners.get("Fetch.requestPaused")?.({ requestId: "request", request: { url }, frameId: "main", resourceType: "Document" });
    },
    isClosed: () => false,
  };
  const navigator = createWorkspaceNavigator(page, { authorizedOrigins: ["https://allowed.example"] });
  await assert.rejects(() => navigator.navigate("data:text/html,blocked"), (error) => error?.code === "unsupported_scheme");
  const preAbort = new AbortController();
  preAbort.abort();
  await assert.rejects(() => navigator.navigate("https://allowed.example/aborted", preAbort.signal), (error) => error?.code === "aborted");
  const result = await navigator.navigate("https://allowed.example/valid?secret=omit");
  assert.equal(result.sourceUrl, "https://allowed.example/valid");
  assert.equal(calls.filter(([method]) => method === "Fetch.enable").length, 1);
  assert.equal(calls.filter(([method]) => method === "Fetch.disable").length, 1);
  await navigator.close();
});

test("workspace navigator close cancels an in-flight navigation without closing the borrowed page", async () => {
  const listeners = new Map();
  const calls = [];
  let currentUrl = "about:blank";
  let navigationStarted;
  let stopNavigation;
  const started = new Promise((resolve) => { navigationStarted = resolve; });
  const session = {
    on(event, listener) { listeners.set(event, listener); },
    off(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); },
    async send(method, params) {
      calls.push([method, params]);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.stopLoading") stopNavigation?.();
      return {};
    },
  };
  const page = {
    url: () => currentUrl,
    context: () => ({ newCDPSession: async () => session }),
    async goto(url) {
      currentUrl = url;
      listeners.get("Fetch.requestPaused")?.({ requestId: "request", request: { url }, frameId: "main", resourceType: "Document" });
      navigationStarted();
      await new Promise((resolve) => { stopNavigation = resolve; });
    },
    isClosed: () => false,
  };
  const navigator = createWorkspaceNavigator(page, { authorizedOrigins: ["https://allowed.example"] });
  const pending = navigator.navigate("https://allowed.example/slow");
  await started;
  const closing = navigator.close();
  await assert.rejects(pending, (error) => error?.code === "aborted");
  await closing;
  assert.equal(page.isClosed(), false);
  assert.equal(calls.some(([method]) => method === "Page.stopLoading"), true);
  await assert.rejects(() => navigator.navigate("https://allowed.example/after-close"), (error) => error?.code === "navigation_unavailable");
});
