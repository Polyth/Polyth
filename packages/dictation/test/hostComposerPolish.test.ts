// The shared composer primary action is terminal, so the voice control cannot
// be contributed after it. Moved out of apps/web/test/composerPolish.test.ts so
// the host test no longer names the removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("the voice control cannot be placed after the primary action", async () => {
  const voice = await read("../widgets/voice.tsx");
  assert.doesNotMatch(voice, /supportedSlots:\s*\[[\s\S]*?"composer\.trailing"/,
    "voice cannot be placed after the primary action");
});
