#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDeskMcpServer } from "../integrations/mcp.js";
import { resolveDeskToolHost } from "../integrations/shared.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** The command-line argument is a trusted operator-owned module, outside the model's tool surface. */
async function main() {
  if (process.argv.length !== 3) throw Error("usage: desklatch-mcp --demo | <trusted-host-module.mjs>");
  const input = process.argv[2];
  const opened = input === "--demo"
    ? await (await import("../demo.js")).createDemoDeskSession()
    : await openHost(input);
  const toolHost = resolveDeskToolHost(opened);
  let closed: Promise<void> | undefined;
  const close = () => (closed ??= Promise.resolve().then(() => toolHost.close()));
  try {
    const server = createDeskMcpServer(toolHost.tools);
    server.onclose = () => { void close().catch(() => { process.exitCode = 1; }); };
    const shutdown = () => { void server.close().finally(close).catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.stdin.once("end", shutdown);
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await close();
    throw error;
  }
}

async function openHost(input: string) {
  const host = await import(pathToFileURL(resolve(input)).href);
  if (typeof host.openDeskSession !== "function") throw Error("host must export openDeskSession()");
  return host.openDeskSession();
}

main().catch(() => {
  // stdout is reserved for MCP. Host exceptions may contain credentials or paths.
  if (process.argv.length !== 3) console.error("usage: desklatch-mcp --demo | <trusted-host-module.mjs>");
  else if (process.argv[2] === "--demo") console.error("DeskLatch demo could not start. Run desklatch-setup mcp to check Playwright and Chromium.");
  else console.error("DeskLatch MCP host could not start");
  process.exitCode = 1;
});
