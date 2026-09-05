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
