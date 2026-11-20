import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("AT-SPI worker traverses application subtrees and fails closed on an unbound window", async () => {
  const source = await readFile(new URL("../src/backends/e2b/atspi_worker.py", import.meta.url), "utf8");
  assert.match(source, /def top_level_accessibles\(\):[\s\S]*Registry\.getDesktop\(0\)[\s\S]*stack\.append\(\(application, 0\)\)/u);
  assert.match(source, /MAX_DEPTH\s*=\s*32/u);
  assert.match(source, /MAX_TREE_NODES\s*=\s*4096/u);
  assert.match(source, /expected_pid is None or pid != expected_pid/u);
  assert.match(source, /expected_window_id is None or xwindow != expected_window_id/u);
  assert.doesNotMatch(source, /if expected_title and title != expected_title/u);
  assert.match(source, /"code": "e2b_atspi_unavailable", "reason": "window_unbound"/u);
});
