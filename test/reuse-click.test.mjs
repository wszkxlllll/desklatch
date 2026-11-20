import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDeskSession } from "../dist/session.js";
import { createBrowserBackend } from "../dist/backends/browser/index.js";
import { createDiscoverableStepReuse } from "../dist/reuse.js";

const capabilities = [{ kind: "click", targets: ["selector"], buttons: ["left"], counts: [1] }];
const here = dirname(fileURLToPath(import.meta.url));

function fakeClickBackend({ structural = true } = {}) {
  let expanded = false;
  let structuralMarker = structural;
  const calls = { observe: 0, dispatch: 0 };
  return {
    calls,
    capabilities,
    async observe() {
      calls.observe += 1;
      return {
        scope: "click-scope",
        complete: true,
        controls: [{
          id: "filters",
          role: "Button",
          name: "Show filters",
          states: ["visible", "enabled", ...(expanded ? ["expanded"] : [])],
          actions: ["click"],
          effect: "read",
          ...(structuralMarker ? { disclosure: true } : {}),
        }],
      };
    },
    async dispatch() {
      calls.dispatch += 1;
      expanded = true;
      return { status: "dispatched" };
    },
    async close() {},
    disableStructural() { structuralMarker = false; },
  };
}

function clickRequest(name = "Show filters") {
  return {
    steps: [{
      kind: "click",
      target: { role: "button", name },
      expect: { target: { role: "button", name }, state: "expanded" },
    }],
  };
}

function tabBackend() {
  let selected = false;
  const calls = { dispatch: 0 };
  return {
    calls,
    capabilities,
    async observe() {
      return {
        scope: "tab-scope",
        complete: true,
        controls: [{
          id: "tab-carl",
          role: "tab",
          name: "Carl Andersen",
          states: ["visible", "enabled", ...(selected ? ["selected"] : [])],
          actions: ["click"],
          effect: "read",
          sameDocumentTab: true,
        }],
      };
    },
    async dispatch() {
      calls.dispatch += 1;
      selected = true;
      return { status: "dispatched" };
    },
    async close() {},
  };
}

test("same-document tab evidence captures only a false-to-true selection", async () => {
  const backend = tabBackend();
  const session = createDeskSession(backend, { capabilities });
  const reuse = createDiscoverableStepReuse({ session, getContext: () => ({ page: "tabs" }) });
  const act = reuse.tools.find((tool) => tool.name === "act");
  assert.ok(act);
  const result = await act.invoke({
    steps: [{
      kind: "click",
      target: { role: "tab", name: "Carl Andersen" },
      expect: { target: { role: "tab", name: "Carl Andersen" }, state: "selected" },
    }],
  });
  assert.equal(result.status, "completed");
  assert.equal(backend.calls.dispatch, 1);
  const [record] = await reuse.verified.list();
  assert.equal(record.version, 2);
  assert.deepEqual(record.clickEvidence, [{ index: 1, state: "selected", structural: "tab" }]);
  await reuse.close();
});

test("verified disclosure click capture supports zero-slot replay and skips an open goal", async () => {
  const backend = fakeClickBackend();
  const session = createDeskSession(backend, { capabilities });
  const reuse = createDiscoverableStepReuse({ session, getContext: () => ({ page: "filters" }) });
  const act = reuse.tools.find((tool) => tool.name === "act");
  const observe = reuse.tools.find((tool) => tool.name === "observe");
  assert.ok(act && observe);

  const initial = await observe.invoke({});
  const first = await act.invoke({ observationId: initial.observationId, ...clickRequest() });
  assert.equal(first.status, "completed");
  assert.equal(backend.calls.dispatch, 1);
  const records = await reuse.verified.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].version, 2);
  assert.deepEqual(records[0].parameterNames, []);
  assert.deepEqual(records[0].clickEvidence, [{ index: 1, state: "expanded", structural: "disclosure" }]);
  assert.equal(Object.hasOwn(records[0].request, "observationId"), false);

  const listed = await observe.invoke({ reuseQuery: "filters" });
  assert.equal(listed.reuseCandidates.length, 1);
  const stale = await act.invoke({ observationId: "wrong-observation", reuse: { ref: listed.reuseCandidates[0].ref } });
  assert.equal(stale.status, "stopped");
  assert.equal(stale.code, "reuse_stale");
  const current = await observe.invoke({ reuseQuery: "filters" });
  const replay = await act.invoke({ observationId: current.observationId, reuse: { ref: current.reuseCandidates[0].ref } });
  assert.equal(replay.status, "completed");
  assert.equal(replay.steps[0].status, "verified");
  assert.equal(replay.steps[0].code, "already_satisfied");
  assert.equal(backend.calls.dispatch, 1);
  await reuse.close();
});

