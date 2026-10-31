// Moved from apps/web/test/responsiveShell.test.ts: the package-owned
// microphone's hide rule.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the package-owned microphone can be hidden without suppressing other slot items", async () => {
  const dictationCss = await readFile(new URL("../widgets/styles.css", import.meta.url), "utf8");
  assert.ok(dictationCss.includes('body[data-dictate="false"] .mic-control .mic-btn'),
    "the package-owned microphone can be hidden without suppressing other slot items");
});
