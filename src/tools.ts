import type { Capability, DocumentRead, Selector, View } from "./contracts.js";
import type { ObservationProjectionRequest } from "./core/session-types.js";
import { actToolSchema, describeActParameters } from "./request.js";

export interface ToolEndpoint {
  name: "observe" | "act" | "run_code";
  description: string;
  inputSchema: Record<string, unknown>;
  invoke(input: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** Optional fragment for an existing agent's own instructions. It does not select a tool on its behalf. */
export const desktopToolInstructions = [
  "When a task names an actionable control, use act with its exact selector if that action advertises selector targeting; otherwise observe with an exact where name or within filter, then use a ref from that latest reply. For keyboard actions, use the current focused control.",
  "Do not observe just to confirm a known target. Use a document query for a passage when the observe guide advertises one. When images are authorized, request image alone for layout before considering an unfiltered or role-only controls query; use both only when controls and pixels are both needed. Avoid broad control lists unless a narrower query cannot answer the task.",
  "Include a named target that appears after an earlier step in the same batch. Each step is resolved immediately before it runs.",
  "Use observe only when you must discover an unknown target, compare candidates, or obtain genuinely necessary visual information.",
  "When compact projection is advertised, scope controls with literal where. compact without since is a fresh bounded snapshot; full requests the detailed backward-compatible shape. For a same-query recheck, use since:\"previous\" with the same view, where, and maxControls when backendComplete:true; published rows may be clipped. Use an explicit observationId only for complete, untruncated controls. backendComplete:false means the backend control query was incomplete; projection.truncated separately marks compact-output clipping. Skip a recheck already verified by act. Comparisons cover that query only, so act uses current refs or a fresh exact selector.",
  "A control name identifies the control. Take a value to enter from the user or from the relevant observed source. A graphic's name alone does not describe its pixels.",
  "type inserts at the current caret or selection; setValue replaces the whole current value only when that capability is advertised. Verify fresh post-action state or a declared expect.",
  "Keyboard steps need the actual focused eligible ref. Prefer a validated earlier one-based focusFromStep in the same act batch when its focus handoff is usable; otherwise query the current focused control with where:{state:\"focused\"}.",
  "A dispatched receipt confirms delivery only; a verified step confirms only its declared expect, not full task completion. Independently verify the requested end state before answering.",
  "Use actual receipts to decide how to continue. Stop on pending approval or uncertain delivery. The host owns consent.",
  "On risk_evidence_required the step was not sent. Inspect the relevant controls or choose an explicit control with a discernible effect. If nothing new establishes the effect, leave the step unsent.",
  "When model images are enabled, choose a fresh image observation directly when layout or visible relationships matter. Point coordinates require an advertised point-click capability and the exact fresh observationId. If both capabilities are advertised, a confirmed grounding failure may also be recovered with a fresh image and newly matched point; never assume vision is available or reuse an older point after an unknown or partial result.",
].join(" ");

/** The agent side receives these two capabilities only. Control-plane methods stay with the host. */
export interface DesktopToolSession {
  readonly capabilities: readonly Capability[];
  readonly allowModelImages: boolean;
  readonly allowModelDocumentText?: boolean;
  readonly supportsObservationProjection?: true;
  /** The host may opt into automatic comparison of repeated broad observations. */
  readonly defaultObservationProjection?: "compact" | "incremental";
  readonly limits?: { maxSteps?: number; maxTextLength?: number; maxScrollAmount?: number };
  observe(input: { view?: View; where?: Selector; read?: DocumentRead; projection?: ObservationProjectionRequest; signal?: AbortSignal }): Promise<unknown>;
  act(input: unknown, signal?: AbortSignal): Promise<unknown>;
}

const states = ["visible", "enabled", "editable", "focused", "checked", "selected", "expanded"] as const;
const fields = ["role", "name", "within", "state"];
const record = (input: unknown): input is Record<string, unknown> =>
  !!input && typeof input === "object" && !Array.isArray(input);

function readObserveArgs(input: unknown, allowImages: boolean, allowDocumentText: boolean, supportsProjection: boolean): { view: View; where?: Selector; read?: DocumentRead; projection?: ObservationProjectionRequest } {
  if (!record(input) || Object.keys(input).some(k => k !== "view" && k !== "where" && k !== "read" && k !== "projection")) throw Error("invalid_observe");
  const hasView = input.view !== undefined;
  let view: View = input.view === undefined ? "controls" : input.view as View;
  if (view !== "controls" && view !== "image" && view !== "both" && view !== "document") throw Error("invalid_view");
  if (view === "document" && !allowDocumentText) throw Error("document_delivery_not_authorized");
  if (!allowImages && (view === "image" || view === "both")) throw Error("image_delivery_not_authorized");
  let read: DocumentRead | undefined;
  let searchRead = false;
  if (input.read !== undefined) {
    if (!allowDocumentText) throw Error("document_delivery_not_authorized");
    if (input.read === "document") {
      read = "document";
    } else {
      const requested = input.read;
      if (!record(requested) || Object.keys(requested).some((key) => !["kind", "query", "cursor", "maxChars", "maxChunks", "chunkSize", "viewportOnly"].includes(key))) {
        throw Error("invalid_document_read");
      }
      const query = requested.query;
      const cursor = requested.cursor;
      const maxChars = requested.maxChars;
      const maxChunks = requested.maxChunks;
      const chunkSize = requested.chunkSize;
      const viewportOnly = requested.viewportOnly;
      if ((query !== undefined && (!isNonBlank(query) || query.length > 256))
        || (cursor !== undefined && (!isNonBlank(cursor) || cursor.length > 512))
        || (query !== undefined && cursor !== undefined)
        || (query === undefined && cursor === undefined && requested.kind !== "document")
        || (requested.kind === "document" && (query !== undefined || cursor !== undefined))
        || (requested.kind !== undefined && requested.kind !== "document")
        || (maxChars !== undefined && (typeof maxChars !== "number" || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 64_000))
        || (maxChunks !== undefined && (typeof maxChunks !== "number" || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 256))
        || (chunkSize !== undefined && (typeof chunkSize !== "number" || !Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 4_096))
        || (viewportOnly !== undefined && typeof viewportOnly !== "boolean")) throw Error("invalid_document_read");
      read = { ...requested } as DocumentRead;
      searchRead = true;
    }
    if (!hasView) view = "document";
  }
  if (view === "document" && read === undefined) read = "document";
  // A combined view is the explicit way to request rendered text plus an
  // authorized screenshot. Image-only remains text-free so a document query
  // can never smuggle text into a pixels-only observation.
  if (searchRead && view === "image") throw Error("invalid_document_view");
  let projection: ObservationProjectionRequest | undefined;
  if (input.projection !== undefined) {
    if (!supportsProjection || !record(input.projection) || Object.keys(input.projection).some(key => !["mode", "maxControls", "since"].includes(key))) throw Error("observation_projection_unsupported");
    if (input.projection.mode === "full") {
      if (Object.keys(input.projection).length !== 1) throw Error("invalid_observation_projection");
      projection = { mode: "full" };
    } else if (input.projection.mode === "compact") {
      const maxControls = input.projection.maxControls;
      const since = input.projection.since;
      if (maxControls !== undefined && (typeof maxControls !== "number" || !Number.isSafeInteger(maxControls) || maxControls < 1 || maxControls > 4096)) throw Error("invalid_observation_projection");
      if (since !== undefined && (typeof since !== "string" || since.trim().length === 0 || since.length > 256)) throw Error("invalid_observation_projection");
      projection = { mode: "compact", ...(maxControls === undefined ? {} : { maxControls }), ...(since === undefined ? {} : { since }) };
    } else throw Error("invalid_observation_projection");
  }
  if (input.where === undefined) return { view, ...(read ? { read } : {}), ...(projection ? { projection } : {}) };
  const where = input.where;
  if (!record(where) || !Object.keys(where).length || Object.keys(where).some(k =>
    !fields.includes(k) || typeof where[k] !== "string" || !(where[k] as string).trim() || (where[k] as string).length > 1024)
    || (where.state !== undefined && !states.some(s => s === where.state))) throw Error("invalid_observe_filter");
  return { view, where: { ...where }, ...(read ? { read } : {}), ...(projection ? { projection } : {}) };
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function modelImageObservationGuidance(session: Pick<DesktopToolSession, "allowModelImages">): string {
  if (session.allowModelImages !== true) return "";
  return ' When layout or visible relationships matter, request {"view":"image"} before any unfiltered or role-only controls query; use {"view":"both"} only when controls and pixels are both needed.';
}

export function modelImagePointGuidance(session: Pick<DesktopToolSession, "allowModelImages" | "capabilities">): string {
  const pointClick = session.capabilities.some(capability => capability.kind === "click" && capability.targets.includes("point"));
  if (session.allowModelImages !== true || !pointClick) return "";
  return " If controls do not expose the target, use a screenshot of the authorized foreground window and a single left click or advertised line scroll. Use screenshot-native x/y (integer pixels) from one fresh image or both observation (the image's top-left pixel is origin (0,0)) with that reply's exact observationId. One valid point call is observe({\"view\":\"image\"}) -> {\"observationId\":\"obs-fresh\",\"image\":{\"width\":800,\"height\":600}}, then act({\"observationId\":\"obs-fresh\",\"steps\":[{\"kind\":\"click\",\"target\":{\"point\":{\"x\":420,\"y\":300}}}]}). target.point is an object, never [x,y]; never omit observationId or reuse coordinates from an older frame. Keep every sibling as its own flat {kind,target,...} step; do not use keyed forms such as {click:{...}}.";
}

export function observationProjectionGuidance(session: Pick<DesktopToolSession, "supportsObservationProjection" | "defaultObservationProjection" | "allowModelDocumentText">): string {
  if (session.supportsObservationProjection !== true) return "";
  const document = session.allowModelDocumentText === true ? " Use read.query for a specific document passage." : "";
  const incremental = session.defaultObservationProjection === "incremental"
    ? " Repeated broad controls/both views may also be compared automatically when compatible and economical."
    : "";
  return ` When broad discovery is necessary, explicitly request projection:{mode:"compact"}; unfiltered or role-only controls/both without a document read return at most six controls unless maxControls is explicit. Exact where filters stay scoped; full requests detailed output.${document} For same-query comparison, use since:"previous" with the same view, where, and maxControls when backendComplete:true; clipped published rows may be compared. Use observationId only for complete, untruncated controls. backendComplete:false means backend enumeration was incomplete; truncated marks compact-output clipping. Comparisons may return changed or unchanged rows for that query only. Narrow with exact name, within, or focused-state filters; skip act-verified rechecks and use current refs or exact selectors.${incremental}`;
}

export const receiptRecoveryGuidance = " Preflight schema, capability, or focus rejection means no step was dispatched; use atStep when present to correct only that step, keep sibling steps as separate valid objects, and retry the corrected request. After a stopped batch, keep dispatched/verified steps and correct or retry only a step confirmed not_dispatched. For a pending keyboard step, resolve current focus; never repeat an earlier delivered edit to recover focus. After unknown or partial delivery, reobserve the effect and do not replay that step. On confirmed grounding failure, reobserve and rematch the unsent target before retrying.";

/** Shared model-facing observe schema used by DeskTools and workspace wrappers. */
export function observeInputSchema(allowImages: boolean, allowDocumentText: boolean, supportsProjection = false): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      view: {
        type: "string",
        enum: [...(allowImages ? ["controls", "image", "both"] : ["controls"]), ...(allowDocumentText ? ["document"] : [])],
        default: "controls",
      },
      where: {
        type: "object", additionalProperties: false, minProperties: 1,
        properties: {
          role: { type: "string" }, name: { type: "string" }, within: { type: "string" }, state: { type: "string", enum: [...states] },
        },
      },
      ...(allowDocumentText ? {
        read: {
          oneOf: [
            { type: "string", enum: ["document"] },
            {
              type: "object", additionalProperties: false,
              properties: {
                kind: { const: "document" },
                query: { type: "string", minLength: 1, maxLength: 256 },
                cursor: { type: "string", minLength: 1, maxLength: 512 },
                maxChars: { type: "integer", minimum: 1, maximum: 64_000 },
                maxChunks: { type: "integer", minimum: 1, maximum: 256 },
                chunkSize: { type: "integer", minimum: 1, maximum: 4_096 },
                viewportOnly: { type: "boolean" },
              },
              oneOf: [
                { required: ["query"] },
                { required: ["cursor"] },
                { required: ["kind"] },
              ],
            },
          ],
        },
      } : {}),
      ...(supportsProjection ? {
        projection: {
          oneOf: [
            {
              type: "object", additionalProperties: false, required: ["mode"],
              properties: {
                mode: { const: "compact" },
                maxControls: { type: "integer", minimum: 1, maximum: 4096 },
                since: { type: "string", minLength: 1, maxLength: 256 },
              },
            },
            { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { const: "full" } } },
          ],
        },
      } : {}),
    },
  };
}

