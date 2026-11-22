import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeskSession, createDeskTools } from "desklatch";

function makeSession({ allowImages, allowDocumentText }) {
  const calls = [];
  const backend = {
    allowDocumentText: true,
    capabilities: [],
    async observe(options) {
      calls.push(options);
      return {
        scope: "document-image-scope",
        complete: true,
        controls: [],
        image: { mimeType: "image/png", dataBase64: "AQ==", width: 1, height: 1 },
        document: {
          kind: "page_text",
          chunks: [{ index: 0, text: "pathlib result" }],
          complete: true,
          truncated: false,
          viewportOnly: false,
          totalChars: 14,
          totalChunks: 1,
        },
      };
    },
    async dispatch() { return { status: "refused", code: "unused" }; },
    async close() {},
  };
  const session = createDeskSession(backend, { allowModelImages: allowImages, allowModelDocumentText: allowDocumentText });
  return { session, calls, observe: createDeskTools(session).find(tool => tool.name === "observe") };
}

test("combined document query and screenshot view delegates only with both grants", async () => {
  const allowed = makeSession({ allowImages: true, allowDocumentText: true });
  assert.ok(allowed.observe);
  const result = await allowed.observe.invoke({ view: "both", read: { query: "pathlib" } });
  assert.equal(result.view, "both");
  assert.deepEqual(allowed.calls.map(call => ({ view: call.view, read: call.read })), [{ view: "both", read: { query: "pathlib" } }]);
  await allowed.session.close();

  const noImage = makeSession({ allowImages: false, allowDocumentText: true });
  await assert.rejects(() => noImage.observe.invoke({ view: "both", read: { query: "pathlib" } }), /image_delivery_not_authorized/u);
  assert.equal(noImage.calls.length, 0);
  await noImage.session.close();

  const noDocument = makeSession({ allowImages: true, allowDocumentText: false });
  await assert.rejects(() => noDocument.observe.invoke({ view: "both", read: { query: "pathlib" } }), /document_delivery_not_authorized/u);
  assert.equal(noDocument.calls.length, 0);
  await noDocument.session.close();
});
