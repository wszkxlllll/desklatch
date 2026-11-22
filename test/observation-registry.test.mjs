import assert from "node:assert/strict";
import test from "node:test";

import { ObservationRegistry } from "../dist/core/observation-registry.js";

function frame(values, scope = "window-a", options = {}) {
  return {
    scope,
    complete: true,
    controls: values.map((value, index) => ({
      id: options.ids?.[index] ?? `${scope}-control-${index}`,
      role: "DataItem",
      name: options.names?.[index] ?? `Cell ${index}`,
      ...(options.windowScopes?.[index] ? { windowScope: options.windowScopes[index] } : {}),
      states: ["visible", "enabled", ...(index === 0 ? ["focused", "editable"] : [])],
      actions: ["click", "type"],
      value,
      labels: ["stable-label", options.labels?.[index] ?? `label-${index}`, "extra-a", "extra-b"],
    })),
  };
}

function registry() {
  return new ObservationRegistry({
    allowModelImages: false,
    allowModelDocumentText: false,
    grantedAction: () => true,
    refsGranted: true,
    maxPublicControls: 64,
  });
}

test("compact observations prioritize values and publish bounded opaque snapshot keys", () => {
  const subject = registry();
  const stored = subject.remember(frame(Array.from({ length: 64 }, (_item, index) => index === 0 ? "focused" : "")), true);
  const compact = subject.publicObservation(stored, "controls", { mode: "compact", maxControls: 4 }, "excel-controls");
  assert.equal(compact.controls.length, 4);
  assert.equal(compact.projection.mode, "compact");
  assert.equal(compact.projection.kind, "snapshot");
  assert.equal(compact.projection.observedControls, 64);
  assert.equal(compact.projection.returnedControls, 4);
  assert.equal(compact.projection.truncated, true);
  assert.ok(compact.controls.every(control => typeof control.snapshotKey === "string"));
  assert.equal(new Set(compact.controls.map(control => control.snapshotKey)).size, compact.controls.length);
  assert.equal(compact.controls.some(control => control.snapshotKey.includes("window-a-control")), false);
  assert.equal(compact.controls[0].value, "focused");
  assert.equal(compact.controls[0].labels.length <= 4, true);
  assert.equal(compact.controls[0].ref.startsWith("obs-"), true);
  assert.equal(stored.refs.size, compact.controls.length);
  const otherSubject = registry();
  const otherStored = otherSubject.remember(frame(["focused"], "window-a"), true);
  const otherCompact = otherSubject.publicObservation(otherStored, "controls", { mode: "compact", maxControls: 1 }, "excel-controls");
  assert.notEqual(compact.controls[0].snapshotKey, otherCompact.controls[0].snapshotKey);
});

test("same-scope since produces unchanged/delta without carrying prior refs", () => {
  const subject = registry();
  const firstStored = subject.remember(frame(["A", "B", "C"], "window-b"), true);
  const first = subject.publicObservation(firstStored, "controls", { mode: "compact", maxControls: 3 }, "q");
  const since = first.observationId;
  const sameStored = subject.remember(frame(["A", "B", "C"], "window-b"), true);
  const same = subject.publicObservation(sameStored, "controls", { mode: "compact", maxControls: 3, since }, "q");
  assert.equal(same.projection.kind, "unchanged");
  assert.deepEqual(same.controls, []);
  assert.notEqual(same.observationId, since);
  assert.equal(same.projection.base, since);
  assert.equal(sameStored.refs.size, 0);
  const changedStored = subject.remember(frame(["A", "CHANGED", "C"], "window-b"), true);
  const delta = subject.publicObservation(changedStored, "controls", { mode: "compact", maxControls: 3, since: same.observationId }, "q");
  assert.equal(delta.projection.kind, "delta");
  assert.equal(delta.controls.length, 1);
  assert.equal(delta.controls[0].value, "CHANGED");
  assert.equal(typeof delta.controls[0].snapshotKey, "string");
  assert.equal(changedStored.refs.size, 1);
  const otherScope = subject.remember(frame(["A", "CHANGED", "C"], "window-c"), true);
  const fallback = subject.publicObservation(otherScope, "controls", { mode: "compact", maxControls: 3, since: delta.observationId }, "q");
  assert.equal(fallback.projection.kind, "snapshot");
  assert.equal(fallback.projection.fallback, "since_scope_changed");
  assert.equal(fallback.controls.length, 3);
});

