// Moved from apps/web/test/railIconsOnly.test.ts: the usage package's own
// surface id registration.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the usage package registers its rail surface id", async () => {
  const usage = await readFile(new URL("../widgets/index.tsx", import.meta.url), "utf8");
  assert.match(usage, /id: "usage"/);
});
