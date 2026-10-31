// The goals composer contribution keeps its own class hook. Moved out of
// apps/web/test/mobilePolish.test.ts so the host test no longer names the
// removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the goals composer contribution keeps its class hook", async () => {
  const source = await readFile(new URL("../widgets/index.tsx", import.meta.url), "utf8");
  assert.match(source, /composer-goals/);
});
