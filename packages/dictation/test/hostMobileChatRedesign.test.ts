// Late dictation finals stay owned by their originating composer, and the
// compact Dictate control keeps a full coarse-pointer touch target. Moved out
// of apps/web/test/mobileChatRedesign.test.ts so the host test no longer names
// the removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("late dictation finals remain owned by their originating composer", async () => {
  const voice = await read("../widgets/voice.tsx");
  const stop = voice.slice(voice.indexOf("const stop = () =>"), voice.indexOf("const startBrowser ="));

  assert.match(stop, /const generation = startGeneration\.current/);
  assert.match(stop, /const originScope = originScopeRef\.current/);
  assert.match(stop, /composerScopeKey\(\) !== originScope/);
  assert.ok(stop.indexOf("streamRef.current = null") > stop.indexOf(".then((text)"),
    "the stream remains cancellable until finalization settles");
  assert.ok(stop.indexOf("requestComposerDictation") > stop.indexOf("composerScopeKey() !== originScope"),
    "insertion happens only after generation and composer-scope checks");
  assert.match(stop, /const runId = runIdRef\.current/,
    "the final is addressed to the run that produced it, not whichever run is current later");
});

test("the compact Dictate control remains a full touch target on coarse pointers", async () => {
  const css = await read("../widgets/styles.css");
  assert.match(
    css,
    /@media \(pointer: coarse\) \{\s*\.mic-control \.mic-btn \{[^}]*min-width:\s*var\(--tap\);[^}]*min-height:\s*var\(--tap\);/s,
    "the compact Dictate control remains a full touch target on coarse pointers",
  );
});
