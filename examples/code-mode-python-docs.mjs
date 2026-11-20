import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright-core";
import { createDeskSession } from "desklatch";
import { createBrowserBackend, createWorkspaceNavigator } from "desklatch/browser";
import { createDeskCodeMode } from "desklatch/code-mode";
import { createWorkspace } from "desklatch/workspace";
import { chromiumPath } from "./support/fixture.mjs";

const origin = "https://docs.python.org";
const index = `${origin}/3/library/index.html`;
const expectedPage = `${origin}/3/library/pathlib.html`;
const topics = ["Pure paths", "Concrete paths"];

const code = `
  await desk.act({ navigate: ${JSON.stringify(index)} });
  const entry = await desk.observe({ where: { role: "link", name: "pathlib \u2014 Object-oriented filesystem paths" } });
  if (entry.controls.length !== 1) {
    inspect({ matchingLinks: entry.controls.length });
    return;
  }
  await desk.act({ observationId: entry.observationId, steps: [{
    kind: "click", target: { ref: entry.controls[0].ref },
    expect: { target: { role: "link", name: "PEP 428" }, state: "present" },
  }] });
  const found = [];
  let sourceUrl;
  for (const topic of ${JSON.stringify(topics)}) {
    const observation = await desk.observe({ read: { query: topic } });
    const document = observation.document;
    sourceUrl = document?.sourceUrl;
    if (document?.matchCount > 0) found.push(topic);
  }
  inspect({ sourceUrl, found });
`;

const executablePath = chromiumPath();
assert.ok(executablePath, "Set DESKLATCH_CHROMIUM to an installed Chromium executable");
const browser = await chromium.launch({ executablePath, headless: true });
let navigator;
let host;
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  assert.equal(page.url(), "about:blank");
  const authorizedOrigins = [origin];
  navigator = await createWorkspaceNavigator(page, { authorizedOrigins, timeoutMs: 15_000 });
  const backend = createBrowserBackend(page, { authorizedOrigins, allowBlank: true, allowDocumentText: true, searchLimit: 3000 });
  const session = createDeskSession(backend, { allowModelDocumentText: true, expectTimeoutMs: 6000 });
  host = createDeskCodeMode(createWorkspace({
    initialActive: "browser",
    applications: [{ id: "browser", name: "Browser", session, navigate: ({ url, signal }) => navigator.navigate(url, signal) }],
  }));

  const started = performance.now();
  const tool = host.tools.find(endpoint => endpoint.name === "run_code");
  const result = await tool.invoke({ code });
  const elapsedMs = Math.round(performance.now() - started);
  console.log(JSON.stringify({ elapsedMs, inspectBytes: Buffer.byteLength(JSON.stringify(result.inspections)), ...result }));

  assert.equal(result.status, "completed");
  assert.deepEqual(result.calls, { act: 2, observe: 3 });
  assert.deepEqual(result.inspections, [{ sourceUrl: expectedPage, found: topics }]);
  assert.equal(page.url(), expectedPage);
  for (const topic of topics) {
    assert.ok(await page.getByRole("heading", { name: topic, exact: false }).first().isVisible(), topic);
  }
} finally {
  try { await host?.close(); }
  finally {
    try { await navigator?.close(); } finally { await browser.close(); }
  }
}
