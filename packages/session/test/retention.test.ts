import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import { archivedSessionRetentionSummary, sessionRetentionSummary } from "@polyth/session";

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
