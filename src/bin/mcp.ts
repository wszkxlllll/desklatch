#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDeskMcpServer } from "../integrations/mcp.js";
import { resolveDeskToolHost } from "../integrations/shared.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const args = process.argv.slice(2);
const codeFlag = args[0] === "--code-mode";
if (codeFlag) args.shift();
const usage = "usage: desklatch-mcp [--code-mode] (--windows <authorization-file> | --demo | <trusted-host-module.mjs>)";

/** The command-line argument is a trusted operator-owned module, outside the model's tool surface. */
async function main() {
  const [input, authorizationFile, extra] = args;
  const windows = input === "--windows";
  if (!input || extra !== undefined || (windows ? !authorizationFile || !isAbsolute(authorizationFile) : authorizationFile !== undefined)) {
    throw Error(usage);
  }
  const opened = windows
    ? await (await import("../product/windows-mcp.js")).createWindowsMcpHost(authorizationFile!)
    : input === "--demo"
    ? await (await import("../demo.js")).createDemoDeskSession()
    : await openHost(input);
  const baseHost = resolveDeskToolHost(opened);
  let toolHost = baseHost;
  if (codeFlag || process.env.DESKLATCH_CODE_MODE === "1") {
    try {
      const { createDeskCodeMode } = await import("../code-mode/index.js");
      toolHost = createDeskCodeMode(baseHost);
    } catch (error) {
      await baseHost.close();
      throw error;
    }
  }
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
  if (args[0] === "--windows") console.error("DeskLatch could not start the Windows desktop host. Check installation and application authorization.");
  else if (args.length !== 1) console.error(usage);
  else if (args[0] === "--demo") console.error("DeskLatch demo could not start. Run desklatch-setup mcp to check Playwright and Chromium.");
  else console.error("DeskLatch MCP host could not start");
  process.exitCode = 1;
});
