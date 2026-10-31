import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceContext, SpaceStorage } from "@polyth/contracts";
import { createActionStore } from "../src/actionStore.ts";
import { normalizeActionInput } from "../src/actionModel.ts";

const space = (spaceId: string, root: string): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId: "u1",
  role: "owner",
  deployment: "local-trusted",
  storageDir: join(root, spaceId),
});

function storageFor(root: string) {
  return (ctx: SpaceContext): SpaceStorage => ({
    root: join(root, ctx.spaceId),
    packageDir(id) {
      const dir = join(root, ctx.spaceId, "packages", id);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    path: (relative) => join(root, ctx.spaceId, relative),
  });
}

const input = (name: string, projectId: string | null = null) =>
  normalizeActionInput({ name, command: `echo ${name}`, projectId });

test("actions persist per Space with create, update, reorder and delete", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "custom-action-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = 1_000;
  let ids = 0;
  const store = createActionStore({ storage: storageFor(root), now: () => clock++, id: () => `id-${++ids}` });
  const home = space("home", root);
  const work = space("work", root);

  const first = await store.create(home, input("First"));
  const second = await store.create(home, input("Second", "p1"));
  await store.create(work, input("Elsewhere"));
  assert.deepEqual((await store.list(home)).map((action) => action.name), ["First", "Second"]);
  assert.deepEqual((await store.list(work)).map((action) => action.name), ["Elsewhere"], "another Space never sees these actions");
  assert.equal(await store.get(work, first.id), undefined);

  const renamed = await store.update(home, first.id, normalizeActionInput({ name: "Renamed", command: "ls", mode: "chat", chat: { prompt: "Explain", when: "always" } }));
  assert.equal(renamed.createdAt, first.createdAt);
  assert.ok(renamed.updatedAt > first.updatedAt);
  // Switching away from chat keeps its hand-off settings for a later switch back.
  const background = await store.update(home, first.id, normalizeActionInput({ name: "Renamed", command: "ls", mode: "background" }));
  assert.deepEqual(background.chat, { prompt: "Explain", when: "always" });

  assert.deepEqual((await store.reorder(home, [second.id])).map((action) => action.id), [second.id, first.id]);
  await assert.rejects(store.reorder(home, ["nope"]), { code: "not-found" });
  await assert.rejects(store.update(work, first.id, input("x")), { code: "not-found" }, "an id from another Space is unknown here");

  await store.remove(home, second.id);
  assert.deepEqual((await store.list(home)).map((action) => action.id), [first.id]);
  await assert.rejects(store.remove(home, second.id), { code: "not-found" });

  const file = join(root, "home", "packages", "custom-action", "actions.json");
  const saved = JSON.parse(await readFile(file, "utf8")) as { version: number; actions: unknown[] };
  assert.equal(saved.version, 1);
  assert.equal(saved.actions.length, 1);
  assert.deepEqual((await readdir(join(root, "home", "packages", "custom-action"))).filter((name) => name.endsWith(".tmp")), [], "no temp files are left behind");
});

test("concurrent writes are serialized instead of losing actions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "custom-action-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createActionStore({ storage: storageFor(root) });
  const home = space("home", root);
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.create(home, input(`Action ${index}`))));
  assert.equal((await store.list(home)).length, 12);
});

test("an unreadable file is moved aside, not overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "custom-action-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs: string[] = [];
  const store = createActionStore({ storage: storageFor(root), now: () => 42, log: (message) => logs.push(message) });
  const home = space("home", root);
  const dir = join(root, "home", "packages", "custom-action");
  mkdirSync(dir, { recursive: true });
  await writeFile(join(dir, "actions.json"), "{ broken");
  assert.deepEqual(await store.list(home), []);
  assert.equal(await readFile(join(dir, "actions.json.unreadable-42"), "utf8"), "{ broken");
  assert.equal(logs.length, 1);
  await store.create(home, input("Fresh"));
  assert.equal((await store.list(home)).length, 1);
});

test("the per-Space limit is enforced", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "custom-action-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = space("home", root);
  const dir = join(root, "home", "packages", "custom-action");
  mkdirSync(dir, { recursive: true });
  const actions = Array.from({ length: 200 }, (_, index) => ({ id: `a${index}`, name: `A${index}`, command: "ls" }));
  await writeFile(join(dir, "actions.json"), JSON.stringify({ version: 1, actions }));
  const store = createActionStore({ storage: storageFor(root) });
  await assert.rejects(store.create(home, input("One too many")), { code: "conflict" });
});
