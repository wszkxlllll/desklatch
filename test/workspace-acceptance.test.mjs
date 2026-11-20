import assert from "node:assert/strict";
import test from "node:test";
import { runWorkspaceAgent } from "../examples/support/workspace-agent.mjs";
import { auditWorkspaceDelivery, verifySavedVisitNote } from "../examples/support/workspace-audit.mjs";
import { eastVisitGuide } from "../examples/support/museum-visit-oracle.mjs";

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

test("saved-file verification requires a single copy of the model's actual draft", async () => {
  const note = `东馆周二闭馆，开放日17:00停止入场。${eastVisitGuide}`;
  const events = [];
  function exchange(name, args, result) {
    const id = String(events.length);
    events.push({ seq: events.length + 1, type: "tool.call", name, toolCallId: id, arguments: args });
    events.push({ seq: events.length + 1, type: "tool.result", name, toolCallId: id, [name === "act" ? "receipt" : "observation"]: result });
  }
  exchange("act", { navigate: eastVisitGuide }, { status: "completed", applicationId: "browser" });
  exchange("observe", { read: "document" }, { applicationId: "browser", document: { sourceUrl: eastVisitGuide, chunks: [{ text: note }] } });
  exchange("act", { activate: "editor" }, { applicationId: "editor", status: "completed", code: "activated" });
  exchange("act", { steps: [{ kind: "type", text: note }, { kind: "hotkey", keys: ["ctrl", "s"] }] }, {
    applicationId: "editor", steps: [{ index: 1, kind: "type", status: "dispatched" }, { index: 2, kind: "hotkey", status: "dispatched" }] });
  const verify = text => verifySavedVisitNote(events, { baselineSha: "a", readSaved: async () => ({ text, sha256: "b" }) });
  assert.equal((await verify(note)).passed, true);
  assert.equal(await verify(note + note), undefined);
});
