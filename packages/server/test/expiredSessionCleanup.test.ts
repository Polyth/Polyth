import test from "node:test";
import assert from "node:assert/strict";

import type { QueueItemDto, SessionProjection } from "@polyth/contracts";
import {
  autoCleanupPreference,
  createExpiredSessionPolicy,
  sessionsKeptByPeople,
  startExpiredSessionCleanup,
  sweepExpiredSessions,
  type ExpiredCleanupPreference,
  type ExpiredSessionSource,
} from "../src/expiredSessionCleanup.ts";
import type { SessionAccountDeps } from "../src/failedStartupCleanup.ts";

const DAY = 24 * 60 * 60_000;
const NOW = 1000 * DAY;

const row = (id: string, extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id,
  projectId: "p",
  spaceId: "space-1",
  title: id,
  status: "idle",
  createdAt: NOW - 90 * DAY,
  updatedAt: NOW - 90 * DAY,
  ...extra,
});

const auto = (days?: number, action?: string) => ({
  product: { autoCleanupExpiredSessions: true },
  sessionDefaults: {
    ...(days === undefined ? {} : { retentionDays: days }),
    ...(action === undefined ? {} : { retentionAction: action }),
  },
});

test("automatic cleanup needs an explicit opt-in and reads the person's period and action", () => {
  assert.equal(autoCleanupPreference(null), undefined);
  assert.equal(autoCleanupPreference({}), undefined);
  assert.equal(autoCleanupPreference({ sessionDefaults: { retentionDays: 5, retentionAction: "delete" } }), undefined);
  assert.equal(autoCleanupPreference({ product: { autoCleanupExpiredSessions: false } }), undefined);
  assert.equal(autoCleanupPreference({ product: { autoCleanupExpiredSessions: "true" } }), undefined);
  assert.deepEqual(autoCleanupPreference(auto()), { days: 30, action: "archive" });
  assert.deepEqual(autoCleanupPreference(auto(5, "delete")), { days: 5, action: "delete" });
  assert.deepEqual(autoCleanupPreference(auto(0, "shred")), { days: 1, action: "archive" });
  assert.deepEqual(autoCleanupPreference(auto(99_999)), { days: 3650, action: "archive" });
});

const accounts = (input: {
  rows?: SessionProjection[];
  recipients?: Record<string, string>;
  settings: Record<string, unknown>;
  members?: string[];
}): SessionAccountDeps => ({
  spaceOf: (projection) => projection.spaceId,
  accountForSession: async (sessionId) => input.recipients?.[sessionId],
  members: () => input.members ?? Object.keys(input.settings),
  settingsFor: (userId) => input.settings[userId] ?? {},
  projection: async (sessionId) => input.rows?.find((candidate) => candidate.id === sessionId),
});

test("the recorded owner's choice decides, and nobody else's reaches their chats", async () => {
  const policy = createExpiredSessionPolicy(accounts({
    recipients: { "alice-chat": "alice", "bob-chat": "bob" },
    settings: { alice: auto(5, "delete"), bob: {} },
  }));
  assert.deepEqual(await policy.forSession(row("alice-chat")), { days: 5, action: "delete" });
  assert.equal(await policy.forSession(row("bob-chat")), undefined);
  assert.equal(policy.shortestDays("space-1"), 5);
});

test("a delegated child follows its nearest recorded ancestor", async () => {
  const rows = [row("root"), row("child", { parentId: "root" })];
  const policy = createExpiredSessionPolicy(accounts({
    rows,
    recipients: { root: "alice" },
    settings: { alice: auto(7), bob: {} },
  }));
  assert.deepEqual(await policy.forSession(rows[1]!), { days: 7, action: "archive" });
});

test("a session with no recorded account needs every member, on the gentlest terms", async () => {
  const allIn = createExpiredSessionPolicy(accounts({
    settings: { alice: auto(5, "delete"), bob: auto(20, "archive") },
  }));
  assert.deepEqual(await allIn.forSession(row("nobody")), { days: 20, action: "archive" });
  assert.equal(allIn.shortestDays("space-1"), 5);

  const allDelete = createExpiredSessionPolicy(accounts({
    settings: { alice: auto(5, "delete"), bob: auto(20, "delete") },
  }));
  assert.deepEqual(await allDelete.forSession(row("nobody")), { days: 20, action: "delete" });

  const oneOut = createExpiredSessionPolicy(accounts({ settings: { alice: auto(5), bob: {} } }));
  assert.equal(await oneOut.forSession(row("nobody")), undefined);

  const empty = createExpiredSessionPolicy(accounts({ settings: {} }));
  assert.equal(await empty.forSession(row("nobody")), undefined);
  assert.equal(empty.shortestDays("space-1"), undefined);
});

test("an unresolvable Space keeps the session", async () => {
  const policy = createExpiredSessionPolicy({
    ...accounts({ settings: { alice: auto(5) } }),
    spaceOf: () => undefined,
  });
  assert.equal(await policy.forSession(row("lost")), undefined);
});

