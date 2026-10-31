// The Browser package's mobile chrome consumes the canonical safe-area
// variables instead of reading env() itself. Moved out of
// apps/web/test/mobileFoundation.test.ts so the host test no longer names the
// removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("browser mobile chrome consumes canonical safe-area variables", async () => {
  const css = await readFile(new URL("../widgets/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /env\(safe-area-inset-/);
  assert.match(css, /padding-left:\s*max\(var\(--space-2\), var\(--safe-left\)\)/);
  assert.match(css, /padding-right:\s*max\(var\(--space-2\), var\(--safe-right\)\)/);
});
