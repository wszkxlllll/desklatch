import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Agent, Runner, OpenAIChatCompletionsModel, setTracingDisabled } from "@openai/agents";
import OpenAI from "openai";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { createDeskSession, createDeskTools, desktopToolInstructions } from "desklatch";
import { createLangChainTools } from "desklatch/langchain";
import { createOpenAIAgentsTools } from "desklatch/openai-agents";
import { createFixture } from "./support/fixture.mjs";

// Only the explicitly requested, synthetic browser fixture is connected to this provider.
const key = process.env.ZHIPU_API_KEY || process.env.ZHIPUAI_API_KEY;
if (!key) throw Error("Set ZHIPU_API_KEY to run the optional live acceptance checks");
const modelName = "glm-5.3-flash";
const baseURL = "https://open.bigmodel.cn/api/paas/v4";
const mode = process.argv[2] ?? "all";
if (!["all", "zero", "visual", "langgraph"].includes(mode)) throw Error("Expected all, zero, visual, or langgraph");
setTracingDisabled(true);
// Disable LangSmith tracing even if this process inherited a developer's tracing environment.
process.env.LANGSMITH_TRACING = "false";
process.env.LANGCHAIN_TRACING_V2 = "false";

function auditFetch(metrics) {
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== new URL(baseURL).origin || !url.pathname.endsWith("/chat/completions")) throw Error("unexpected_model_endpoint");
    const body = JSON.parse(init.body);
    if (body.model !== modelName) throw Error("unexpected_model");
    if (metrics.requests >= 4) throw Error("provider_request_budget");
    metrics.requests++;
    for (const msg of body.messages) if (Array.isArray(msg.content)) {
      metrics.images += msg.content.filter(c => c.type === "image_url" || c.type === "input_image").length;
    }
    // Only synthetic fields are used here. Record structure and validation diagnostics, never pixels or field contents.
    const lastTool = body.messages.filter(m => m.role === "tool").at(-1);
    if (lastTool && typeof lastTool.content === "string" && lastTool.content.startsWith("Error")) {
      metrics.toolErrors.push(lastTool.content.replace(/data:[^ ]+/g, "[data]").slice(0, 240));
    }
    // Keep vendor-specific settings entirely outside the runtime.
    body.reasoning_effort = "low";
    const response = await fetch(url, { ...init, body: JSON.stringify(body), redirect: "error",
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000) });
    if (response.ok) {
      const result = await response.clone().json();
      metrics.tokens += result.usage?.total_tokens ?? 0;
      metrics.finishes.push(result.choices?.[0]?.finish_reason ?? "missing");
      metrics.completionTokens += result.usage?.completion_tokens ?? 0;
      for (const call of result.choices?.[0]?.message?.tool_calls ?? []) {
        let args;
        try { args = JSON.parse(call.function.arguments); } catch { args = {}; }
        metrics.proposed.push({ name: call.function.name, fields: Object.keys(args),
          steps: Array.isArray(args.steps) ? args.steps.map(s => [s.kind, s.target?.name ?? (s.target?.ref ? "ref" : undefined),
            Object.keys(s), s.expect ? Object.keys(s.expect) : undefined]) : undefined });
      }
    }
    return response;
  };
}

