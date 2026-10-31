// Canonical-identity fixture for sharing tests: one organization, a Home
// Space with five people of different roles, a Work Space with an outsider,
// one project in each, and an in-memory session domain.
import type test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Project,
  ProjectService,
  SessionEvent,
  SessionProjection,
  SessionService,
  SessionSummaryQuery,
  SpaceContext,
} from "@polyth/contracts";
import { createCanonicalSecurity } from "../../src/canonicalSecurity.ts";
import { bindCanonicalSecurity } from "../../src/runtimeSecurity.ts";
import { accessControlledSessionService } from "../../src/sessionResourceAccess.ts";
import { canonicalSessionService } from "../../src/sessionResourceAuthority.ts";
import { createSessionSharingService } from "../../src/sessionSharing.ts";

const PEOPLE = [
  ["usr_owner", "Olena", "member"],
  ["usr_admin", "Adam", "admin"],
  ["usr_member", "Marta", "member"],
  ["usr_other", "Oleh", "member"],
  ["usr_viewer", "Vira", "viewer"],
] as const;

export function sharingFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-session-sharing-"));
  const security = createCanonicalSecurity({ dataDir: root, origin: "http://127.0.0.1:4400", localOnly: true });
  security.control.transaction(() => {
    security.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    for (const space of ["spc_home", "spc_work"]) {
      security.control.run(
        "INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES(?,'org_home',?,?,'shared',1,1)",
        space, space, space,
      );
    }
    for (const [id, name, role] of [...PEOPLE, ["usr_outside", "Outsider", "owner"]] as const) {
      security.control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, name);
      security.control.run(
        "INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES(?,?,?,1)",
        id === "usr_outside" ? "spc_work" : "spc_home", id, role,
      );
    }
    for (const [id, space, owner] of [["prj_one", "spc_home", "usr_owner"], ["prj_work", "spc_work", "usr_outside"]]) {
      security.control.run(
        `INSERT INTO resources(id,kind,org_id,space_id,owner_principal_id,created_by,visibility,lifecycle,created_at_ms,updated_at_ms)
         VALUES(?,'project','org_home',?,?,?,'space','active',1,1)`,
        id, space, owner, owner,
      );
    }
  });
  const binding = bindCanonicalSecurity(security);
  const projectsById = new Map<string, Project>([
    ["prj_one", { id: "prj_one", path: join(root, "one"), name: "One", createdAt: 1, spaceId: "spc_home" }],
    ["prj_work", { id: "prj_work", path: join(root, "work"), name: "Work", createdAt: 1, spaceId: "spc_work" }],
  ]);
  const projectsFor = (spaceId: string): ProjectService => ({
    async list() { return [...projectsById.values()].filter((project) => project.spaceId === spaceId); },
    async add() { throw new Error("unused"); },
    async create() { throw new Error("unused"); },
    async remove() {},
    async get(id) { const project = projectsById.get(id); return project?.spaceId === spaceId ? project : undefined; },
  });

  const projections = new Map<string, SessionProjection>();
  const histories = new Map<string, SessionEvent[]>();
  let clock = 100;
  const missing = (): Error => Object.assign(new Error("session not found"), { code: "not-found" });
  const row = (id: string, projectId: string, parentId?: string): SessionProjection => ({
    id, projectId, spaceId: projectsById.get(projectId)!.spaceId,
    ...(parentId ? { parentId } : {}),
    title: id, status: "idle", createdAt: clock, updatedAt: ++clock,
  } as SessionProjection);
  const sent: string[] = [];
  const base = {
    async create(input: { id?: string; projectId: string; parentId?: string; title?: string }) {
      const id = input.id ?? randomUUID();
      projections.set(id, { ...row(id, input.projectId, input.parentId), ...(input.title ? { title: input.title } : {}) });
      histories.set(id, []);
      return { id };
    },
    async snapshot(id: string) { const found = projections.get(id); if (!found) throw missing(); return { ...found }; },
    async list(projectId?: string) {
      return [...projections.values()].filter((p) => !projectId || p.projectId === projectId).map((p) => ({ ...p }));
    },
    async sync(projectId: string) { return [...projections.values()].filter((p) => p.projectId === projectId).map((p) => ({ ...p })); },
    async events(id: string) { if (!projections.has(id)) throw missing(); return [...(histories.get(id) ?? [])]; },
    async replayPage(id: string) {
      if (!projections.has(id)) throw missing();
      return { events: [], highWater: 0, complete: true };
    },
    async fork(parentId: string) {
      if (!projections.has(parentId)) throw missing();
      const id = randomUUID();
      projections.set(id, row(id, projections.get(parentId)!.projectId, parentId));
      histories.set(id, [{ id: randomUUID(), sessionId: id, seq: 1, time: 1, type: "session/forked", data: {}, ignorable: true } as SessionEvent]);
      return { id, fromSessionId: parentId };
    },
    async archive(id: string) { const found = projections.get(id)!; projections.set(id, { ...found, status: "archived" }); },
    async restore(id: string) { const found = projections.get(id)!; projections.set(id, { ...found, status: "idle" }); },
    async delete(id: string) { projections.delete(id); },
    async send(id: string) { if (!projections.has(id)) throw missing(); sent.push(id); return { turnId: randomUUID() }; },
    async rename(id: string, title: string) { const found = projections.get(id)!; projections.set(id, { ...found, title }); },
    async markRead() {},
    async abort() {},
    async replyPermission() {},
    async replyQuestion() {},
    async summaries(input: SessionSummaryQuery) {
      const limit = input.limit ?? 50;
      const rows = [...projections.values()]
        .filter((p) => p.spaceId === input.spaceId && (!input.projectId || p.projectId === input.projectId))
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
        .filter((p) => !input.cursor || p.updatedAt < input.cursor.updatedAt
          || (p.updatedAt === input.cursor.updatedAt && p.id < input.cursor.id));
      const page = rows.slice(0, limit).map((p) => ({ ...p, summary: true }));
      const last = page.at(-1);
      return {
        sessions: page,
        revision: 1,
        complete: rows.length <= limit,
        ...(rows.length > limit && last ? { next: { updatedAt: last.updatedAt, id: last.id } } : {}),
      };
    },
  } as unknown as SessionService;

  const ctx = (userId: string, spaceId = "spc_home"): SpaceContext => {
    const role = [...PEOPLE, ["usr_outside", "Outsider", "owner"]].find(([id]) => id === userId)?.[2] ?? "member";
    return { spaceId, spaceSlug: spaceId, userId, role, deployment: "local-trusted", storageDir: join(root, spaceId) } as SpaceContext;
  };
  const system = (spaceId = "spc_home"): SpaceContext => ({
    ...ctx("system:polyth-runtime", spaceId), role: "owner", authority: { kind: "system", serviceId: "polyth-runtime" },
  } as SpaceContext);
  const sessionsFor = (context: SpaceContext): SessionService =>
    accessControlledSessionService(context, canonicalSessionService(context, base, projectsFor(context.spaceId)));
  const changed: SessionProjection[][] = [];
  type Listener = (rows: SessionProjection[], formerReaders: ReadonlyMap<string, ReadonlySet<string>>) => void;
  let listener: Listener | undefined;
  const sharing = createSessionSharingService({
    projection: async (id) => projections.get(id),
    accessChanged: (rows, formerReaders) => { changed.push(rows); listener?.(rows, formerReaders); },
  });
  t.after(() => {
    binding.dispose();
    security.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    security, ctx, system, sessionsFor, sharing, changed, sent, projections,
    /** Route sharing changes to a live broadcaster as production does. */
    onAccessChanged(fn: Listener) { listener = fn; },
  };
}

