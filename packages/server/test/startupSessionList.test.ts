// The navigator list is built from `sessions.list`, so a row hidden there is a
// row the person cannot reach. A failed startup row may only be hidden while it
// is a blank remnant, and only while "Delete failed startup sessions" allows
// removing it: a row holding a draft, a checkout the chat owns, or a recorded
// turn is something the startup sweeps refuse to delete, so hiding it would
// strand real work.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Project, ProjectService } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService } from "../src/sessions.ts";

const service = (allowDelete?: () => boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-startup-list-"));
  const store = createStore(join(dir, "sessions.db"));
  const project: Project = { id: "project-1", name: "Project", path: dir, createdAt: 1 };
  const projects = {
    list: async () => [project],
    get: async (id: string) => (id === project.id ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => undefined,
  } as unknown as ProjectService;
  const sessions = createSessionService({
    store,
    projects,
    permissions: { evaluate: () => "ask", addRule: () => undefined, rules: () => [] } as unknown as PermissionService,
    broadcast: { event: () => undefined, projection: () => undefined },
    queue: store,
    runtimes: { forProject: async () => { throw new Error("no runtime in this test"); } },
    ...(allowDelete ? { failedStartupCleanupAllowed: () => allowDelete() } : {}),
  });
  return { sessions, store, project };
};

const base = (id: string, projectId: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId,
  title: "New session",
  status: "failed" as const,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

test("a blank failed startup row stays out of the list while cleanup is allowed", async () => {
  const { sessions, store, project } = service(() => true);
  await store.upsertProjection(base("blank", project.id));
  await store.upsertProjection(base("drafted", project.id, { draft: "порадь", draftUpdatedAt: 2 }));
  await store.upsertProjection(base("checkout", project.id, { worktreePath: "/tmp/wt", branch: "polyth/isolate/x" }));
  await store.upsertProjection(base("turned", project.id, { lastTurnAt: 3 }));
  const ids = (await sessions.list(project.id)).map((row) => row.id).sort();
  assert.deepEqual(ids, ["checkout", "drafted", "turned"]);
  await store.close();
});

test("a kept failed startup row stays listed even when it holds nothing else", async () => {
  const { sessions, store, project } = service(() => false);
  await store.upsertProjection(base("blank", project.id));
  await store.upsertProjection(base("checkout", project.id, { worktreePath: "/tmp/wt", branch: "polyth/isolate/y" }));
  const ids = (await sessions.list(project.id)).map((row) => row.id).sort();
  assert.deepEqual(ids, ["blank", "checkout"]);
  await store.close();
});

test("a failed row's draft is never hidden, whatever the cleanup choice says", async () => {
  const { sessions, store, project } = service(() => true);
  await store.upsertProjection(base("drafted", project.id, { draft: "не втрачай це", draftUpdatedAt: 4 }));
  const [row] = (await sessions.list(project.id)).map((session) => session);
  assert.equal(row?.id, "drafted");
  assert.equal(row?.draft, "не втрачай це");
  await store.close();
});