export function createDeskTools(session: DesktopToolSession): ToolEndpoint[] {
  const allowImages = session.allowModelImages === true;
  const allowDocumentText = session.allowModelDocumentText === true;
  const supportsProjection = session.supportsObservationProjection === true;
  const imageGuidance = modelImageObservationGuidance(session);
  const visualGuidance = modelImagePointGuidance(session);
  const visualObservationGuidance = visualGuidance
    ? " Use screenshot-native x/y from the exact observationId returned by a fresh image or both observation; never reuse coordinates from an older frame."
    : "";
  const projectionGuidance = observationProjectionGuidance(session);
  const observe: ToolEndpoint = {
      name: "observe",
      description: "Discover an unknown target or resolve ambiguity. A known actionable name goes directly to act with its exact selector when that action advertises selector targeting; otherwise use a literal exact where name or within filter and act with the current ref. Avoid unfiltered and role-only controls lists unless a narrower query cannot answer the task. The controls view lists actual names, roles and available public values."
        + (allowDocumentText ? " Use read.query for a passage instead of scanning controls." : "")
        + (allowImages ? imageGuidance : " This session permits text observations.")
        + visualObservationGuidance
        + projectionGuidance
        + (allowDocumentText ? ' To read rendered page text, call {"read":"document"}; use {"read":{"query":"keyword"}} for a literal query string (max 256 characters), or continue with the returned document.nextCursor. Results echo document.query, report document.matchCount, and expose document.chunks[].text. If a cursor is stale, start a fresh read.' : ""),
      inputSchema: observeInputSchema(allowImages, allowDocumentText, supportsProjection),
      invoke: async (input, signal) => session.observe({ ...readObserveArgs(input, allowImages, allowDocumentText, supportsProjection), signal }),
    };
  if (session.capabilities.length === 0) return [observe];
  const examples = [];
  if (session.capabilities.some(c => c.kind === "type" && c.targets.includes("selector")))
    examples.push('{"kind":"type","target":{"name":"City"},"text":"Paris"}');
  if (session.capabilities.some(c => c.kind === "setValue" && c.targets.includes("selector")))
    examples.push('{"kind":"setValue","target":{"name":"Notes"},"value":"Revised"}');
  const parameters = examples.length ? ` Valid individual steps: ${examples.join(" or ")}.` : "";
  const actionSchema = actToolSchema(session.capabilities, session.limits);
  const schemaGuide = describeActParameters(actionSchema);
  const semantics = [
    "A dispatched receipt confirms delivery only; verified confirms its declared expect, not full task completion.",
    "Keyboard steps need the actual focused eligible ref. Prefer an earlier one-based focusFromStep in this act when its validated focus handoff is usable; otherwise query the current focused control with where:{state:\"focused\"}.",
  ].join(" ");
  return [observe, {
      name: "act",
      description: "Use act first for known targets. Put successive actions together in the steps array. Refs, points, and drags require observationId from the relevant observation. On risk_evidence_required inspect or choose a clearer control before retrying; approval_required waits for the host." + receiptRecoveryGuidance + visualGuidance + parameters + (schemaGuide ? ` Exact action parameter guide: ${schemaGuide}.` : "") + ` ${semantics}`
        + ' Each step uses only its own keys. Omit unused keys entirely. If checking a result, add "expect":{"target":{"name":"City"},"valueEquals":"Paris"} inside the action that produces it.',
      inputSchema: actionSchema,
      invoke: async (input, signal) => session.act(input, signal),
    },
  ];
}
