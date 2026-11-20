import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createWorkspace } from "../dist/workspace.js";
import { createDiscoverableStepReuse, MemoryVerifiedStepReuseStore } from "../dist/reuse.js";
import { createLangChainTools } from "../dist/integrations/langchain.js";
import { createOpenAIAgentsTools } from "../dist/integrations/openai-agents.js";
import { createDeskMcpServer } from "../dist/integrations/mcp.js";

function makeWorkspace() {
  const state = { navigations: [], dispatches: [] };
  const session = {
    capabilities: [{ kind: "click", targets: ["selector"] }],
    allowModelImages: false,
    limits: { maxSteps: 4, maxTextLength: 1000, maxScrollAmount: 10 },
    async observe() {
      return { observationId: "fixture-observation", view: "controls", complete: true, controls: [] };
    },
    async act(input) {
      state.dispatches.push(input);
      return { status: "completed", steps: [] };
    },
    async resolveApproval(requestId) {
      return { requestId, status: "stopped", code: "approval_not_found", steps: [] };
    },
    correct() {},
    cancel() {},
    async close() {},
  };
  const workspace = createWorkspace({
    applications: [{
      id: "fixture-app",
      name: "Fixture app",
      session,
      async navigate({ url }) {
        state.navigations.push(url);
        return { status: "completed", code: "navigated" };
      },
    }],
    initialActive: "fixture-app",
  });
  return { workspace, state };
}

test("LangChain workspace tools invoke navigate and reject mixed workspace forms before dispatch", async () => {
  const { workspace, state } = makeWorkspace();
  try {
    const tools = createLangChainTools(workspace.tools);
    assert.deepEqual(tools.map((tool) => tool.name), ["observe", "act"]);
    const act = tools.find((tool) => tool.name === "act");
    const result = await act.invoke({ navigate: "https://workspace.test/one" });
    assert.match(JSON.stringify(result), /navigated/u);
    assert.deepEqual(state.navigations, ["https://workspace.test/one"]);
    await assert.rejects(act.invoke({ navigate: "https://workspace.test/two", activate: "fixture-app" }));
    assert.deepEqual(state.navigations, ["https://workspace.test/one"]);
  } finally {
    await workspace.close();
  }
});

test("LangChain keeps document query and continuation parameters when the editor is registered first", async () => {
  const reads = [];
  const session = (allowModelDocumentText) => ({
    capabilities: [], allowModelImages: false, allowModelDocumentText,
    limits: { maxSteps: 4, maxTextLength: 1_000, maxScrollAmount: 10 },
    async observe({ read } = {}) {
      reads.push(read);
      return { observationId: `fixture-${reads.length}`, view: "document", complete: true, controls: [] };
    },
    async act() { return { status: "rejected", steps: [] }; },
    correct() {},
    cancel() {},
    async close() {},
  });
  const workspace = createWorkspace({
    applications: [
      { id: "editor", name: "Editor", session: session(false) },
      { id: "browser", name: "Browser", session: session(true) },
    ],
    initialActive: "browser",
  });
  try {
    const tools = createLangChainTools(workspace.tools);
    assert.deepEqual(tools.map((tool) => tool.name), ["observe", "act"]);
    const observe = tools.find((tool) => tool.name === "observe");
    await observe.invoke({ read: { query: "opening hours" } });
    await observe.invoke({ read: { cursor: "document-page-two" } });
    await assert.rejects(() => observe.invoke({ read: { query: "new query", cursor: "wrong cursor" } }));
    assert.deepEqual(reads, [{ query: "opening hours" }, { cursor: "document-page-two" }]);
  } finally {
    await workspace.close();
  }
});

