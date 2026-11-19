import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createDeskSession, createDeskTools } from "desklatch";
import { createBrowserBackend } from "../dist/backends/browser/index.js";

const chromium = Number.parseInt(process.versions.node.split(".")[0], 10) >= 20
  ? (await import("playwright-core")).chromium
  : undefined;

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(join(here, "fixtures", name), "utf8");

function executablePath() {
  const candidates = [
    process.env.DESKLATCH_CHROMIUM,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

async function withPage(callback) {
  if (!chromium) return { skipped: true };
  const path = executablePath();
  if (!path) return { skipped: true };
  const browser = await chromium.launch({ headless: true, executablePath: path });
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  try {
    return await callback(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

test("DOM observe and form actions stay zero-image", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(await fixture("browser-form.html"));
    let screenshots = 0;
    const originalScreenshot = page.screenshot.bind(page);
    page.screenshot = async (...args) => {
      screenshots += 1;
      return originalScreenshot(...args);
    };
    const backend = createBrowserBackend(page);
    const frame = await backend.observe({ view: "controls" });
    assert.equal(frame.complete, true);
    assert.ok(frame.controls.some((control) => control.name === "Title"));
    assert.ok(frame.controls.some((control) => control.name === "Notes"));
    const titleControl = frame.controls.find((control) => control.name === "Title");
    assert.ok(titleControl);
    const title = await backend.dispatch({ frame, target: titleControl, step: { kind: "setValue", target: { ref: "opaque-core-ref" }, value: "Public title" } });
    assert.equal(title.status, "dispatched");
    assert.equal(await page.locator("#title").inputValue(), "Public title");
    assert.equal(screenshots, 0);
    await backend.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("image capture requires explicit host opt-in and is viewport-scoped", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(await fixture("browser-form.html"));
    const denied = createBrowserBackend(page);
    await assert.rejects(() => denied.observe({ view: "image" }), (error) => error.code === "image_not_allowed");
    await denied.close();
    const backend = createBrowserBackend(page, { allowImages: true });
    const imageFrame = await backend.observe({ view: "image" });
    assert.equal(imageFrame.image?.mimeType, "image/png");
    assert.ok((imageFrame.image?.dataBase64.length ?? 0) > 20);
    assert.equal(imageFrame.image?.width, 900);
    assert.equal(imageFrame.image?.height, 700);
    await backend.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("pixel target is rejected after a modal occludes it", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(await fixture("browser-modal.html"));
    const backend = createBrowserBackend(page, { allowImages: true });
    const frame = await backend.observe({ view: "both" });
    const openControl = frame.controls.find((control) => control.name === "Open modal");
    const underlayControl = frame.controls.find((control) => control.name === "Underlying action");
    assert.ok(openControl && underlayControl);
    const open = await backend.dispatch({ frame, target: openControl, step: { kind: "click", target: { ref: "opaque-core-ref" } } });
    assert.equal(open.status, "dispatched");
    const box = await page.locator("#underlay").boundingBox();
    assert.ok(box);
    const refused = await backend.dispatch({ frame, target: underlayControl, origin: frame, step: { kind: "click", target: { point: { x: box.x + box.width / 2, y: box.y + box.height / 2 } } } });
    assert.equal(refused.status, "refused");
    assert.ok(["point_occluded", "point_target_changed"].includes(refused.code));
    await backend.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("public act finds an off-list edit, distinguishes inserting and replacing, and refuses duplicate names", async t => {
  const result = await withPage(async page => {
    const filler = Array.from({ length: 35 }, (_, i) => `<input aria-label="Field ${i}">`).join("");
    await page.setContent(`<main>${filler}<input id="later" aria-label="Later" value="abcd">
      <input aria-label="Twin"><input aria-label="Twin"><form role="search" aria-label="Orders" onsubmit="event.preventDefault();this.dataset.count='1'">
      <input type="search" aria-label="Keywords"><button type="submit">查询</button></form></main>`);
    const session = createDeskSession(createBrowserBackend(page, { observeLimit: 1, includePublicValues: true }));
    try {
      const [observe, act] = createDeskTools(session);
      assert.equal((await observe.invoke({})).complete, false);
      await page.locator("#later").evaluate(el => { el.focus(); el.setSelectionRange(2, 2); });
      const target = { role: "Edit", name: "Later" };
      const inserted = await act.invoke({ steps: [{ kind: "type", target, text: "X", expect: { target, valueEquals: "abXcd" } }] });
      assert.equal(inserted.steps[0].status, "verified", JSON.stringify(inserted));
      assert.equal(await page.locator("#later").inputValue(), "abXcd");
      const replaced = await act.invoke({ steps: [{ kind: "setValue", target, value: "new" }] });
      assert.equal(replaced.status, "completed", JSON.stringify(replaced));
      assert.equal(await page.locator("#later").inputValue(), "new");
      const ambiguous = await act.invoke({ steps: [{ kind: "type", target: { name: "Twin" }, text: "no" }] });
      assert.equal(ambiguous.steps[0].status, "not_dispatched");
      assert.equal(ambiguous.candidates.length, 2);
      const alias = await act.invoke({ steps: [{ kind: "click", target: { role: "button", name: "搜索", within: "Orders" } }] });
      assert.equal(alias.status, "completed", JSON.stringify(alias));
      assert.equal(await page.locator("form").getAttribute("data-count"), "1");
    } finally { await session.close(); }
    return { skipped: false };
  });
  if (result.skipped) t.skip("Installed Chromium required");
});

test("navigation invalidates the old observation scope", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(await fixture("browser-form.html"));
    const backend = createBrowserBackend(page);
    const frame = await backend.observe({ view: "controls" });
    await page.goto("data:text/html,<button id='next'>Next</button>");
    const stale = await backend.dispatch({ frame, target: frame.controls[0], step: { kind: "click", target: { ref: "opaque-core-ref" } } });
    assert.equal(stale.status, "refused");
    assert.equal(stale.code, "scope_changed");
    await backend.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("dispatch search finds a late-rendered control independently of observe budget", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(await fixture("browser-late-render.html"));
    const backend = createBrowserBackend(page, { observeLimit: 1, searchLimit: 20 });
    const frame = await backend.observe({ view: "controls" });
    const late = await backend.dispatch({ frame, step: { kind: "click", target: { role: "button", name: "Late action" } } });
    assert.equal(late.status, "dispatched");
    assert.equal(await page.locator("#late-button").count(), 1);
    await backend.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("scoped observe searches beyond the public first-page budget", async (t) => {
  const result = await withPage(async (page) => {
    const fields = Array.from({ length: 35 }, (_, index) => `<label for="field-${index}">Field ${index}</label><input id="field-${index}" name="field-${index}">`).join("");
    await page.setContent(`<form aria-label="Large public form">${fields}<label for="later">Unique later</label><input id="later" name="later"><label for="dup-a">Duplicate</label><input id="dup-a" name="dup-a"><label for="dup-b">Duplicate</label><input id="dup-b" name="dup-b"><input id="hidden-duplicate" aria-label="Duplicate" style="display:none"></form>`);
    const backend = createBrowserBackend(page, { observeLimit: 1 });
    const later = await backend.observe({ view: "controls", where: { role: "textbox", name: "Unique later" } });
    assert.equal(later.complete, true);
    assert.equal(later.controls.length, 1);
    const duplicate = await backend.observe({ view: "controls", where: { role: "textbox", name: "Duplicate" } });
    assert.equal(duplicate.complete, true);
    assert.equal(duplicate.controls.length, 2);
    await page.setContent(await fixture("browser-form.html"));
    const alias = await backend.observe({ view: "controls", where: { role: "button", name: "Query" } });
    assert.equal(alias.complete, true);
    assert.equal(alias.controls.length, 1);
    assert.equal(alias.controls[0].filterAction, true);
    await backend.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("replacement between observations receives a fresh identity", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(await fixture("browser-form.html"));
    const backend = createBrowserBackend(page);
    const first = await backend.observe({ view: "controls" });
    const oldTitle = first.controls.find((control) => control.name === "Title");
    assert.ok(oldTitle);
    await page.evaluate(() => {
      const old = document.getElementById("title");
      old.replaceWith(old.cloneNode(true));
    });
    const second = await backend.observe({ view: "controls" });
    const newTitle = second.controls.find((control) => control.name === "Title");
    assert.ok(newTitle);
    assert.notEqual(newTitle.id, oldTitle.id);
    const stale = await backend.dispatch({ frame: first, target: oldTitle, step: { kind: "setValue", target: { ref: "old-public-ref" }, value: "must refuse" } });
    assert.equal(stale.status, "refused");
    assert.equal(stale.code, "target_changed");
    const fresh = await backend.dispatch({ frame: second, target: newTitle, step: { kind: "setValue", target: { ref: "new-public-ref" }, value: "accepted" } });
    assert.equal(fresh.status, "dispatched");
    assert.equal(await page.locator("#title").inputValue(), "accepted");
    await backend.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("a replaced same-label node cannot receive a pinned dispatch", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(await fixture("browser-form.html"));
    const backend = createBrowserBackend(page);
    const frame = await backend.observe({ view: "controls" });
    const title = frame.controls.find((control) => control.name === "Title");
    assert.ok(title);
    await page.evaluate(() => {
      const old = document.getElementById("title");
      const replacement = old.cloneNode(true);
      old.replaceWith(replacement);
    });
    const result = await backend.dispatch({ frame, target: title, step: { kind: "setValue", target: { ref: "opaque-core-ref" }, value: "must not redirect" } });
    assert.equal(result.status, "refused");
    assert.equal(result.code, "target_changed");
    assert.equal(await page.locator("#title").inputValue(), "");
    await backend.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("material control binding changes when its recipient changes", async (t) => {
  const result = await withPage(async (page) => {
    await page.goto(pathToFileURL(join(here, "fixtures", "browser-approval.html")).href);
    const backend = createBrowserBackend(page);
    const frame = await backend.observe({ view: "controls" });
    const send = frame.controls.find((control) => control.name === "Send");
    assert.ok(send?.approvalContext?.token);
    await page.locator("#recipient").fill("bob@example.test");
    const refused = await backend.dispatch({ frame, target: send, step: { kind: "click", target: { ref: "approval-ref" } } });
    assert.equal(refused.status, "refused");
    assert.equal(refused.code, "approval_context_changed");
    assert.equal(await page.locator("#send-form").getAttribute("data-sent"), null);
    await backend.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("backend reports delivery even when a caller-side expect would fail", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(await fixture("browser-form.html"));
    const backend = createBrowserBackend(page);
    const frame = await backend.observe({ view: "controls" });
    const title = frame.controls.find((control) => control.name === "Title");
    assert.ok(title);
    const delivery = await backend.dispatch({
      frame,
      target: title,
      step: { kind: "setValue", target: { ref: "opaque-core-ref" }, value: "actual", expect: { target: { role: "textbox", name: "Title" }, valueEquals: "different" } },
    });
    assert.equal(delivery.status, "dispatched");
    assert.equal(await page.locator("#title").inputValue(), "actual");
    await backend.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("origin allowlists reject explicit empty and opaque-origin mismatches", async (t) => {
  const result = await withPage(async (page) => {
    const fileUrl = pathToFileURL(join(here, "fixtures", "browser-form.html")).href;
    await page.goto(fileUrl);
    const empty = createBrowserBackend(page, { authorizedOrigins: [] });
    await assert.rejects(() => empty.observe({ view: "controls" }), (error) => error.code === "unauthorized_origin");
    await empty.close();
    const opaqueOther = createBrowserBackend(page, { authorizedOrigins: ["data:text/html,<p>other</p>"] });
    await assert.rejects(() => opaqueOther.observe({ view: "controls" }), (error) => error.code === "unauthorized_origin");
    await opaqueOther.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});
