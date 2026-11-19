#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDeskTools, type DesktopToolSession } from "../tools.js";
import { createDeskMcpServer } from "../integrations/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** The command-line argument is a trusted operator-owned module, outside the model's tool surface. */
async function main() {
  if (process.argv.length !== 3) throw Error("usage: desklatch-mcp <trusted-host-module.mjs>");
  const host = await import(pathToFileURL(resolve(process.argv[2])).href);
  if (typeof host.openDeskSession !== "function") throw Error("host must export openDeskSession()");
  const session: DesktopToolSession & { close(): Promise<void> } = await host.openDeskSession();
  let closed: Promise<void> | undefined;
  const close = () => (closed ??= Promise.resolve().then(() => session.close()));
  try {
    const server = createDeskMcpServer(createDeskTools(session));
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
main().catch(() => {
  // stdout is reserved for MCP. Host exceptions may contain credentials or paths.
  console.error(process.argv.length !== 3 ? "usage: desklatch-mcp <trusted-host-module.mjs>" : "DeskLatch MCP host could not start");
  process.exitCode = 1;
});
