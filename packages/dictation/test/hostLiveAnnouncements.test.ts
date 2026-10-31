// Dictation and the composer both forward a resolved status (null clears)
// instead of skipping the update. Moved out of apps/web/test/liveAnnouncements.
// test.ts so the host test no longer names the removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("status producers forward a resolved status instead of skipping the update", async () => {
  const [voice, composer] = await Promise.all([
    read("../widgets/voice.tsx"),
    read("../../../apps/web/src/components/Composer.tsx"),
  ]);
  assert.match(voice, /if \(lifecycleStatus !== lastAnnounced\.current\) announce\(lifecycleStatus\)/);
  assert.match(composer, /if \(statusText !== lastAnnounced\.current\) announce\(statusText\)/);
  assert.doesNotMatch(voice, /if \(lifecycleStatus && lifecycleStatus !== lastAnnounced\.current\)/);
  assert.doesNotMatch(composer, /if \(statusText && statusText !== lastAnnounced\.current\)/);
});
