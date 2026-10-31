import test from "node:test";
import assert from "node:assert/strict";

import type { QueueItemDto, SessionEvent, SessionProjection } from "@polyth/contracts";
import { sweepPristineSessions, type PristineSessionSource } from "../src/sessionSweep.ts";

const HOUR = 60 * 60_000;
const NOW = 100 * HOUR;

const projection = (
  id: string,
  extra: Partial<SessionProjection> = {},
): SessionProjection => ({
  id,
  projectId: "p",
  title: id,
  status: "unknown",
  createdAt: NOW - 2 * HOUR,
  updatedAt: NOW - 2 * HOUR,
  ...extra,
});

const event = (type: string, data: Record<string, unknown> = {}): SessionEvent =>
  ({ id: "e", sessionId: "s", seq: 1, time: NOW, type, data, v: 1 }) as unknown as SessionEvent;

const pristineLog = (): SessionEvent[] => [
  event("session/created"),
  event("mutation/prepared", { mutationKind: "session-create" }),
  event("mutation/confirmed", { mutationKind: "session-create" }),
  event("reconciliation/started"),
  event("runtime/status-observed", { state: "idle" }),
  event("reconciliation/completed", { state: "ready" }),
];

const source = (input: {
  rows: SessionProjection[];
  events?: Record<string, SessionEvent[]>;
  queue?: Record<string, QueueItemDto[]>;
  remove?: (id: string, options?: { expectedLastEventSeq?: number; expectedUpdatedAt?: number }) => Promise<void>;
}): PristineSessionSource & { removed: string[] } => {
  const removed: string[] = [];
  return {
    removed,
    list: async () => input.rows,
    events: async (id) => input.events?.[id] ?? pristineLog(),
    queueList: async (id) => input.queue?.[id] ?? [],
    delete: async (id, options) => {
      if (input.remove) await input.remove(id, options);
      removed.push(id);
    },
  };
};

test("sweep deletes old pristine sessions and keeps every protected shape", async () => {
  const rows = [
    // eligible: empty create lifecycle, old, draft-free
    projection("empty-garbage"),
    // protected: too young to reclaim
    projection("recent", { createdAt: NOW - 5 * 60_000, updatedAt: NOW - 5 * 60_000 }),
    // protected: unsent composer text
    projection("draft", { draft: "half a thought" }),
    // protected: delegated child, and its parent because the child references it
    projection("child", { parentId: "parent" }),
    projection("parent"),
    // protected: lifecycle states that mean live work
    projection("working", { status: "working" }),
    projection("waiting", { status: "waiting" }),
    // protected: archived sessions follow retention, not this sweep
    projection("archived", { status: "archived" }),
    // protected: successful empty sessions and owned/package workspaces are
    // intentional resources, not failed-startup garbage
    projection("idle", { status: "idle" }),
    projection("worktree", { worktreePath: "/tmp/owned-worktree" }),
    projection("purpose", { purpose: "review" }),
    // protected: real content and other activity
    projection("prompted"),
    projection("activity"),
    // protected: queued delivery is durable user intent
    projection("queued"),
  ];
  const sessions = source({
    rows,
    events: {
      "empty-garbage": pristineLog(),
      "recent": pristineLog(),
      "draft": pristineLog(),
      "child": pristineLog(),
      "parent": pristineLog(),
      "working": pristineLog(),
      "waiting": pristineLog(),
      "archived": pristineLog(),
      "idle": pristineLog(),
      "worktree": pristineLog(),
      "purpose": pristineLog(),
      "prompted": [event("session/created"), event("user/message", { text: "hi" })],
      "activity": [event("session/created"), event("browser/action-requested")],
      "queued": pristineLog(),
    },
    queue: {
      queued: [{ id: "q1" } as unknown as QueueItemDto],
    },
  });

  const result = await sweepPristineSessions({ sessions, now: () => NOW });

  assert.deepEqual(result.deleted, ["empty-garbage"]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.eligible, 1);
  assert.equal(result.scanned, rows.length);
  assert.deepEqual(sessions.removed, ["empty-garbage"]);
});

test("sweep tolerates a missing or failing delete without touching other sessions", async () => {
  const withoutDelete: PristineSessionSource = {
    list: async () => [projection("a")],
    events: async () => pristineLog(),
  };
  const skipped = await sweepPristineSessions({ sessions: withoutDelete, now: () => NOW });
  assert.deepEqual(skipped.deleted, []);
  assert.equal(skipped.eligible, 0);

  const failing = source({
    rows: [projection("boom"), projection("ok")],
    remove: async (id) => {
      if (id === "boom") throw Object.assign(new Error("locked"), { code: "conflict" });
    },
  });
  const result = await sweepPristineSessions({ sessions: failing, now: () => NOW });
  assert.deepEqual(result.deleted, ["ok"]);
  assert.deepEqual(result.failed, [{ id: "boom", code: "conflict" }]);
});

test("sweep guards deletion against content and projection races", async () => {
  const calls: Array<{ id: string; expectedLastEventSeq?: number; expectedUpdatedAt?: number }> = [];
  const sessions = source({
    rows: [projection("guarded", { updatedAt: NOW - HOUR })],
    remove: async (id, options) => { calls.push({ id, ...options }); },
  });
  await sweepPristineSessions({ sessions, now: () => NOW });
  assert.deepEqual(calls, [{ id: "guarded", expectedLastEventSeq: 1, expectedUpdatedAt: NOW - HOUR }]);
});

test("sweep refuses a negative grace and honors an explicit zero", async () => {
  const sessions = source({ rows: [projection("just-created", { createdAt: NOW, updatedAt: NOW })] });
  await assert.rejects(
    () => sweepPristineSessions({ sessions, graceMs: -1 }),
    /non-negative/,
  );
  const result = await sweepPristineSessions({ sessions, graceMs: 0, now: () => NOW });
  assert.deepEqual(result.deleted, ["just-created"]);
});

test("sweep keeps every pristine session its owner chose not to auto-delete", async () => {
  const sessions = source({ rows: [projection("kept-a"), projection("kept-b", { status: "failed" }), projection("allowed")] });
  const asked: string[] = [];
  const result = await sweepPristineSessions({
    sessions,
    now: () => NOW,
    allowDelete: async (row) => { asked.push(row.id); return row.id === "allowed"; },
  });
  assert.deepEqual(result.deleted, ["allowed"]);
  assert.deepEqual(sessions.removed, ["allowed"]);
  assert.deepEqual(asked.sort(), ["allowed", "kept-a", "kept-b"]);
});
