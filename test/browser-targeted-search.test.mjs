import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createBrowserBackend } from "../dist/backends/browser/index.js";

const chromium = Number.parseInt(process.versions.node.split(".")[0], 10) >= 20
  ? (await import("playwright-core")).chromium
  : undefined;

function executablePath() {
  const candidates = [
    process.env.DESKLATCH_CHROMIUM,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate));
}

async function withPage(callback) {
  if (!chromium) return { skipped: true };
  const executable = executablePath();
  if (!executable) return { skipped: true };
  const browser = await chromium.launch({ headless: true, executablePath: executable });
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  try { return await callback(page); }
  finally {
    await context.close();
    await browser.close();
  }
}

function crowdedMarkup() {
  const prefix = Array.from({ length: 650 }, (_, index) => `<label for="prefix-${index}">Prefix ${index}</label><input id="prefix-${index}" name="prefix-${index}">`).join("");
  const duplicates = Array.from({ length: 140 }, (_, index) => `<button id="duplicate-${index}" type="button">Duplicate target</button>`).join("");
  return `<main><section id="deep" aria-label="Deep section"><div>${prefix}</div><input id="target-after-cap" aria-label="Target after cap"><div>${duplicates}</div></section></main>`;
}

test("targeted observe scans beyond public observation/search prefixes and preserves scope", async t => {
  const result = await withPage(async page => {
    await page.setContent(crowdedMarkup());
    const backend = createBrowserBackend(page, { observeLimit: 1, searchLimit: 4 });
    try {
      const scoped = await backend.observe({ view: "controls", where: { role: "textbox", name: "Target after cap", within: "Deep section" } });
      assert.equal(scoped.complete, true);
      assert.equal(scoped.controls.length, 1);
      assert.equal(scoped.controls[0].name, "Target after cap");
      assert.equal(scoped.controls[0].within, "Deep section");

      const frame = await backend.observe({ view: "controls" });
      const dispatched = await backend.dispatch({ frame, step: { kind: "setValue", target: { role: "textbox", name: "Target after cap", within: "Deep section" }, value: "found" } });
      assert.equal(dispatched.status, "dispatched", JSON.stringify(dispatched));
      assert.equal(await page.locator("#target-after-cap").inputValue(), "found");

      const duplicates = await backend.observe({ view: "controls", where: { role: "button", name: "Duplicate target", within: "Deep section" } });
      assert.equal(duplicates.complete, false);
      assert.ok(duplicates.controls.length > 1);
      assert.ok(duplicates.controls.length <= 4);
    } finally { await backend.close(); }
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});
