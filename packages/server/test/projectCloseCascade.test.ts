import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  SessionEvent,
  SessionProjection,
  SessionService,
  SpaceContext,
} from "@polyth/contracts";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { bindCanonicalSecurity } from "../src/runtimeSecurity.ts";
import { createProjectService } from "../src/projects.ts";
import { createSpaceGuard, createSpaceServices } from "../src/spaceScope.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-project-close-"));
  const security = createCanonicalSecurity({
    dataDir: root,
    origin: "http://127.0.0.1:4400",
    localOnly: true,
    now: () => 1_000,
  });
  security.control.transaction(() => {
    security.control.run("INSERT INTO principals(id,kind,status) VALUES('usr_owner','user','active')");
    security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_owner','Owner',1,1)");
    security.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    security.control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_home','usr_owner','owner')");
    security.control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_home','org_home','Home','home','shared',1,1)");
    security.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home','usr_owner','owner',1)");
  });
  const binding = bindCanonicalSecurity(security);
  const registry = createProjectService(root);

  const projections = new Map<string, SessionProjection>();
  const histories = new Map<string, SessionEvent[]>();
  const missing = (): Error => Object.assign(new Error("session not found"), { code: "not-found" });
  const base = {
    async create(input: { id?: string; projectId: string; parentId?: string }) {
      const row = {
        id: input.id ?? randomUUID(),
        projectId: input.projectId,
        spaceId: "spc_home",
        ...(input.parentId ? { parentId: input.parentId } : {}),
        title: "Chat",
        status: "idle",
        createdAt: 10,
        updatedAt: 10,
      } as SessionProjection;
      projections.set(row.id, row);
      histories.set(row.id, []);
      return { id: row.id };
    },
    async snapshot(id: string) {
      const row = projections.get(id);
      if (!row) throw missing();
      return { ...row };
    },
    async list(projectId?: string) {
      return [...projections.values()]
        .filter((row) => !projectId || row.projectId === projectId)
        .map((row) => ({ ...row }));
    },
    async sync(projectId: string) { return base.list(projectId); },
    async events(id: string) {
      if (!projections.has(id)) throw missing();
      return [...(histories.get(id) ?? [])];
    },
    async delete(id: string) {
      if (!projections.delete(id)) throw missing();
      histories.delete(id);
    },
    async archive() {},
    async restore() {},
  } as unknown as SessionService;

  const ctx: SpaceContext = {
    spaceId: "spc_home",
    spaceSlug: "home",
    userId: "usr_owner",
    role: "owner",
    deployment: "local-trusted",
    storageDir: join(root, "spaces", "home"),
  };
  const services = createSpaceServices({
    registry,
    sessions: () => base,
    guard: createSpaceGuard({
      spaceOfSession: (sessionId) => (projections.has(sessionId) ? "spc_home" : undefined),
      spaceOfProject: (id) => (id === registry.spaceOfProject(id) ? "spc_home" : undefined),
    }),
  })(ctx);
  t.after(() => {
    binding.dispose();
    security.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, security, registry, projections, services };
}

test("closing a project removes the chats it still owns", async t => {
  const f = fixture(t);
  const path = join(f.root, "work", "close");
  mkdirSync(path, { recursive: true });
  const project = await f.services.projects.add(path, "Close");
  const chat = await f.services.sessions.create({ projectId: project.id, title: "Hello" });
  assert.equal(f.security.resources.resource(chat.id)?.lifecycle, "active");

  await f.services.projects.remove(project.id);

  assert.equal(await f.services.projects.get(project.id), undefined);
  assert.equal(f.security.resources.resource(project.id)?.lifecycle, "deleted");
  assert.equal(f.security.resources.resource(chat.id)?.lifecycle, "deleted");
  assert.equal(f.projections.size, 0);
});
