// One indexed read for every event tail of a Space (Usage checks them on each report).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionProjection } from "@polyth/contracts";
import { createStore } from "../src/index.ts";

const proj = (id: string, spaceId: string | undefined, projectId: string): SessionProjection => ({
  id, projectId, ...(spaceId ? { spaceId } : {}), title: id, status: "idle", createdAt: 1, updatedAt: 1,
});

test("latestSeqs returns every tail of one Space and nothing from another", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-tails-"));
  const store = createStore(join(dir, "s.db"));
  try {
    await store.upsertProjection(proj("a", "sp", "p"));
    await store.upsertProjection(proj("b", "sp", "q"));
    await store.upsertProjection(proj("empty", "sp", "p"));
    await store.upsertProjection(proj("foreign", "other", "p"));
    await store.upsertProjection(proj("legacy", undefined, "p"));
    for (const id of ["a", "a", "a", "b", "foreign", "foreign", "legacy"]) await store.append(id, "assistant/message", { text: id });

    assert.deepEqual([...(await store.latestSeqs!({ spaceId: "sp" }))].sort(), [["a", 3], ["b", 1], ["empty", 0]]);
    assert.deepEqual([...(await store.latestSeqs!({ spaceId: "sp", projectId: "p" }))].sort(), [["a", 3], ["empty", 0]]);
    assert.deepEqual([...(await store.latestSeqs!({ spaceId: "other" }))], [["foreign", 2]]);
    assert.deepEqual([...(await store.latestSeqs!({ spaceId: "missing" }))], []);
    // The same answer as the per-session lookup it replaces.
    for (const [id, seq] of await store.latestSeqs!({ spaceId: "sp" })) assert.equal(seq, await store.latestSeq(id));
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
