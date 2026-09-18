import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("low-resource mode disables expensive glass while the Appearance glass setting stays independent", async () => {
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
  assert.match(styles, /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\)/);
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
  assert.match(source, /api\.getSession\(sessionId\)/);
  assert.match(openSession, /requestSessionTail\(sessionId, false\)/);
  assert.match(source, /api\.getEvents\(sessionId, afterSeq, \{ prefetch: false \}\)/);
  assert.match(openSession, /useCachedView/);
  assert.match(openSession, /generation !== openSessionGeneration/);
});


test("runtime catalog boot reuses the daily persisted aggregate instead of refetching on reload", async () => {
  const [init, runtimeCatalog] = await Promise.all([
    readFile(new URL("../src/init.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/models/widgets/runtimeCatalog.ts", import.meta.url), "utf8"),
  ]);

  assert.match(init, /const cachedModels = peekPersistedRuntimeModels\(projectId\)/);
  assert.match(init, /cachedModels !== undefined\) store\.setModels\(cachedModels\)[\s\S]*else void refreshModels\(projectId\)/);
  assert.match(init, /const cachedAgents = peekPersistedRuntimeAgents\(projectId\)/);
  assert.match(init, /runtimeCatalogPolicy = "project"/);
  assert.match(runtimeCatalog, /polyth\.runtimeGlobalModels\.v1/);
  assert.match(runtimeCatalog, /polyth\.runtimeGlobalAgents\.v1/);
  assert.match(runtimeCatalog, /if \(models\.length > 0\) persistedGlobalModels\.write/);
  assert.match(runtimeCatalog, /persistedGlobalModels\.clear\(\)/);
  assert.match(runtimeCatalog, /persistedGlobalAgents\.clear\(\)/);
  assert.match(runtimeCatalog, /persistedWarmScopes\.clear\(\)/);
  assert.match(init, /subscribeRuntimeCatalogInvalidations\(\(\) => \{/);
  assert.match(init, /void refreshModels\(\);[\s\S]*void refreshAgents\(\);/);
});
