import assert from "node:assert/strict";
import { test } from "node:test";

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createLangChainTools, prepareDeskChatCompletionsMessages } from "desklatch/langchain";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDeskMcpServer } from "desklatch/mcp";
import { createDeskTools } from "desklatch";
import { openDeskSession } from "./fixtures/framework-host.mjs";

const PIXELS = "AQID";

test("LangGraph ToolNode invokes only observe and act and keeps image bytes native", async t => {
  const session = openDeskSession(); t.after(() => session.close());
  const endpoints = createDeskTools(session);
  const tools = createLangChainTools(endpoints);
  assert.deepEqual(tools.map((tool) => tool.name), ["observe", "act"]);
  assert.equal(tools.some((tool) => tool.name === "approve" || tool.name === "resolve"), false);

  const node = new ToolNode(tools);
  const output = await node.invoke({
    messages: [
      new AIMessage({
        content: "",
        tool_calls: [{ name: "observe", args: { view: "both" }, id: "fixture-call", type: "tool_call" }],
      }),
    ],
  });
  const content = output.messages[0].content;
  assert.equal(Array.isArray(content), true);
  assert.equal(content.some((block) => block.type === "image" && block.data === PIXELS), true);
  const text = content.find((block) => block.type === "text")?.text ?? "";
  assert.equal(text.includes(PIXELS), false);
});

test("Chat Completions receives requested screen pixels once, after all tool replies, without changing graph history", async () => {
  const ask = new AIMessage({ content: "", tool_calls: [
    { name: "observe", args: { view: "both" }, id: "screen", type: "tool_call" },
    { name: "another", args: {}, id: "sibling", type: "tool_call" },
  ] });
  const observation = new ToolMessage({ name: "observe", tool_call_id: "screen", content: [
    { type: "text", text: '{"observationId":"one"}' }, { type: "image", mimeType: "image/png", data: PIXELS },
  ] });
  const sibling = new ToolMessage({ name: "another", tool_call_id: "sibling", content: "ok" });
  const history = [new HumanMessage("Use the displayed value"), ask, observation, sibling];
  const adapted = prepareDeskChatCompletionsMessages(history);
  assert.deepEqual(prepareDeskChatCompletionsMessages(adapted), adapted);
  assert.equal(observation.content[1].data, PIXELS);
  assert.equal(prepareDeskChatCompletionsMessages([observation])[0], observation);
  let sent;
  const model = new ChatOpenAI({ apiKey: "local-fixture", model: "glm-5.3-flash", maxRetries: 0,
    configuration: { fetch: async (_url, init) => {
      sent = JSON.parse(init.body).messages;
      return Response.json({ id: "local", object: "chat.completion", model: "fixture", created: 0,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
    } } });
  await model.invoke(adapted);
  assert.deepEqual(sent.map(message => message.role), ["user", "assistant", "tool", "tool", "user"]);
  assert.deepEqual(sent.slice(2, 4).map(message => message.tool_call_id), ["screen", "sibling"]);
  assert.equal(sent[2].content, '{"observationId":"one"}');
  assert.match(sent[4].content[0].text, /observe \(screen\)/);
  assert.deepEqual(sent[4].content[1], { type: "image_url", image_url: { url: `data:image/png;base64,${PIXELS}` } });
});

test("official MCP Client lists and calls the same endpoints over InMemoryTransport", async t => {
  const session = openDeskSession(); t.after(() => session.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createDeskMcpServer(createDeskTools(session));
  const client = new Client({ name: "desklatch-test-client", version: "0.1.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["observe", "act"]);
    const called = await client.callTool({ name: "observe", arguments: { view: "both" } });
    assert.deepEqual(called.content.map((block) => block.type), ["text", "image"]);
    assert.equal(called.content.some((block) => block.type === "image" && block.data === PIXELS), true);
    const text = called.content.find((block) => block.type === "text")?.text ?? "";
    assert.equal(text.includes(PIXELS), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("official MCP Client can call the stdio fixture without personal desktop access", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/bin/mcp.js", "test/fixtures/framework-host.mjs"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "desklatch-stdio-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["observe", "act"]);
    const edited = await client.callTool({ name: "act", arguments: { steps: [{
      kind: "type", target: { name: "Title" }, text: "MCP", expect: { target: { name: "Title" }, valueEquals: "MCP" },
    }] } });
    assert.equal(JSON.parse(edited.content[0].text).steps[0].status, "verified");
    const called = await client.callTool({ name: "observe", arguments: { view: "both" } });
    assert.equal(called.content.some((block) => block.type === "image" && block.data === PIXELS), true);
    assert.equal((called.content.find((block) => block.type === "text")?.text ?? "").includes(PIXELS), false);
  } finally {
    await client.close();
  }
});
