import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { createDeskSession, createDeskTools } from "desklatch";
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
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    process.env["ProgramFiles(x86)"] && `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env["ProgramFiles(x86)"] && `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
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

test("session only delivers page evidence after an explicit public read", async () => {
  const backend = {
    allowDocumentText: true,
    capabilities: [],
    async observe() {
      return {
        scope: "test-document-scope",
        complete: true,
        controls: [],
        document: {
          kind: "page_text",
          chunks: [{ text: "Page-provided text", index: 0 }],
          complete: true,
          truncated: false,
          viewportOnly: false,
          totalChars: 18,
          totalChunks: 1,
          sourceUrl: "https://example.test/path?private=1#fragment",
        },
      };
    },
    async dispatch() { return { status: "refused", code: "unused" }; },
    async close() {},
  };
  const session = createDeskSession(backend, { allowModelDocumentText: true });
  const plain = await session.observe();
  assert.equal("document" in plain, false);
  const explicit = await session.observe({ read: "document" });
  assert.equal(explicit.view, "document");
  assert.deepEqual(explicit.controls, []);
  assert.equal(explicit.document?.kind, "page_text");
  assert.equal(explicit.document?.sourceUrl, "https://example.test/path");
  await session.close();
});

test("document reads are off by default and never become controls", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(`
      <title>Title secret should never be copied</title>
      <main id="article">
        <h1>Gallery hours</h1>
        <p>The museum opens at nine and closes at five.</p>
        <div>Intro before heading<h2>Nested heading</h2><p>Nested paragraph</p>Tail after paragraph</div>
        <p><a href="/share">Action link label</a> <button type="button">Action button label</button></p>
        <p aria-hidden="true">Hidden secret article text</p>
        <div style="display:none"><p>Hidden ancestor text</p></div>
        <div id="hidden-root-wrap" style="display:none"><main id="hidden-root"><p>Hidden root text</p></main></div>
        <div id="nested-hidden-outer" style="display:none"><div id="nested-hidden-inner"><main id="nested-hidden-root"><p>Nested hidden root text</p></main></div></div>
        <div id="content-hidden-outer" style="content-visibility:hidden"><main id="content-hidden-root"><p>Content hidden root text</p></main></div>
        <p id="zero-height-clip" style="height:0;overflow:hidden">Zero height clipped text</p>
        <div id="display-contents" style="display:contents"><span>Display contents readable text</span></div>
        <p id="offscreen-readable" style="position:absolute;top:2400px">Offscreen readable text</p>
        <script>const sourceOnlySecret = "Script secret text";</script>
        <form><label for="secret">Private field</label><input id="secret" value="typed-private-value"></form>
        <div contenteditable="true">Editor private value</div>
        <iframe srcdoc="<p>External frame text</p>"></iframe>
      </main>`);
    const denied = createBrowserBackend(page);
    await assert.rejects(() => denied.observe({ view: "controls", read: "document" }), (error) => error?.code === "document_not_allowed");
    await assert.rejects(() => denied.observe({ view: "document" }), (error) => error?.code === "document_not_allowed");
    await denied.close();

    const backend = createBrowserBackend(page, { allowDocumentText: true });
    const frame = await backend.observe({ view: "controls", read: "document" });
    assert.equal(frame.document?.kind, "page_text");
    assert.equal(frame.document?.viewportOnly, false);
    assert.equal(frame.document?.truncated, false);
    const text = frame.document?.chunks.map((chunk) => chunk.text).join(" ") ?? "";
    assert.match(text, /Gallery hours/);
    assert.match(text, /opens at nine/);
    assert.ok(text.indexOf("Intro before heading") < text.indexOf("Nested heading"));
    assert.ok(text.indexOf("Nested heading") < text.indexOf("Nested paragraph"));
    assert.ok(text.indexOf("Nested paragraph") < text.indexOf("Tail after paragraph"));
    assert.doesNotMatch(text, /Hidden secret|Hidden ancestor|Script secret|typed-private-value|Editor private|External frame/);
    assert.doesNotMatch(text, /Title secret|Hidden root/);
    assert.doesNotMatch(text, /Zero height clipped/);
    assert.match(text, /Display contents readable/);
    assert.match(text, /Offscreen readable/);
    assert.doesNotMatch(text, /Action link label|Action button label/);
    assert.equal(frame.controls.some((control) => control.name === "Action button label"), true);
    await backend.close();

    const hiddenRootBackend = createBrowserBackend(page, { allowDocumentText: true, rootSelector: "#hidden-root" });
    const hiddenRoot = await hiddenRootBackend.observe({ view: "controls", read: "document" });
    assert.deepEqual(hiddenRoot.document?.chunks, []);
    await hiddenRootBackend.close();

    const nestedHiddenBackend = createBrowserBackend(page, { allowDocumentText: true, rootSelector: "#nested-hidden-root" });
    const nestedHidden = await nestedHiddenBackend.observe({ view: "controls", read: "document" });
    assert.deepEqual(nestedHidden.document?.chunks, []);
    await nestedHiddenBackend.close();

    const contentHiddenBackend = createBrowserBackend(page, { allowDocumentText: true, rootSelector: "#content-hidden-root" });
    const contentHidden = await contentHiddenBackend.observe({ view: "controls", read: "document" });
    assert.deepEqual(contentHidden.document?.chunks, []);
    await contentHiddenBackend.close();

    const htmlRootBackend = createBrowserBackend(page, { allowDocumentText: true, rootSelector: "html" });
    const htmlRoot = await htmlRootBackend.observe({ view: "controls", read: "document" });
    assert.doesNotMatch(htmlRoot.document?.chunks.map((chunk) => chunk.text).join(" ") ?? "", /Title secret/);
    await htmlRootBackend.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("document reads expose bounded chunks, transparent truncation, and sanitized citation URL", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(`<main><h1>Public article</h1><p>${"Rendered article words ".repeat(20)}</p></main>`);
    const fakeUrl = "https://user:pass@example.test/articles/today?secret=do-not-cite#hours";
    const adaptedPage = {
      evaluate: async (fn, arg) => {
        const evalArg = arg?.expectedHref ? { ...arg, expectedHref: page.url() } : arg;
        const result = await page.evaluate(fn, evalArg);
        if (arg?.expectedHref && result?.attestation) {
          return {
            ...result,
            attestation: {
              ...result.attestation,
              before: { ...result.attestation.before, href: fakeUrl },
              after: { ...result.attestation.after, href: fakeUrl },
            },
            routeChanged: false,
          };
        }
        return result;
      },
      locator: page.locator.bind(page),
      mouse: page.mouse,
      url: () => fakeUrl,
      on: page.on.bind(page),
      off: page.off.bind(page),
      waitForTimeout: page.waitForTimeout.bind(page),
      screenshot: page.screenshot.bind(page),
      mainFrame: page.mainFrame.bind(page),
      isClosed: page.isClosed.bind(page),
    };
    const backend = createBrowserBackend(adaptedPage, {
      allowDocumentText: true,
      documentTextLimit: 50,
      documentChunkLimit: 2,
      documentChunkSize: 20,
    });
    const frame = await backend.observe({ view: "controls", read: { kind: "document" } });
    assert.ok(frame.document);
    assert.equal(frame.document.kind, "page_text");
    assert.equal(frame.document.viewportOnly, false);
    assert.equal(frame.document.complete, false);
    assert.equal(frame.document.truncated, true);
    assert.ok(frame.document.chunks.length <= 2);
    assert.ok(frame.document.chunks.every((chunk) => chunk.text.length <= 20));
    assert.ok(frame.document.totalChars > 50);
    assert.ok(frame.document.totalChunks >= frame.document.chunks.length);
    assert.equal(frame.document.sourceUrl, "https://example.test/articles/today");
    await backend.close();

    const sessionBackend = createBrowserBackend(page, { allowDocumentText: true });
    const session = createDeskSession(sessionBackend, { allowModelDocumentText: true });
    const observe = createDeskTools(session).find((tool) => tool.name === "observe");
    assert.ok(observe);
    const observation = await observe.invoke({ read: "document" });
    assert.equal(observation.document.kind, "page_text");
    assert.equal(observation.document.chunks.every((chunk) => typeof chunk.text === "string"), true);
    await session.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("document reads reject an exact-route race from the live evaluation", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent("<main><h1>Race-safe text</h1><p>Public content</p></main>");
    const routeBefore = "https://example.test/articles/today";
    const routeAfter = "https://example.test/articles/changed";
    const adaptedPage = {
      evaluate: async (fn, arg) => {
        const evalArg = arg?.expectedHref ? { ...arg, expectedHref: page.url() } : arg;
        const result = await page.evaluate(fn, evalArg);
        if (arg?.expectedHref && result?.attestation) {
          return {
            ...result,
            attestation: {
              ...result.attestation,
              before: { ...result.attestation.before, href: routeBefore },
              after: { ...result.attestation.after, href: routeAfter },
            },
            routeChanged: false,
          };
        }
        return result;
      },
      locator: page.locator.bind(page),
      mouse: page.mouse,
      url: () => routeBefore,
      on: page.on.bind(page),
      off: page.off.bind(page),
      waitForTimeout: page.waitForTimeout.bind(page),
      screenshot: page.screenshot.bind(page),
      mainFrame: page.mainFrame.bind(page),
      isClosed: page.isClosed.bind(page),
    };
    const backend = createBrowserBackend(adaptedPage, { allowDocumentText: true });
    await assert.rejects(
      () => backend.observe({ view: "controls", read: "document" }),
      (error) => error?.code === "document_route_changed",
    );
    await backend.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});

test("plain same-page GET search requires a uniquely named public query field", async (t) => {
  const result = await withPage(async (page) => {
    await page.setContent(`
      <form id="positive" action="" method="get">
        <label id="search-documentation">Search documentation</label>
        <input type="text" name="q" aria-labelledby="search-documentation">
        <input id="positive-submit" type="submit" value="search">
      </form>
      <form id="hidden-field" action="" method="get">
        <label for="hidden-q">Search</label><input id="hidden-q" type="text" name="q">
        <input type="hidden" name="tracking" value="x"><input id="hidden-submit" type="submit" value="search">
      </form>
      <form id="other-route" action="/other" method="get">
        <label for="other-q">Query</label><input id="other-q" type="text" name="q">
        <input id="other-submit" type="submit" value="search">
      </form>
      <form id="post-route" action="" method="post">
        <label for="post-q">Query</label><input id="post-q" type="text" name="q">
        <input id="post-submit" type="submit" value="search">
      </form>
      <form id="override-route" action="" method="get">
        <label for="override-q">Query</label><input id="override-q" type="text" name="q">
        <button id="override-submit" type="submit" formmethod="get" formtarget="_blank">Search</button>
      </form>
      <form id="external-field" action="" method="get">
        <label for="external-q">Query</label><input id="external-q" type="text" name="q">
        <input id="external-submit" type="submit" value="search">
      </form>
      <input form="external-field" type="text" name="other" value="extra">
      <form id="aria-disabled-extra" action="" method="get">
        <label for="aria-q">Query</label><input id="aria-q" type="text" name="q">
        <input type="text" name="extra" aria-disabled="true"><input id="aria-submit" type="submit" value="search">
      </form>
      <form id="image-submit" action="" method="get">
        <label for="image-q">Query</label><input id="image-q" type="text" name="q">
        <input id="image-submit-button" type="image" alt="search" value="search">
      </form>
      <form id="dirname-extra" action="" method="get">
        <label for="dirname-q">Query</label><input id="dirname-q" type="text" name="q" dirname="q.dir">
        <input id="dirname-submit" type="submit" value="search">
      </form>`);
    const backend = createBrowserBackend(page);
    const frame = await backend.observe({ view: "controls" });
    const positive = frame.controls.find((control) => control.name === "search" && control.filterAction === true);
    assert.ok(positive, "input submit value should provide its static button caption");
    assert.equal(positive.effect, "read");
    for (const id of ["hidden-field", "other-route", "post-route", "override-route", "external-field", "aria-disabled-extra", "image-submit", "dirname-extra"]) {
      const control = frame.controls.find((candidate) => candidate.name?.toLocaleLowerCase() === "search" && candidate.within === id);
      assert.ok(control, `${id} submitter should be observed`);
      assert.equal(control.filterAction, false, `${id} must not be a bounded search`);
    }
    const publicSession = createDeskSession(createBrowserBackend(page));
    const publicObservation = await publicSession.observe();
    const publicSearch = publicObservation.controls.find((control) => control.name?.toLocaleLowerCase() === "search" && control.effect === "read");
    assert.ok(publicSearch);
    assert.equal(publicSearch.effect, "read");
    await publicSession.close();
    await backend.close();
    return { skipped: false };
  });
  if (result.skipped) t.skip("No installed Edge/Chrome/Chromium executable");
});
