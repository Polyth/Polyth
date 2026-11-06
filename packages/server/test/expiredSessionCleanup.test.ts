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

const auto = (days?: number, action?: string, skipIsolated?: unknown) => ({
  product: { autoCleanupExpiredSessions: true },
  sessionDefaults: {
    ...(days === undefined ? {} : { retentionDays: days }),
    ...(action === undefined ? {} : { retentionAction: action }),
    ...(skipIsolated === undefined ? {} : { retentionSkipIsolated: skipIsolated }),
  },
});

const isolation = (): NonNullable<SessionProjection["isolation"]> => ({
  kind: "git-worktree",
  state: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  worktreePath: "/repo-polyth-isolate/x",
  worktreeBranch: "polyth/isolate/x",
  targetPath: "/repo",
  targetBranch: "main",
  baseCommit: "abc",
} as NonNullable<SessionProjection["isolation"]>);

test("automatic cleanup needs an explicit opt-in and reads the person's period and action", () => {
  assert.equal(autoCleanupPreference(null), undefined);
  assert.equal(autoCleanupPreference({}), undefined);
  assert.equal(autoCleanupPreference({ sessionDefaults: { retentionDays: 5, retentionAction: "delete" } }), undefined);
  assert.equal(autoCleanupPreference({ product: { autoCleanupExpiredSessions: false } }), undefined);
  assert.equal(autoCleanupPreference({ product: { autoCleanupExpiredSessions: "true" } }), undefined);
  assert.deepEqual(autoCleanupPreference(auto()), { days: 30, action: "archive", skipIsolated: true });
  assert.deepEqual(autoCleanupPreference(auto(5, "delete")), { days: 5, action: "delete", skipIsolated: true });
  assert.deepEqual(autoCleanupPreference(auto(0, "shred")), { days: 1, action: "archive", skipIsolated: true });
  assert.deepEqual(autoCleanupPreference(auto(99_999)), { days: 3650, action: "archive", skipIsolated: true });
  // Only an explicit `false` lets it take isolated work: an older client's
  // settings write drops fields it does not know.
  assert.equal(autoCleanupPreference(auto(5, "delete", false))?.skipIsolated, false);
  assert.equal(autoCleanupPreference(auto(5, "delete", true))?.skipIsolated, true);
  assert.equal(autoCleanupPreference(auto(5, "delete", "false"))?.skipIsolated, true);
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
  assert.deepEqual(await policy.forSession(row("alice-chat")), { days: 5, action: "delete", skipIsolated: true });
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
  assert.deepEqual(await policy.forSession(rows[1]!), { days: 7, action: "archive", skipIsolated: true });
});

test("a session with no recorded account needs every member, on the gentlest terms", async () => {
  const allIn = createExpiredSessionPolicy(accounts({
    settings: { alice: auto(5, "delete"), bob: auto(20, "archive") },
  }));
  assert.deepEqual(await allIn.forSession(row("nobody")), { days: 20, action: "archive", skipIsolated: true });
  assert.equal(allIn.shortestDays("space-1"), 5);

  const allDelete = createExpiredSessionPolicy(accounts({
    settings: { alice: auto(5, "delete"), bob: auto(20, "delete") },
  }));
  assert.deepEqual(await allDelete.forSession(row("nobody")), { days: 20, action: "delete", skipIsolated: true });

  const oneSkips = createExpiredSessionPolicy(accounts({
    settings: { alice: auto(5, "archive", false), bob: auto(5, "archive") },
  }));
  assert.equal((await oneSkips.forSession(row("nobody")))?.skipIsolated, true);
  const noneSkip = createExpiredSessionPolicy(accounts({
    settings: { alice: auto(5, "archive", false), bob: auto(5, "archive", false) },
  }));
  assert.equal((await noneSkip.forSession(row("nobody")))?.skipIsolated, false);

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
  assert.deepEqual(result, { scanned: 0, archived: [], deleted: [], released: [], failed: [] });
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
  const result = await sweep(sessions, { days: 30, action: "archive", skipIsolated: true }, { keep: () => new Set(["kept-by-person"]) });
  assert.deepEqual(sessions.archived, ["old"]);
  assert.deepEqual(sessions.deleted, []);
  assert.deepEqual(result, { scanned: 7, archived: ["old"], deleted: [], released: [], failed: [] });
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
        ? { days: 5, action: "archive", skipIsolated: true }
        : { days: 30, action: "archive", skipIsolated: true },
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
    policy: fixedPolicy({ days: 30, action: "archive", skipIsolated: true }, seen),
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
    // Its checkout belongs to someone else and stays where it is.
    row("borrowed-worktree", { worktreePath: "/tmp/w" }),
    row("parent-of-archived"),
    row("archived-child", { parentId: "parent-of-archived", status: "archived" }),
    row("parent-of-unknown"),
    row("unknown-child", { parentId: "parent-of-unknown", status: "unknown" }),
  ] });
  await sweep(sessions, { days: 30, action: "delete", skipIsolated: true });
  assert.deepEqual(sessions.deleted, ["plain", "failed", "borrowed-worktree", "parent-of-archived"]);
  assert.deepEqual(sessions.archived, ["unknown", "epoch-pending", "parent-of-unknown"]);
});

