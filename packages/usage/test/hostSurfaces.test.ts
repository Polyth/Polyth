// Moved from apps/web/test/surfaces.test.ts: the Usage package owning its rail
// surface is package behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the Usage package owns its rail surface", async () => {
  const source = await readFile(new URL("../widgets/index.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("host.surfaces.register"));
  assert.ok(source.includes('id: "usage"'));
  assert.ok(source.includes("component: UsageDashboard"));
  assert.ok(!source.includes("visible:"), "zero tokens never hide the Usage command");
});
