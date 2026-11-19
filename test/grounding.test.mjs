import assert from "node:assert/strict";
import test from "node:test";

import { matchControl } from "../dist/grounding.js";

const button = (overrides = {}) => ({
  id: "button-1",
  role: "Button",
  name: "OK",
  within: "dialog",
  states: ["visible", "enabled"],
  actions: ["click"],
  ...overrides,
});

test("matches normalized roles, names, labels, scope and state", () => {
  const control = button({ name: undefined, labels: ["  Fullwidth  "], state: undefined });
  const frame = { scope: "session-1", complete: true, controls: [control] };
  assert.equal(matchControl(frame, { role: "button", name: "Ｆｕｌｌｗｉｄｔｈ", within: "dialog", state: "enabled" }, { kind: "click" }).control, control);
});

test("refuses incomplete frames, conflicts and ambiguous candidates", () => {
  assert.equal(matchControl({ scope: "s", complete: false, controls: [] }, { name: "OK" }).code, "frame_incomplete");
  assert.equal(matchControl({ scope: "", complete: true, controls: [] }, { name: "OK" }).code, "frame_unauthorized");

  const first = button({ id: "one", name: "One" });
  const second = button({ id: "two", name: "Two" });
  const frame = { scope: "s", complete: true, controls: [first, second] };
  assert.equal(matchControl(frame, { role: "Button", name: "Other" }).code, "selector_conflict");
  assert.equal(matchControl(frame, { role: "Button" }).code, "ambiguous");
  assert.equal(matchControl(frame, { name: "Missing" }).code, "no_match");
});

test("only permits the scoped low-risk search alias", () => {
  const query = button({ id: "query", name: "\u67e5\u8be2", within: "form", filterAction: true, effect: "read" });
  const frame = { scope: "s", complete: true, controls: [query] };
  assert.equal(matchControl(frame, { role: "button", name: "\u641c\u7d22", within: "form" }, { kind: "click", aliases: true }).control, query);
  assert.equal(matchControl(frame, { name: "\u641c\u7d22" }, { kind: "click", aliases: true }).code, "alias_scope_required");
  assert.equal(matchControl(frame, { name: "\u641c\u7d22", within: "form" }, { kind: "click" }).code, "no_match");

  const unsafe = button({ id: "unsafe", name: "\u67e5\u8be2", within: "form", filterAction: true, effect: "external" });
  assert.equal(matchControl({ scope: "s", complete: true, controls: [unsafe] }, { name: "\u641c\u7d22", within: "form" }, { kind: "click", aliases: true }).code, "alias_unsafe");
});
