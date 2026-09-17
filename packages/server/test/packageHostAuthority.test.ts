import test from "node:test";
import assert from "node:assert/strict";
import type { Project, SessionProjection, SessionService, SpaceContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { RUNTIME_SYSTEM_PRINCIPAL_ID } from "@polyth/plugins";
import { governPackageHost } from "../src/packageHostAuthority.ts";

const projection: SessionProjection = {
  id: "ses_one", projectId: "prj_one", spaceId: "spc_home", title: "One",
  status: "idle", createdAt: 1, updatedAt: 1,
};

test("discovered package sessions route through system-scoped Space services", async () => {
  let rawCreate = 0;
  let rawSnapshot = 0;
  let scopedCreate = 0;
  let scopedSnapshot = 0;
  let appended = 0;
  const project: Project = { id: "prj_one", path: "/tmp/project", name: "One", createdAt: 1, spaceId: "spc_home" };
  const scoped = {
    async create() { scopedCreate++; return { id: "ses_created" }; },
    async snapshot() { scopedSnapshot++; return projection; },
  } as unknown as SessionService;
  const raw = {
    async create() { rawCreate++; throw new Error("raw create called"); },
    async snapshot() { rawSnapshot++; throw new Error("raw snapshot called"); },
  } as unknown as SessionService;
  const host = {
    pluginId: "test-package",
    deployment: "local-trusted",
    projects: { get: async (id: string) => id === project.id ? project : undefined },
    sessions: raw,
    store: { projection: async (id: string) => id === projection.id ? projection : undefined },
    forSpace(ctx: SpaceContext) {
      assert.equal(ctx.spaceId, "spc_home");
      assert.equal(ctx.userId, RUNTIME_SYSTEM_PRINCIPAL_ID);
      return { projects: {} as never, sessions: scoped };
    },
    events: {
      async append(sessionId: string) {
        assert.equal(sessionId, projection.id);
        appended++;
        return { sessionId, seq: 1, ts: 1, type: "test/event", data: {} } as never;
      },
    },
  } as unknown as ServerPackageHost;

  const governed = governPackageHost(host);
  assert.deepEqual(await governed.sessions.create({ projectId: project.id }), { id: "ses_created" });
  assert.equal((await governed.sessions.snapshot(projection.id)).id, projection.id);
  await governed.events.append(projection.id, "test/event", {});

  assert.equal(rawCreate, 0);
  assert.equal(rawSnapshot, 0);
  assert.equal(scopedCreate, 1);
  // One explicit snapshot plus the event append lifecycle guard.
  assert.equal(scopedSnapshot, 2);
  assert.equal(appended, 1);
});
