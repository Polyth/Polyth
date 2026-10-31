import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionProjection } from "@polyth/contracts";
import { createStore } from "../src/index.ts";

test("physical checkout references stay atomic across rebind, rollback, old writers, delete and reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-checkout-index-"));
  const path = join(dir, "sessions.db");
  let store = createStore(path);
  const row: SessionProjection = { id: "foreign-but-physically-shared", spaceId: "foreign", projectId: "p", title: "", status: "idle", createdAt: 1, updatedAt: 1,
    workspace: { repositories: [{ repositoryId: "r", path: "/checkout/child/.." }] } };
  try {
    await store.upsertProjection(row);
    assert.equal((await store.workspaceReference!("/checkout", "usage"))?.id, row.id);
    await assert.rejects(store.appendBatch!(row.id, [], { projection: { ...row, workspace: { repositories: [{ repositoryId: "r", path: "/other" }] } }, expectedSeq: 999 }), { code: "conflict" });
    assert.equal((await store.workspaceReference!("/checkout", "usage"))?.id, row.id);
    await store.patchProjection!(row.id, (p) => ({ ...p, workspace: { repositories: [{ repositoryId: "r", path: "/new" }] } }));
    assert.equal(await store.workspaceReference!("/checkout", "usage"), undefined);
    assert.equal((await store.workspaceReference!("/new", "usage"))?.id, row.id);
    assert.equal(await store.workspaceReference!("/new", "usage", row.id), undefined);
    // A rolled-back binary uses ordinary SQL and never knows the new index.
    // Its durable dirty marker makes the next indexed lookup repair first.
    const db = new DatabaseSync(path);
    db.prepare("UPDATE projections SET data = ? WHERE session_id = ?").run(JSON.stringify({ ...row, workspace: { repositories: [{ repositoryId: "r", path: "/old-writer" }] } }), row.id);
    assert.equal((await store.workspaceReference!("/old-writer", "usage"))?.id, row.id);
    assert.equal(await store.workspaceReference!("/new", "usage"), undefined);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM workspace_reference_dirty").get() as { n: number }).n, 0);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT session_id FROM workspace_references WHERE path = ? AND kind = ? AND session_id <> ? LIMIT 1").all(resolve("/new"), "usage", "");
    assert.match(JSON.stringify(plan), /idx_workspace_reference_path/);
    db.close();
    await store.close(); store = createStore(path);
    assert.equal((await store.workspaceReference!("/old-writer", "usage"))?.id, row.id);
    await store.deleteSession(row.id);
    assert.equal(await store.workspaceReference!("/old-writer", "usage"), undefined);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
