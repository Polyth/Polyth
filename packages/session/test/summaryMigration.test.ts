import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/index.ts";

test("v15 upgrade builds navigator indexes atomically and preserves canonical bytes across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-summary-upgrade-"));
  const path = join(dir, "sessions.db");
  try {
    let store = createStore(path);
    await store.upsertProjection({ id: "s", spaceId: "space", projectId: "p", title: "preserved", status: "idle", createdAt: 1, updatedAt: 2 });
    await store.append("s", "user/message", { text: "original" });
    const events = await store.events("s");
    await store.close();
    const db = new DatabaseSync(path);
    const drop = `DROP INDEX idx_projections_navigator; DROP INDEX idx_projections_space_recent;
      DROP INDEX idx_events_unread; DROP TRIGGER session_catalog_insert; DROP TRIGGER session_catalog_update;
      DROP TRIGGER session_catalog_delete; DROP TRIGGER session_catalog_move; DROP TABLE session_catalog_revision;
      DROP TRIGGER workspace_reference_insert; DROP TRIGGER workspace_reference_update; DROP TRIGGER workspace_reference_delete;
      DROP TABLE workspace_references; DROP TABLE workspace_reference_dirty; DROP INDEX idx_legacy_workspace_project;
      UPDATE schema_meta SET value = '15' WHERE key = 'version';`;
    db.exec(drop);
    // Interrupted schema work is rolled back, just as the store's migration owner does.
    db.exec("BEGIN IMMEDIATE; CREATE INDEX idx_projections_navigator ON projections(project_id); ROLLBACK;");
    db.close();
    for (let reopen = 0; reopen < 2; reopen++) {
      store = createStore(path);
      assert.deepEqual(await store.events("s"), events);
      const page = await store.summaries!({ spaceId: "space" });
      assert.equal(page.sessions[0]?.id, "s");
      assert.equal(page.complete, true);
      assert.equal(page.revision, 1);
      await store.close();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("v19 upgrade backfills navigator merge receipts from the merge notice only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-merge-receipt-"));
  const path = join(dir, "sessions.db");
  const isolation = {
    kind: "git-worktree" as const, createdAt: "today", worktreePath: "/repo-isolated", worktreeBranch: "polyth/isolate/x",
    targetPath: "/repo", targetBranch: "main", baseCommit: "base",
  };
  try {
    let store = createStore(path);
    const session = (id: string, extra: Record<string, unknown> = {}) =>
      store.upsertProjection({ id, spaceId: "space", projectId: "p", title: id, status: "idle", createdAt: 1, updatedAt: 2, ...extra });
    await session("merged", { branch: "main" });
    await store.append("merged", "isolation/merged", { targetBranch: "old", commit: "1111111" });
    await store.append("merged", "isolation/merged", { targetBranch: "main", commit: "2222222" });
    await session("stuck-cleanup", { isolation: { ...isolation, state: "cleanup-pending", resultCommit: "3333333" } });
    await store.append("stuck-cleanup", "isolation/merged", { targetBranch: "main", commit: "3333333" });
    await session("re-isolated", { isolation: { ...isolation, state: "active" } });
    await store.append("re-isolated", "isolation/merged", { targetBranch: "main", commit: "4444444" });
    await session("discarded");
    await store.append("discarded", "isolation/discarded", { targetBranch: "main" });
    await store.close();
    const db = new DatabaseSync(path);
    db.exec("UPDATE schema_meta SET value = '18' WHERE key = 'version';");
    db.close();
    store = createStore(path);
    const byId = new Map((await store.summaries!({ spaceId: "space" })).sessions.map((row) => [row.id, row]));
    const merged = byId.get("merged")?.isolationMerge;
    assert.deepEqual({ targetBranch: merged?.targetBranch, commit: merged?.commit }, { targetBranch: "main", commit: "2222222" });
    assert.equal(typeof merged?.at, "number");
    assert.equal((await store.projection("stuck-cleanup"))?.isolationMerge?.commit, "3333333");
    assert.equal(byId.get("re-isolated")?.isolationMerge, undefined);
    assert.equal(byId.get("discarded")?.isolationMerge, undefined);
    await store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
