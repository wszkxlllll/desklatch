import { createDeskSession } from "desklatch";
import { createFixture } from "../support/fixture.mjs";

// Use this with desklatch-mcp to try a private form. Supply a host-owned backend for a product deployment.
export async function openDeskSession() {
  const fixture = await createFixture();
  const session = createDeskSession(fixture.backend);
  return { ...session, close: async () => {
    try { await session.close(); } finally { await fixture.close(); }
  } };
}
