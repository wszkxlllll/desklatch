import type { Context, Plugin } from "@deepseek-ai/cordis";
import { createMcpToolDefinition } from "@deepseek-ai/dsh-mcp-client";
import type { ToolExecution, ToolDefinition } from "@deepseek-ai/dsh-tools";

import type { ToolEndpoint } from "../tools.js";
import { errorText, resolveDeskToolHost, toDesktopContent, type DeskToolHost, type DeskToolSource } from "./shared.js";

export type DeskDshSession = DeskToolSource;

export type DeskDshOpenSession = (
  ctx: Context,
  signal: AbortSignal,
) => DeskDshSession | Promise<DeskDshSession>;

function makeDefinition(ctx: Context, endpoint: ToolEndpoint): ToolDefinition {
  return createMcpToolDefinition(ctx, {
    name: `desklatch_${endpoint.name}`,
    rawName: endpoint.name,
    description: endpoint.description,
    inputSchema: endpoint.inputSchema,
    call: async (args: Record<string, unknown>, execution: ToolExecution) => {
      try {
        return { content: toDesktopContent(await endpoint.invoke(args, execution.signal)) };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: errorText(error) }],
        };
      }
    },
  });
}

/**
 * Create a native Cordis plugin. Each mount obtains its own host-authorized
 * session and owns exactly the registrations and close hook created by it.
 * No model loop, MCP transport, child process, or approval endpoint is added.
 */
export function createDeskDshPlugin(openSession: DeskDshOpenSession) {
  return {
    name: "desklatch",
    inject: ["tools"],
    apply(ctx: Context) {
      const controller = new AbortController();
      let disposed = false;
      let session: DeskToolHost | undefined;
      let closed = false;
      const disposers: Array<() => void> = [];

      const closeOnce = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        const current = session;
        if (!current) return;
        session = undefined;
        await current.close();
      };

      const activation = Promise.resolve()
        .then(() => openSession(ctx, controller.signal))
        .then((opened) => {
          session = resolveDeskToolHost(opened);
          if (disposed || controller.signal.aborted) return closeOnce();
          for (const endpoint of session.tools) {
            if (disposed || controller.signal.aborted) break;
            disposers.push(ctx.tools.register(makeDefinition(ctx, endpoint)));
          }
        });

      // Register the asynchronous cleanup before returning activation. If the
      // fiber is disposed while openSession is pending, cleanup waits for the
      // late result, closes it once, and removes any partial registrations.
      const disposeEffect = ctx.effect(() => async () => {
        disposed = true;
        controller.abort("dsh_plugin_unmounted");
        await activation.catch(() => undefined);
        for (const dispose of disposers.splice(0).reverse()) dispose();
        await closeOnce();
      }, "desklatch session");

      return activation.then(() => disposeEffect);
    },
  } satisfies Plugin.Object<void>;
}
