import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";

import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from "@deepseek-ai/dsh-attachment";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ToolExecution, ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";

import type { ApprovalDecision, ApprovalRequest } from "../core/session-types.js";
import type { ToolEndpoint } from "../tools.js";
import { errorText, resolveDeskToolHost, toDesktopContent, type DeskToolHost, type DeskToolSource } from "./shared.js";
import type { CodeModeOptions } from "../code-mode/index.js";

export type DeskDshSession = DeskToolSource;

export type DeskDshOpenSession = (
  ctx: Context,
  signal: AbortSignal,
) => DeskDshSession | Promise<DeskDshSession>;

export interface DeskDshApprovalBridge {
  /** Pass this callback to createDeskSession({ onApprovalRequested }). */
  readonly onApprovalRequested: (request: ApprovalRequest) => ApprovalDecision | void | Promise<ApprovalDecision | void>;
  /** Bind the actual DSH ToolExecution to the host approval resolver. */
  run<T>(execution: ToolExecution, host: DeskToolHost, invoke: () => Promise<T>): Promise<T>;
}

interface ApprovalBinding {
  readonly execution: ToolExecution;
  readonly host: DeskToolHost;
}

interface PendingBridgeApproval {
  readonly promise: Promise<unknown>;
  readonly resolve: (result: unknown) => void;
}

interface ApprovalResultLike {
  readonly requestId?: unknown;
  readonly code?: unknown;
}

function isApprovalRequired(value: unknown): value is ApprovalResultLike & { readonly requestId: string } {
  return typeof value === "object" && value !== null
    && (value as ApprovalResultLike).code === "approval_required"
    && typeof (value as ApprovalResultLike).requestId === "string";
}

function modelContent(value: unknown, name: string): ContentBlock[] {
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return [{ type: "text", text: `(${name} returned no model-visible content)` }];
  return content.map((block) => {
    if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image") {
      const mimeType = typeof (block as { mimeType?: unknown }).mimeType === "string"
        ? (block as { mimeType: string }).mimeType
        : "unknown media type";
      return { type: "text", text: `[image unavailable: ${mimeType}; this result was not admitted to durable model context]` };
    }
    return block as ContentBlock;
  });
}

interface PreparedImageProjection {
  readonly value: unknown;
  readonly fallback: ContentBlock[];
  readonly content: ContentBlock[];
}

const IMAGE_MEDIA_TYPES = new Set<ImageMediaType>(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function imageInput(value: unknown): SaveImageAttachment | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const block = value as { data?: unknown; mimeType?: unknown };
  if (typeof block.data !== "string" || typeof block.mimeType !== "string" || !IMAGE_MEDIA_TYPES.has(block.mimeType as ImageMediaType)) return undefined;
  if (!CANONICAL_BASE64.test(block.data)) return undefined;
  const data = Buffer.from(block.data, "base64");
  if (data.toString("base64") !== block.data) return undefined;
  return { data, mediaType: block.mimeType as ImageMediaType };
}

function hasImageContent(value: unknown): boolean {
  const content = (value as { content?: unknown }).content;
  return Array.isArray(content) && content.some((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image");
}

async function prepareImageProjection(ctx: Context, execution: ToolExecution, value: unknown, name: string): Promise<ContentBlock[]> {
  const content = (value as { content?: unknown }).content;
  const fallback = modelContent(value, name);
  if (!Array.isArray(content)) return fallback;
  const encoded: SaveImageAttachment[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image") {
      const image = imageInput(block);
      if (!image) return fallback;
      encoded.push(image);
    }
  }
  const attachments = ctx.get("attachments") as AttachmentStore | undefined;
  const llm = ctx.get("llm");
  const routed = execution.agent?.session.requestHeader()?.config;
  const provider = routed?.provider ?? execution.agent?.options.provider;
  const model = routed?.model ?? execution.agent?.options.model;
  if (!attachments || !llm || !provider || !model || execution.signal.aborted) return fallback;
  try {
    const info = await llm.resolveModelInfo(provider, model, execution.signal);
    if (info.inputModalities === undefined || !info.inputModalities.includes("image") || execution.signal.aborted) return fallback;
    const refs = await attachments.saveImages(encoded);
    let imageIndex = 0;
    return content.map((block) => {
      if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image") {
        return { type: "image", attachment: refs[imageIndex++] as ImageAttachmentRef };
      }
      return block as ContentBlock;
    });
  } catch {
    return fallback;
  }
}

function deniedApprovalResult(requestId: string): Record<string, unknown> {
  return { requestId, status: "stopped", code: "approval_unavailable", steps: [] };
}

/**
 * Some DSH model/tool adapters serialize the nested observe `read` object as
 * a JSON string before invoking the native tool.  Recover only that one
 * transport representation; the shared observe parser still performs the
 * strict query/cursor shape and length checks.  No act or authorization input
 * is coerced here.
 */
