import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionProjection } from "@polyth/contracts";
import { createStore } from "../src/index.ts";

const row = (id: string): SessionProjection => ({
  id, projectId: "p1", title: id, status: "idle", createdAt: 1, updatedAt: 1,
});

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-append-batches-"));
  const store = createStore(join(dir, "s.db"));
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await store.upsertProjection(row("a"));
  await store.upsertProjection(row("b"));
  await store.append("a", "seed", {});
  await store.append("b", "seed", {});
  return store;
}

const marker = { type: "session/project-moved", data: { toProjectId: "p2" }, ignorable: true };
const moved = (current: SessionProjection): SessionProjection => ({ ...current, projectId: "p2" });

test("every session publishes its events and projection together", async (t) => {
  const store = await fixture(t);
  const [a, b] = await store.appendBatches!([
    { sessionId: "a", events: [marker], expectedSeq: 1, patch: moved },
    { sessionId: "b", events: [marker], expectedSeq: 1, patch: moved },
  ]);
  assert.deepEqual([a!.events[0]!.seq, b!.events[0]!.seq], [2, 2]);
  assert.equal(a!.projection.projectId, "p2");
  assert.equal((await store.projection("b"))?.projectId, "p2");
  assert.equal((await store.projections("p1")).length, 0, "the indexed listing follows");
  assert.equal((await store.projections("p2")).length, 2);
});

test("one stale session rolls back all of them", async (t) => {
  const store = await fixture(t);
  await assert.rejects(store.appendBatches!([
    { sessionId: "a", events: [marker], expectedSeq: 1, patch: moved },
    { sessionId: "b", events: [marker], expectedSeq: 99, patch: moved },
  ]), { code: "conflict" });
  assert.equal((await store.projection("a"))?.projectId, "p1");
  assert.equal(await store.latestSeq("a"), 1, "no marker survives the rollback");
  assert.equal(await store.latestSeq("b"), 1);
});

test("a session with no projection refuses the whole batch", async (t) => {
  const store = await fixture(t);
  await assert.rejects(store.appendBatches!([
    { sessionId: "a", events: [marker], expectedSeq: 1, patch: moved },
    { sessionId: "missing", events: [marker], expectedSeq: 0, patch: moved },
  ]), { code: "not-found" });
  assert.equal((await store.projection("a"))?.projectId, "p1");
});

test("the patch sees the latest row, so a concurrent projection write survives", async (t) => {
  const store = await fixture(t);
  await store.upsertProjection({ ...(await store.projection("a"))!, draft: "written after the caller read" });
  const [a] = await store.appendBatches!([{ sessionId: "a", events: [marker], expectedSeq: 1, patch: moved }]);
  assert.equal(a!.projection.draft, "written after the caller read");
  assert.equal((await store.projection("a"))?.draft, "written after the caller read");
});

test("a patch may not write another session's row, and a duplicate is refused", async (t) => {
  const store = await fixture(t);
  await assert.rejects(store.appendBatches!([
    { sessionId: "a", events: [], expectedSeq: 1, patch: (current) => ({ ...current, id: "b" }) },
  ]), { code: "invalid-input" });
  await assert.rejects(store.appendBatches!([
    { sessionId: "a", events: [], expectedSeq: 1, patch: moved },
    { sessionId: "a", events: [], expectedSeq: 1, patch: moved },
  ]), { code: "invalid-input" });
});
