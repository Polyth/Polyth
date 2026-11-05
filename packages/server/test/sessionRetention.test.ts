import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection, SessionService } from "@polyth/contracts";
import { sessionRetentionRoutes } from "../src/routes/sessionRetention.ts";
import type { SpaceServices } from "../src/spaceScope.ts";
import { fakeSpaceContext } from "./support/spaces.ts";

const DAY = 24 * 60 * 60_000;
const now = Date.now();
const sessions: SessionProjection[] = [
  { id: "old", projectId: "p", title: "old", status: "idle", createdAt: 1, updatedAt: now - 40 * DAY },
  { id: "new", projectId: "p", title: "new", status: "idle", createdAt: 1, updatedAt: now - DAY },
];
const archived: string[] = [];
const service = {
  list: async () => sessions,
  archive: async (id: string) => { archived.push(id); },
} as SessionService;

test("session retention route reports and archives eligible sessions", async () => {
  const space = fakeSpaceContext();
  const route = sessionRetentionRoutes(() => ({ sessions: service } as unknown as SpaceServices));
  let response: unknown;
  const base = {
    space,
    path: "/api/session-retention",
    url: new URL("http://localhost/api/session-retention?days=30"),
    body: async () => ({ days: 30 }),
    json: (_status: number, value: unknown) => { response = value; },
  };
  assert.equal(await route({ ...base, method: "GET" } as never), true);
  assert.equal((response as { eligibleCount: number }).eligibleCount, 1);

  assert.equal(await route({ ...base, method: "POST" } as never), true);
  assert.deepEqual(archived, ["old"]);
});

test("session retention can delete sessions and purge old or all archives", async () => {
  const rows: SessionProjection[] = [
    { id: "old", projectId: "p", title: "old", status: "idle", createdAt: 1, updatedAt: now - 40 * DAY },
    { id: "old-archive", projectId: "p", title: "old archive", status: "archived", createdAt: 1, updatedAt: now - 40 * DAY },
    { id: "recent-archive", projectId: "p", title: "recent archive", status: "archived", createdAt: 1, updatedAt: now - DAY },
  ];
  const deleted: string[] = [];
  const deleteService = {
    list: async () => rows,
    archive: async () => {},
    delete: async (id: string) => { deleted.push(id); },
  } as SessionService;
  const space = fakeSpaceContext();
  const route = sessionRetentionRoutes(() => ({ sessions: deleteService } as unknown as SpaceServices));
  let response: unknown;
  const request = (method: "GET" | "POST", url: string, value: Record<string, unknown> = {}) => route({
    space,
    path: "/api/session-retention",
    method,
    url: new URL(`http://localhost${url}`),
    body: async () => value,
    json: (_status: number, body: unknown) => { response = body; },
  } as never);

  await request("GET", "/api/session-retention?days=30&target=archives");
  assert.equal((response as { eligibleCount: number }).eligibleCount, 1);

  await request("POST", "/api/session-retention", { days: 30, action: "delete" });
  assert.deepEqual(deleted, ["old"]);

  await request("POST", "/api/session-retention", { target: "archives", days: 30 });
  assert.deepEqual(deleted, ["old", "old-archive"]);

  await request("POST", "/api/session-retention", { target: "archives", all: true });
  assert.deepEqual(deleted, ["old", "old-archive", "old-archive", "recent-archive"]);
});

test("a child its parent's cascade already removed counts as cleaned up", async () => {
  const rows: SessionProjection[] = [
    { id: "parent", projectId: "p", title: "parent", status: "idle", createdAt: 1, updatedAt: now - 40 * DAY },
    { id: "child", projectId: "p", parentId: "parent", title: "child", status: "idle", createdAt: 1, updatedAt: now - 40 * DAY },
    { id: "broken", projectId: "p", title: "broken", status: "idle", createdAt: 1, updatedAt: now - 40 * DAY },
  ];
  const gone = new Set<string>();
  const cascading = {
    list: async () => rows,
    archive: async () => {},
    delete: async (id: string) => {
      if (id === "broken") throw Object.assign(new Error("busy"), { code: "conflict" });
      if (gone.has(id)) throw Object.assign(new Error("session not found"), { code: "not-found" });
      gone.add(id);
      if (id === "parent") gone.add("child");
    },
  } as SessionService;
  const route = sessionRetentionRoutes(() => ({ sessions: cascading } as unknown as SpaceServices));
  let response: unknown;
  await route({
    space: fakeSpaceContext(),
    path: "/api/session-retention",
    method: "POST",
    url: new URL("http://localhost/api/session-retention"),
    body: async () => ({ days: 30, action: "delete" }),
    json: (_status: number, body: unknown) => { response = body; },
  } as never);
  assert.deepEqual(response, {
    eligibleCount: 3,
    succeeded: ["parent", "child"],
    failed: [{ id: "broken", code: "conflict" }],
  });
});

