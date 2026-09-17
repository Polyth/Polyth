import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection, SessionService, SpaceContext } from "@polyth/contracts";
import {
  RUNTIME_SYSTEM_PRINCIPAL_ID,
  systemAppendSessionEvent,
  systemSessionsForProject,
  systemSessionsForSession,
} from "../src/systemSessions.ts";

function fixture(status: SessionProjection["status"] = "idle") {
  const contexts: SpaceContext[] = [];
  const appended: string[] = [];
  const projection: SessionProjection = {
    id: "ses_one",
    projectId: "prj_one",
    spaceId: "spc_one",
    title: "One",
    status,
    createdAt: 1,
    updatedAt: 1,
  } as SessionProjection;
  const sessions = {
    async create() { return { id: "ses_created" }; },
    async snapshot(id: string) {
      if (id !== projection.id) throw Object.assign(new Error("missing"), { code: "not-found" });
      return projection;
    },
    async send() { return { turnId: "turn_one" }; },
  } as unknown as SessionService;
  const host = {
    deployment: "local-trusted" as const,
    projects: {
      async get(id: string) {
        return id === "prj_one"
          ? { id, path: "/tmp/prj", name: "One", createdAt: 1, spaceId: "spc_one" }
          : undefined;
      },
    },
    store: {
      async projection(id: string) { return id === projection.id ? projection : undefined; },
    },
    forSpace(ctx: SpaceContext) {
      contexts.push(ctx);
      return { projects: {} as never, sessions };
    },
    events: {
      async append(sessionId: string) {
        appended.push(sessionId);
        return { id: "ev_one", sessionId, seq: 1, time: 1, type: "test", data: {} } as never;
      },
    },
  };
  return { host, contexts, appended, sessions };
}

test("background project/session routing uses an explicit non-human system context", async () => {
  const f = fixture();
  assert.equal(await systemSessionsForProject(f.host as never, "prj_one"), f.sessions);
  assert.equal(await systemSessionsForSession(f.host as never, "ses_one"), f.sessions);
  assert.equal(f.contexts.length, 2);
  for (const ctx of f.contexts) {
    assert.equal(ctx.spaceId, "spc_one");
    assert.equal(ctx.userId, RUNTIME_SYSTEM_PRINCIPAL_ID);
    assert.equal(ctx.role, "owner");
    assert.equal(ctx.deployment, "local-trusted");
  }
});

test("background event append validates canonical snapshot and rejects archived sessions", async () => {
  const active = fixture("idle");
  await systemAppendSessionEvent(active.host as never, "ses_one", "background/test", {}, { ignorable: true });
  assert.deepEqual(active.appended, ["ses_one"]);

  const archived = fixture("archived");
  await assert.rejects(
    systemAppendSessionEvent(archived.host as never, "ses_one", "background/test", {}),
    { code: "conflict" },
  );
  assert.deepEqual(archived.appended, []);
});

test("unknown project or session cannot manufacture a background Space context", async () => {
  const f = fixture();
  await assert.rejects(systemSessionsForProject(f.host as never, "missing"), { code: "not-found" });
  await assert.rejects(systemSessionsForSession(f.host as never, "missing"), { code: "not-found" });
  assert.equal(f.contexts.length, 0);
});
