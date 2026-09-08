import test from "node:test";
import assert from "node:assert/strict";
import type { SpaceContext } from "@polyth/contracts";
import { createBundleService } from "../src/bundles.ts";
import type { ContextSourceRegistry } from "../src/index.ts";

const spaceCtx = (spaceId: string): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId: "user-1",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/tmp",
});

test("old in-memory bundles are pruned by count and ttl", async () => {
  const registry: ContextSourceRegistry = {
    list: () => [],
    get: () => undefined,
    register() {},
  };
  const bundles = createBundleService({ registry, warnTokenThreshold: 80_000 });
  const collectCtx = { space: spaceCtx("space-retain"), projectId: "proj", sessionId: "sess" };
  const ids: string[] = [];
  for (let i = 0; i < 15; i++) {
    const bundle = await bundles.createBundle({
      storage: { path: (p: string) => p } as never,
      collectCtx,
      projectId: "proj",
      sessionId: "sess",
      presetId: "review",
      label: `Bundle ${i}`,
      instruction: `instruction ${i}`,
      sources: [],
    });
    ids.push(bundle.id);
  }
  const listed = await bundles.listBundles({ path: (p: string) => p } as never, "proj", "space-retain");
  assert.equal(listed.length, 12);
  assert.ok(listed.length < ids.length);
});

test("expired bundles are inaccessible on read paths", async () => {
  let now = 1_000_000;
  const registry: ContextSourceRegistry = {
    list: () => [],
    get: () => undefined,
    register() {},
  };
  const bundles = createBundleService({
    registry,
    warnTokenThreshold: 80_000,
    now: () => now,
    ttlMs: 1_000,
  });
  const collectCtx = { space: spaceCtx("space-ttl"), projectId: "proj", sessionId: "sess" };
  const created = await bundles.createBundle({
    storage: { path: (p: string) => p } as never,
    collectCtx,
    projectId: "proj",
    sessionId: "sess",
    presetId: "review",
    label: "TTL bundle",
    instruction: "instruction",
    sources: [],
  });
  now += 2_000;
  assert.equal(await bundles.getBundle({ path: (p: string) => p } as never, "proj", created.id, "space-ttl"), null);
  assert.equal((await bundles.listBundles({ path: (p: string) => p } as never, "proj", "space-ttl")).length, 0);
  await assert.rejects(
    () => bundles.checkStale({ path: (p: string) => p } as never, collectCtx, "proj", created.id),
    /not found/,
  );
});
