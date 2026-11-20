import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalDecision, ApprovalRequest } from "../core/session-types.js";
import type { DeskToolHost } from "../integrations/shared.js";
import { openInstalledWindowsHost } from "./windows-product.js";

type ConfirmWindowsAction = (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;

function requiredApproval(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as { code?: unknown; requestId?: unknown };
  return result.code === "approval_required" && typeof result.requestId === "string" ? result.requestId : undefined;
}

/** The MCP process keeps the call open while the user decides in a local window. */
export async function createWindowsMcpHost(
  authorizationFile: string,
  confirm: ConfirmWindowsAction = confirmWindowsAction,
): Promise<DeskToolHost> {
  const pending = new Map<string, ApprovalRequest>();
  const workspace = await openInstalledWindowsHost({
    authorizationFile,
    onApprovalRequested(request) {
      for (const [id, earlier] of pending) if (earlier.expiresAt <= Date.now()) pending.delete(id);
      pending.set(request.requestId, request);
    },
  });
  return {
    tools: workspace.tools.map(endpoint => endpoint.name !== "act" ? endpoint : ({
      name: endpoint.name,
      get description() { return endpoint.description; },
      get inputSchema() { return endpoint.inputSchema; },
      async invoke(input, signal) {
        let result = await endpoint.invoke(input, signal);
        let requestId = requiredApproval(result);
        while (requestId !== undefined) {
          const request = pending.get(requestId);
          pending.delete(requestId);
          const decision = request && !signal?.aborted && request.expiresAt > Date.now()
            ? await confirm(request, signal).catch(() => "deny" as const)
            : "deny";
          result = await workspace.resolveApproval(requestId,
            request && request.expiresAt > Date.now() && !signal?.aborted ? decision : "deny");
          requestId = requiredApproval(result);
        }
        return result;
      },
    })),
    resolveApproval: workspace.resolveApproval,
    cancel: workspace.cancel,
    async close() { pending.clear(); await workspace.close(); },
  };
}

async function confirmWindowsAction(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
  const duration = request.expiresAt - Date.now();
  if (duration <= 0 || signal?.aborted) return "deny";
  const deadline = AbortSignal.timeout(duration);
  const promptSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = fileURLToPath(new URL("windows-approval.ps1", import.meta.url));
  const command = '& ([scriptblock]::Create([IO.File]::ReadAllText($env:DESKLATCH_APPROVAL_SCRIPT,[Text.Encoding]::UTF8)))';
  return new Promise(resolve => {
    const child = spawn(shell, ["-NoLogo", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      env: { ...process.env, DESKLATCH_APPROVAL_SCRIPT: script },
      windowsHide: true,
      signal: promptSignal,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let response = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { response = (response + chunk).slice(0, 32); });
    child.on("error", () => resolve("deny"));
    child.on("close", code => resolve(code === 0 && response.trim() === "approve" && !promptSignal.aborted ? "approve" : "deny"));
    child.stdin.on("error", () => resolve("deny"));
    child.stdin.end(JSON.stringify({ summary: request.summary, context: request.contextSummary ?? "" }), "utf8");
  });
}
