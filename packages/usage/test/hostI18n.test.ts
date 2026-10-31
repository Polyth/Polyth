// The Ukrainian usage catalog names the context surface. Moved out of
// apps/web/test/i18n.test.ts so the host i18n integrity test no longer names
// the removable package.
import assert from "node:assert/strict";
import test from "node:test";
import { usageLocales } from "@polyth/usage/i18n";

test("the Ukrainian usage catalog names the context surface", () => {
  const usageContext = usageLocales.uk["usage.context"];
  assert.ok(usageContext);
  assert.match(usageContext, /Контекст/);
});
