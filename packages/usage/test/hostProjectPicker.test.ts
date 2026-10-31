// Moved from apps/web/test/projectPicker.test.ts: the usage dashboard keeps the
// shared Select/Picker, checked with the package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the usage dashboard keeps the shared Select/Picker", async () => {
  const source = await readFile(new URL("../widgets/usage/UsageDashboard.tsx", import.meta.url), "utf8");
  assert.match(source, /<Select/);
});
