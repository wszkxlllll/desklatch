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
  observationWithoutPixels,
  safeJson,
  type ImagePolicy,
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
 * Convert an endpoint result to an MCP CallToolResult. Frame images use MCP's
 * native image content block; the text block contains only non-pixel metadata.
 */
function toMcpResult(value: unknown, policy: ImagePolicy = "native"): CallToolResult {
  const normalized = observationWithoutPixels(value);
  if (!normalized.image) return textResult(safeJson(normalized.value));

  const content: CallToolResult["content"] = [
    { type: "text", text: safeJson(normalized.value) },
  ];
  if (policy === "native") {
    content.push({
      type: "image",
      data: normalized.image.dataBase64,
      mimeType: normalized.image.mimeType,
    });
  }
  return { content };
}

/**
 * Build an official MCP v1 server around the two public DeskLatch endpoints.
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const endpoint = byName.get(request.params.name as ToolEndpoint["name"]);
    if (!endpoint) return textResult(`Unknown DeskLatch tool: ${request.params.name}`, true);

    try {
      const input = request.params.arguments ?? {};
      return toMcpResult(await endpoint.invoke(input), imagePolicy(options));
    } catch (error) {
      return textResult(errorText(error), true);
    }
  });

  return server;
}
