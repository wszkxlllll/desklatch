import { existsSync } from "node:fs";
import { randomInt } from "node:crypto";
import { chromium } from "playwright-core";
import { createBrowserBackend } from "desklatch/browser";

export const fixtureOrigin = "http://desklatch.test";

export function chromiumPath() {
  return [process.env.DESKLATCH_CHROMIUM, chromium.executablePath(),
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    .find(file => file && existsSync(file));
}

export function fixtureHtml(marker, variant = "standard", fieldTag = String(randomInt(1000, 10000))) {
  if (!/^[0-9]{6}$/.test(marker)) throw Error("invalid_fixture_marker");
  if (!/^[0-9]{4}$/.test(fieldTag)) throw Error("invalid_fixture_field_tag");
  const handoff = variant === "handoff" || variant === "canvas-handoff";
  const badge = variant.startsWith("canvas") ? '<canvas width="160" height="42" aria-label="Batch code"></canvas>' : `<output>${marker}</output>`;
  return `<!doctype html><meta charset="utf-8"><title>DeskLatch · task form</title>
  <style>body{font:20px system-ui;margin:36px;max-width:660px}label{display:block;margin:18px 0}
  input,textarea,button{font:inherit;padding:7px}output{font-weight:700;letter-spacing:5px}</style>
  <main><h1>DeskLatch test workspace</h1><p>Batch code ${badge}</p>
  <label>${handoff ? `Work summary ${fieldTag}` : "Title"} <input id="title" autocomplete="off"></label>
  <label>${handoff ? `For the incoming shift ${fieldTag}` : "Notes"} <textarea id="notes"></textarea></label>
  ${handoff ? `<label>Archive key ${fieldTag} <input id="archive" value="R-17"></label>` : ""}
  <button type="button" id="expand" aria-controls="fields" aria-expanded="false">Show filters</button>
  <form role="search" aria-label="Order filters" onsubmit="event.preventDefault()">
  <div id="fields" hidden><label>Keywords <input id="keywords" type="search" autocomplete="off"></label></div></form>
  <button type="button" id="send">Send message</button><output id="sends">0</output></main>
  <script>document.querySelector('#expand').onclick=event=>{document.querySelector('#fields').hidden=false;event.currentTarget.setAttribute('aria-expanded','true')};
  document.querySelector('#send').onclick=()=>{document.querySelector('#sends').textContent=String(Number(document.querySelector('#sends').textContent)+1)};</script>`;
}

export async function loadFixture(page, marker, variant = "standard") {
  const html = fixtureHtml(marker, variant);
  await page.route("**/*", route => new URL(route.request().url()).origin === fixtureOrigin
    ? route.fulfill({ contentType: "text/html; charset=utf-8", body: html })
    : route.abort());
  await page.goto(fixtureOrigin);
  if (variant.startsWith("canvas")) await page.locator("canvas").evaluate((canvas, value) => {
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#101820"; ctx.font = "bold 30px monospace"; ctx.fillText(value, 3, 32);
  }, marker);
}

export async function createFixture({ allowImages = false, guest, variant = "standard" } = {}) {
  const marker = String(randomInt(100000,1000000));
  const stats = { captures: 0, observations: 0, dispatches: 0 };
  const grants = { authorizedOrigins: [fixtureOrigin], includePublicValues: true, allowImages };
  let browser, page, native;
  async function prepare(managedPage) {
    page = managedPage;
    await loadFixture(page, marker, variant);
    const screenshot = page.screenshot.bind(page);
    page.screenshot = (...args) => { stats.captures++; return screenshot(...args); };
  }
  try {
    if (guest) {
      const { createE2BBrowserBackend } = await import("desklatch/e2b");
      native = await createE2BBrowserBackend(guest, { prepare, browser: grants, headless: false });
    } else {
      const executablePath = chromiumPath();
      if (!executablePath) throw Error("Set DESKLATCH_CHROMIUM to an installed Chromium executable");
      browser = await chromium.launch({ executablePath, headless: true });
      await prepare(await browser.newPage({ viewport: { width: 900, height: 640 } }));
      native = createBrowserBackend(page, grants);
    }
    let closing;
    const close = () => closing ??= Promise.resolve().then(async () => {
      try { await native.close(); } finally { await browser?.close(); }
    });
    const backend = {
      capabilities: native.capabilities,
      observe: input => { stats.observations++; return native.observe(input); },
      hitTest: (f, p, signal) => native.hitTest(f, p, signal),
      dispatch: input => { stats.dispatches++; return native.dispatch(input); },
      close,
    };
    return { backend, page, marker, stats, close };
  } catch (error) { await browser?.close(); throw error; }
}