async function exercise(framework, visual = false) {
  const fixture = await createFixture({ allowImages: visual });
  const started = performance.now();
  const session = createDeskSession(fixture.backend, { allowModelImages: visual });
  const metrics = { requests: 0, images: 0, tokens: 0, completionTokens: 0, finishes: [], calls: [], receipts: [], proposed: [], toolErrors: [] };
  const instrumented = createDeskTools(session).map(endpoint => ({
    ...endpoint,
    async invoke(args) {
      metrics.calls.push(endpoint.name);
      const value = await endpoint.invoke(args);
      if (endpoint.name === "act") metrics.receipts.push({
        status: value.status, code: value.code, atStep: value.atStep, steps: value.steps.map(s => [s.kind, s.status, s.code]),
      });
      return value;
    },
  }));
  const values = { title: "Order-" + randomBytes(2).toString("hex"), notes: "复核完成" };
  // Only the host reads the oracle. It governs termination and never supplies an answer or a next action to the model.
  async function shouldEndAfterTools() {
    const outcome = metrics.receipts.at(-1)?.status;
    if (outcome === "stopped") return true;
    if (outcome !== "completed") return false;
    if (visual) return await fixture.page.locator("#fields").isVisible() && await fixture.page.locator("#keywords").inputValue() === fixture.marker;
    return await fixture.page.locator("#title").inputValue() === values.title && await fixture.page.locator("#notes").inputValue() === values.notes;
  }
  const instructions = desktopToolInstructions + " Operate only this authorized synthetic form. Do not send or submit. Stop once the requested changes are applied.";
  try {
    let userText = `Fill the empty Title field with "${values.title}" and the empty Notes field with "${values.notes}". Keep the form open.`;
    let imageUrl;
    if (visual) {
      const observed = await session.observe({ view: "image" });
      if (!observed.image) throw Error("host_image_unavailable");
      imageUrl = "data:" + observed.image.mimeType + ";base64," + observed.image.dataBase64;
      userText = "Read the six-digit Batch code from this picture. Use Show filters and put that exact code into the Keywords field that appears. Leave it open.";
    }
    if (framework === "openai-agents") {
      const client = new OpenAI({ apiKey: key, baseURL, fetch: auditFetch(metrics), maxRetries: 0 });
      const agent = new Agent({ name: "DeskLatch acceptance", instructions,
        model: new OpenAIChatCompletionsModel(client, modelName),
        modelSettings: { temperature: 0.1, maxTokens: 2048 },
        tools: createOpenAIAgentsTools(instrumented), toolUseBehavior: async () => await shouldEndAfterTools()
          ? { isFinalOutput: true, finalOutput: "Host verification finished." } : { isFinalOutput: false } });
      await new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false })
        .run(agent, userText, { maxTurns: 4 });
    } else {
      const tools = createLangChainTools(instrumented);
      const model = new ChatOpenAI({ model: modelName, apiKey: key, temperature: 0.1, maxTokens: 2048, maxRetries: 0,
        configuration: { baseURL, fetch: auditFetch(metrics) } }).bindTools(tools);
      const graph = new StateGraph(MessagesAnnotation)
        .addNode("model", async ({ messages }) => ({ messages: [await model.invoke(messages)] }))
        .addNode("tools", new ToolNode(tools))
        .addEdge(START, "model")
        .addConditionalEdges("model", ({ messages }) => messages.at(-1).tool_calls?.length ? "tools" : END)
        .addConditionalEdges("tools", async () => await shouldEndAfterTools() ? END : "model")
        .compile();
      const content = imageUrl ? [{ type: "text", text: userText }, { type: "image_url", image_url: { url: imageUrl } }] : userText;
      await graph.invoke({ messages: [new SystemMessage(instructions), new HumanMessage({ content })] }, { recursionLimit: 10 });
    }
    if (visual) {
      assert.equal(await fixture.page.locator("#keywords").inputValue(), fixture.marker);
      assert.ok(await fixture.page.locator("#fields").isVisible());
      assert.ok(metrics.images >= 1);
    } else {
      assert.equal(await fixture.page.locator("#title").inputValue(), values.title);
      assert.equal(await fixture.page.locator("#notes").inputValue(), values.notes);
      assert.equal(metrics.images, 0);
      assert.equal(fixture.stats.captures, 0);
    }
    assert.equal(await fixture.page.locator("#sends").innerText(), "0");
    assert.equal(metrics.receipts.at(-1)?.status, "completed");
    console.log(JSON.stringify({ framework, model: modelName, scenario: visual ? "one-image" : "zero-image",
      ...metrics, ...fixture.stats, elapsedMs: Math.round(performance.now() - started), independentlyVerified: true,
      singleModelCall: metrics.requests === 1 && metrics.calls.length === 1 && metrics.calls[0] === "act" }));
  } catch (error) {
    console.error(JSON.stringify({ framework, model: modelName, scenario: visual ? "one-image" : "zero-image",
      ...metrics, ...fixture.stats, independentlyVerified: false, errorType: error.name, providerCode: error.code,
      status: error.status, message: String(error.message).replaceAll(key, "[credential]").replace(/data:image[^\s]+/gi, "[image]").slice(0, 250) }));
    process.exitCode = 1;
  } finally {
    try { await session.close(); } finally { await fixture.close(); }
  }
}
if (mode === "all" || mode === "zero") await exercise("openai-agents");
if (mode === "all" || mode === "langgraph") await exercise("langgraph");
if (mode === "all" || mode === "visual") await exercise("langgraph", true);
