// WP5: folders (cycles, cross-project, stale revisions), labels, derived
// attention counters, bounded text search.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/index.ts";

const freshStore = () => createStore(join(mkdtempSync(join(tmpdir(), "polyth-org-")), "s.db"));

test("folders: create/list/update; cycles, cross-project moves and stale revisions fail safely", async () => {
  const store = freshStore();

  const a = await store.folderCreate("p1", "A");
  const b = await store.folderCreate("p1", "B", a.id);
  const c = await store.folderCreate("p1", "C", b.id);
  const other = await store.folderCreate("p2", "Other");

  const listed = await store.folderList("p1");
  assert.deepEqual(listed.map((f) => f.name), ["A", "B", "C"]);
  assert.equal(listed[1]!.parentId, a.id);

  // cycle: A cannot move under its own descendant C, nor under itself
  await assert.rejects(() => store.folderUpdate(a.id, { parentId: c.id }, a.revision), /cycle/);
  await assert.rejects(() => store.folderUpdate(a.id, { parentId: a.id }, a.revision), /cycle/);

  // cross-project move rejected
  await assert.rejects(() => store.folderUpdate(b.id, { parentId: other.id }, b.revision), /another project|cross-project/);

  // stale revision → conflict
  const renamed = await store.folderUpdate(a.id, { name: "A2" }, a.revision);
  assert.equal(renamed.name, "A2");
  assert.equal(renamed.revision, a.revision + 1);
  await assert.rejects(
    () => store.folderUpdate(a.id, { name: "A3" }, a.revision),
    (err: Error & { code?: string }) => err.code === "conflict",
  );

  // valid reparent: C to root
  const moved = await store.folderUpdate(c.id, { parentId: null }, c.revision);
  assert.equal(moved.parentId, undefined);

  await store.close();
});

test("folder names are normalized and unique within each parent", async () => {
  const store = freshStore();
  const roadmap = await store.folderCreate("p1", "Roadmap");
  await assert.rejects(
    () => store.folderCreate("p1", "  ＲＯＡＤＭＡＰ  "),
    (error: Error & { code?: string }) => error.code === "conflict",
  );

  const parent = await store.folderCreate("p1", "Parent");
  const nested = await store.folderCreate("p1", "Roadmap", parent.id);
  assert.equal(nested.parentId, parent.id, "the same name remains valid in a different parent");
  await assert.rejects(
    () => store.folderUpdate(nested.id, { parentId: null }, nested.revision),
    (error: Error & { code?: string }) => error.code === "conflict",
  );
  await assert.rejects(
    () => store.folderUpdate(parent.id, { name: "roadmap" }, parent.revision),
    (error: Error & { code?: string }) => error.code === "conflict",
  );
  assert.equal((await store.folderList("p1")).find((folder) => folder.id === roadmap.id)?.name, "Roadmap");
  await store.close();
});

test("folder remove reparents children to the removed folder's parent", async () => {
  const store = freshStore();
  const a = await store.folderCreate("p1", "A");
  const b = await store.folderCreate("p1", "B", a.id);
  await store.folderCreate("p1", "C", b.id);

  assert.equal(await store.folderRemove(b.id), true);
  assert.equal(await store.folderRemove(b.id), false); // idempotent-ish: gone is gone

  const listed = await store.folderList("p1");
  const cRow = listed.find((f) => f.name === "C")!;
  assert.equal(cRow.parentId, a.id); // hoisted to grandparent
  await store.close();
});

test("folder remove refuses to hoist a child onto a duplicate destination", async () => {
  const store = freshStore();
  await store.folderCreate("p1", "Existing");
  const container = await store.folderCreate("p1", "Container");
  await store.folderCreate("p1", "existing", container.id);

  await assert.rejects(
    () => store.folderRemove(container.id),
    (error: Error & { code?: string }) => error.code === "conflict",
  );
  assert.deepEqual(
    (await store.folderList("p1")).map((folder) => folder.name),
    ["Existing", "Container", "existing"],
  );
  await store.close();
});

test("labels: CRUD with color validation and stale revision conflict", async () => {
  const store = freshStore();
  const l = await store.labelCreate("urgent", "#ff0000");
  assert.equal(l.name, "urgent");
  await assert.rejects(() => store.labelCreate("bad", "red"), /hex/);

  const upd = await store.labelUpdate(l.id, { name: "later" }, l.revision);
  assert.equal(upd.name, "later");
  await assert.rejects(
    () => store.labelUpdate(l.id, { name: "again" }, l.revision),
    (err: Error & { code?: string }) => err.code === "conflict",
  );

  assert.equal(await store.labelRemove(l.id), true);
  assert.deepEqual(await store.labelList(), []);
  await store.close();
});

test("attentionFor counts only unresolved questions/permissions per session", async () => {
  const store = freshStore();
  await store.append("s1", "permission/requested", { requestId: "p1" });
  await store.append("s1", "permission/requested", { requestId: "p2" });
  await store.append("s1", "permission/resolved", { requestId: "p1", reply: "once" });
  await store.append("s1", "question/asked", { requestId: "q1" });
  await store.append("s2", "question/asked", { requestId: "q2" });
  await store.append("s2", "question/answered", { requestId: "q2" });

  const counts = await store.attentionFor(["s1", "s2", "s3"]);
  assert.deepEqual(counts.s1, { questions: 1, permissions: 1 });
  assert.deepEqual(counts.s2, { questions: 0, permissions: 0 });
  assert.deepEqual(counts.s3, { questions: 0, permissions: 0 });
  await store.close();
});

test("searchEventText returns bounded snippets, at most two per session", async () => {
  const store = freshStore();
  const long = `${"x".repeat(200)} the needle sits here ${"y".repeat(200)}`;
  await store.append("s1", "user/message", { text: "needle first" });
  await store.append("s1", "assistant/message", { text: "needle again" });
  await store.append("s1", "user/message", { text: "third needle mention" });
  await store.append("s2", "user/message", { text: long });
  await store.append("s3", "user/message", { text: "no match here" });

  const hits = await store.searchEventText("needle");
  assert.equal(hits.filter((h) => h.sessionId === "s1").length, 2); // capped per session
  const snip = hits.find((h) => h.sessionId === "s2");
  assert.ok(snip);
  assert.ok(snip.snippet.length < 140, `snippet too long: ${snip.snippet.length}`);
  assert.ok(snip.snippet.startsWith("…") && snip.snippet.endsWith("…"));
  assert.equal(hits.some((h) => h.sessionId === "s3"), false);
  await store.close();
});

test("reopening the store re-runs no migrations and keeps org data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-org-"));
  const path = join(dir, "s.db");
  const store = createStore(path);
  await store.folderCreate("p1", "Keep");
  await store.close();

  const reopened = createStore(path);
  const listed = await reopened.folderList("p1");
  assert.deepEqual(listed.map((f) => f.name), ["Keep"]);
  await reopened.close();
});