function normalizeDshObserveInput(endpointName: string, args: unknown): unknown {
  if (endpointName !== "observe" || typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const input = args as Record<string, unknown>;
  if (typeof input.read !== "string" || input.read === "document") return args;
  const encoded = input.read.trim();
  if (!encoded.startsWith("{") || !encoded.endsWith("}")) return args;
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ...input, read: parsed };
    }
  } catch {
    // Leave malformed transport input untouched so the strict parser rejects it.
  }
  return args;
}

function mergeApprovalReceipts(previous: unknown, next: unknown): unknown {
  if (typeof previous !== "object" || previous === null || !Array.isArray((previous as { steps?: unknown }).steps)) return next;
  if (typeof next !== "object" || next === null) return next;
  const receipts = new Map<number, unknown>();
  for (const source of [(previous as { steps: unknown[] }).steps, Array.isArray((next as { steps?: unknown }).steps) ? (next as { steps: unknown[] }).steps : []]) {
    for (const receipt of source) {
      if (typeof receipt !== "object" || receipt === null) continue;
      const index = (receipt as { index?: unknown }).index;
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 1) continue;
      const prior = receipts.get(index) as { status?: unknown } | undefined;
      if (prior && prior.status !== "not_dispatched" && (receipt as { status?: unknown }).status === "not_dispatched") continue;
      receipts.set(index, receipt);
    }
  }
  return { ...(next as Record<string, unknown>), steps: [...receipts.entries()].sort(([left], [right]) => left - right).map(([, receipt]) => receipt) };
}

function boundedApprovalSignal(parent: AbortSignal, expiresAt: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason ?? "cancelled");
  if (parent.aborted) onAbort();
  else parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort("approval_expired"), Math.max(0, expiresAt - Date.now()));
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return {
    signal: controller.signal,
    dispose() {
      parent.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    },
  };
}

/**
 * Bridge DeskLatch's host approval callback into DSH's native approval seam.
 * The callback itself never authorizes an action: it asks `ctx.approval`, then
 * resolves the original host request. Missing services, stale requests,
 * cancellation, expiry, and unavailable answerers fail closed.
 */
export function createDeskDshApprovalBridge(ctx: Context): DeskDshApprovalBridge {
  const active = new AsyncLocalStorage<ApprovalBinding>();
  const pending = new Map<string, PendingBridgeApproval>();

  const onApprovalRequested = (request: ApprovalRequest): ApprovalDecision | void | Promise<void> => {
    const binding = active.getStore();
    if (!binding || !binding.execution.agent || !binding.host.resolveApproval) return "deny";
    if (binding.execution.signal.aborted || request.expiresAt <= Date.now()) return "deny";
    const resolveApproval = binding.host.resolveApproval;

    let resolvePending!: (result: unknown) => void;
    const promise = new Promise<unknown>((resolve) => { resolvePending = resolve; });
    const record: PendingBridgeApproval = { promise, resolve: resolvePending };
    pending.set(request.requestId, record);
    const cleanupTimer = setTimeout(() => {
      if (pending.get(request.requestId) === record) pending.delete(request.requestId);
    }, Math.max(1_000, request.expiresAt - Date.now() + 1_000));
    if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) cleanupTimer.unref();

    void (async () => {
      let result: unknown = deniedApprovalResult(request.requestId);
      const bounded = boundedApprovalSignal(binding.execution.signal, request.expiresAt);
      try {
        const approval = ctx.get("approval") as ApprovalService | undefined;
        const reason = request.contextSummary ? `${request.summary}\n${request.contextSummary}` : request.summary;
        const outcome = approval === undefined ? "unavailable" : await approval.request({
          agent: binding.execution.agent as Agent,
          toolName: binding.execution.name,
          callId: binding.execution.callId,
          reason,
          displayReason: { en: reason },
          signal: bounded.signal,
        });
        const decision = outcome === "allowed-once" && !bounded.signal.aborted && request.expiresAt > Date.now()
          ? "approve" : "deny";
        try {
          result = await resolveApproval(request.requestId, decision);
        } catch {
          binding.host.cancel?.("dsh_approval_unavailable");
          result = deniedApprovalResult(request.requestId);
        }
      } catch {
        try {
          result = await resolveApproval(request.requestId, "deny");
        } catch {
          binding.host.cancel?.("dsh_approval_unavailable");
          result = deniedApprovalResult(request.requestId);
        }
      } finally {
        bounded.dispose();
        clearTimeout(cleanupTimer);
        record.resolve(result);
      }
    })();
    // The host resolver above owns the pending DeskLatch request. Returning
    // void prevents DeskSession from resolving the same request a second time.
    return promise.then(() => undefined);
  };

  const run = async <T>(execution: ToolExecution, host: DeskToolHost, invoke: () => Promise<T>): Promise<T> => {
    let result = await active.run({ execution, host }, invoke) as unknown as T;
    const settled = new Set<string>();
    while (isApprovalRequired(result)) {
      const requestId = result.requestId;
      if (settled.has(requestId)) return mergeApprovalReceipts(result, deniedApprovalResult(requestId)) as T;
      settled.add(requestId);
      const pendingApproval = pending.get(requestId);
      if (!pendingApproval) {
        if (!host.resolveApproval) return mergeApprovalReceipts(result, deniedApprovalResult(requestId)) as T;
        try {
          result = mergeApprovalReceipts(result, await host.resolveApproval(requestId, "deny")) as T;
        } catch {
          host.cancel?.("dsh_approval_unavailable");
          return mergeApprovalReceipts(result, deniedApprovalResult(requestId)) as T;
        }
        continue;
      }
      result = mergeApprovalReceipts(result, await pendingApproval.promise) as T;
      pending.delete(requestId);
    }
    return result;
  };

  return Object.freeze({ onApprovalRequested, run });
}

