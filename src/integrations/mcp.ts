import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { ToolEndpoint } from "../tools.js";
import {
  errorText,
  imagePolicy,
  normalizeEndpoints,
  toDesktopContent,
  type IntegrationOptions,
} from "./shared.js";

export interface DeskMcpServerOptions extends IntegrationOptions {
  readonly name?: string;
  readonly version?: string;
  readonly instructions?: string;
}

function jsonSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)) return inputSchema;
  return { type: "object", properties: {} };
}

function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Build an official MCP v1 server around the provided DeskLatch endpoints.
 * A low-level `Server` is used so the endpoint-provided JSON Schema is
 * advertised unchanged; no Zod conversion can silently broaden or narrow the
 * host's authorization contract.
 */
export function createDeskMcpServer(
  endpoints: readonly ToolEndpoint[],
  options?: DeskMcpServerOptions,
): Server {
  const normalized = normalizeEndpoints(endpoints);
  const byName = new Map(normalized.map((endpoint) => [endpoint.name, endpoint]));
  const server = new Server(
    {
      name: options?.name ?? "desklatch",
      version: options?.version ?? "0.1.0",
    },
    {
      instructions: options?.instructions,
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: normalized.map((endpoint) => ({
      name: endpoint.name,
      description: endpoint.description,
      inputSchema: jsonSchema(endpoint.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
    const endpoint = byName.get(request.params.name as ToolEndpoint["name"]);
    if (!endpoint) return textResult(`Unknown DeskLatch tool: ${request.params.name}`, true);

    try {
      const input = request.params.arguments ?? {};
      return { content: toDesktopContent(await endpoint.invoke(input, context.signal), imagePolicy(options)) };
    } catch (error) {
      return textResult(errorText(error), true);
    }
  });

  return server;
}