const isolatedRows = () => [
  row("plain"),
  row("isolated", { isolation: isolation() }),
  row("other-repository", {
    workspace: { repositories: [{ repositoryId: "r", alias: "r", path: "/x", isolation: isolation() }] } as unknown as SessionProjection["workspace"],
  }),
  row("parent"),
  row("isolated-child", { parentId: "parent", isolation: isolation() }),
];

test("skipping isolated sessions leaves their whole trees untouched", async () => {
  for (const action of ["archive", "delete"] as const) {
    const sessions = source({ rows: isolatedRows() });
    const released: string[] = [];
    const result = await sweep(sessions, { days: 30, action, skipIsolated: true }, {
      releaseCheckouts: async (id) => { released.push(id); },
    });
    assert.deepEqual([...sessions.archived, ...sessions.deleted], ["plain"], action);
    assert.deepEqual(released, []);
    assert.deepEqual(result.released, []);
  }
});

test("with no way to remove a checkout, isolated sessions are skipped whatever was chosen", async () => {
  const sessions = source({ rows: isolatedRows() });
  await sweep(sessions, { days: 30, action: "delete", skipIsolated: false });
  assert.deepEqual(sessions.deleted, ["plain"]);
  assert.deepEqual(sessions.archived, []);
});

test("a delete choice takes isolated sessions through the full delete", async () => {
  const sessions = source({ rows: isolatedRows() });
  const released: string[] = [];
  const result = await sweep(sessions, { days: 30, action: "delete", skipIsolated: false }, {
    releaseCheckouts: async (id) => { released.push(id); },
  });
  assert.deepEqual(sessions.deleted, ["plain", "isolated", "other-repository", "parent"]);
  assert.deepEqual(sessions.archived, []);
  assert.deepEqual(released, [], "deleting already removes the checkouts");
  assert.deepEqual(result.failed, []);
});

test("an archive choice archives each tree first, then removes only its checkouts", async () => {
  const sessions = source({ rows: isolatedRows() });
  const order: string[] = [];
  const archive = sessions.archive;
  sessions.archive = async (id) => { await archive(id); order.push(`archive:${id}`); };
  const result = await sweep(sessions, { days: 30, action: "archive", skipIsolated: false }, {
    releaseCheckouts: async (id) => { order.push(`release:${id}`); },
  });
  assert.deepEqual(sessions.archived, ["plain", "isolated", "other-repository", "parent"]);
  assert.deepEqual(result.released, ["isolated", "other-repository", "parent"]);
  assert.deepEqual(order, [
    "archive:plain",
    "archive:isolated", "release:isolated",
    "archive:other-repository", "release:other-repository",
    "archive:parent", "release:parent",
  ]);
});

