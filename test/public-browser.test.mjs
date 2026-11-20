import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { createPublicBrowserWorkspace, isPublicAddress, PublicBrowserError } from "../dist/backends/browser/index.js";

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

test("public address vetting rejects private and special-use ranges", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "fc00::1", "fe80::1", "fec0::1", "2001:db8::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "2001:4860:4860::8888"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("public navigation never sends a private destination to a local server", { skip: nodeMajor < 20 || !chromium || !executablePath() }, async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("must not be reached");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  const workspace = await createPublicBrowserWorkspace({ executablePath: executablePath(), timeoutMs: 10_000 });
  try {
    await assert.rejects(
      workspace.navigate(`http://127.0.0.1:${address.port}/private`),
      (error) => error instanceof PublicBrowserError && error.code === "private_address",
    );
    await assert.rejects(
      workspace.navigate("file:///C:/Windows/win.ini"),
      (error) => error instanceof PublicBrowserError && error.code === "unsupported_scheme",
    );
    assert.equal(requests, 0);
  } finally {
    await workspace.close();
    await new Promise((resolve) => server.close(resolve));
  }
  t.diagnostic("loopback destination was denied before browser egress");
});