test("incremental previous compares a complete frame's bounded published controls safely", () => {
  const subject = new ObservationRegistry({
    allowModelImages: true,
    allowModelDocumentText: false,
    grantedAction: () => true,
    refsGranted: true,
  });
  const values = (changed = false) => Array.from({ length: 64 }, (_item, index) => ({
    id: "control-" + index,
    role: "Button",
    name: "Button " + index,
    states: ["visible", "enabled"],
    actions: ["click"],
    value: changed && index === 0 ? "changed" : "value-" + index,
  }));
  const firstStored = subject.remember({ scope: "window-incremental", complete: true, image: { mimeType: "image/png", dataBase64: "first", width: 1, height: 1 }, controls: values() }, true);
  const first = subject.publicObservation(firstStored, "both", { mode: "compact", since: "previous" }, "broad", true);
  assert.equal(first.projection.kind, "snapshot");
  assert.equal(first.projection.truncated, true);
  assert.ok(first.controls.length > 0 && first.controls.length <= 48);
  assert.equal(first.image.dataBase64, "first");

  const sameStored = subject.remember({ scope: "window-incremental", complete: true, image: { mimeType: "image/png", dataBase64: "same", width: 1, height: 1 }, controls: values() }, true);
  const same = subject.publicObservation(sameStored, "both", { mode: "compact", since: "previous" }, "broad", true);
  assert.equal(same.projection.kind, "unchanged");
  assert.equal(same.projection.basis, "published_controls");
  assert.equal(same.complete, false);
  assert.equal(same.controls.length, 0);
  assert.equal(same.image.dataBase64, "same");
  assert.equal(sameStored.refs.size, 0);

  const changedStored = subject.remember({ scope: "window-incremental", complete: true, image: { mimeType: "image/png", dataBase64: "changed", width: 1, height: 1 }, controls: values(true) }, true);
  const changed = subject.publicObservation(changedStored, "both", { mode: "compact", since: "previous" }, "broad", true);
  assert.equal(changed.projection.kind, "delta");
  assert.equal(changed.projection.basis, "published_controls");
  assert.equal(changed.projection.truncated, true);
  assert.equal(changed.controls.length, 1);
  assert.equal(changed.controls[0].name, "Button 0");
  assert.equal(changed.image.dataBase64, "changed");
  assert.equal(changedStored.refs.size, 1);
});

test("incremental previous falls back on incomplete or changed scope and after invalidation", () => {
  const subject = registry();
  const complete = subject.remember(frame(["A", "B"], "window-incremental"), true);
  const first = subject.publicObservation(complete, "controls", { mode: "compact", since: "previous" }, "q", true);
  assert.equal(first.projection.kind, "snapshot");

  const incomplete = subject.remember({ ...frame(["A", "B"], "window-incremental"), complete: false }, true);
  const incompleteResult = subject.publicObservation(incomplete, "controls", { mode: "compact", since: "previous" }, "q", true);
  assert.equal(incompleteResult.projection.kind, "snapshot");
  assert.equal(incompleteResult.projection.fallback, "since_delta_unsafe");

  const changedScope = subject.remember(frame(["A", "B"], "window-other"), true);
  const scopeResult = subject.publicObservation(changedScope, "controls", { mode: "compact", since: "previous" }, "q", true);
  assert.equal(scopeResult.projection.kind, "snapshot");
  assert.equal(scopeResult.projection.fallback, "since_scope_changed");

  subject.invalidatePublicSnapshots();
  const afterInvalidate = subject.remember(frame(["A", "B"], "window-other"), true);
  const invalidated = subject.publicObservation(afterInvalidate, "controls", { mode: "compact", since: "previous" }, "q", true);
  assert.equal(invalidated.projection.kind, "snapshot");
  assert.equal(invalidated.projection.fallback, "since_previous_missing");
});

test("compact image observations suppress controls without changing private frame evidence", () => {
  const subject = new ObservationRegistry({
    allowModelImages: true,
    allowModelDocumentText: false,
    grantedAction: () => true,
    refsGranted: true,
  });
  const stored = subject.remember({
    ...frame(["A", "B", "C"], "window-image"),
    image: { mimeType: "image/png", dataBase64: "pixels", width: 2, height: 2 },
  }, true);
  const image = subject.publicObservation(stored, "image", { mode: "compact" }, undefined);
  assert.equal(image.controls.length, 0);
  assert.equal(image.projection.truncated, false);
  assert.equal(image.projection.observedControls, 3);
  assert.equal(image.projection.returnedControls, 0);
  assert.equal(image.image.dataBase64, "pixels");
  assert.equal(stored.frame.controls.length, 3);
  assert.equal(stored.refs.size, 0);

  const bothStored = subject.remember({
    ...frame(["A", "B", "C"], "window-image"),
    image: { mimeType: "image/png", dataBase64: "both", width: 2, height: 2 },
  }, true);
  const both = subject.publicObservation(bothStored, "both", { mode: "compact" }, "broad");
  assert.ok(both.controls.length > 0);
  assert.equal(both.image.dataBase64, "both");

  const legacyStored = subject.remember({
    ...frame(["A", "B", "C"], "window-image"),
    image: { mimeType: "image/png", dataBase64: "legacy", width: 2, height: 2 },
  }, true);
  const legacy = subject.publicObservation(legacyStored, "image");
  assert.equal(legacy.controls.length, 3);
  assert.equal(legacy.image.dataBase64, "legacy");
});

