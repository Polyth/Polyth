import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop reduced-motion and low-resource modes disable motion and expensive glass", async () => {
  const [desktop, styles, timeline] = await Promise.all([
    readFile(new URL("../src/desktop.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(desktop, /itemId="desktop\.reduceAnimations"/);
  assert.match(desktop, /document\.documentElement\.dataset\.reduceAnimations/);
  assert.match(desktop, /polyth:desktop-performance-changed/);
  assert.match(styles, /:is\(html\[data-reduce-animations="true"\], body\[data-desktop-low-resource="true"\]\) \*/);
  assert.match(styles, /backdrop-filter:\s*none !important/);
  assert.match(timeline, /addEventListener\("polyth:desktop-performance-changed"/);
  assert.match(timeline, /Math\.min\(current, LOW_RESOURCE_TIMELINE_WINDOW\)/);
});

test("desktop session hydration batches metadata and history with stale-while-revalidate", async () => {
  const source = await readFile(new URL("../src/init.ts", import.meta.url), "utf8");
  const openSession = source.slice(
    source.indexOf("export async function openSession"),
    source.indexOf("function maybeSeedFromReplay"),
  );

  assert.match(openSession, /Promise\.all\(\[/);
  assert.match(openSession, /api\.getSession\(sessionId\)/);
  assert.match(openSession, /requestSessionTail\(sessionId, false\)/);
  assert.match(source, /api\.getEvents\(sessionId, afterSeq, \{ prefetch: false \}\)/);
  assert.match(openSession, /useCachedView/);
  assert.match(openSession, /generation !== openSessionGeneration/);
});
