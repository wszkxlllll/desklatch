import OpenAI from "openai";

const MODEL = "glm-5.3-flash";
const BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const MAX_HANDOFF_TEXT = 16_384;
const DATA_URL = /data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/u;
const BYTES_IN_JSON = /("(?:dataBase64|base64)"\s*:\s*")[^"]*(")/gu;
const LONG_IMAGE_DATA = /("data"\s*:\s*")[A-Za-z0-9+/=]{128,}(")/gu;
const APPROVAL_CODES = new Set(["approval_required", "approval_pending", "unresolved_approval"]);
const CORRECTION_CODES = new Set(["user_correction_required", "user_input_required", "needs_user_input"]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function clone(value, seen = new WeakMap()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  const output = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value)) output[key] = clone(item, seen);
  return output;
}

function scrub(value, apiKey) {
  let text = String(value ?? "");
  if (apiKey?.length >= 8) text = text.replaceAll(apiKey, "[credential]");
  return text.replace(DATA_URL, "[image omitted]")
    .replace(BYTES_IN_JSON, "$1[image omitted]$2")
    .replace(LONG_IMAGE_DATA, "$1[image omitted]$2")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}

/** Public trace/tool serialization: preserve source text and identifiers, omit pixels. */
function publicValue(value, apiKey, seen = new WeakSet(), parent) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return scrub(value, apiKey);
  if (typeof value === "undefined") return undefined;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object") return scrub(value, apiKey);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => publicValue(item, apiKey, seen, parent));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "dataBase64" || key === "base64" || (key === "data" && value.type === "image")) continue;
    if (key === "image" && isObject(item)) {
      output[key] = Object.fromEntries(["mimeType", "width", "height"].filter(k => item[k] !== undefined).map(k => [k, item[k]]));
      continue;
    }
    if (key === "image_url" && isObject(item)) {
      output[key] = { ...item, url: typeof item.url === "string" && DATA_URL.test(item.url) ? "[image omitted]" : item.url };
      continue;
    }
    const cleaned = publicValue(item, apiKey, seen, key);
    if (cleaned !== undefined) output[key] = cleaned;
  }
  return output;
}

function json(value, apiKey) {
  const cleaned = publicValue(value, apiKey);
  try { return JSON.stringify(cleaned); } catch { return scrub(cleaned, apiKey); }
}

function errorEvidence(error, apiKey, fallback = "tool_failed") {
  return {
    status: "error",
    code: typeof error?.code === "string" && error.code ? error.code : fallback,
    message: scrub(error?.message ?? error ?? fallback, apiKey).slice(0, 2_000),
  };
}

function schemaRef(schema, root) {
  if (!isObject(schema) || typeof schema.$ref !== "string") return schema;
  const prefix = "#/$defs/";
  return schema.$ref.startsWith(prefix) ? root?.$defs?.[schema.$ref.slice(prefix)] ?? schema : schema;
}

function schemaVariants(schema, root) {
  const current = schemaRef(schema, root);
  if (!isObject(current)) return [];
  const variants = [...(current.oneOf ?? []), ...(current.anyOf ?? [])];
  return variants.length ? variants.flatMap(item => schemaVariants(item, root)) : [current];
}

function schemaType(schema, root) {
  const types = new Set(schemaVariants(schema, root).map(item => schemaRef(item, root)?.type).filter(Boolean));
  return types.size === 1 ? types.values().next().value : undefined;
}

function childSchema(schema, key, root) {
  for (const variant of schemaVariants(schema, root)) {
    const current = schemaRef(variant, root);
    if (current?.properties?.[key]) return current.properties[key];
  }
  return undefined;
}

function itemSchema(schema, root) {
  return schemaVariants(schema, root).map(item => schemaRef(item, root)?.items).find(Boolean);
}

// Only decode JSON strings at schema positions that unambiguously require an object/array.
function normalize(value, schema, root, path, audit) {
  const expected = schemaType(schema, root);
  if (typeof value === "string" && (expected === "object" || expected === "array")) {
    try {
      const parsed = JSON.parse(value);
      if ((Array.isArray(parsed) ? "array" : isObject(parsed) ? "object" : typeof parsed) === expected) {
        audit.push({ path, expected, action: "parsed" });
        return normalize(parsed, schema, root, path, audit);
      }
      audit.push({ path, expected, action: "left_string", reason: "type_mismatch" });
    } catch { audit.push({ path, expected, action: "left_string", reason: "invalid_json" }); }
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, itemSchema(schema, root), root, `${path}[${index}]`, audit));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      childSchema(schema, key, root) ? normalize(item, childSchema(schema, key, root), root, `${path}.${key}`, audit) : clone(item),
    ]));
  }
  return value;
}

