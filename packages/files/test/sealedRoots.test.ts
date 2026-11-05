// The server's data folder holds everyone's private chats and notes. A project at
// a parent folder must not be a way into it, whatever the file view.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browseHost, createFileService, mkdirHost } from "../src/index.ts";

function fixture(t: test.TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "polyth-sealed-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const data = join(home, "polyth-data");
  const roomOfOlia = join(data, "spaces", "s", "personal", "olia", "rooms", "w");
  const roomOfTaras = join(data, "spaces", "s", "personal", "taras", "rooms", "w");
  mkdirSync(roomOfOlia, { recursive: true });
  mkdirSync(roomOfTaras, { recursive: true });
  writeFileSync(join(data, "sessions.db"), "everyone's chats");
  writeFileSync(join(roomOfOlia, "secret.txt"), "needle of olia");
  writeFileSync(join(roomOfTaras, "secret.txt"), "needle of taras");
  writeFileSync(join(home, "plan.txt"), "needle in the open");
  return { home, data, roomOfOlia, roomOfTaras, files: createFileService({ sealedRoots: () => [data] }) };
}

const code = (error: unknown): unknown => (error as { code?: unknown }).code;

test("a project at a parent folder doesn't show the data folder, in any view", async (t) => {
  const { home, files } = fixture(t);
  const names = (await files.tree(home, { hidden: true })).map((entry) => entry.name);
  assert.deepEqual(names, ["plan.txt"]);
  assert.deepEqual((await files.list(home, { hidden: true })).entries.map((entry) => entry.path), ["plan.txt"]);
  assert.deepEqual(await files.search(home, "secret", 10), []);
  assert.deepEqual(await files.search(home, "polyth-data", 10), []);
  const content = await files.searchContent(home, "needle");
  assert.deepEqual(content.hits.map((hit) => hit.path), ["plan.txt"]);
});

test("naming a path inside it reads as missing, for reads and writes alike", async (t) => {
  const { home, data, roomOfOlia, files } = fixture(t);
  const inside = "polyth-data/spaces/s/personal/olia/rooms/w/secret.txt";
  for (const attempt of [
    () => files.read(home, inside),
    () => files.stat(home, inside),
    () => files.readRaw(home, inside),
    () => files.read(home, "polyth-data/sessions.db"),
    () => files.tree(home, { path: "polyth-data" }),
    () => files.list(home, { path: "polyth-data/spaces" }),
    () => files.write(home, inside, "changed"),
    () => files.writeBytes(home, "polyth-data/planted", new Uint8Array([1])),
    () => files.mkdir(home, "polyth-data/planted"),
    () => files.remove(home, inside),
    () => files.rename(home, inside, "stolen.txt"),
    () => files.rename(home, "plan.txt", "polyth-data/plan.txt"),
    // An absolute path, the external-read door.
    () => files.read(home, join(roomOfOlia, "secret.txt")),
    () => files.read(home, join(data, "sessions.db")),
  ]) {
    await assert.rejects(attempt, (error) => code(error) === "not-found");
  }
  assert.equal(readFileSync(join(roomOfOlia, "secret.txt"), "utf8"), "needle of olia");
});

test("a link inside the project doesn't lead there either", async (t) => {
  const { home, data, files } = fixture(t);
  symlinkSync(data, join(home, "shortcut"));
  await assert.rejects(files.read(home, "shortcut/sessions.db"));
});

test("a room sees its own folder and nothing beside it, even by absolute path in an allowed folder", async (t) => {
  const { roomOfOlia, roomOfTaras, files } = fixture(t);
  assert.equal((await files.read(roomOfOlia, "secret.txt")).content, "needle of olia");
  assert.deepEqual((await files.tree(roomOfOlia)).map((entry) => entry.name), ["secret.txt"]);
  // The fixture's data folder is under the temp folder, which external reads allow.
  await assert.rejects(files.read(roomOfOlia, join(roomOfTaras, "secret.txt")), (error) => code(error) === "not-found");
});

test("a project registered at the data folder itself gets nothing", async (t) => {
  const { data, files } = fixture(t);
  await assert.rejects(files.read(data, "sessions.db"), (error) => code(error) === "not-found");
  await assert.rejects(files.tree(data), (error) => code(error) === "not-found");
});

test("without sealed folders nothing changes", async (t) => {
  const { home } = fixture(t);
  const open = createFileService();
  assert.equal((await open.read(home, "polyth-data/sessions.db")).content, "everyone's chats");
});

test("the folder picker reads as if the data folder weren't there", async (t) => {
  const { home, data, roomOfOlia } = fixture(t);
  const sealedRoots = [data];
  const listed = await browseHost(home, { sealedRoots });
  assert.deepEqual(listed.entries.map((entry) => entry.name), []);
  assert.deepEqual((await browseHost(home)).entries.map((entry) => entry.name), ["polyth-data"], "unsealed, it's an ordinary folder");
  for (const target of [data, roomOfOlia, join(data, "spaces")]) {
    await assert.rejects(browseHost(target, { sealedRoots }), (error) => code(error) === "not-found");
  }
  symlinkSync(data, join(home, "shortcut"));
  assert.deepEqual((await browseHost(home, { sealedRoots })).entries.map((entry) => entry.name), [], "nor through a link");
  await assert.rejects(browseHost(join(home, "shortcut"), { sealedRoots }), (error) => code(error) === "not-found");
  await assert.rejects(mkdirHost(join(data, "planted"), { sealedRoots }), (error) => code(error) === "invalid-path");
});