test("LangChain chooses an advertised verified replay through the two workspace tools", async () => {
  const target = { role: "textbox", name: "Search documentation" };
  const notes = { role: "textbox", name: "Scratch notes" };
  const writes = [];
  let controlsTruncated = false;
  let pageScope = "docs-search";
  const store = new MemoryVerifiedStepReuseStore();
  const session = {
    capabilities: [{ kind: "setValue", targets: ["selector"] }],
    allowModelImages: false,
    limits: { maxSteps: 4, maxTextLength: 1_000, maxScrollAmount: 10 },
    async observe() {
      const observedTargets = controlsTruncated ? [target] : [target, notes];
      const controls = observedTargets.map((item) => ({ ref: item.name, ...item, states: ["visible", "enabled", "editable"], actions: ["setValue"] }));
      return { observationId: "doc-search-screen", view: "controls", complete: !controlsTruncated, controls };
    },
    async act(input) {
      writes.push(...input.steps.map((step) => step.value));
      return { status: "completed", steps: input.steps.map((step, index) => ({ index: index + 1, kind: step.kind, status: "verified" })) };
    },
    correct() {},
    cancel() {},
    async close() {},
  };
  const stepReuse = createDiscoverableStepReuse({ session, store, getContext: () => ({ workspace: "test", page: pageScope }) });
  const workspace = createWorkspace({
    initialActive: "browser", applications: [{ id: "browser", name: "Browser", session, stepReuse }],
  });
  try {
    const tools = createLangChainTools(workspace.tools);
    assert.deepEqual(tools.map((tool) => tool.name), ["observe", "act"]);
    const [observe, act] = tools;
    const first = await act.invoke({ steps: [{ kind: "setValue", target, value: "pathlib", expect: { target, valueEquals: "pathlib" } }] });
    assert.equal(first.status, "completed");
    await act.invoke({ steps: [{ kind: "setValue", target: notes, value: "draft", expect: { target: notes, valueEquals: "draft" } }] });
    const available = await observe.invoke({ workspace: true, reuseQuery: "search documentation", where: { state: "visible" } });
    assert.equal(available.active, "browser");
    assert.deepEqual(available.applications.map((app) => app.id), ["browser"]);
    const [candidate] = available.reuseCandidates;
    assert.equal(candidate.actions[0].target.name, target.name);
    const next = await act.invoke({ reuse: { ref: candidate.ref, values: { [candidate.actions[0].parameter]: "datetime" } } });
    assert.equal(next.status, "completed");
    assert.deepEqual(writes, ["pathlib", "draft", "datetime"]);
    controlsTruncated = true;
    const truncated = await observe.invoke({ reuseQuery: "scratch notes" });
    const [unconfirmed] = truncated.reuseCandidates;
    assert.equal(unconfirmed.actions[0].target.name, notes.name);
    assert.equal(unconfirmed.available, false);
    const loadRecord = store.get.bind(store);
    store.get = (key) => {
      pageScope = "different-page";
      return loadRecord(key);
    };
    const changed = await act.invoke({ reuse: { ref: unconfirmed.ref, values: { [unconfirmed.actions[0].parameter]: "new notes" } } });
    assert.equal(changed.code, "context_mismatch");
    assert.deepEqual(writes, ["pathlib", "draft", "datetime"]);
  } finally {
    await workspace.close();
  }
});

test("OpenAI Agents workspace function tools use normal bound invocation and preserve mixed-form rejection", async () => {
  const { workspace, state } = makeWorkspace();
  try {
    const tools = createOpenAIAgentsTools(workspace.tools);
    assert.deepEqual(tools.map((tool) => tool.name), ["observe", "act"]);
    const act = tools.find((tool) => tool.name === "act");
    const signal = new AbortController().signal;
    const result = await act.invoke({}, JSON.stringify({ navigate: "https://workspace.test/agents" }), { signal });
    assert.match(result, /navigated/u);
    assert.deepEqual(state.navigations, ["https://workspace.test/agents"]);
    const rejected = await act.invoke({}, JSON.stringify({ navigate: "https://workspace.test/no", activate: "fixture-app" }), { signal });
    assert.match(rejected, /rejected/u);
    assert.deepEqual(state.navigations, ["https://workspace.test/agents"]);
  } finally {
    await workspace.close();
  }
});

test("MCP workspace tools list dynamic routes and execute navigate in process", async () => {
  const { workspace, state } = makeWorkspace();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createDeskMcpServer(workspace.tools);
  const client = new Client({ name: "workspace-framework-test", version: "0.1.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const actSchema = listed.tools.find((tool) => tool.name === "act")?.inputSchema;
    assert.equal(actSchema?.properties?.navigate?.type, "string");
    const result = await client.callTool({ name: "act", arguments: { navigate: "https://workspace.test/mcp" } });
    assert.match(result.content[0].text, /navigated/u);
    assert.deepEqual(state.navigations, ["https://workspace.test/mcp"]);
    const rejected = await client.callTool({ name: "act", arguments: { navigate: "https://workspace.test/no", activate: "fixture-app" } });
    assert.match(rejected.content[0].text, /rejected/u);
    assert.deepEqual(state.navigations, ["https://workspace.test/mcp"]);
  } finally {
    await client.close();
    await server.close();
    await workspace.close();
  }
});

test("stdio CLI accepts a workspace host and exposes only observe/act", async () => {
  const transport = new (await import("@modelcontextprotocol/sdk/client/stdio.js")).StdioClientTransport({
    command: process.execPath,
    args: ["dist/bin/mcp.js", "test/fixtures/workspace-host.mjs"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "workspace-stdio-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["observe", "act"]);
    const called = await client.callTool({ name: "act", arguments: { navigate: "https://workspace.test/stdio" } });
    assert.match(called.content[0].text, /navigated/u);
  } finally {
    await client.close();
  }
});
