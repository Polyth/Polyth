import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserArtifactStore } from "../src/artifacts.ts";

test("artifact store prunes draft files older than the TTL", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "polyth-art-ttl-")), "arts");
  const store = createBrowserArtifactStore(dir, { ttlMs: 60_000, maxFiles: 50 });
  const old = await store.write(new Uint8Array([1, 2, 3]), "image/jpeg", "old-shot");
  assert.ok(old.localPath);
  const aged = new Date(Date.now() - 120_000);
  await utimes(old.localPath, aged, aged);
  await store.write(new Uint8Array([4, 5, 6]), "image/jpeg", "new-shot");
  const names = await readdir(join(dir, "draft"));
  assert.ok(names.includes("new-shot.jpg"));
  assert.ok(!names.includes("old-shot.jpg"));
});

test("artifact store keeps only the newest N draft files", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "polyth-art-cap-")), "arts");
  const store = createBrowserArtifactStore(dir, { ttlMs: 24 * 60 * 60 * 1000, maxFiles: 2 });
  const first = await store.write(new Uint8Array([1]), "image/jpeg", "a");
  assert.ok(first.localPath);
  await store.write(new Uint8Array([2]), "image/jpeg", "b");
  const aged = new Date(Date.now() - 5_000);
  await utimes(first.localPath, aged, aged);
  await store.write(new Uint8Array([3]), "image/jpeg", "c");
  const names = (await readdir(join(dir, "draft"))).sort();
  assert.deepEqual(names, ["b.jpg", "c.jpg"]);
});

test("committed artifacts survive draft prune, overflow, and discard", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "polyth-art-keep-")), "arts");
  const store = createBrowserArtifactStore(dir, { ttlMs: 60_000, maxFiles: 1 });
  const kept = await store.write(new Uint8Array([1]), "image/jpeg", "kept");
  assert.ok(kept.localPath);
  await store.commit(["kept"]);
  assert.ok(await store.read("kept"));
  assert.equal(await store.remove("kept"), false);
  assert.ok(await store.read("kept"));
  const aged = new Date(Date.now() - 120_000);
  const committedPath = join(dir, "committed", "kept.jpg");
  await utimes(committedPath, aged, aged);
  await store.write(new Uint8Array([2]), "image/jpeg", "draft-a");
  await store.write(new Uint8Array([3]), "image/jpeg", "draft-b");
  assert.ok(await store.read("kept"));
  assert.equal(await store.read("draft-a"), null);
  assert.ok(await store.read("draft-b"));
});
