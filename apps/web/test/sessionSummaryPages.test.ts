import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSessionSummaries, createSummaryPager } from "../src/sessionSummaryPages.ts";
import type { SessionSummaryPage, SessionSummaryQuery } from "@polyth/contracts";

test("navigator restarts a changed catalog once and ignores a superseded page", async () => {
  const calls: SessionSummaryQuery[] = [];
  let finishOld!: (page: SessionSummaryPage) => void;
  const published: string[] = [];
  const pager = createSummaryPager(async (query) => {
    calls.push(query);
    if (query.query === "old") return new Promise<SessionSummaryPage>((resolve) => { finishOld = resolve; });
    if (query.cursor) throw Object.assign(new Error("changed"), { code: "catalog-changed" });
    return { sessions: [{ id: query.query!, projectId: "p", title: "", status: "idle", createdAt: 1, updatedAt: 1 }], revision: calls.length,
      complete: false, next: { id: "cursor", updatedAt: 1 } };
  }, (rows) => published.push(...rows.map((row) => row.id)), () => {});
  pager.reset({ query: "old" });
  const old = pager.more();
  pager.reset({ query: "new" });
  await pager.more();
  finishOld({ sessions: [], revision: 0, complete: true });
  await old;
  await pager.more();
  assert.deepEqual(published, ["new", "new"]);
  assert.equal(calls.length, 4);
  assert.equal(calls[2]?.revision, 2);
  assert.equal(calls[3]?.cursor, undefined);
  pager.cancel();
});

test("bulk actions collect beyond the visible page and refuse incomplete or changed selections", async () => {
  const calls: unknown[] = [];
  const rows = await collectSessionSummaries(async (query) => {
    calls.push(query);
    const offset = query.cursor ? Number(query.cursor.id) : 0;
    return { sessions: Array.from({ length: offset === 500 ? 3 : 100 }, (_, i) => ({ id: String(offset + i), projectId: "p", title: "", status: "idle", createdAt: 1, updatedAt: 1 })),
      complete: offset === 500, revision: 7, next: { id: String(offset + 100), updatedAt: 1 } };
  }, { projectId: "p", worktreePath: "/checkout" }, new AbortController().signal);
  assert.equal(rows.length, 503);
  assert.equal(calls.length, 6);
  assert.equal((calls[1] as { revision: number }).revision, 7);
  let revision = 0;
  await assert.rejects(collectSessionSummaries(async () => ({ sessions: [], complete: false, revision: ++revision, next: { id: String(revision), updatedAt: 1 } }), {}, new AbortController().signal), /catalog changed/);
  await assert.rejects(collectSessionSummaries(async () => ({ sessions: [], complete: false, revision: 1 }), {}, new AbortController().signal), /did not advance/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(collectSessionSummaries(async () => { throw new Error("must not read"); }, {}, cancelled.signal), { name: "AbortError" });
});
