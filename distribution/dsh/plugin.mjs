import { createDeskDshApprovalBridge, createDeskDshPlugin } from "desklatch/dsh";
import { createDemoDeskSession } from "desklatch/demo";

/**
 * Official Cordis entry for the portable DeskLatch demo bundle.
 *
 * The agent loop remains DSH-owned. This module only binds the host-owned
 * demo session and bridges DSH's approval service into DeskLatch's callback.
 */
export default {
  name: "desklatch-dsh",
  inject: ["tools"],
  apply(ctx) {
    const approval = createDeskDshApprovalBridge(ctx);
    return ctx.plugin(createDeskDshPlugin(
      () => createDemoDeskSession({ onApprovalRequested: approval.onApprovalRequested }),
      { approval },
    ));
  },
};
