// WP1/WP3: durable delivery queue + forward-only migration behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createStore } from "@polyth/session";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "polyth-queue-"));
}

test("enqueue keeps FIFO order and queueShift pops in order", async () => {
  const store = createStore(join(freshDir(), "q.db"));
  try {
    await store.enqueue("s1", "first", "queue");
    await store.enqueue("s1", "second", "queue");
    await store.enqueue("s1", "third", "steer");
    const list = await store.queueList("s1");
    assert.deepEqual(list.map((i) => i.text), ["first", "second", "third"]);
    assert.equal(list[2]!.delivery, "steer");

    const a = await store.queueShift("s1");
    assert.equal(a?.text, "first");
    const rest = await store.queueList("s1");
    assert.deepEqual(rest.map((i) => i.text), ["second", "third"]);
  } finally {
    await store.close();
  }
});

test("queue order survives store reopen (restart)", async () => {
  const dir = freshDir();
  const dbPath = join(dir, "q.db");
  {
    const store = createStore(dbPath);
    await store.enqueue("s1", "a", "queue");
    await store.enqueue("s1", "b", "queue");
    await store.close();
  }
  const store = createStore(dbPath);
  try {
    const list = await store.queueList("s1");
    assert.deepEqual(list.map((i) => i.text), ["a", "b"]);
  } finally {
    await store.close();
  }
});

test("queueReorder validates an exact permutation", async () => {
  const store = createStore(join(freshDir(), "q.db"));
  try {
    const a = await store.enqueue("s1", "a", "queue");
    const b = await store.enqueue("s1", "b", "queue");
    const c = await store.enqueue("s1", "c", "queue");

    // wrong count
    await assert.rejects(() => store.queueReorder("s1", [a.id, b.id]), /permutation/);
    // foreign id
    await assert.rejects(() => store.queueReorder("s1", [a.id, b.id, "nope"]), /permutation/);
    // duplicate id
    await assert.rejects(() => store.queueReorder("s1", [a.id, b.id, b.id]), /permutation/);
    // cross-session ids stay isolated
    await store.enqueue("s2", "x", "queue");
    await assert.rejects(() => store.queueReorder("s2", [a.id]), /permutation/);

    const reordered = await store.queueReorder("s1", [c.id, a.id, b.id]);
    assert.deepEqual(reordered.map((i) => i.text), ["c", "a", "b"]);
    // failed reorder above must not have corrupted order
    const list = await store.queueList("s1");
    assert.deepEqual(list.map((i) => i.text), ["c", "a", "b"]);
  } finally {
    await store.close();
  }
});

test("queueRemove removes only the owning session's item", async () => {
  const store = createStore(join(freshDir(), "q.db"));
  try {
    const a = await store.enqueue("s1", "a", "queue");
    assert.equal(await store.queueRemove("other-session", a.id), false);
    assert.equal(await store.queueRemove("s1", a.id), true);
    assert.equal(await store.queueRemove("s1", a.id), false);
    assert.deepEqual(await store.queueList("s1"), []);
  } finally {
    await store.close();
  }
});

test("pre-migration database reopens unchanged and gains queue support", async () => {
  const dir = freshDir();
  const dbPath = join(dir, "old.db");
  // simulate an M1-era database: events + projections only, no schema_meta
  {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL,
        time INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL,
        ignorable INTEGER NOT NULL DEFAULT 0, surface_op TEXT,
        source_seqs TEXT, producer TEXT, v INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (session_id, seq)
      )
    `);
    db.exec("CREATE TABLE projections (session_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    db.prepare(
      "INSERT INTO events (session_id, seq, id, time, type, data) VALUES ('s1', 1, 'e1', 1, 'user/message', '{\"text\":\"old\"}')",
    ).run();
    db.prepare("INSERT INTO projections (session_id, data) VALUES ('s1', ?)").run(
      JSON.stringify({ id: "s1", projectId: "p1", title: "Old", status: "idle", createdAt: 1, updatedAt: 1 }),
    );
    db.close();
  }
  const store = createStore(dbPath);
  try {
    // old rows intact
    const events = await store.events("s1");
    assert.equal(events.length, 1);
    assert.equal((events[0]!.data as { text: string }).text, "old");
    const proj = await store.projection("s1");
    assert.equal(proj?.title, "Old");
    // new capability works after migration
    await store.enqueue("s1", "queued later", "queue");
    assert.equal((await store.queueList("s1")).length, 1);
  } finally {
    await store.close();
  }
});

test("projection decoder tolerates new optional metadata fields", async () => {
  const store = createStore(join(freshDir(), "p.db"));
  try {
    await store.upsertProjection({
      id: "s1", projectId: "p1", title: "T", status: "idle", createdAt: 1, updatedAt: 1,
      attention: { questions: 2, permissions: 1, unread: 3 },
      labelIds: ["l1"], folderId: "f1", branch: "main", worktreeState: "ready",
    });
    const p = await store.projection("s1");
    assert.equal(p?.attention?.questions, 2);
    assert.deepEqual(p?.labelIds, ["l1"]);
    // old-shaped projection (no new fields) still round-trips
    await store.upsertProjection({ id: "s2", projectId: "p1", title: "Old", status: "idle", createdAt: 1, updatedAt: 1 });
    const old = await store.projection("s2");
    assert.equal(old?.attention, undefined);
  } finally {
    await store.close();
  }
});
