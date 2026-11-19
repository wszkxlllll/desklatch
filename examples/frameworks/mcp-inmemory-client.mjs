import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDeskTools } from "desklatch";
import { createDeskMcpServer } from "desklatch/mcp";
import { openDeskSession } from "./browser-host.mjs";

const session = await openDeskSession();
const server = createDeskMcpServer(createDeskTools(session));
const client = new Client({ name: "fixture-client", version: "1" });
try {
  const [consumer, host] = InMemoryTransport.createLinkedPair();
  await server.connect(host);
  await client.connect(consumer);
  const result = await client.callTool({ name: "act", arguments: {
    steps: [{ kind: "type", target: { name: "Notes" }, text: "Reviewed" }],
  } });
  console.log(result.content[0].text);
} finally {
  try { await client.close(); await server.close(); } finally { await session.close(); }
}
