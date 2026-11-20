import { dirname } from "node:path";
import type { Workspace } from "../workspace.js";
import { createWindowsProductHost, type WindowsProductHostOptions } from "./windows-host.js";
import { readE2BProductEnvironment, readWindowsProductRuntimeConfig } from "./runtime-config.js";

export { createWindowsProductHost };
export { readWindowsAuthorizationPath, windowsProductGrantsFile } from "./windows-grants.js";

type InstalledWindowsHost = Pick<Workspace, "tools" | "resolveApproval" | "cancel" | "close">;

/** Both packaged integrations open the same operator-configured runtime. */
export async function openInstalledWindowsHost(
  options: Pick<WindowsProductHostOptions, "authorizationFile" | "onApprovalRequested">,
): Promise<InstalledWindowsHost> {
  const config = await readWindowsProductRuntimeConfig(options.authorizationFile);
  const cloudSettings = config.e2b ? readE2BProductEnvironment(config.e2b.envFile) : undefined;
  const cloud = cloudSettings?.apiKey ? (await import("./e2b-workspace.js")).createE2BProductWorkspace({
    installationRoot: dirname(dirname(dirname(options.authorizationFile))),
    apiKey: cloudSettings.apiKey,
    browserAuthorizedOrigins: cloudSettings.browserAuthorizedOrigins,
    onApprovalRequested: options.onApprovalRequested,
  }) : undefined;
  try {
    const workspace = await createWindowsProductHost({
      ...options,
      ocr: config.ocr,
      extraApplications: cloud?.applications,
    });
    let closing: Promise<void> | undefined;
    return {
      tools: workspace.tools,
      resolveApproval: workspace.resolveApproval,
      cancel: workspace.cancel,
      close() {
        return closing ??= Promise.all([workspace.close(), cloud?.close()]).then(() => undefined);
      },
    };
  } catch (error) {
    await cloud?.close();
    throw error;
  }
}
