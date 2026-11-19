import { createDeskSession } from "desklatch";

export function openDeskSession() {
  let value = "";
  const backend = {
    capabilities: [{ kind: "type", targets: ["selector", "ref"] }],
    async observe({ view }) {
      return { scope: "framework-fixture", complete: true,
        controls: [{ id: "private-editor", role: "Edit", name: "Title", states: ["visible", "enabled", "editable"], actions: ["type"], effect: "edit", value }],
        ...(view === "controls" ? {} : { image: { mimeType: "image/png", dataBase64: "AQID", width: 1, height: 1 } }) };
    },
    async dispatch({ step, target }) {
      if (target.id !== "private-editor" || step.kind !== "type") return { status: "refused" };
      value += step.text;
      return { status: "dispatched" };
    },
    async close() {},
  };
  return createDeskSession(backend, { allowModelImages: true });
}
