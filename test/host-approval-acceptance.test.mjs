import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDeskSession, createDeskTools } from "desklatch";
import { createDeskMcpServer } from "desklatch/mcp";
import { chromiumPath, createFixture } from "../examples/support/fixture.mjs";

test("a real browser batch handed off over MCP can be approved only by the host and is resumed once", {
  skip: chromiumPath() ? false : "installed Chromium required",
}, async () => {
  const fixture = await createFixture();
  const requests = [];
  const session = createDeskSession(fixture.backend, {
    onApprovalRequested(request) { requests.push(request); },
  });
  const client = new Client({ name: "host-approval-test", version: "1.0.0" });
  const server = createDeskMcpServer(createDeskTools(session));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ["observe", "act"]);

    const response = await client.callTool({ name: "act", arguments: { steps: [
      { kind: "type", target: { name: "Title" }, text: "Draft", expect: { target: { name: "Title" }, valueEquals: "Draft" } },
      { kind: "click", target: { name: "Send message" } },
    ] } });
    const stopped = JSON.parse(response.content[0].text);
    assert.equal(stopped.code, "approval_required");
    assert.equal(stopped.steps[0].status, "verified");
    assert.equal(requests.length, 1);
    assert.equal(stopped.requestId, requests[0].requestId);
    assert.equal(await fixture.page.locator("#title").inputValue(), "Draft");
    assert.equal(await fixture.page.locator("#sends").textContent(), "0");
    const forbidden = await client.callTool({ name: "resolveApproval", arguments: {
      requestId: stopped.requestId, decision: "approve",
    } });
    assert.equal(forbidden.isError, true);
    assert.equal(await fixture.page.locator("#sends").textContent(), "0");

    const approvals = await Promise.all([session.resolveApproval(stopped.requestId, "approve"),
      session.resolveApproval(stopped.requestId, "approve")]);
    assert.deepEqual(approvals[0], approvals[1]);
    assert.equal(approvals[0].status, "completed");
    assert.equal(await fixture.page.locator("#sends").textContent(), "1");
    assert.equal(fixture.stats.dispatches, 2);
    assert.equal(fixture.stats.captures, 0);
  } finally {
    await client.close();
    await server.close();
    await session.close();
    await fixture.close();
  }
});

test("the host sees a masked recipient and a changed addressee invalidates approval before dispatch", {
  skip: chromiumPath() ? false : "installed Chromium required",
}, async () => {
  const fixture = await createFixture();
  let consent;
  const session = createDeskSession(fixture.backend, { onApprovalRequested(request) { consent = request; } });
  try {
    await fixture.page.setContent(`<form action="/send" onsubmit="event.preventDefault();this.dataset.sent='yes'">
      <label>To <input type="email" name="recipient" value="alice@example.test"></label>
      <button type="submit">Send</button></form>`);
    const act = createDeskTools(session).find(tool => tool.name === "act");
    const paused = await act.invoke({ steps: [{ kind: "click", target: { name: "Send" } }] });
    assert.equal(paused.code, "approval_required");
    assert.match(consent.contextSummary, /a…@example\.test/);
    assert.equal(JSON.stringify(consent).includes("alice@"), false);
    assert.equal(JSON.stringify(paused).includes("example.test"), false);
    await fixture.page.locator('[name="recipient"]').fill("bob@example.test");
    const resolved = await session.resolveApproval(consent.requestId, "approve");
    assert.equal(resolved.status, "stopped");
    assert.equal(resolved.steps.at(-1).status, "not_dispatched");
    assert.equal(await fixture.page.locator("form").getAttribute("data-sent"), null);
    assert.equal(fixture.stats.dispatches, 0);
  } finally {
    await session.close();
    await fixture.close();
  }
});
