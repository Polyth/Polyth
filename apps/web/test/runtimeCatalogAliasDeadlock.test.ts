import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

// Two preview reads for the same harness under different scopes (the composer
// carries Space + cwd, the project preload carries neither) alias each other's
// keys. Each one used to await the other's in-flight cache entry before
// finishing its own, so the pair never settled and the model picker stayed on
// "Loading…" until a harness switch re-read the snapshot cache.

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage as unknown as Storage,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

const projectId = "alias-deadlock-project";
const spaceId = "alias-deadlock-space";
const cwd = "/work/alias-deadlock";
const snapshot = (harnessId: string) => ({
  identity: { id: harnessId, name: harnessId, integration: "native" },
  policy: { enabled: true, priority: 0, autoSelect: true },
  availability: { harnessId, state: "ready", installed: true, healthy: true, authenticated: true, checkedAt: 1 },
  context: { projectId, spaceId, cwd, revision: "r", fetchedAt: 1 },
  catalog: { models: [{ providerID: "xai", modelID: "grok", name: "Grok", connected: true, harnessId }] },
});
globalThis.fetch = async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://127.0.0.1:4400");
  if (url.pathname === "/api/harnesses/roster") {
    return new Response(JSON.stringify([{ identity: { id: "cursor", name: "Cursor" }, policy: { enabled: true, priority: 0, autoSelect: true } }]));
  }
  if (url.pathname === "/api/harnesses/snapshots") {
    // A native detail probe takes a moment, so both scopes are in flight together.
    if (url.searchParams.get("detail") === "1") await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify([snapshot("cursor")]));
  }
  return new Response("{}", { status: 404 });
};

const { preloadRuntimeCatalogs } = await import("@polyth/models/runtime-catalog");

test("concurrent preview reads whose keys alias each other both settle", async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"hung">((resolve) => { timer = setTimeout(() => resolve("hung"), 2_000); });
  const outcome = await Promise.race([
    Promise.all([
      preloadRuntimeCatalogs({ projectId }),
      preloadRuntimeCatalogs({ projectId, spaceId }),
    ]).then(() => "settled" as const),
    timeout,
  ]);
  clearTimeout(timer);
  assert.equal(outcome, "settled");
});
