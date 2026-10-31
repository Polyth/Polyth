import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import {
  archivedSessionRetentionSummary,
  isPristineSessionLog,
  sessionRetentionSummary,
} from "@polyth/session";

const DAY = 24 * 60 * 60_000;
const session = (id: string, status: SessionProjection["status"], updatedAt: number): SessionProjection => ({
  id,
  projectId: "p",
  title: id,
  status,
  createdAt: updatedAt,
  updatedAt,
});

test("retention includes only inactive unarchived sessions older than cutoff", () => {
  const now = 100 * DAY;
  const result = sessionRetentionSummary([
    session("old-idle", "idle", now - 31 * DAY),
    session("recent", "finished", now - 2 * DAY),
    session("working", "working", now - 90 * DAY),
    session("waiting", "waiting", now - 90 * DAY),
    session("archived", "archived", now - 90 * DAY),
  ], 30, now);

  assert.equal(result.days, 30);
  assert.deepEqual(result.eligible.map((item) => item.id), ["old-idle"]);
});

test("archived retention includes only old archived sessions", () => {
  const now = 100 * DAY;
  const result = archivedSessionRetentionSummary([
    session("old-archive", "archived", now - 31 * DAY),
    session("recent-archive", "archived", now - 2 * DAY),
    session("old-idle", "idle", now - 90 * DAY),
  ], 30, now);

  assert.deepEqual(result.eligible.map((item) => item.id), ["old-archive"]);
});

const event = (type: string, data: Record<string, unknown> = {}): Pick<SessionEvent, "type" | "data"> =>
  ({ type, data }) as Pick<SessionEvent, "type" | "data">;

test("pristine logs contain only the create/reconcile lifecycle", () => {
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("mutation/prepared", { mutationKind: "session-create" }),
    event("mutation/confirmed", { mutationKind: "session-create" }),
    event("reconciliation/started"),
    event("runtime/status-observed", { state: "idle" }),
    event("reconciliation/completed"),
  ]), true);
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("mutation/rejected", { mutationKind: "session-create" }),
  ]), true);
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("mutation/uncertainty-recorded", { mutationKind: "session-create" }),
  ]), true);
});

test("pristine check is fail-closed for turns, activity, and unknown events", () => {
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("user/message"),
  ]), false);
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("mutation/confirmed", { mutationKind: "turn-submit" }),
  ]), false);
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("browser/action-requested"),
  ]), false);
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("queue/enqueued"),
  ]), false);
  assert.equal(isPristineSessionLog([
    event("session/created"),
    event("future/unknown-event"),
  ]), false);
  assert.equal(isPristineSessionLog([]), false);
  assert.equal(isPristineSessionLog([event("reconciliation/completed")]), false);
});
