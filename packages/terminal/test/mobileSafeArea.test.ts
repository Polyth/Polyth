// The terminal's touch chrome uses the canonical safe-area variables and
// leaves home-indicator and keyboard clearance to its hosting layer instead of
// padding for it a second time.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("terminal touch chrome leaves safe-area clearance to its hosting layer", async () => {
  const css = await readFile(new URL("../widgets/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /env\(safe-area-inset-/);
  assert.match(css, /hosting layer owns the home-indicator and keyboard clearance/);
  assert.doesNotMatch(css, /var\(--safe-bottom\)/);
});