test("another person's pin or draft keeps a session", () => {
  const kept = sessionsKeptByPeople(["a", "b", "c", "d"], ["alice", "bob"], (_ids, personId) => personId === "alice"
    ? { a: { pinned: { position: 0 } }, c: { pinned: null } }
    : { b: { draft: "later" }, d: { draft: "  " } });
  assert.deepEqual([...kept].sort(), ["a", "b"]);
});

const source = (input: {
  rows: SessionProjection[];
  queue?: Record<string, number>;
  fresh?: Record<string, Partial<SessionProjection>>;
  fail?: Record<string, string>;
}): ExpiredSessionSource & { archived: string[]; deleted: string[]; listed: number } => {
  const state = {
    archived: [] as string[],
    deleted: [] as string[],
    listed: 0,
    list: async () => { state.listed += 1; return input.rows; },
    snapshot: async (id: string) => ({ ...input.rows.find((candidate) => candidate.id === id)!, ...input.fresh?.[id] }),
    queueList: async (id: string) => Array.from({ length: input.queue?.[id] ?? 0 }, () => ({}) as QueueItemDto),
    archive: async (id: string) => {
      if (input.fail && id in input.fail) throw Object.assign(new Error("no"), { code: input.fail[id] });
      state.archived.push(id);
    },
    delete: async (id: string) => {
      if (input.fail && id in input.fail) throw Object.assign(new Error("no"), { code: input.fail[id] });
      state.deleted.push(id);
    },
  };
  return state;
};

const fixedPolicy = (preference: ExpiredCleanupPreference | undefined, seen: string[] = []) => ({
  forSession: async (projection: SessionProjection) => { seen.push(projection.id); return preference; },
});

const sweep = (
  sessions: ExpiredSessionSource,
  preference: ExpiredCleanupPreference | undefined,
  extra: Partial<Parameters<typeof sweepExpiredSessions>[0]> = {},
) => sweepExpiredSessions({
  sessions,
  policy: fixedPolicy(preference),
  shortestDays: preference?.days,
  now: () => NOW,
  pause: async () => {},
  ...extra,
});

test("with nobody opted in the sweep does not even list sessions", async () => {
  const sessions = source({ rows: [row("old")] });
  const result = await sweep(sessions, undefined);
  assert.equal(sessions.listed, 0);
  assert.deepEqual(result, { scanned: 0, archived: [], deleted: [], failed: [] });
});

test("the sweep archives expired sessions and leaves the rest alone", async () => {
  const sessions = source({ rows: [
    row("old"),
    row("recent", { updatedAt: NOW - DAY }),
    row("working", { status: "working" }),
    row("pinned", { pinned: { position: 0 } }),
    row("archived", { status: "archived" }),
    row("agent", { purpose: "agent" }),
    row("kept-by-person"),
  ] });
  const result = await sweep(sessions, { days: 30, action: "archive" }, { keep: () => new Set(["kept-by-person"]) });
  assert.deepEqual(sessions.archived, ["old"]);
  assert.deepEqual(sessions.deleted, []);
  assert.deepEqual(result, { scanned: 7, archived: ["old"], deleted: [], failed: [] });
});

test("each session is held to the period its owner chose, not the shortest in the Space", async () => {
  const rows = [
    row("alice-old", { updatedAt: NOW - 10 * DAY }),
    row("bob-old", { updatedAt: NOW - 10 * DAY }),
  ];
  const sessions = source({ rows });
  await sweepExpiredSessions({
    sessions,
    policy: {
      forSession: async (projection) => projection.id === "alice-old"
        ? { days: 5, action: "archive" }
        : { days: 30, action: "archive" },
    },
    shortestDays: 5,
    now: () => NOW,
    pause: async () => {},
  });
  assert.deepEqual(sessions.archived, ["alice-old"]);
});

test("a tree is cleaned once, from its topmost expired session", async () => {
  const seen: string[] = [];
  const sessions = source({ rows: [
    row("child", { parentId: "root" }),
    row("root"),
    row("grandchild", { parentId: "child" }),
    row("archived-parent", { status: "archived" }),
    row("left-behind", { parentId: "archived-parent" }),
  ] });
  await sweepExpiredSessions({
    sessions,
    policy: fixedPolicy({ days: 30, action: "archive" }, seen),
    shortestDays: 30,
    now: () => NOW,
    pause: async () => {},
  });
  assert.deepEqual(seen.sort(), ["left-behind", "root"]);
  assert.deepEqual(sessions.archived.sort(), ["left-behind", "root"]);
});

