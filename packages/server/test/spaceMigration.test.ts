// Migration from a real single-user installation to Spaces.
//
// The state written here is exactly what a pre-tenancy Polyth leaves on disk:
// a projects.json with no owner field, session projections with no spaceId,
// and global workspace labels. Booting the gateway over it must adopt every
// row into one Personal Space without moving anything or asking the user
// anything — and must be safe to run again.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStore } from "@polyth/session";
import type { Project, SessionProjection, SessionService } from "@polyth/contracts";
import { BOOTSTRAP_USER_ID, DEFAULT_SPACE_NAME } from "@polyth/tenancy";
import { createProjectService } from "../src/projects.ts";
import { createSpaceGateway } from "../src/spaces.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-space-migration-"));

/** Write the on-disk state a pre-tenancy server would have left behind. */
async function legacyInstallation(dataDir: string): Promise<{
  projectIds: string[];
  sessionIds: string[];
  labelId: string;
}> {
  const projectIds = [randomUUID(), randomUUID()];
  const projects: Project[] = projectIds.map((id, i) => {
    const path = join(dataDir, `repo-${i}`);
    mkdirSync(path, { recursive: true });
    // Deliberately no `spaceId` — that field did not exist yet.
    return { id, path, name: `repo-${i}`, createdAt: 1_000 + i };
  });
  writeFileSync(join(dataDir, "projects.json"), JSON.stringify(projects, null, 2));

  const store = createStore(join(dataDir, "sessions.db"));
  const sessionIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, id] of sessionIds.entries()) {
    await store.upsertProjection({
      id,
      projectId: projectIds[i % projectIds.length]!,
      title: `legacy ${i}`,
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
  }
  const label = await store.labelCreate("Legacy", "#334455");
  await store.close();
  return { projectIds, sessionIds, labelId: label.id };
}

test("a pre-tenancy installation boots into Personal with every row adopted", async () => {
  const dataDir = tmp();
  const legacy = await legacyInstallation(dataDir);

  const store = createStore(join(dataDir, "sessions.db"));
  const registry = createProjectService(dataDir);

  // Before: nothing is owned.
  assert.equal((await registry.list()).every((p) => !p.spaceId), true);
  assert.equal(store.spaceOfSession(legacy.sessionIds[0]!), undefined);

  const { gateway, migration } = await createSpaceGateway({
    dataDir,
    registry,
    store,
    sessions: () => ({} as SessionService),
  });

  assert.equal(migration.created, true);
  assert.equal(migration.space.name, DEFAULT_SPACE_NAME);
  assert.equal(migration.space.isDefault, true);
  assert.equal(migration.user.id, BOOTSTRAP_USER_ID);
  assert.equal(migration.projectsAdopted, 2);
  assert.equal(migration.sessionsAdopted, 3);

  const spaceId = migration.space.id;
  // After: every project and session belongs to Personal, and paths are
  // untouched — nothing was moved on disk.
  const projects = await registry.list();
  assert.equal(projects.length, 2);
  for (const project of projects) {
    assert.equal(project.spaceId, spaceId);
    assert.ok(project.path.startsWith(dataDir));
  }
  for (const sessionId of legacy.sessionIds) {
    assert.equal(store.spaceOfSession(sessionId), spaceId);
  }
  assert.deepEqual(
    (await store.projections(undefined, { spaceId })).map((p) => p.id).sort(),
    [...legacy.sessionIds].sort(),
  );
  // Global labels moved too.
  assert.equal((await store.labelList(spaceId)).length, 1);

  // The existing operator is the owner and lands in Personal with no wizard.
  const ctx = gateway.resolve({ kind: "local-user", trustedLoopback: true });
  assert.equal(ctx.spaceId, spaceId);
  assert.equal(ctx.role, "owner");

  // Persisted where the next boot will find it.
  const persisted = JSON.parse(readFileSync(join(dataDir, "tenancy.json"), "utf8")) as {
    spaces: Array<{ id: string }>;
    memberships: Array<{ role: string }>;
  };
  assert.deepEqual(persisted.spaces.map((s) => s.id), [spaceId]);
  assert.deepEqual(persisted.memberships.map((m) => m.role), ["owner"]);
});

test("re-running the migration adopts nothing and keeps the same Space", async () => {
  const dataDir = tmp();
  await legacyInstallation(dataDir);

  const boot = async () => {
    const store = createStore(join(dataDir, "sessions.db"));
    const registry = createProjectService(dataDir);
    return createSpaceGateway({ dataDir, registry, store, sessions: () => ({} as SessionService) });
  };

  const first = await boot();
  const second = await boot();

  assert.equal(second.migration.created, false);
  assert.equal(second.migration.space.id, first.migration.space.id);
  assert.equal(second.migration.projectsAdopted, 0);
  assert.equal(second.migration.sessionsAdopted, 0);
});

test("rows created after the migration are owned by the Space that created them", async () => {
  const dataDir = tmp();
  const store = createStore(join(dataDir, "sessions.db"));
  const registry = createProjectService(dataDir);
  const { gateway, migration } = await createSpaceGateway({
    dataDir,
    registry,
    store,
    sessions: () => ({} as SessionService),
  });

  const owner = migration.user.id;
  const second = gateway.store.createSpace({ name: "Hobby", ownerId: owner });
  const personal = gateway.resolver.forUser(owner, migration.space.id);
  const hobby = gateway.resolver.forUser(owner, second.id);

  const dir = join(dataDir, "new-repo");
  mkdirSync(dir, { recursive: true });
  const created = await gateway.services(hobby).projects.add(dir, "new");
  assert.equal(created.spaceId, second.id);
  assert.equal(registry.spaceOfProject(created.id), second.id);
  assert.deepEqual(await gateway.services(personal).projects.list(), []);
});
