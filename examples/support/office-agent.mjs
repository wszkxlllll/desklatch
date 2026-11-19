import assert from "node:assert/strict";
import OpenAI from "openai";

const DEFAULT_MODEL = "glm-5.3-flash";
const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const MAX_NOTE_LENGTH = 16_384;

/**
 * Project only the public, non-binding part of a DeskLatch observation for a
 * passive model planner. Refs, values, rectangles, and host-private context
 * never enter the provider request.
 */
export function publicOfficeControls(observation, allowedKinds = ["type", "setValue", "click"]) {
  const controls = (observation?.controls ?? []).filter((control) =>
    !control.sensitive && control.name && control.actions.some((kind) => allowedKinds.includes(kind)));
  return {
    complete: observation?.complete === true,
    controls: controls.map((control) => ({
      role: control.role,
      ...(control.name === undefined ? {} : { name: control.name }),
      states: control.states,
      actions: control.actions,
      ...(control.effect === undefined ? {} : { effect: control.effect }),
    })),
  };
}

function modelText(response) {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((block) => block?.text ?? "").join("").trim();
  return "";
}

function parsePlan(response) {
  const content = modelText(response).replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  if (!content) throw Error("office_agent_empty_model_plan");
  try { return JSON.parse(content); }
  catch { throw Error("office_agent_invalid_model_plan"); }
}

function planMessages({ controls, note, objective, allowedKinds }) {
  return [
    {
      role: "system",
      content: [
        "You are a passive planner for one host-owned Windows scratch window controlled by DeskLatch.",
        "Choose exactly one next native action using only the supplied public controls.",
        `Allowed action kinds: ${allowedKinds.join(", ")}. Never invent a control, ref, ID, coordinate, or success result.`,
        "The host will revalidate your named target and execute the action through DeskLatch; your response is only a proposal.",
        'Return {"kind":"type|setValue|click","targetName":"EXACT CONTROL NAME","targetRole":"EXACT ROLE"}. For a text action also set "input":"note" to use the supplied note verbatim. A click has no input.',
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `OBJECTIVE=${objective}`,
        `NOTE_TO_DELIVER=${note}`,
        `ALLOWED_KINDS=${JSON.stringify(allowedKinds)}`,
        `PUBLIC_CONTROLS=${JSON.stringify(controls)}`,
      ].join("\n"),
    },
  ];
}

function validatePlan(plan, observation, allowedKinds) {
  assert.ok(plan && typeof plan === "object" && !Array.isArray(plan), "office_agent_plan_not_object");
  const kind = plan.kind;
  const targetName = plan.targetName;
  const targetRole = plan.targetRole;
  assert.ok(typeof kind === "string" && allowedKinds.includes(kind), "office_agent_kind_not_allowed");
  assert.ok(typeof targetName === "string" && targetName.trim().length > 0 && targetName.length <= 512, "office_agent_target_name_invalid");
  assert.ok(typeof targetRole === "string" && targetRole.trim().length > 0 && targetRole.length <= 128, "office_agent_target_role_invalid");
  const matches = (observation?.controls ?? []).filter((control) => control.name === targetName && control.role === targetRole);
  assert.equal(matches.length, 1, `office_agent_target_not_unique:${targetRole}:${targetName}`);
  const target = matches[0];
  assert.ok(target.actions.includes(kind), "office_agent_target_action_missing");
  assert.equal(plan.input, kind === "click" ? undefined : "note", "office_agent_unexpected_input");
  return { kind, targetName, targetRole, ...(kind === "click" ? {} : { input: "note" }) };
}

/**
 * Make one bounded GLM choice and execute it through the supplied live
 * DeskLatch session. This helper never brings a window forward, resolves a
 * ref, or fabricates success; the caller owns the observation and native route.
 */
export async function chooseAndActWithGlm({
  session,
  observation,
  note,
  objective,
  allowedKinds = ["type"],
  apiKey = process.env.ZHIPU_API_KEY || process.env.ZHIPUAI_API_KEY,
  model = DEFAULT_MODEL,
  baseURL = DEFAULT_BASE_URL,
  fetch: fetchImpl = globalThis.fetch,
  metrics,
}) {
  if (!session || typeof session.observe !== "function" || typeof session.act !== "function") throw Error("office_agent_session_required");
  if (typeof note !== "string" || note.length === 0 || note.length > MAX_NOTE_LENGTH) throw Error("office_agent_note_invalid");
  if (typeof objective !== "string" || objective.trim().length === 0 || objective.length > 2_048) throw Error("office_agent_objective_invalid");
  if (!Array.isArray(allowedKinds) || allowedKinds.length === 0 || allowedKinds.some((kind) => !["type", "setValue", "click"].includes(kind))) throw Error("office_agent_allowed_kinds_invalid");
  if (typeof apiKey !== "string" || apiKey.length === 0) throw Error("office_agent_zhipu_key_missing");
  if (typeof fetchImpl !== "function") throw Error("office_agent_fetch_missing");

  const current = observation ?? await session.observe({ view: "controls" });
  const controls = publicOfficeControls(current, allowedKinds);
  if (controls.controls.length === 0 || controls.complete !== true) throw Error("office_agent_observation_incomplete");
  const stats = metrics ?? {};
  stats.providerRequests = 0;
  stats.images = 0;
  stats.modelCalls = stats.modelCalls ?? [];
  const auditedFetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== new URL(baseURL).origin || !url.pathname.endsWith("/chat/completions")) throw Error("office_agent_unexpected_model_endpoint");
    const body = JSON.parse(init.body);
    if (body.model !== model) throw Error("office_agent_unexpected_model");
    if (stats.providerRequests >= 1) throw Error("office_agent_model_budget");
    for (const message of body.messages ?? []) {
      const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
      for (const block of blocks) if (block?.type === "image_url" || block?.type === "input_image" || (block?.type === "image" && block.data)) {
        stats.images += 1;
        throw Error("office_agent_unexpected_image");
      }
    }
    stats.providerRequests += 1;
    const response = await fetchImpl(url, {
      ...init,
      body: JSON.stringify({ ...body, reasoning_effort: "low" }),
      redirect: "error",
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
    });
    const usage = await response.clone().json().then((value) => value.usage ?? {}).catch(() => ({}));
    stats.promptTokens = (stats.promptTokens ?? 0) + (usage.prompt_tokens ?? 0);
    stats.completionTokens = (stats.completionTokens ?? 0) + (usage.completion_tokens ?? 0);
    stats.totalTokens = (stats.totalTokens ?? 0) + (usage.total_tokens ?? 0);
    return response;
  };
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0, fetch: auditedFetch });
  const started = performance.now();
  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 512,
    response_format: { type: "json_object" },
    messages: planMessages({ controls, note, objective, allowedKinds }),
  });
  stats.modelCalls.push({
    elapsedMs: Math.round(performance.now() - started),
    finish: response.choices?.[0]?.finish_reason ?? "missing",
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    totalTokens: response.usage?.total_tokens ?? 0,
  });
  const plan = validatePlan(parsePlan(response), current, allowedKinds);
  const step = {
    kind: plan.kind,
    target: { name: plan.targetName, role: plan.targetRole },
    ...(plan.kind === "type" ? { text: note } : plan.kind === "setValue" ? { value: note } : {}),
  };
  const result = await session.act({
    observationId: current.observationId,
    steps: [step],
  });
  stats.nativeActCalls = (stats.nativeActCalls ?? 0) + 1;
  stats.nativeReceipts = result.steps;
  return { observation: current, controls, plan, step, result, metrics: stats };
}
