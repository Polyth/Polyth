// The fixed sidebar status zone has one mutually exclusive state.
import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import { sessionRowStatus } from "../src/sessionBadges.ts";

const NOW = 1_000_000_000;
const s = (over: Partial<SessionProjection>): SessionProjection => ({
  id: "s", projectId: "p", title: "t", status: "idle",
  createdAt: NOW - 600_000, updatedAt: NOW - 120_000,
  ...over,
});

test("running: elapsed derives from lastTurnAt (fallback updatedAt), never negative", () => {
  assert.deepEqual(
    sessionRowStatus(s({ status: "working", lastTurnAt: NOW - 90_000 }), NOW),
    { kind: "working", elapsedMs: 90_000 },
  );
  assert.deepEqual(
    sessionRowStatus(s({ status: "working" }), NOW),
    { kind: "working", elapsedMs: 120_000 },
  );
  assert.deepEqual(
    sessionRowStatus(s({ status: "working", lastTurnAt: NOW + 5_000 }), NOW),
    { kind: "working", elapsedMs: 0 },
  );
});

test("action-needed states win over activity and remain mutually exclusive", () => {
  assert.deepEqual(sessionRowStatus(s({ status: "waiting" }), NOW), { kind: "needs-reply" });
  assert.deepEqual(
    sessionRowStatus(s({ status: "working", attention: { questions: 1, permissions: 0, unread: 2 } }), NOW),
    { kind: "needs-reply" },
  );
  assert.deepEqual(
    sessionRowStatus(s({ status: "waiting", attention: { questions: 3, permissions: 2, unread: 4 } }), NOW),
    { kind: "needs-approval" },
  );
});

test("unread maps to the compact unread state", () => {
  assert.deepEqual(
    sessionRowStatus(s({ attention: { questions: 0, permissions: 0, unread: 2 } }), NOW),
    { kind: "unread" },
  );
});

test("read idle, finished, failed, archived, and worktree sessions are regular", () => {
  for (const session of [
    s({ status: "idle" }),
    s({ status: "finished" }),
    s({ status: "failed" }),
    s({ status: "archived" }),
    s({ status: "idle", attention: { questions: 0, permissions: 0, unread: 0 } }),
    s({ status: "idle", branch: "feat/x", worktreeState: "ready" }),
    s({ status: "idle", branch: "feat/x", worktreeState: "missing" }),
  ]) assert.deepEqual(sessionRowStatus(session, NOW), { kind: "regular" });
});
