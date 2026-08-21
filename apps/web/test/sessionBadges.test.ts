// Finding 3 (UX-SHELL-CONSOLIDATION-02): session status badge derivation.
// Pure over the existing SessionProjection — no event-log shape change.
import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import { sessionStatusBadge } from "../src/sessionBadges.ts";

const NOW = 1_000_000_000;
const s = (over: Partial<SessionProjection>): SessionProjection => ({
  id: "s", projectId: "p", title: "t", status: "idle",
  createdAt: NOW - 600_000, updatedAt: NOW - 120_000,
  ...over,
});

test("running: elapsed derives from lastTurnAt (fallback updatedAt), never negative", () => {
  assert.deepEqual(
    sessionStatusBadge(s({ status: "working", lastTurnAt: NOW - 90_000 }), NOW),
    { kind: "running", elapsedMs: 90_000 },
  );
  assert.deepEqual(
    sessionStatusBadge(s({ status: "working" }), NOW),
    { kind: "running", elapsedMs: 120_000 },
  );
  assert.deepEqual(
    sessionStatusBadge(s({ status: "working", lastTurnAt: NOW + 5_000 }), NOW),
    { kind: "running", elapsedMs: 0 },
  );
});

test("waiting: badge only when the ?N/!N attention badges are not already shown", () => {
  assert.deepEqual(sessionStatusBadge(s({ status: "waiting" }), NOW), { kind: "waiting" });
  assert.equal(
    sessionStatusBadge(s({ status: "waiting", attention: { questions: 1, permissions: 0, unread: 0 } }), NOW),
    null,
  );
  assert.equal(
    sessionStatusBadge(s({ status: "waiting", attention: { questions: 0, permissions: 2, unread: 0 } }), NOW),
    null,
  );
});

test("completed and merged (lite: branch recorded + worktree removed)", () => {
  assert.deepEqual(sessionStatusBadge(s({ status: "finished" }), NOW), { kind: "completed" });
  assert.deepEqual(
    sessionStatusBadge(s({ status: "idle", branch: "feat/x", worktreePath: "/wt/x", worktreeState: "missing" }), NOW),
    { kind: "merged" },
  );
  // merged wins over completed for a finished, cleaned-up worktree session
  assert.deepEqual(
    sessionStatusBadge(s({ status: "finished", branch: "feat/x", worktreeState: "missing" }), NOW),
    { kind: "merged" },
  );
  // a live worktree is not merged
  assert.equal(
    sessionStatusBadge(s({ status: "idle", branch: "feat/x", worktreeState: "ready" }), NOW),
    null,
  );
});

test("read + nothing pending → NO badge (idle, failed, archived)", () => {
  assert.equal(sessionStatusBadge(s({ status: "idle" }), NOW), null);
  assert.equal(sessionStatusBadge(s({ status: "failed" }), NOW), null);
  assert.equal(sessionStatusBadge(s({ status: "archived" }), NOW), null);
  assert.equal(
    sessionStatusBadge(s({ status: "idle", attention: { questions: 0, permissions: 0, unread: 0 } }), NOW),
    null,
  );
});
