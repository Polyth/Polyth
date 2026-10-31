// Moving several selected sessions out of isolation: each is read live and
// sorted like the row menu (return / integrate / needs a look), and the plan
// runs one session at a time so merges into a shared branch never race.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { IsolationStatusDto, SessionIsolation, SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
register("./tsxHooks.mjs", import.meta.url);
const { setSessions } = await import("../../../apps/web/src/store.ts");
const { planIsolationExit, runIsolationExit } = await import("../widgets/IsolationBulkAction.tsx");
const { api } = await import("@polyth/session/web-api");

const isolation: SessionIsolation = {
  kind: "git-worktree", worktreePath: "/repo-isolated", worktreeBranch: "polyth/isolate/test",
  targetBranch: "main", targetPath: "/repo", originPath: "/repo", baseCommit: "base", createdAt: "today",
  state: "active",
};
const projection = (id: string, extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id, projectId: "bulk-test", title: id, status: "idle", createdAt: 1, updatedAt: 1, isolation, ...extra,
});
const actions = { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false };
const suggestion = (hasChanges: boolean) => ({
  eligible: hasChanges, hasChanges, targetBranch: "main", targetDirty: false, revision: "rev",
  ...(hasChanges ? {} : { reason: "no-changes" as const }),
});
const statuses: Record<string, IsolationStatusDto> = {
  "s-clean": { isolation, effectiveState: "active", suggestion: suggestion(false), actions: { ...actions, canMerge: false } },
  "s-ready": { isolation: { ...isolation, state: "merge-ready" }, effectiveState: "merge-ready", suggestion: suggestion(true), actions },
  "s-ready-2": { isolation: { ...isolation, state: "merge-ready" }, effectiveState: "merge-ready", suggestion: suggestion(true), actions },
  "s-conflict": {
    isolation: { ...isolation, state: "conflict", conflict: { files: ["a.ts"], message: "" } } as SessionIsolation,
    effectiveState: "conflict", suggestion: suggestion(true), actions,
  },
};

test("a bulk exit returns clean isolations, merges changed ones and leaves the rest", async () => {
  const original = { status: api.isolationStatus, ret: api.isolationReturn, merge: api.isolationMerge };
  const calls: string[] = [];
  setSessions("bulk-test", [
    projection("s-clean"),
    projection("s-ready"),
    projection("s-ready-2"),
    projection("s-conflict"),
    projection("s-busy", { status: "working" }),
    projection("s-plain", { isolation: undefined }),
  ]);
  statuses["s-busy"] = statuses["s-ready"]!;
  api.isolationStatus = async (id) => { calls.push(`status:${id}`); return statuses[id]!; };
  api.isolationReturn = async (id) => { calls.push(`return:${id}`); return projection(id, { isolation: undefined }); };
  api.isolationMerge = async (id) => {
    calls.push(`merge:${id}`);
    if (id === "s-ready-2") throw Object.assign(new Error("target moved"), { code: "conflict" });
    return { ok: true, commit: "c", targetBranch: "main", session: projection(id, { isolation: undefined }), finalized: true };
  };
  try {
    const ids = ["s-plain", "s-clean", "s-ready", "s-ready-2", "s-conflict", "s-busy"];
    const plan = await planIsolationExit(ids);
    assert.ok(!calls.includes("status:s-plain"), "a session the store knows is ordinary is never read");
    assert.deepEqual(plan.returns, ["s-clean"]);
    assert.deepEqual(plan.merges, ["s-ready", "s-ready-2"]);
    assert.deepEqual(plan.skipped, [
      { id: "s-conflict", code: "needs-review" },
      { id: "s-busy", code: "needs-review" },
    ]);

    calls.length = 0;
    const result = await runIsolationExit(plan);
    assert.deepEqual(calls, ["return:s-clean", "merge:s-ready", "merge:s-ready-2"], "one at a time, returns first");
    assert.equal(result.succeeded, 2);
    assert.deepEqual(result.failed.map((failure) => failure.id).sort(), ["s-busy", "s-conflict", "s-ready-2"]);
    assert.equal(result.failed.find((failure) => failure.id === "s-ready-2")?.code, "conflict");
  } finally {
    api.isolationStatus = original.status;
    api.isolationReturn = original.ret;
    api.isolationMerge = original.merge;
  }
});