export interface DeskDshPluginOptions {
  /** Optional bridge created with createDeskDshApprovalBridge(ctx). */
  readonly approval?: DeskDshApprovalBridge;
  /** Trusted host opt-in. Programmatic act calls use the same DSH approval bridge. */
  readonly codeMode?: boolean | CodeModeOptions;
}

type DshCodeInvocation = (input: unknown, execution: ToolExecution) => Promise<unknown>;

function makeDefinition(ctx: Context, endpoint: ToolEndpoint, approval: DeskDshApprovalBridge | undefined, host: () => DeskToolHost | undefined, runCode?: DshCodeInvocation): ToolDefinition {
  const name = `desklatch_${endpoint.name}`;
  const projections = new WeakMap<ToolExecution, PreparedImageProjection>();
  return {
    name,
    get description() { return endpoint.description; },
    get parameters() { return endpoint.inputSchema; },
    output: {
      schema: {
        type: "object",
        properties: { content: { type: "array", items: {} } },
        required: ["content"],
        additionalProperties: false,
      },
      render(_args: unknown, value: unknown): ContentBlock[] {
        return modelContent(value, name);
      },
    },
    projectContent(exec, result) {
      const projection = projections.get(exec);
      if (projection === undefined) return undefined;
      projections.delete(exec);
      if (result.isError || !isDeepStrictEqual(result.value, projection.value) || !isDeepStrictEqual(result.content, projection.fallback)) return undefined;
      return projection.content;
    },
    execute: async (args: unknown, execution: ToolExecution) => {
      try {
        const normalized = normalizeDshObserveInput(endpoint.name, args);
        const input = typeof normalized === "object" && normalized !== null && !Array.isArray(normalized)
          ? normalized as Record<string, unknown>
          : {};
        const invoke = () => endpoint.name === "run_code" && runCode
          ? runCode(input, execution)
          : endpoint.invoke(input, execution.signal);
        const value = approval !== undefined && endpoint.name === "act"
          ? await approval.run(execution, host() as DeskToolHost, invoke)
          : await invoke();
        const result = { content: toDesktopContent(value) };
        if (hasImageContent(result)) {
          projections.set(execution, {
            value: result,
            fallback: modelContent(result, name),
            content: await prepareImageProjection(ctx, execution, result, name),
          });
        }
        return result;
      } catch (error) {
        throw new Error(errorText(error));
      }
    },
  };
}

/**
 * Create a native Cordis plugin. Each mount obtains its own host-authorized
 * session and owns exactly the registrations and close hook created by it.
 * No model loop, MCP transport, or approval model endpoint is added.
 * The optional approval bridge only connects an existing host callback to DSH's
 * native in-conversation approval seam.
 */
export function createDeskDshPlugin(openSession: DeskDshOpenSession, options: DeskDshPluginOptions = {}) {
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
        .then(async (opened) => {
          session = resolveDeskToolHost(opened);
          if (disposed || controller.signal.aborted) return closeOnce();
          let runCode: DshCodeInvocation | undefined;
          if (options.codeMode) {
            try {
              const { createDeskCodeMode } = await import("../code-mode/index.js");
              const enabled = createDeskCodeMode(session, options.codeMode === true ? undefined : options.codeMode);
              session = enabled;
              const approval = options.approval;
              runCode = (input, execution) => enabled.runCode(input, execution.signal, approval
                ? (invoke, signal) => approval.run({ ...execution, signal }, enabled, invoke)
                : undefined);
            } catch (error) {
              await closeOnce();
              throw error;
            }
          }
          if (disposed || controller.signal.aborted) return closeOnce();
          for (const endpoint of session.tools) {
            if (disposed || controller.signal.aborted) break;
            disposers.push(ctx.tools.register(makeDefinition(ctx, endpoint, options.approval, () => session, runCode)));
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
