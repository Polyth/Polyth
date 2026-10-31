// Late dictation finals remain owned by their originating composer. Moved out
// of apps/web/test/mobileFoundation.test.ts so the host test no longer names
// the removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("late dictation finals remain owned by their originating composer", async () => {
  const voice = await read("../widgets/voice.tsx");
  const stop = voice.slice(voice.indexOf("const stop = () =>"), voice.indexOf("const startBrowser ="));

  assert.match(stop, /const generation = startGeneration\.current/);
  assert.match(stop, /const originScope = originScopeRef\.current/);
  assert.match(stop, /composerScopeKey\(\) !== originScope/);
  assert.ok(stop.indexOf("streamRef.current = null") > stop.indexOf(".then((text)"),
    "the provider stream remains cancellable until finalization settles");
  assert.ok(stop.indexOf("requestComposerDictation") > stop.indexOf("composerScopeKey() !== originScope"),
    "insertion follows the generation and project/session scope checks");
});
