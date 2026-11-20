import { createLocalBrowserBackend } from "./backends/browser/local.js";
import type { DesktopBackend } from "./contracts.js";
import { createDeskSession, type ApprovalHandler, type DeskSession } from "./session.js";

const form = `<!doctype html><html lang="en"><meta charset="utf-8"><title>DeskLatch demo</title>
<main>
  <h1>DeskLatch demo form</h1>
  <p>Send message increments the local counter on this demo page.</p>
  <label>Title <input autocomplete="off"></label>
  <label>Notes <textarea></textarea></label>
  <button type="button" id="send">Send message</button>
  <output id="sends" aria-label="Simulated sends">0</output>
</main>
<script>
  const sends = document.getElementById("sends");
  document.getElementById("send").onclick = () => {
    sends.value = String(Number(sends.value) + 1);
  };
</script></html>`;

/** The install demo opens its isolated browser on the first observation or action. */
export function createDemoDeskSession(options: { onApprovalRequested?: ApprovalHandler } = {}): DeskSession {
  let browser: ReturnType<typeof createLocalBrowserBackend> | undefined;
  const open = () => browser ??= createLocalBrowserBackend({ content: form, includePublicValues: true }).catch(error => {
    browser = undefined;
    throw error;
  });
  const backend: DesktopBackend = {
    capabilities: [
      { kind: "click", targets: ["selector", "ref"], buttons: ["left"], counts: [1] },
      { kind: "type", targets: ["selector", "ref", "focus"] },
    ],
    async observe(input) { return (await open()).observe(input); },
    async dispatch(input) { return (await open()).dispatch(input); },
    async close() { await (await browser?.catch(() => undefined))?.close(); },
  };
  return createDeskSession(backend, options);
}
