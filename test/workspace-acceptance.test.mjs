import assert from "node:assert/strict";
import test from "node:test";
import { runWorkspaceAgent } from "../examples/support/workspace-agent.mjs";
import { auditWorkspaceDelivery } from "../examples/support/workspace-audit.mjs";

test("a length-limited provider response never dispatches an incomplete proposal", async () => {
  let dispatched = false;
  const endpoint = { name: "act", description: "Act on the authorized app", inputSchema: { type: "object" },
    async invoke() { dispatched = true; } };
  const run = await runWorkspaceAgent({ tools: [endpoint], task: "Write a note", apiKey: "local-test-only",
    fetch: async () => Response.json({ choices: [{ index: 0, finish_reason: "length", message: { role: "assistant",
      content: null, tool_calls: [{ id: "cut", type: "function", function: { name: "act", arguments: '{"steps":[]}' } }] } }] }),
  });
  assert.equal(dispatched, false);
  assert.equal(run.status, "error");
  assert.equal(run.events.at(-1).error.code, "model_output_limit");
});

test("the delivery audit requires ordered model actions and actual editor receipts", () => {
  const events = [];
  function act(id, args, app, receipt) {
    events.push({ type: "tool.call", name: "act", toolCallId: id, arguments: args, seq: events.length + 1 });
    events.push({ type: "tool.result", name: "act", toolCallId: id, receipt: { applicationId: app, ...receipt }, seq: events.length + 1 });
  }
  act("n", { navigate: "https://museum.example/guide" }, "browser", { status: "completed" });
  act("e", { activate: "editor" }, "editor", { code: "activated", status: "completed" });
  const input = [{ kind: "type", text: "Research note", target: { name: "Body" } }, { kind: "hotkey", keys: ["Ctrl", "S"] }];
  act("a", { steps: input }, "editor", { status: "stopped", steps: [
    { kind: "type", index: 1, status: "dispatched" }, { kind: "hotkey", index: 2, status: "not_dispatched" },
  ] });
  const interrupted = auditWorkspaceDelivery(events);
  assert.equal(interrupted.writes.length, 1);
  assert.equal(interrupted.modelOperatedAcrossApps, false);
  act("s", { steps: [input[1]] }, "editor", { status: "completed", steps: [{ kind: "hotkey", index: 1, status: "dispatched" }] });
  assert.equal(auditWorkspaceDelivery(events).modelOperatedAcrossApps, true);
});
