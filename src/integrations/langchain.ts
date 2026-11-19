import { tool, type StructuredToolInterface } from "@langchain/core/tools";
export { prepareDeskChatCompletionsMessages } from "./langchain-images.js";

import type { ToolEndpoint } from "../tools.js";
import {
  errorText,
  imagePolicy,
  normalizeEndpoints,
  observationWithoutPixels,
  safeJson,
  type IntegrationOptions,
} from "./shared.js";

export interface LangChainToolOptions extends IntegrationOptions {
  /**
   * Set `returnDirect` for hosts that want LangChain to stop after this tool.
   * It defaults to false so a host remains in control of any model loop.
   */
  readonly returnDirect?: boolean;
}

/**
 * Convert a DeskLatch endpoint result to a LangChain tool result.
 *
 * A frame image becomes a native LangChain multimodal content block. Its
 * base64 payload is never included in the accompanying text block.
 */
export function toLangChainResult(value: unknown, options?: IntegrationOptions): unknown {
  const normalized = observationWithoutPixels(value);
  if (!normalized.image) return normalized.value;

  const blocks: Array<Record<string, unknown>> = [
    { type: "text", text: safeJson(normalized.value) },
  ];
  if (imagePolicy(options) === "native") {
    blocks.push({
      type: "image",
      data: normalized.image.dataBase64,
      mimeType: normalized.image.mimeType,
    });
  }
  return blocks;
}

/**
 * Adapt the two public DeskLatch endpoints (`observe` and `act`) to native
 * LangChain structured tools. The host owns the session and any model loop;
 * this factory only supplies tool definitions and invocation plumbing.
 */
export function createLangChainTools(
  endpoints: readonly ToolEndpoint[],
  options?: LangChainToolOptions,
): StructuredToolInterface[] {
  const normalized = normalizeEndpoints(endpoints);
  const makeTool = tool as unknown as (
    func: (input: unknown, config?: { signal?: AbortSignal }) => Promise<unknown>,
    fields: {
      name: string;
      description: string;
      schema: Record<string, unknown>;
      returnDirect?: boolean;
    },
  ) => StructuredToolInterface;

  return normalized.map((endpoint) =>
    makeTool(
      async (input, config) => {
        try { return toLangChainResult(await endpoint.invoke(input, config?.signal), options); }
        catch (error) { throw new Error(errorText(error)); }
      },
      {
        name: endpoint.name,
        description: endpoint.description,
        schema: endpoint.inputSchema,
        returnDirect: options?.returnDirect ?? false,
      },
    ),
  );
}
