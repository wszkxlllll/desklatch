import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { Config as PiAiConfig, apply as applyPiAi } from "@deepseek-ai/dsh-llm-pi-ai";
import { LlmRuntime, createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as nativeExecutor from "@deepseek-ai/dsh-tool-executor-native";
import { ToolsService } from "@deepseek-ai/dsh-tools";

import { createDeskDshPlugin } from "desklatch/dsh";

/**
 * Compose the official DSH AgentLoop with an authorized DeskLatch host.
 *
 * `openSession` is host-owned and should return one already-authorized
 * DeskSession or Workspace. The caller supplies the credential reference via
 * `apiKeyEnv` (default: ZHIPU_API_KEY); this helper never reads or prints the
 * credential and never chooses a desktop target.
 */
export async function createDshAgentRuntime({
  openSession,
  sessionId = `desklatch-dsh-${Date.now()}`,
  provider = "zai",
  model = "glm-5.3-flash",
  apiKeyEnv = "ZHIPU_API_KEY",
  baseURL = "https://open.bigmodel.cn/api/paas/v4",
  maxTokens = 4096,
} = {}) {
  if (typeof openSession !== "function") throw new TypeError("openSession is required");
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be non-empty");
  if (typeof apiKeyEnv !== "string" || apiKeyEnv.length === 0) throw new TypeError("apiKeyEnv must be non-empty");

  const ctx = new Context();
  const fibers = [];
  let handle;
  let disposed = false;
  try {
    const mount = async (plugin, config) => {
      const fiber = ctx.plugin(plugin, config);
      await fiber.await();
      fibers.push(fiber);
    };
    await mount(SessionProjectionRegistry);
    await mount(SessionStore);
    await mount(SystemPrompt, { includeRuntimeContext: false });
    await mount(ToolsService);
    await mount(nativeExecutor);
    await mount(AgentRegistry);
    await mount(LlmRuntime);
    await mount({
      name: "llm-pi-ai",
      inject: ["llm"],
      apply(pluginCtx, config) { applyPiAi(pluginCtx, PiAiConfig(config)); },
    }, {
      providers: {
        [provider]: {
          apiKeyEnv,
          api: "openai-completions",
          baseURL,
          models: [{ id: model, name: model, contextWindow: 131072, maxTokens }],
        },
      },
    });
    await mount(AgentLoop);

    handle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider, model, maxTokens },
      setup: async (agentCtx) => {
        const plugin = agentCtx.plugin(createDeskDshPlugin(openSession));
        await plugin.await();
      },
    });

    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      await handle.dispose();
      for (const fiber of fibers.reverse()) await fiber.dispose();
      await ctx.fiber.dispose();
    };
    const followup = async (task) => {
      if (disposed) throw new Error("DSH Agent runtime is disposed");
      if (typeof task !== "string" || task.trim().length === 0) throw new TypeError("task must be non-empty");
      handle.agent.followup(createUserMessage({
        content: [{ type: "text", text: task }],
        source: { kind: "user" },
      }));
      await handle.agent.whenIdle();
    };
    return Object.freeze({ context: ctx, agent: handle.agent, followup, dispose });
  } catch (error) {
    if (handle) await handle.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await ctx.fiber.dispose();
    throw error;
  }
}
