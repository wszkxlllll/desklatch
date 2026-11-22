import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createDeskSession, createDeskTools, createRiskPolicy } from "desklatch";
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

test("a sandbox host can delegate an unclassified point inside its local palette while the adjacent send still requires approval", async t => {
  const result = await withPage(async page => {
    await page.setContent('<button id="palette" type="button">Amber</button><button id="send" type="button">Send message</button><input aria-label="Draft"><output></output>');
    await page.evaluate(() => document.addEventListener("click", e => {
      if (e.target.id) document.querySelector("output").textContent += e.target.id;
    }));
    const backend = createBrowserBackend(page, { allowImages: true, includePublicValues: true });
    const controls = (await backend.observe({ view: "controls" })).controls;
    const palette = controls.find(c => c.name === "Amber");
    const send = controls.find(c => c.name === "Send message");
    assert.ok(palette?.rect && send?.rect);
    const grant = { targetId: palette.id, region: palette.rect };
    const session = createDeskSession(backend, {
      allowModelImages: true,
      policy: createRiskPolicy({ hostRules: { allowScopedPointClick: () => grant } }),
    });
    const click = async (rect, following = []) => {
      const { observationId } = await session.observe({ view: "image" });
      const point = { x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2) };
      return session.act({ observationId, steps: [{ kind: "click", target: { point } }, ...following] });
    };
    try {
      const type = { kind: "setValue", target: { name: "Draft" }, value: "ready", expect: { target: { name: "Draft" }, valueEquals: "ready" } };
      const mixed = await click(palette.rect, [type]);
      assert.deepEqual(mixed.steps.map(step => step.status), ["dispatched", "verified"]);
      assert.equal(await page.locator("input").inputValue(), "ready");
      const pending = await click(send.rect);
      assert.equal(pending.code, "approval_required");
      await session.resolveApproval(pending.requestId, "deny");
      assert.equal(await page.locator("output").textContent(), "palette");

      const outer = await session.observe({ view: "image" });
      const point = { x: Math.floor(palette.rect.x + palette.rect.width / 2), y: Math.floor(palette.rect.y + palette.rect.height / 2) };
      const { createDeskCodeMode } = await import("desklatch/code-mode");
      const guest = createDeskCodeMode(session);
      try {
        const args = { observationId: outer.observationId, steps: [{ kind: "click", target: { point } }] };
        const ran = await guest.runCode({ code: `await desk.act(${JSON.stringify(args)}); const snap = await desk.observe({where:{name:"Draft"}}); inspect(snap.controls.length);` });
        assert.equal(ran.status, "completed", JSON.stringify(ran.actions));
        assert.equal(ran.actions[0].steps[0].status, "dispatched");
        assert.deepEqual(ran.inspections, [1]);
        assert.equal(await page.locator("output").textContent(), "palettepalette");
      } finally { await guest.close(); }
    } finally { await session.close(); }
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

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

test("real Playwright snapshots observed selectors through one exact DOM batch", async t => {
  const result = await withPage(async page => {
    await page.setContent(await fixture("browser-form.html"));
    assert.equal(typeof page.evaluateHandle, "function");
    const nativeEvaluateHandle = page.evaluateHandle.bind(page);
    const nativeLocator = page.locator.bind(page);
    let batchCalls = 0;
    let getPropertiesCalls = 0;
    let locatorSnapshotCalls = 0;
    page.evaluateHandle = async (...args) => {
      batchCalls += 1;
      const root = await nativeEvaluateHandle(...args);
      const nativeGetProperties = root.getProperties.bind(root);
      root.getProperties = async (...propertyArgs) => {
        getPropertiesCalls += 1;
        return nativeGetProperties(...propertyArgs);
      };
      return root;
    };
    page.locator = selector => {
      const locator = nativeLocator(selector);
      if (typeof locator.elementHandles === "function") {
        const nativeElementHandles = locator.elementHandles.bind(locator);
        locator.elementHandles = async (...args) => {
          locatorSnapshotCalls += 1;
          return nativeElementHandles(...args);
        };
      }
      return locator;
    };
    const backend = createBrowserBackend(page);
    try {
      const frame = await backend.observe({ view: "controls" });
      const title = frame.controls.find(control => control.name === "Title");
      assert.ok(title);
      // The fixture includes one material approval candidate, so observe has
      // two independent snapshot phases: approval context and frame binding.
      assert.equal(batchCalls, 2, "approval and bind phases should each use one batched DOM evaluation");
      assert.equal(getPropertiesCalls, 2, "approval and bind phases should each unwrap one flattened property map");
      assert.equal(locatorSnapshotCalls, 0, "native Playwright must not acquire one locator snapshot per selector");
      const edited = await backend.dispatch({ frame, target: title, step: { kind: "setValue", target: { ref: "opaque-core-ref" }, value: "batched" } });
      assert.equal(edited.status, "dispatched");
      assert.equal(await nativeLocator("#title").inputValue(), "batched");
    } finally {
      await backend.close();
    }
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("scoped remote actions bind only matching controls, scroll clipped targets, and distinguish a timeout from detachment", async t => {
  const result = await withPage(async page => {
    await page.setContent('<input id="visible" aria-label="Visible"><div style="height:45px;overflow:auto"><div style="height:160px"></div><input id="clipped" aria-label="Clipped"></div>');
    const locator = page.locator.bind(page);
    const bound = new Set();
    let scrolls = 0, rejectScroll = true;
    page.locator = selector => {
      const loc = locator(selector);
      const getHandle = loc.elementHandle.bind(loc);
      const getHandles = loc.elementHandles.bind(loc);
      function track(handle) {
        if (handle) {
          bound.add(selector);
          const scroll = handle.scrollIntoViewIfNeeded.bind(handle);
          handle.scrollIntoViewIfNeeded = async options => {
            scrolls++;
            if (rejectScroll) throw Object.assign(new Error("synthetic transport deadline"), { name: "TimeoutError" });
            await scroll(options);
          };
        }
        return handle;
      }
      loc.elementHandle = async (...args) => track(await getHandle(...args));
      loc.elementHandles = async (...args) => (await getHandles(...args)).map(track);
      return loc;
    };
    // This test intentionally exercises the legacy locator adapter seam and
    // its synthetic timeout injection; the native batch path has its own test.
    page.evaluateHandle = undefined;
    const session = createDeskSession(createBrowserBackend(page));
    const [, act] = createDeskTools(session);
    const write = name => act.invoke({ steps: [{ kind: "setValue", target: { name }, value: "ok" }] });
    try {
      assert.equal((await write("Visible")).status, "completed");
      assert.equal(scrolls, 0);
      assert.deepEqual([...bound], ["#visible"]);
      const refused = await write("Clipped");
      assert.equal(refused.code, "timeout");
      assert.equal(refused.steps[0].status, "not_dispatched");
      assert.equal(await locator("#clipped").inputValue(), "");
      rejectScroll = false;
      assert.equal((await write("Clipped")).status, "completed");
      assert.equal(await locator("#clipped").inputValue(), "ok");
    } finally { await session.close(); }
    return { skipped: false };
  });
  if (result.skipped) t.skip("Installed Chromium required");
});

test("a focus-relative step stops if the active input changes just before dispatch", async t => {
  const result = await withPage(async page => {
    await page.setContent('<input id="first" aria-label="First"><input id="next" aria-label="Next">');
    const native = createBrowserBackend(page);
    const session = createDeskSession({ ...native, async dispatch(request) {
      if (request.step.target?.focusFromStep) await page.locator("#next").focus();
      return native.dispatch(request);
    } });
    try {
      const [, act] = createDeskTools(session);
      const batch = await act.invoke({ steps: [
        { kind: "type", target: { name: "First" }, text: "A" },
        { kind: "type", target: { focusFromStep: 1 }, text: "B" },
      ] });
      assert.equal(batch.code, "focus_changed");
      assert.equal(batch.steps[1].status, "not_dispatched");
      assert.equal(await page.locator("#first").inputValue(), "A");
      assert.equal(await page.locator("#next").inputValue(), "");
    } finally { await session.close(); }
    return { skipped: false };
  });
  if (result.skipped) t.skip("Installed Chromium required");
});

test("a text observation identifies a named visual source without exposing its pixels or granting actions", async t => {
  const result = await withPage(async page => {
    await page.setContent('<canvas aria-label="Serial plate"></canvas><canvas></canvas><canvas aria-label="Hidden" hidden></canvas><input aria-label="Record 7051">');
    await page.locator("canvas").first().evaluate(el => el.getContext("2d").fillText("543763", 1, 12));
    const session = createDeskSession(createBrowserBackend(page, { includePublicValues: true }));
    const [observe, act] = createDeskTools(session);
    try {
      const frame = await observe.invoke({});
      const graphics = frame.controls.filter(c => c.role === "img");
      assert.deepEqual(graphics.map(c => c.name), ["Serial plate"]);
      assert.deepEqual(graphics[0].actions, []);
      assert.equal(graphics[0].value, undefined);
      assert.equal(frame.image, undefined);
      assert.equal(JSON.stringify(frame).includes("543763"), false);
      assert.equal(frame.controls[0].name, "Record 7051");
      const clicked = await act.invoke({ observationId: frame.observationId, steps: [{ kind: "click", target: { ref: graphics[0].ref } }] });
      assert.equal(clicked.steps[0].status, "not_dispatched");
    } finally { await session.close(); }
    return { skipped: false };
  });
  if (result.skipped) t.skip("Installed Chromium required");
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

test("pixel target accepts the live topmost control when source rectangles overlap", async (t) => {
  const result = await withPage(async page => {
    await page.setContent(`
      <main style="position:relative;width:240px;height:120px">
        <button id="under" style="position:absolute;left:20px;top:20px;width:180px;height:70px;z-index:1">Under</button>
        <button id="top" style="position:absolute;left:20px;top:20px;width:180px;height:70px;z-index:2">Top</button>
      </main>
      <script>document.getElementById('top').addEventListener('click', () => document.body.dataset.clicked = 'top');</script>
    `);
    const session = createDeskSession(createBrowserBackend(page, { allowImages: true }), {
      allowModelImages: true,
      policy: () => ({ decision: "allow", code: "test" }),
    });
    try {
      const [observe, act] = createDeskTools(session);
      const observation = await observe.invoke({ view: "image" });
      const top = observation.controls.find(control => control.name === "Top");
      const under = observation.controls.find(control => control.name === "Under");
      assert.ok(top?.rect && under?.rect);
      assert.ok(top.rect.x === under.rect.x && top.rect.y === under.rect.y
        && top.rect.width === under.rect.width && top.rect.height === under.rect.height);
      const point = {
        x: Math.floor(top.rect.x + top.rect.width / 2),
        y: Math.floor(top.rect.y + top.rect.height / 2),
      };
      const result = await act.invoke({ observationId: observation.observationId, steps: [{ kind: "click", target: { point } }] });
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.equal(result.steps[0].status, "dispatched");
      assert.equal(await page.locator("body").getAttribute("data-clicked"), "top");
    } finally { await session.close(); }
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("editable browser controls accept a click for visual focus handoff", async (t) => {
  const result = await withPage(async page => {
    await page.setContent('<input id="query" aria-label="Query">');
    const backend = createBrowserBackend(page, { allowImages: true });
    try {
      const frame = await backend.observe({ view: "both" });
      const query = frame.controls.find(control => control.name === "Query");
      assert.ok(query);
      assert.ok(query.actions.includes("click"));
      const clicked = await backend.dispatch({ frame, target: query, step: { kind: "click", target: { ref: "query-ref" } } });
      assert.equal(clicked.status, "dispatched", JSON.stringify(clicked));
      assert.equal(await page.evaluate(() => document.activeElement?.id), "query");
    } finally { await backend.close(); }
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("pixel overlap origin fails closed for a covering popup and a replaced target", async (t) => {
  const result = await withPage(async page => {
    await page.setContent(`
      <main style="position:relative;width:240px;height:120px">
        <button id="under" style="position:absolute;left:20px;top:20px;width:180px;height:70px;z-index:1">Under</button>
        <button id="top" style="position:absolute;left:20px;top:20px;width:180px;height:70px;z-index:2">Top</button>
      </main>
    `);
    const session = createDeskSession(createBrowserBackend(page, { allowImages: true }), {
      allowModelImages: true,
      policy: () => ({ decision: "allow", code: "test" }),
    });
    try {
      const [observe, act] = createDeskTools(session);
      const observation = await observe.invoke({ view: "image" });
      const top = observation.controls.find(control => control.name === "Top");
      assert.ok(top?.rect);
      const point = {
        x: Math.floor(top.rect.x + top.rect.width / 2),
        y: Math.floor(top.rect.y + top.rect.height / 2),
      };
      await page.evaluate(() => {
        const popup = document.createElement("button");
        popup.id = "popup";
        popup.textContent = "Popup";
        popup.style.cssText = "position:absolute;left:20px;top:20px;width:180px;height:70px;z-index:9;opacity:0";
        document.body.append(popup);
      });
      const covered = await act.invoke({ observationId: observation.observationId, steps: [{ kind: "click", target: { point } }] });
      assert.notEqual(covered.status, "completed", JSON.stringify(covered));
      assert.equal(covered.steps[0].status, "not_dispatched");
      assert.ok(["point_occluded", "point_target_changed", "point_not_unique"].includes(covered.code), JSON.stringify(covered));

      await page.evaluate(() => document.getElementById("popup")?.remove());
      await page.evaluate(() => { document.getElementById("top").style.pointerEvents = "none"; });
      const pointerChanged = await act.invoke({ observationId: observation.observationId, steps: [{ kind: "click", target: { point } }] });
      assert.notEqual(pointerChanged.status, "completed", JSON.stringify(pointerChanged));
      assert.equal(pointerChanged.steps[0].status, "not_dispatched");
      assert.ok(["point_target_changed", "point_not_unique", "stale_point"].includes(pointerChanged.code), JSON.stringify(pointerChanged));

      await page.evaluate(() => { document.getElementById("top").style.pointerEvents = "auto"; });
      await page.evaluate(() => {
        const old = document.getElementById("top");
        old?.replaceWith(old.cloneNode(true));
      });
      const replaced = await act.invoke({ observationId: observation.observationId, steps: [{ kind: "click", target: { point } }] });
      assert.notEqual(replaced.status, "completed", JSON.stringify(replaced));
      assert.equal(replaced.steps[0].status, "not_dispatched");
      assert.ok(["point_target_changed", "point_not_unique", "stale_point"].includes(replaced.code), JSON.stringify(replaced));
    } finally { await session.close(); }
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
    const native = createBrowserBackend(page);
    let dispatched = 0;
    const backend = {
      ...native,
      async dispatch(request) {
        const result = await native.dispatch(request);
        if (result.status === "dispatched") dispatched += 1;
        return result;
      },
    };
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
    assert.equal(dispatched, 1, "the stale replacement attempt must not dispatch; only the fresh target may dispatch");
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

test("native tab evidence stays read while generic form submitters retain material binding", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(`
      <form id="generic-form" aria-label="Generic action form" onsubmit="event.preventDefault(); this.dataset.sent='true'">
        <label for="recipient">Recipient</label><input id="recipient" name="recipient" type="text" value="alice@example.test">
        <label for="message">Message</label><textarea id="message" name="message">Hello</textarea>
        <button id="generic-submit" aria-expanded="false" aria-controls="generic-panel">Opaque action</button>
        <button id="labeled-submit" type="button" aria-expanded="false" aria-controls="generic-panel">Send</button>
        <div id="generic-panel" role="tabpanel">Form panel</div>
      </form>
      <form aria-label="Post search" role="search" method="post">
        <input type="search" aria-label="Post query"><button type="submit">Search</button>
      </form>
      <form aria-label="Targeted search" role="search" method="get" target="_blank">
        <input type="search" aria-label="Targeted query"><button type="submit">Search</button>
      </form>
      <form aria-label="Bounded search" role="search" method="get">
        <input type="search" aria-label="Bounded query"><button type="submit">Search</button>
      </form>
      <div role="tablist" aria-label="Opaque tabs">
        <button id="ordinary-tab" type="button" role="tab" aria-controls="ordinary-panel" aria-selected="false">Opaque tab</button>
        <a id="external-tab" role="tab" href="/outside" aria-controls="ordinary-panel">External tab</a>
      </div>
      <div id="ordinary-panel" role="tabpanel">Tab panel</div>
      <script>
        document.getElementById('ordinary-tab').addEventListener('click', function () { this.dataset.activated = 'true'; });
      </script>`);
    const backend = createBrowserBackend(page);
    try {
      const frame = await backend.observe({ view: "controls" });
      const submit = frame.controls.find((control) => control.name === "Opaque action");
      const labeled = frame.controls.find((control) => control.name === "Send");
      const tab = frame.controls.find((control) => control.name === "Opaque tab");
      const externalTab = frame.controls.find((control) => control.name === "External tab");
      const recipient = frame.controls.find((control) => control.name === "Recipient");
      const message = frame.controls.find((control) => control.name === "Message");
      assert.ok(submit?.approvalContext?.token);
      assert.equal(submit?.effect, "external");
      assert.equal(labeled?.effect, "external");
      assert.equal(frame.controls.find((control) => control.name === "Search" && control.within === "Post search")?.effect, "external");
      assert.equal(frame.controls.find((control) => control.name === "Search" && control.within === "Targeted search")?.effect, "external");
      const boundedSearch = frame.controls.find((control) => control.name === "Search" && control.within === "Bounded search");
      assert.equal(boundedSearch?.effect, "read");
      assert.equal(boundedSearch?.filterAction, true);
      assert.equal(tab?.effect, "read");
      assert.equal(externalTab?.effect, "navigate");
      assert.equal(recipient?.enterMaySubmit, true);
      assert.equal(message?.enterMaySubmit, undefined);

      await page.locator("#recipient").fill("bob@example.test");
      const stale = await backend.dispatch({ frame, target: submit, step: { kind: "click", target: { ref: "generic-submit-ref" } } });
      assert.equal(stale.status, "refused");
      assert.equal(stale.code, "approval_context_changed");
      assert.equal(await page.locator("#generic-form").getAttribute("data-sent"), null);

      const fresh = await backend.observe({ view: "controls" });
      const freshSubmit = fresh.controls.find((control) => control.name === "Opaque action");
      assert.ok(freshSubmit?.approvalContext?.token);
      assert.notEqual(freshSubmit.approvalContext.token, submit.approvalContext.token);
      const sent = await backend.dispatch({ frame: fresh, target: freshSubmit, step: { kind: "click", target: { ref: "fresh-generic-submit-ref" } } });
      assert.equal(sent.status, "dispatched");
      assert.equal(await page.locator("#generic-form").getAttribute("data-sent"), "true");

      const clickedTab = await backend.dispatch({ frame, target: tab, step: { kind: "click", target: { ref: "tab-ref" } } });
      assert.equal(clickedTab.status, "dispatched");
      assert.equal(await page.locator("#ordinary-tab").getAttribute("data-activated"), "true");
    } finally { await backend.close(); }
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("fallback browser paths remain unique across nested and document-level controls", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(`<button>First</button><fieldset><button>Continue</button></fieldset><button>Continue</button>`);
    const backend = createBrowserBackend(page);
    try {
      const frame = await backend.observe({ view: "controls" });
      assert.equal(frame.controls.filter((control) => control.name === "Continue").length, 2);
      const scoped = await backend.observe({ view: "controls", where: { role: "button", name: "Continue" } });
      assert.equal(scoped.controls.length, 2);
    } finally { await backend.close(); }
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("same-document tab evidence stays inside a scoped observation root", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(`<div id="tab-scope"><div role="tablist"><button type="button" role="tab" aria-controls="outside-panel">Opaque scoped tab</button></div></div><div id="outside-panel" role="tabpanel">Outside panel</div>`);
    const backend = createBrowserBackend(page, { rootSelector: "#tab-scope" });
    try {
      const frame = await backend.observe({ view: "controls" });
      const tab = frame.controls.find((control) => control.name === "Opaque scoped tab");
      assert.equal(tab?.effect, "unknown");
    } finally { await backend.close(); }
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
