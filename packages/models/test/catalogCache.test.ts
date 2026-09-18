import test from "node:test";
import assert from "node:assert/strict";
import { createCatalogCache } from "../widgets/catalogCache.ts";
import { flatModelCatalog, pickerCatalogModels, pickerModelMatches } from "../widgets/modelPickerState.ts";

test("rapid Cursor/Codex/Cursor reads share discovery and warm reads do no work", async () => {
  const cache = createCatalogCache<string[]>();
  let finish!: (models: string[]) => void;
  let calls = 0;
  const load = () => { calls++; return new Promise<string[]>((resolve) => { finish = resolve; }); };
  const cursor = cache.read("account/space/project/cursor", load);
  await cache.read("account/space/project/codex", async () => ["luna"]);
  const again = cache.read("account/space/project/cursor", load);
  assert.equal(cursor, again);
  assert.equal(calls, 1);
  finish(["cursor-model"]);
  await cursor;
  assert.deepEqual(cache.peek("account/space/project/cursor"), ["cursor-model"]);
  assert.deepEqual(await cache.read("account/space/project/cursor", load), ["cursor-model"]);
  assert.equal(calls, 1);
});

test("cache separates identities, expires, and does not retain provider failures", async () => {
  let now = 0;
  const cache = createCatalogCache<string>(10, 2, () => now);
  await cache.read("owner/space-a/project/cursor", async () => "a");
  assert.equal(cache.peek("owner/space-b/project/cursor"), undefined);
  assert.equal(cache.peek("guest/space-a/project/cursor"), undefined);
  now = 11;
  assert.equal(cache.peek("owner/space-a/project/cursor"), undefined);
  await assert.rejects(cache.read("owner/space-a/project/cursor", async () => { throw new Error("sign in"); }), /sign in/);
  assert.equal(await cache.read("owner/space-a/project/cursor", async () => "signed in"), "signed in");
  await cache.read("b", async () => "b");
  await cache.read("c", async () => "c");
  assert.equal(cache.peek("owner/space-a/project/cursor"), undefined);
});

test("authentication invalidation fences an older discovery response", async () => {
  const cache = createCatalogCache<string>();
  let finish!: (value: string) => void;
  const before = cache.read("cursor", () => new Promise<string>((resolve) => { finish = resolve; }));
  cache.clear();
  await cache.read("cursor", async () => "new account catalog");
  finish("old account catalog");
  await before;
  assert.equal(cache.peek("cursor"), "new account catalog");
});

test("persisted metadata paints synchronously across restart while stale data revalidates", async () => {
  let now = 100;
  let saved: string | null = null;
  const storage = {
    read: () => saved,
    write: (value: string) => { saved = value; },
    clear: () => { saved = null; },
  };
  createCatalogCache<string[]>(10, 2, () => now, storage).write("space/project/cursor", ["cached"]);

  now = 105;
  const warmRestart = createCatalogCache<string[]>(10, 2, () => now, storage);
  assert.equal(warmRestart.someFresh(), true, "fresh persisted metadata can suppress reload discovery");
  assert.equal(warmRestart.someFresh((key) => key.endsWith("/cursor")), true);
  assert.equal(warmRestart.someFresh((key) => key.endsWith("/codex")), false);
  assert.equal(warmRestart.expiresIn("space/project/cursor"), 5,
    "daily refresh can be scheduled from the original successful write");
  assert.equal(warmRestart.expiresIn("missing"), undefined);

  now = 111;
  const restarted = createCatalogCache<string[]>(10, 2, () => now, storage);
  assert.equal(restarted.peek("space/project/cursor"), undefined, "expired data is not authoritative");
  assert.deepEqual(restarted.peekStale("space/project/cursor"), ["cached"], "last-known rows can paint without waiting");
  let finish!: (value: string[]) => void;
  const fresh = restarted.read("space/project/cursor", () => new Promise((resolve) => { finish = resolve; }));
  assert.deepEqual(restarted.peekStale("space/project/cursor"), ["cached"], "refresh does not blank the picker");
  finish(["fresh"]);
  await fresh;
  assert.deepEqual(restarted.peek("space/project/cursor"), ["fresh"]);

  restarted.clear();
  assert.equal(saved, null, "auth/settings invalidation removes persisted presentation data");
});

test("native catalogs are flat and OpenCode hides disconnected providers", () => {
  const codex = { harnessId: "codex", providerID: "openai", modelID: "luna", name: "Luna" };
  assert.equal(flatModelCatalog([codex]), true);
  assert.equal(flatModelCatalog([{ ...codex, harnessId: "claude" }]), true);
  assert.equal(flatModelCatalog([{ ...codex, harnessId: "opencode" }]), false);
  assert.equal(pickerModelMatches(codex, { providerID: "openai", modelID: "luna" }), true);
  assert.equal(pickerModelMatches(codex, { harnessId: "opencode", providerID: "openai", modelID: "luna" }), false);
  assert.deepEqual(pickerCatalogModels([
    { ...codex, harnessId: "opencode", connected: true },
    { ...codex, harnessId: "opencode", providerID: "unconfigured", connected: false },
    codex,
  ], "opencode").map((model) => model.providerID), ["openai"]);
});