test("delta reports opaque removals and permits stable window scopes", () => {
  const subject = registry();
  const firstStored = subject.remember(frame(["A", "B", "C"], "window-d", {
    ids: ["control-a", "control-b", "control-c"],
    names: ["A", "B", "C"],
    labels: ["A", "B", "C"],
    windowScopes: ["hwnd-1", "hwnd-1", "hwnd-1"],
  }), true);
  const first = subject.publicObservation(firstStored, "controls", { mode: "compact", maxControls: 3 }, "q");
  const sameStored = subject.remember(frame(["A", "B", "C"], "window-d", {
    ids: ["control-a", "control-b", "control-c"],
    names: ["A", "B", "C"],
    labels: ["A", "B", "C"],
    windowScopes: ["hwnd-1", "hwnd-1", "hwnd-1"],
  }), true);
  const same = subject.publicObservation(sameStored, "controls", { mode: "compact", maxControls: 3, since: first.observationId }, "q");
  assert.equal(same.projection.kind, "unchanged");
  const removedStored = subject.remember(frame(["A", "C"], "window-d", {
    ids: ["control-a", "control-c"],
    names: ["A", "C"],
    labels: ["A", "C"],
    windowScopes: ["hwnd-1", "hwnd-1"],
  }), true);
  const removed = subject.publicObservation(removedStored, "controls", { mode: "compact", maxControls: 3, since: same.observationId }, "q");
  assert.equal(removed.projection.kind, "delta");
  assert.equal(removed.controls.length, 0);
  assert.equal(removed.projection.removed.length, 1);
  assert.equal(removed.projection.removed[0].includes("control-b"), false);
  assert.equal(removedStored.refs.size, 0);
  const changedWindow = subject.remember(frame(["A", "C"], "window-d", {
    ids: ["control-a", "control-c"],
    windowScopes: ["hwnd-2", "hwnd-2"],
  }), true);
  const fallback = subject.publicObservation(changedWindow, "controls", { mode: "compact", maxControls: 3, since: removed.observationId }, "q");
  assert.equal(fallback.projection.kind, "snapshot");
  assert.equal(fallback.projection.fallback, "since_window_scope_changed");
});

test("full and invalidated snapshots keep legacy/full behavior and no stale delta", () => {
  const subject = registry();
  const stored = subject.remember(frame(["A", "B"]), true);
  const full = subject.publicObservation(stored, "controls", { mode: "full" });
  assert.equal(Object.hasOwn(full, "projection"), false);
  assert.equal(full.controls.length, 2);
  const compact = subject.publicObservation(stored, "controls", { mode: "compact", maxControls: 2 }, "q");
  const since = compact.observationId;
  subject.invalidatePublicSnapshots();
  const next = subject.remember(frame(["A", "B"]), true);
  const after = subject.publicObservation(next, "controls", { mode: "compact", maxControls: 2, since }, "q");
  assert.equal(after.projection.kind, "snapshot");
  assert.equal(after.projection.fallback, "since_invalid");
});

test("expired since reports expiry instead of becoming indistinguishable from invalid", () => {
  const subject = registry();
  const originalNow = Date.now;
  let now = 1_000_000;
  try {
    Date.now = () => now;
    const firstStored = subject.remember(frame(["A"], "window-expiry"), true);
    const first = subject.publicObservation(firstStored, "controls", { mode: "compact", maxControls: 1 }, "q");
    now += 90_001;
    const nextStored = subject.remember(frame(["A"], "window-expiry"), true);
    const expired = subject.publicObservation(nextStored, "controls", { mode: "compact", maxControls: 1, since: first.observationId }, "q");
    assert.equal(expired.projection.kind, "snapshot");
    assert.equal(expired.projection.fallback, "since_expired");
  } finally {
    Date.now = originalNow;
  }
});