function parseArguments(raw, endpoint) {
  const audit = [];
  let original = raw;
  if (typeof raw === "string") {
    try { original = JSON.parse(raw); audit.push({ path: "$", expected: "object", action: "parsed" }); }
    catch { return { original: raw, error: { code: "invalid_tool_arguments", message: "tool arguments are not valid JSON" }, audit }; }
  }
  if (!isObject(original)) return { original, error: { code: "invalid_tool_arguments", message: "tool arguments must be an object" }, audit };
  return { original: clone(original), normalized: normalize(original, endpoint.inputSchema, endpoint.inputSchema, "$", audit), audit };
}

function imagesIn(messages) {
  let count = 0;
  for (const message of messages) for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type === "image_url" || block?.type === "input_image" || (block?.type === "image" && block.data)) count += 1;
  }
  return count;
}

function removeSentImages(message) {
  if (!Array.isArray(message?.content)) return;
  message.content = message.content.filter(block =>
    !(block?.type === "image_url" || block?.type === "input_image" || (block?.type === "image" && block.data)));
}

function observationImage(value) {
  const image = value?.image;
  return isObject(image) && typeof image.dataBase64 === "string" && image.dataBase64
    && typeof image.mimeType === "string" && image.mimeType ? image : undefined;
}

function approval(value) {
  return APPROVAL_CODES.has(value?.code) || value?.approvalRequired === true
    || value?.status === "pending_approval" || value?.status === "awaiting_approval";
}

function correction(value) {
  return CORRECTION_CODES.has(value?.code) || value?.handoffRequired === true;
}

function usageOf(response) {
  const usage = response.usage ?? {};
  const prompt = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? usage.completionTokens ?? 0) || 0;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: Number(usage.total_tokens ?? usage.totalTokens ?? prompt + completion) || 0 };
}

/**
 * Run a real GLM-5.3-Flash conversation over caller-supplied public
 * Workspace endpoints. The host never invents a target or a task step.
 */