test("isolated sessions count and go only when the request explicitly says so", async () => {
  const isolation = {
    kind: "git-worktree",
    state: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    worktreePath: "/repo-polyth-isolate/x",
    worktreeBranch: "polyth/isolate/x",
    targetPath: "/repo",
    targetBranch: "main",
    baseCommit: "abc",
  } as unknown as SessionProjection["isolation"];
  const old = now - 40 * DAY;
  const rows: SessionProjection[] = [
    { id: "plain", projectId: "p", title: "plain", status: "idle", createdAt: 1, updatedAt: old },
    { id: "isolated", projectId: "p", title: "isolated", status: "idle", createdAt: 1, updatedAt: old, isolation },
    { id: "parent", projectId: "p", title: "parent", status: "idle", createdAt: 1, updatedAt: old },
    { id: "isolated-child", projectId: "p", title: "child", status: "idle", createdAt: 1, updatedAt: old, parentId: "parent", isolation },
    { id: "left-behind", projectId: "p", title: "left", status: "archived", createdAt: 1, updatedAt: old, isolation },
  ];
  const calls: string[] = [];
  const run = async (
    query: string,
    body: Record<string, unknown>,
    method: "GET" | "POST",
    release: ((id: string) => Promise<void>) | undefined = async (id) => { calls.push(`release:${id}`); },
  ) => {
    const route = sessionRetentionRoutes(() => ({
      sessions: {
        list: async () => rows,
        archive: async (id: string) => { calls.push(`archive:${id}`); },
        delete: async (id: string) => { calls.push(`delete:${id}`); },
      },
    } as unknown as SpaceServices), release);
    let response: { eligibleCount: number; failed: unknown[] } | undefined;
    await route({
      space: fakeSpaceContext(),
      path: "/api/session-retention",
      method,
      url: new URL(`http://localhost/api/session-retention?days=30${query}`),
      body: async () => ({ days: 30, ...body }),
      json: (_status: number, value: typeof response) => { response = value; },
    } as never);
    return response!;
  };

  assert.equal((await run("", {}, "GET")).eligibleCount, 1, "an older client's request leaves them out");
  assert.equal((await run("&skipIsolated=false", {}, "GET")).eligibleCount, 5);

  await run("", { action: "delete" }, "POST");
  assert.deepEqual(calls.splice(0), ["delete:plain"]);

  await run("", { action: "archive", skipIsolated: false }, "POST");
  assert.deepEqual(calls.splice(0), [
    "archive:plain",
    "archive:isolated", "release:isolated",
    "archive:parent", "release:parent",
    "archive:isolated-child", "release:isolated-child",
    // Archiving first is what checks this person may touch it.
    "archive:left-behind", "release:left-behind",
  ]);

  await run("", { action: "delete", skipIsolated: false }, "POST");
  assert.deepEqual(calls.splice(0), [
    "delete:plain", "delete:isolated", "delete:parent", "delete:isolated-child",
    "archive:left-behind", "release:left-behind",
  ], "an archived session's chat stays for the Archive section");

  const failing = await run("", { action: "archive", skipIsolated: false }, "POST", async (id) => {
    if (id === "isolated") throw Object.assign(new Error("no"), { code: "conflict" });
  });
  assert.deepEqual(failing.failed, [{ id: "isolated", code: "conflict" }]);
  calls.splice(0);
});

test("without a way to remove checkouts the route always skips isolated sessions", async () => {
  const rows: SessionProjection[] = [{
    id: "isolated", projectId: "p", title: "i", status: "idle", createdAt: 1, updatedAt: now - 40 * DAY,
    isolation: { kind: "git-worktree", state: "active", createdAt: "2026-01-01T00:00:00.000Z", worktreePath: "/w", worktreeBranch: "b", targetPath: "/r", targetBranch: "main", baseCommit: "a" } as unknown as SessionProjection["isolation"],
  }];
  const route = sessionRetentionRoutes(() => ({ sessions: { list: async () => rows } } as unknown as SpaceServices));
  let response: { eligibleCount: number } | undefined;
  await route({
    space: fakeSpaceContext(),
    path: "/api/session-retention",
    method: "GET",
    url: new URL("http://localhost/api/session-retention?days=30&skipIsolated=false"),
    body: async () => ({}),
    json: (_status: number, value: typeof response) => { response = value; },
  } as never);
  assert.equal(response?.eligibleCount, 0);
});
