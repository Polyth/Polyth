import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/index.ts";

test("forward pages select the earliest contiguous suffix; newest windows keep their old meaning", async () => {
  const store = createStore(":memory:");
  try {
    await store.appendBatch!("s", Array.from({ length: 1200 }, (_, i) => ({ type: "assistant/chunk", data: { delta: String(i) } })));
    assert.deepEqual((await store.events("s", 0, { limit: 3 })).map((e) => e.seq), [1198, 1199, 1200]);
    const first = await store.events("s", 100, { direction: "forward", throughSeq: 1100, limit: 3 });
    assert.deepEqual(first.map((e) => e.seq), [101, 102, 103]);
    await store.append("s", "test/event", {});
    assert.deepEqual((await store.events("s", 1099, { direction: "forward", throughSeq: 1100 })).map((e) => e.seq), [1100]);
    assert.ok((await store.events("s", 0, { direction: "forward", maxBytes: 1200 })).length <= 2);
    await assert.rejects(store.events("s", 10, { direction: "forward", throughSeq: 9 }), /invalid replay cursor/);
  } finally { await store.close(); }
});

test("summaries page stable ties, query the whole Space, and never disclose runtime details or foreign IDs", async () => {
  const store = createStore(":memory:");
  try {
    for (let i = 0; i < 120; i++) await store.upsertProjection({
      id: `s${String(i).padStart(3, "0")}`, spaceId: "a", projectId: "p", title: `Chat ${i}`, status: "idle", createdAt: 1, updatedAt: 1, draft: "private draft", backendSessionId: "native-secret", worktreePath: "/test",
    });
    // The status-resolving fields must survive the summary projection: without
    // them a row shows a failure or a false runtime warning until it is opened.
    await store.patchProjection!("s000", (row) => ({
      ...row,
      status: "failed",
      resume: { resumeAt: 9, scope: "quota", attempt: 1, userMessageSeq: 1 },
      runtimeControl: "owned",
      harnessTransition: { id: "switch-1", selection: { mode: "auto" }, targetHarnessId: "cursor", timing: "after-turn", phase: "requested" },
    }));
    await store.upsertProjection({ id: "valid-foreign", spaceId: "b", projectId: "q", title: "foreign", status: "idle", createdAt: 1, updatedAt: 1 });
    const first = await store.summaries!({ spaceId: "a", projectId: "p" });
    assert.equal(first.sessions.length, 50);
    assert.equal(first.complete, false);
    assert.equal(first.sessions[0]?.id, "s119");
    assert.equal(first.sessions[0]?.draft, undefined);
    assert.equal(first.sessions[0]?.backendSessionId, undefined);
    const second = await store.summaries!({ spaceId: "a", projectId: "p", cursor: first.next });
    assert.equal(second.sessions[0]?.id, "s069");
    assert.equal(second.revision, first.revision);
    const search = await store.summaries!({ spaceId: "a", query: "Chat 0" });
    assert.deepEqual(search.sessions.map((r) => r.id), ["s000"]);
    assert.equal(search.sessions[0]?.resume?.attempt, 1);
    assert.equal(search.sessions[0]?.runtimeControl, "owned");
    assert.equal(search.sessions[0]?.harnessTransition?.phase, "requested");
    assert.equal((await store.summaries!({ spaceId: "a", projectId: "q" })).sessions.length, 0);
    await store.patchProjection!("valid-foreign", (row) => ({ ...row, title: "changed" }));
    assert.equal((await store.summaries!({ spaceId: "a" })).revision, first.revision);
    assert.equal((await store.summaries!({ spaceId: "a", worktreePath: "/absent" })).sessions.length, 0);
    // A reconnect re-reads named rows across projects, still inside the Space.
    const named = await store.summaries!({ spaceId: "a", ids: ["s007", "s000", "valid-foreign", "s007", "missing"] });
    assert.deepEqual(named.sessions.map((r) => r.id).sort(), ["s000", "s007"]);
    assert.equal(named.sessions[0]?.draft, undefined);
    assert.equal((await store.summaries!({ spaceId: "a", ids: [] })).sessions.length, 0, "no ids, no rows");
    await store.patchProjection!("s000", (row) => ({ ...row, updatedAt: 2 }));
    await assert.rejects(async () => store.summaries!({ spaceId: "a", cursor: first.next, revision: first.revision }), { code: "catalog-changed" });
  } finally { await store.close(); }
});
