import { createWorkspace } from "desklatch/workspace";

const state = { navigations: [] };
const session = {
  capabilities: [{ kind: "click", targets: ["selector"] }],
  allowModelImages: false,
  limits: { maxSteps: 4, maxTextLength: 1000, maxScrollAmount: 10 },
  async observe() {
    return { observationId: "workspace-stdio-observation", view: "controls", complete: true, controls: [] };
  },
  async act() {
    return { status: "completed", steps: [] };
  },
  async resolveApproval(requestId) {
    return { requestId, status: "stopped", code: "approval_not_found", steps: [] };
  },
  correct() {},
  cancel() {},
  async close() {},
};

export function openDeskSession() {
  return createWorkspace({
    applications: [{
      id: "workspace-stdio-app",
      name: "Workspace stdio fixture",
      session,
      async navigate({ url }) {
        state.navigations.push(url);
        return { status: "completed", code: "navigated" };
      },
    }],
    initialActive: "workspace-stdio-app",
  });
}
