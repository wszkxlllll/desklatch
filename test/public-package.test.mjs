import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createDeskTools } from "desklatch";
import { createOpenAIAgentsTools } from "desklatch/openai-agents";
import { RunContext } from "@openai/agents";
import { openDeskSession } from "./fixtures/framework-host.mjs";

test("installing a host does not require loading any framework, browser, CUA or model in the core", () => {
  const code = `
    import { registerHooks } from 'node:module';
    registerHooks({resolve(name, context, next) {
      if (/^(?:@langchain|@openai|@e2b|@trycua|@modelcontextprotocol|playwright-core|koffi|openai)(?:\\/|$)/.test(name)) {
        throw Error('unexpected core dependency ' + name);
      }
      return next(name, context);
    }});
    const core = await import('desklatch');
    if (typeof core.createDeskSession !== 'function' || typeof core.createDeskTools !== 'function') process.exit(1);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], { stdio: "pipe" });
});

test("Agents SDK function tools invoke the real executor and keep host controls private", async t => {
  const session = openDeskSession();
  t.after(() => session.close());
  const tools = createOpenAIAgentsTools(createDeskTools(session));
  assert.deepEqual(tools.map(x => x.name), ["observe", "act"]);
  const observe = await tools[0].invoke(new RunContext({}), '{"view":"image"}');
  assert.ok(Array.isArray(observe));
  assert.equal(observe.some(b => b.type === "text" && b.text.includes("AQID")), false);
  assert.ok(observe.some(b => b.type === "image"));
  const act = tools[1];
  const receipt = JSON.parse(await act.invoke(new RunContext({}), JSON.stringify({
    steps: [{ kind: "type", target: { name: "Title" }, text: "SDK", expect: { target: { name: "Title" }, valueEquals: "SDK" } }],
  })));
  assert.equal(receipt.steps[0].status, "verified");
  const refused = JSON.parse(await act.invoke(new RunContext({}), '{"approved":true,"steps":[]}'));
  assert.equal(refused.status, "rejected");
});
