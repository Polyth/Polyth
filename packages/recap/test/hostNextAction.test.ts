// Moved from apps/web/test/nextAction.test.ts: the optional prompt controls and
// requests are the recap package's own UI, so the host must not name it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("optional prompt controls and requests belong to Session Assist", async () => {
  const [entry, feature] = await Promise.all([
    read("../widgets/index.tsx"),
    read("../widgets/PromptAssist.tsx"),
  ]);
  assert.match(entry, /id: "composer\.next-action"/);
  assert.match(feature, /draft\.replace\(result\.suggestion\)/);
  assert.doesNotMatch(feature, /conversation\.send/);
});
