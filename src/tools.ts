import type { Capability, Selector, View } from "./contracts.js";
import { actToolSchema } from "./request.js";

export interface ToolEndpoint {
  name: "observe" | "act";
  description: string;
  inputSchema: Record<string, unknown>;
  invoke(input: unknown): Promise<unknown>;
}

/** Optional fragment for an existing agent's own instructions. It does not select a tool on its behalf. */
export const desktopToolInstructions = [
  "If the user gives the field or control names and the intended changes, first submit those named steps together with act.",
  "DeskLatch performs its own live lookup inside act. An initial observe just to check whether a named field exists is redundant.",
  "Include a named target that appears after an earlier step in the same batch. Each step is resolved immediately before it runs.",
  "Use observe when you must discover a target, compare candidates, or obtain genuinely necessary visual information.",
  "Use actual receipts to decide how to continue. Stop on pending approval or uncertain delivery; the host owns consent.",
].join(" ");

/** The agent side receives these two capabilities only. Control-plane methods stay with the host. */
export interface DesktopToolSession {
  readonly capabilities: readonly Capability[];
  readonly allowModelImages: boolean;
  readonly limits?: { maxSteps?: number; maxTextLength?: number; maxScrollAmount?: number };
  observe(input: { view?: View; where?: Selector }): Promise<unknown>;
  act(input: unknown): Promise<unknown>;
}

const states = ["visible", "enabled", "editable", "focused", "checked", "selected"] as const;
const fields = ["role", "name", "within", "state"];
const record = (input: unknown): input is Record<string, unknown> =>
  !!input && typeof input === "object" && !Array.isArray(input);

function readObserveArgs(input: unknown, allowImages: boolean): { view: View; where?: Selector } {
  if (!record(input) || Object.keys(input).some(k => k !== "view" && k !== "where")) throw Error("invalid_observe");
  const view = input.view === undefined ? "controls" : input.view;
  if (view !== "controls" && view !== "image" && view !== "both") throw Error("invalid_view");
  if (!allowImages && view !== "controls") throw Error("image_delivery_not_authorized");
  if (input.where === undefined) return { view };
  const where = input.where;
  if (!record(where) || !Object.keys(where).length || Object.keys(where).some(k =>
    !fields.includes(k) || typeof where[k] !== "string" || !(where[k] as string).trim() || (where[k] as string).length > 1024)
    || (where.state !== undefined && !states.some(s => s === where.state))) throw Error("invalid_observe_filter");
  return { view, where: { ...where } };
}

export function createDeskTools(session: DesktopToolSession): ToolEndpoint[] {
  const allowImages = session.allowModelImages === true;
  const observe: ToolEndpoint = {
      name: "observe",
      description: "Discover unspecified controls or resolve ambiguity. Known names can go directly to act without calling this tool. Default to text controls. Request a picture only when new visual information is necessary and authorized.",
      inputSchema: {
        type: "object", additionalProperties: false, properties: {
          view: { type: "string", enum: allowImages ? ["controls", "image", "both"] : ["controls"], default: "controls" },
          where: { type: "object", additionalProperties: false, minProperties: 1, properties: {
            role: { type: "string" }, name: { type: "string" }, within: { type: "string" }, state: { type: "string", enum: [...states] },
          } },
        },
      },
      invoke: async input => session.observe(readObserveArgs(input, allowImages)),
    };
  if (session.capabilities.length === 0) return [observe];
  const examples = [];
  if (session.capabilities.some(c => c.kind === "type" && c.targets.includes("selector")))
    examples.push('{"kind":"type","target":{"name":"City"},"text":"Paris"}');
  if (session.capabilities.some(c => c.kind === "setValue" && c.targets.includes("selector")))
    examples.push('{"kind":"setValue","target":{"name":"Notes"},"value":"Revised"}');
  const parameters = examples.length ? ` Valid individual steps: ${examples.join(" or ")}.` : "";
  return [observe, {
      name: "act",
      description: "Use act first for known targets. Put successive actions together in the steps array. Only refs or pixels require observationId." + parameters
        + ' Each step uses only its own keys. Omit unused keys entirely. If checking a result, add "expect":{"target":{"name":"City"},"valueEquals":"Paris"} inside the action that produces it.',
      inputSchema: actToolSchema(session.capabilities, session.limits),
      invoke: async input => session.act(input),
    },
  ];
}