export async function runWorkspaceAgent({
  tools,
  task,
  apiKey = process.env.ZHIPU_API_KEY,
  maxTurns = 24,
  maxTokens = 4_096,
  requestTimeoutMs = 120_000,
  signal,
  onEvent,
  instructions,
  initialMessages = [],
  onUserCorrection,
  verifyDelivery,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const invalid = !Array.isArray(tools) || !Array.isArray(initialMessages) || typeof task !== "string" || !task.trim() || !Number.isInteger(maxTurns) || maxTurns < 1
    || !Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 16_384
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 300_000
    || tools.some(tool => !isObject(tool) || !["observe", "act"].includes(tool.name) || typeof tool.description !== "string"
      || !isObject(tool.inputSchema) || typeof tool.invoke !== "function");
  if (invalid) return { status: "error", answer: "", events: [{ seq: 1, type: "run.error", error: { code: "invalid_options", message: "invalid Workspace agent options" } }], metrics: { model: MODEL, requests: 0 } };

  const byName = new Map(tools.map(tool => [tool.name, tool]));
  if (byName.size !== tools.length) return { status: "error", answer: "", events: [{ seq: 1, type: "run.error", error: { code: "duplicate_tool", message: "duplicate Workspace tool" } }], metrics: { model: MODEL, requests: 0 } };
  const events = [];
  const metrics = {
    model: MODEL, requests: 0, images: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    toolCalls: 0, dispatchedToolCalls: 0, toolErrors: 0, calls: [], observations: [], receipts: [], normalizations: [],
  };
  let seq = 0;
  const emit = async (type, detail = {}) => {
    const event = { seq: ++seq, type, at: new Date().toISOString(), ...publicValue(detail, apiKey) };
    events.push(event);
    try { await onEvent?.(event); } catch { metrics.eventErrors = (metrics.eventErrors ?? 0) + 1; }
  };
  const finish = async (status, answer = "", error) => {
    metrics.status = status;
    if (status === "completed") await emit("run.completed", { answer, tokenCounters: counters() });
    else if (status === "cancelled") await emit("run.cancelled", { answer, partial: metrics.requests > 0, tokenCounters: counters() });
    else if (status === "max_turns" || status === "stopped") await emit("run.stopped", { reason: metrics.stopCode, answer, partial: true, ...(error ? { error } : {}), tokenCounters: counters() });
    else await emit("run.error", { error: error ?? { code: "workspace_agent_failed", message: "agent failed" }, answer, partial: metrics.requests > 0, tokenCounters: counters() });
    return { status, answer, events, metrics };
  };
  const counters = () => ({ requests: metrics.requests, images: metrics.images, promptTokens: metrics.promptTokens, completionTokens: metrics.completionTokens, totalTokens: metrics.totalTokens, toolCalls: metrics.toolCalls, dispatchedToolCalls: metrics.dispatchedToolCalls, toolErrors: metrics.toolErrors });

  await emit("run.started", { model: MODEL, task, maxTurns, toolNames: tools.map(tool => tool.name), initialMessageCount: initialMessages.length });
  if (typeof apiKey !== "string" || !apiKey) return finish("error", "", { code: "zhipu_api_key_missing", message: "ZHIPU_API_KEY is required" });
  if (typeof fetchImpl !== "function") return finish("error", "", { code: "fetch_missing", message: "fetch is unavailable" });
  if (signal?.aborted) return finish("cancelled");

  const client = new OpenAI({ apiKey, baseURL: `${BASE_URL}/`, maxRetries: 0, fetch: fetchImpl });
  const messages = [
    { role: "system", content: typeof instructions === "string" && instructions.trim() ? instructions : "Use only the supplied Workspace tools and actual observations. Do not claim success without a receipt." },
    ...initialMessages.map(clone),
    { role: "user", content: task },
  ];
  const imageMessages = [];
  let correctionUsed = false;
  let answer = "";

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (signal?.aborted) return finish("cancelled", answer);
    for (const record of imageMessages) if (record.sent) removeSentImages(record.message);
    const imageCount = imagesIn(messages);
    metrics.requests += 1;
    metrics.images += imageCount;
    await emit("model.request", { turn, requestNumber: metrics.requests, model: MODEL, imageCount, tokenCounters: counters() });
    imageMessages.forEach(record => { record.sent = true; });

    let response;
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    try {
      const requestSignal = signal && AbortSignal.any ? AbortSignal.any([signal, timeoutSignal]) : signal ?? timeoutSignal;
      response = await client.chat.completions.create({
        model: MODEL,
        temperature: 0.1,
        reasoning_effort: "low",
        max_tokens: maxTokens,
        messages,
        tools: tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
        tool_choice: "auto",
      }, { signal: requestSignal });
    } catch (error) {
      const callerCancelled = signal?.aborted === true;
      const timedOut = timeoutSignal.aborted || error?.name === "TimeoutError";
      return finish(callerCancelled ? "cancelled" : "error", answer, { code: callerCancelled ? "cancelled" : timedOut ? "model_request_timeout" : error?.code ?? "model_request_failed", message: scrub(error?.message ?? error, apiKey) });
    }
    const used = usageOf(response);
    metrics.promptTokens += used.promptTokens; metrics.completionTokens += used.completionTokens; metrics.totalTokens += used.totalTokens;
    const finishReason = response.choices?.[0]?.finish_reason;
    const message = response.choices?.[0]?.message ?? {};
    const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call, index) => ({
      ...call,
      id: call?.id || `workspace-call-${turn}-${index + 1}`,
      function: call?.function ?? {},
    }));
    answer = scrub(typeof message.content === "string" ? message.content : "", apiKey);
    await emit("model.response", { turn, requestNumber: metrics.requests, finish: response.choices?.[0]?.finish_reason ?? "missing", text: answer, toolCallCount: calls.length, tokenUsage: used, tokenCounters: counters() });
    messages.push({ role: "assistant", content: message.content ?? "", ...(calls.length ? { tool_calls: calls } : {}) });
    // A truncated tool proposal may look like valid JSON while omitting later steps.
    if (finishReason === "length") return finish("error", answer, { code: "model_output_limit", message: `provider reached the ${maxTokens}-token output limit` });
    if (!calls.length) return answer.trim() ? finish("completed", answer) : finish("error", answer, { code: "empty_model_response", message: "model returned neither text nor a tool call" });

    let pendingApproval;
    let pendingCorrection;
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      const name = call?.function?.name ?? "";
      const endpoint = byName.get(name);
      const parsed = endpoint ? parseArguments(call?.function?.arguments, endpoint) : undefined;
      metrics.toolCalls += 1;
      await emit("tool.call", { turn, index, toolCallId: call?.id, name, arguments: parsed?.original ?? call?.function?.arguments, ...(parsed ? { normalizedArguments: parsed.normalized, normalization: parsed.audit } : {}) });
      if (parsed?.audit?.length) metrics.normalizations.push({ turn, index, name, audit: parsed.audit });
      if (!endpoint || parsed?.error) {
        metrics.toolErrors += 1;
        const evidence = parsed?.error ?? { code: "unknown_tool", message: `Tool is not public: ${name}` };
        await emit("tool.error", { turn, index, toolCallId: call?.id, name, dispatched: false, error: evidence });
        messages.push({ role: "tool", tool_call_id: call?.id ?? `workspace-call-${turn}-${index + 1}`, content: json(evidence, apiKey) });
        continue;
      }
      metrics.dispatchedToolCalls += 1; metrics.calls.push(name);
      let result;
      try { result = await endpoint.invoke(parsed.normalized, signal); }
      catch (error) { result = errorEvidence(error, apiKey); metrics.toolErrors += 1; await emit("tool.error", { turn, index, toolCallId: call?.id, name, dispatched: true, error: result, partial: true }); }
      const clean = publicValue(result, apiKey);
      const evidenceEvent = { turn, index, toolCallId: call?.id, name, [name === "observe" ? "observation" : "receipt"]: clean, tokenCounters: counters() };
      await emit("tool.result", evidenceEvent);
      if (name === "observe") metrics.observations.push(clean); else if (name === "act") metrics.receipts.push(clean);
      messages.push({ role: "tool", tool_call_id: call?.id ?? `workspace-call-${turn}-${index + 1}`, content: json(result, apiKey) });
      const image = name === "observe" ? observationImage(result) : undefined;
      if (image) {
        const attachment = { role: "user", content: [
          { type: "text", text: "The following user-authorized image is the pixels returned by the preceding observe call." },
          { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` } },
        ] };
        messages.push(attachment); imageMessages.push({ message: attachment, sent: false });
        await emit("image.queued", { turn, index, toolCallId: call?.id, mimeType: image.mimeType, width: image.width, height: image.height });
      }
      if (approval(result)) {
        pendingApproval = { code: result.code ?? "approval_required", requestId: result.requestId };
        for (const skipped of calls.slice(index + 1)) await emit("tool.skipped", { turn, toolCallId: skipped?.id, name: skipped?.function?.name, reason: "approval_pending", dispatched: false });
        break;
      }
      if (name === "act" && verifyDelivery && result?.steps?.some(step => step.status === "dispatched" || step.status === "verified")) {
        let evidence;
        try { evidence = await verifyDelivery({ events, signal }); }
        catch (error) { await emit("delivery.check_failed", { turn, message: scrub(error?.message ?? error, apiKey) }); }
        if (evidence && !signal?.aborted) {
          await emit("delivery.verified", { turn, toolCallId: call.id, evidence });
          for (const later of calls.slice(index + 1)) await emit("tool.skipped", { turn, toolCallId: later.id, name: later.function?.name, reason: "delivery_verified", dispatched: false });
          metrics.completionReason = "host_verified_artifact";
          return finish("completed", answer);
        }
      }
      if (correction(result) && !pendingCorrection) pendingCorrection = { name, result: clean, code: result.code };
    }
    if (pendingApproval) {
      metrics.stopCode = pendingApproval.code; if (pendingApproval.requestId) metrics.approvalRequestId = pendingApproval.requestId;
      return finish("stopped", answer);
    }
    if (pendingCorrection) {
      let correctionText;
      if (typeof onUserCorrection === "function" && !correctionUsed) {
        correctionUsed = true;
        try { correctionText = await onUserCorrection({ ...clone(pendingCorrection), signal }); } catch (error) { return finish("error", answer, errorEvidence(error, apiKey, "correction_failed")); }
      }
      if (typeof correctionText === "string" && correctionText.length <= MAX_HANDOFF_TEXT && correctionText.trim()) {
        messages.push({ role: "user", content: correctionText });
        await emit("correction.received", { turn, text: correctionText });
        continue;
      }
      metrics.stopCode = "user_correction_required";
      return finish("stopped", answer);
    }
    if (turn === maxTurns) { metrics.stopCode = "max_turns"; return finish("max_turns", answer); }
  }
  metrics.stopCode = "max_turns";
  return finish("max_turns", answer);
}
