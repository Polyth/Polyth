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