test("delete applies only with certainty; anything else is archived, which loses nothing", async () => {
  const sessions = source({ rows: [
    row("plain"),
    row("failed", { status: "failed" }),
    row("unknown", { status: "unknown" }),
    row("epoch-pending", { status: "epoch-pending" }),
    row("worktree", { worktreePath: "/tmp/w" }),
    row("isolated", { isolation: {} as SessionProjection["isolation"] }),
    row("workspace", { workspace: { repositories: [{ isolation: {} }] } as unknown as SessionProjection["workspace"] }),
    row("parent-of-isolated"),
    row("isolated-child", { parentId: "parent-of-isolated", isolation: {} as SessionProjection["isolation"] }),
    row("parent-of-archived-isolated"),
    row("archived-isolated-child", {
      parentId: "parent-of-archived-isolated",
      status: "archived",
      isolation: {} as SessionProjection["isolation"],
    }),
    row("parent-of-archived"),
    row("archived-child", { parentId: "parent-of-archived", status: "archived" }),
  ] });
  await sweep(sessions, { days: 30, action: "delete" });
  assert.deepEqual(sessions.deleted, ["plain", "failed", "parent-of-archived"]);
  assert.deepEqual(sessions.archived, [
    "unknown", "epoch-pending", "worktree", "isolated", "workspace", "parent-of-isolated", "parent-of-archived-isolated",
  ]);
});

test("delete falls back to archive when the service cannot delete", async () => {
  const { delete: _delete, ...withoutDelete } = source({ rows: [row("old")] });
  const archived: string[] = [];
  await sweep({ ...withoutDelete, archive: async (id) => { archived.push(id); } }, { days: 30, action: "delete" });
  assert.deepEqual(archived, ["old"]);
});

test("queued delivery anywhere in the tree keeps it", async () => {
  const sessions = source({
    rows: [row("queued"), row("root"), row("child", { parentId: "root" }), row("plain")],
    queue: { queued: 1, child: 2 },
  });
  await sweep(sessions, { days: 30, action: "archive" });
  assert.deepEqual(sessions.archived, ["plain"]);
});

test("a session touched since the list wins", async () => {
  const sessions = source({
    rows: [row("resumed"), row("reused"), row("plain")],
    fresh: { resumed: { status: "working" }, reused: { updatedAt: NOW } },
  });
  await sweep(sessions, { days: 30, action: "archive" });
  assert.deepEqual(sessions.archived, ["plain"]);
});

test("one failure keeps that session and the pass goes on", async () => {
  const sessions = source({ rows: [row("broken"), row("silent"), row("plain")], fail: { broken: "conflict", silent: "" } });
  const result = await sweep(sessions, { days: 30, action: "archive" });
  assert.deepEqual(result.archived, ["plain"]);
  assert.deepEqual(result.failed, [{ id: "broken", code: "conflict" }, { id: "silent", code: "internal" }]);
});

test("the sweep paces its actions and stops when asked", async () => {
  const sessions = source({ rows: [row("a"), row("b"), row("c")] });
  let pauses = 0;
  await sweep(sessions, { days: 30, action: "archive" }, {
    pause: async () => { pauses += 1; },
    stopped: () => pauses >= 2,
  });
  assert.equal(pauses, 2);
  assert.deepEqual(sessions.archived, ["a", "b"]);
});

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200 && !condition(); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(condition(), true);
};

const schedule = (input: { settings: Record<string, unknown>; rows: SessionProjection[] }) => {
  const sessions = source({ rows: input.rows.map((candidate) => ({ ...candidate, updatedAt: Date.now() - 90 * DAY })) });
  const log = console.log;
  console.log = () => {};
  const cleanup = startExpiredSessionCleanup({
    spaceIds: () => ["space-1"],
    sessionsFor: () => sessions,
    policy: createExpiredSessionPolicy(accounts({ settings: input.settings })),
    keep: () => new Set(),
    stopped: () => false,
    firstDelayMs: 60_000,
    intervalMs: 60_000,
    settingsDelayMs: 1,
    pause: async () => {},
  });
  return { sessions, cleanup, restore: () => { console.log = log; } };
};

test("turning it on runs soon; an unrelated settings write does not run again", async () => {
  const settings: Record<string, unknown> = { alice: auto(5) };
  const { sessions, cleanup, restore } = schedule({ settings, rows: [row("old")] });
  try {
    cleanup.settingsChanged("alice", settings.alice);
    await waitFor(() => sessions.listed === 1);

    cleanup.settingsChanged("alice", { ...auto(5), ui: { density: "compact" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sessions.listed, 1);

    cleanup.settingsChanged("alice", auto(9));
    await waitFor(() => sessions.listed === 2);
  } finally {
    await cleanup.stop();
    restore();
  }
});

test("turning it off never starts a pass, and stop ends the schedule", async () => {
  const settings: Record<string, unknown> = { alice: {} };
  const { sessions, cleanup, restore } = schedule({ settings, rows: [row("old")] });
  try {
    cleanup.settingsChanged("alice", { product: { autoCleanupExpiredSessions: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sessions.listed, 0);

    await cleanup.stop();
    cleanup.settingsChanged("alice", auto(5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sessions.listed, 0);
  } finally {
    await cleanup.stop();
    restore();
  }
});
