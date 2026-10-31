import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The package-side half of the former combined test now lives with the recap
// package's own tests.
test("the host composer owns no optional prompt controls", async () => {
  const [composer, builtins] = await Promise.all([
    readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/widgets/builtinMiniWidgets.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(composer, /assistSuggestion|assistPrompt|generateNextAction|promptRewrite/i);
  assert.doesNotMatch(builtins, /composer\.next-action/);
});
