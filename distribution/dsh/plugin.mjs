import { createDeskDshApprovalBridge, createDeskDshPlugin } from "desklatch/dsh";
import { createDemoDeskSession } from "desklatch/demo";

/**
 * Official Cordis entry for the portable DeskLatch bundle.
 *
 * The agent loop remains DSH-owned. Windows uses the host-owned native CUA
 * authorization; non-Windows environments retain the explicit browser demo
 * fallback for development and packaging probes.
 */
export default {
  name: "desklatch-dsh",
  inject: ["tools"],
  async apply(ctx) {
    const approval = createDeskDshApprovalBridge(ctx);
    const openSession = process.platform === "win32"
      ? async () => {
        const { openInstalledWindowsHost, readWindowsAuthorizationPath } = await import("desklatch/windows-product");
        return openInstalledWindowsHost({
          authorizationFile: await readWindowsAuthorizationPath(),
          onApprovalRequested: approval.onApprovalRequested,
        });
      }
      : () => createDemoDeskSession({ onApprovalRequested: approval.onApprovalRequested });
    await ctx.plugin(createDeskDshPlugin(openSession, { approval })).await();
  },
};
