import type { FunctionTool } from "@openai/agents";
import type { ToolEndpoint } from "../tools.js";
import { errorText, normalizeEndpoints, observationWithoutPixels } from "./shared.js";

/** Attach to an existing Agents SDK Agent. Model selection, tracing and the run loop belong to its host. */
export function createOpenAIAgentsTools(endpoints: readonly ToolEndpoint[]): FunctionTool[] {
  return normalizeEndpoints(endpoints).map(endpoint => {
    const schema = endpoint.inputSchema;
    if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object"
      || Array.isArray(schema.properties) || (schema.required !== undefined && !Array.isArray(schema.required))) {
      throw Error("invalid_agent_tool_schema");
    }
    return {
      type: "function", name: endpoint.name, description: endpoint.description,
      parameters: {
        ...schema, type: "object", properties: schema.properties,
        required: (schema.required ?? []) as string[], additionalProperties: false,
      },
      // Compound capability schemas are validated by DeskLatch on every invocation.
      strict: false, isEnabled: async () => true, needsApproval: async () => false,
      invoke: async (_context, input, details) => {
        let args: unknown;
        try { args = JSON.parse(input); }
        catch { return JSON.stringify({ status: "rejected", code: "invalid_json" }); }
        let output: unknown;
        try { output = await endpoint.invoke(args, details?.signal); }
        catch (error) { return JSON.stringify({ error: errorText(error) }); }
        const result = observationWithoutPixels(output);
        const text = JSON.stringify(result.value);
        if (!result.image) return text;
        return [
          { type: "text", text },
          { type: "image", image: { data: result.image.dataBase64, mediaType: result.image.mimeType } },
        ];
      },
    };
  });
}