test("an already archived checkout is removed even under a delete choice, and its chat stays", async () => {
  const sessions = source({ rows: [
    row("left-behind", { status: "archived", isolation: isolation() }),
    row("archived-yesterday", { status: "archived", isolation: isolation(), updatedAt: NOW - DAY }),
  ] });
  const released: string[] = [];
  const result = await sweep(sessions, { days: 30, action: "delete", skipIsolated: false }, {
    releaseCheckouts: async (id) => { released.push(id); },
  });
  assert.deepEqual(released, ["left-behind"]);
  assert.deepEqual(sessions.deleted, []);
  assert.deepEqual(result.archived, [], "it was archived before this pass");
  assert.deepEqual(result.released, ["left-behind"]);
});

test("a session that may still be executing keeps its checkout for now", async () => {
  const sessions = source({ rows: [
    row("unknown", { status: "unknown", isolation: isolation() }),
    row("parent", { isolation: isolation() }),
    row("epoch-pending-child", { parentId: "parent", status: "epoch-pending" }),
  ] });
  const released: string[] = [];
  await sweep(sessions, { days: 30, action: "delete", skipIsolated: false }, {
    releaseCheckouts: async (id) => { released.push(id); },
  });
  assert.deepEqual(sessions.archived, ["unknown", "parent"]);
  assert.deepEqual(sessions.deleted, []);
  assert.deepEqual(released, []);
});

test("a checkout that could not be removed is reported, and the pass goes on", async () => {
  const sessions = source({ rows: [
    row("stuck", { isolation: isolation() }),
    row("fine", { isolation: isolation() }),
  ] });
  const released: string[] = [];
  const result = await sweep(sessions, { days: 30, action: "archive", skipIsolated: false }, {
    releaseCheckouts: async (id) => {
      if (id === "stuck") throw Object.assign(new Error("no"), { code: "conflict" });
      released.push(id);
    },
  });
  assert.deepEqual(result.failed, [{ id: "stuck", code: "conflict" }]);
  assert.deepEqual(released, ["fine"]);
  assert.deepEqual(result.archived, ["stuck", "fine"]);
});

test("each owner's own choice about isolated sessions applies", async () => {
  const rows = [row("alice", { isolation: isolation() }), row("bob", { isolation: isolation() })];
  const sessions = source({ rows });
  await sweep(sessions, { days: 30, action: "archive", skipIsolated: true }, {
    policy: {
      forSession: async (projection) => ({ days: 30, action: "archive", skipIsolated: projection.id !== "alice" }),
    },
    releaseCheckouts: async () => {},
  });
  assert.deepEqual(sessions.archived, ["alice"]);
});

test("delete falls back to archive when the service cannot delete", async () => {
  const { delete: _delete, ...withoutDelete } = source({ rows: [row("old")] });
  const archived: string[] = [];
  await sweep({ ...withoutDelete, archive: async (id) => { archived.push(id); } }, { days: 30, action: "delete", skipIsolated: true });
  assert.deepEqual(archived, ["old"]);
});

test("queued delivery anywhere in the tree keeps it", async () => {
  const sessions = source({
    rows: [row("queued"), row("root"), row("child", { parentId: "root" }), row("plain")],
    queue: { queued: 1, child: 2 },
  });
  await sweep(sessions, { days: 30, action: "archive", skipIsolated: true });
  assert.deepEqual(sessions.archived, ["plain"]);
});

test("a session touched since the list wins", async () => {
  const sessions = source({
    rows: [row("resumed"), row("reused"), row("plain")],
    fresh: { resumed: { status: "working" }, reused: { updatedAt: NOW } },
  });
  await sweep(sessions, { days: 30, action: "archive", skipIsolated: true });
  assert.deepEqual(sessions.archived, ["plain"]);
});

test("one failure keeps that session and the pass goes on", async () => {
  const sessions = source({ rows: [row("broken"), row("silent"), row("plain")], fail: { broken: "conflict", silent: "" } });
  const result = await sweep(sessions, { days: 30, action: "archive", skipIsolated: true });
  assert.deepEqual(result.archived, ["plain"]);
  assert.deepEqual(result.failed, [{ id: "broken", code: "conflict" }, { id: "silent", code: "internal" }]);
});

test("the sweep paces its actions and stops when asked", async () => {
  const sessions = source({ rows: [row("a"), row("b"), row("c")] });
  let pauses = 0;
  await sweep(sessions, { days: 30, action: "archive", skipIsolated: true }, {
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