test("effect read alone cannot create a reusable click", async () => {
  const backend = fakeClickBackend({ structural: false });
  const session = createDeskSession(backend, { capabilities });
  const reuse = createDiscoverableStepReuse({ session, getContext: () => ({ page: "unsafe" }) });
  const act = reuse.tools.find((tool) => tool.name === "act");
  assert.ok(act);
  const result = await act.invoke(clickRequest());
  assert.equal(result.status, "completed");
  assert.equal(backend.calls.dispatch, 1);
  assert.deepEqual(await reuse.verified.list(), []);
  await reuse.close();
});

test("a structural marker change rejects cached click before dispatch", async () => {
  const backend = fakeClickBackend();
  const session = createDeskSession(backend, { capabilities });
  const reuse = createDiscoverableStepReuse({ session, getContext: () => ({ page: "filters" }) });
  const act = reuse.tools.find((tool) => tool.name === "act");
  assert.ok(act);
  assert.equal((await act.invoke(clickRequest())).status, "completed");
  backend.disableStructural();
  const replay = await reuse.verified.run((await reuse.verified.list())[0].key, { context: { page: "filters" } });
  assert.equal(replay.status, "stopped");
  assert.equal(replay.result.code, "replay_unsafe_target");
  assert.equal(backend.calls.dispatch, 1);
  await reuse.close();
});

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
  return candidates.find((candidate) => existsSync(candidate));
}

test("real browser disclosure fixture captures and replays without toggling it closed", async (t) => {
  const chromium = Number.parseInt(process.versions.node.split(".")[0], 10) >= 20
    ? (await import("playwright-core")).chromium
    : undefined;
  const executable = executablePath();
  if (!chromium || !executable) {
    t.skip("No installed Edge/Chrome/Chromium executable");
    return;
  }
  const browser = await chromium.launch({ headless: true, executablePath: executable });
  const context = await browser.newContext();
  const page = await context.newPage();
  const html = await readFile(join(here, "fixtures", "browser-form.html"), "utf8");
  await page.setContent(html);
  const session = createDeskSession(createBrowserBackend(page));
  const reuse = createDiscoverableStepReuse({ session, getContext: () => ({ page: "browser-form" }) });
  try {
    const act = reuse.tools.find((tool) => tool.name === "act");
    const observe = reuse.tools.find((tool) => tool.name === "observe");
    assert.ok(act && observe);
    const first = await act.invoke(clickRequest("Show advanced"));
    assert.equal(first.status, "completed");
    assert.equal(await page.locator("#disclosure").getAttribute("aria-expanded"), "true");
    const listed = await observe.invoke({ reuseQuery: "advanced filters" });
    assert.equal(listed.reuseCandidates.length, 1);
    const replay = await act.invoke({ reuse: { ref: listed.reuseCandidates[0].ref } });
    assert.equal(replay.status, "completed");
    assert.equal(replay.steps[0].code, "already_satisfied");
    assert.equal(await page.locator("#disclosure").getAttribute("aria-expanded"), "true");
  } finally {
    await reuse.close();
    await context.close();
    await browser.close();
  }
});
