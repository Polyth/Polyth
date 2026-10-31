// Moved from apps/web/test/widgetWorkspaceUx.test.ts: the usage widget's own
// container queries.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the usage widget responds to its own card box", async () => {
  const usage = await readFile(new URL("../widgets/usageWidgets.css", import.meta.url), "utf8");
  assert.match(usage, /\.usage-widget\s*\{[^}]*container:\s*usage-widget \/ size/s);
  assert.match(usage, /@container usage-widget \(max-height:\s*200px\)/);
  assert.match(usage, /@container usage-widget \(min-width:\s*440px\)/);
});
