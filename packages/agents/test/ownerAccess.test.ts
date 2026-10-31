import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, SpaceContext, SpaceRole } from "@polyth/contracts";
import { createScheduleService, type ScheduleTask } from "../src/index.ts";
import { scheduleRoutes } from "../src/serverEntry.ts";

const project: Project = { id: "prj_a", path: "/a", name: "A", createdAt: 1, spaceId: "spc_a" };
const as = (userId: string, role: SpaceRole = "member"): SpaceContext => ({
  spaceId: "spc_a", spaceSlug: "a", userId, role, deployment: "server-trusted", storageDir: "/tmp/a",
});

test("members see and change only their own agents; admins see others' metadata and may only pause or remove them", async t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-schedule-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const schedule = createScheduleService({ file: join(root, "schedule.json"), runner: { async run() {} }, now: () => 1_000 });
  const task = (ownerUserId: string | undefined, prompt: string) => schedule.create({
    projectId: project.id, spaceId: "spc_a", ...(ownerUserId ? { ownerUserId } : {}), prompt, kind: "every", everyMinutes: 60, title: prompt,
  });
  const ada = task("usr_ada", "ada's charter");
  const bob = task("usr_bob", "bob's charter");
  const legacy = task(undefined, "legacy charter");
  const routes = scheduleRoutes({
    schedule,
    forSpace: () => ({
      projects: { list: async () => [project], get: async (id: string) => id === project.id ? project : undefined },
      sessions: { snapshot: async () => { throw Object.assign(new Error("not found"), { code: "not-found" }); } },
    }) as never,
  });
  const call = async (space: SpaceContext, path: string, method: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    await routes({
      path, method, url: new URL(`http://localhost${path}`), body: async () => body,
      json(code: number, value: unknown) { status = code; payload = value; }, space,
    } as never);
    return { status, payload };
  };
  const list = async (space: SpaceContext) =>
    ((await call(space, "/api/schedule", "GET")).payload as { tasks: ScheduleTask[] }).tasks;

  // A member: only their own agent, in full.
  const mine = await list(as("usr_ada"));
  assert.deepEqual(mine.map((item) => item.id), [ada.id]);
  assert.equal(mine[0]!.prompt, "ada's charter");
  assert.equal((await call(as("usr_ada"), `/api/schedule/${bob.id}`, "PATCH", { prompt: "hijack" })).status, 404);
  assert.equal((await call(as("usr_ada"), `/api/schedule/${bob.id}/pause`, "POST")).status, 404);
  assert.equal((await call(as("usr_ada"), `/api/schedule/${legacy.id}`, "DELETE")).status, 404, "ownerless legacy agents are admins' alone");
  assert.equal((await call(as("usr_ada"), `/api/schedule/${bob.id}/runs`, "GET")).status, 404);
  assert.equal((await call(as("usr_ada"), `/api/schedule/${ada.id}`, "PATCH", { prompt: "ada's new charter" })).status, 200);

  // A Space admin: everyone's agents; others' only as metadata.
  const admin = as("usr_admin", "admin");
  const all = await list(admin);
  assert.deepEqual(all.map((item) => item.id).sort(), [ada.id, bob.id, legacy.id].sort());
  const bobView = all.find((item) => item.id === bob.id)!;
  assert.equal(bobView.title, "bob's charter");
  assert.equal(bobView.ownerUserId, "usr_bob");
  assert.equal(bobView.prompt, "", "never another person's charter");
  assert.equal(all.find((item) => item.id === legacy.id)!.prompt, "legacy charter", "ownerless agents are the admins' to manage");

  const edit = await call(admin, `/api/schedule/${bob.id}`, "PATCH", { prompt: "admin's charter" });
  assert.equal(edit.status, 403);
  assert.equal(schedule.get(bob.id)!.prompt, "bob's charter");
  assert.equal((await call(admin, `/api/schedule/${bob.id}/run`, "POST")).status, 403, "running it would act for bob");
  assert.equal((await call(admin, `/api/schedule/${bob.id}/runs`, "GET")).status, 403);
  assert.equal((await call(admin, `/api/schedule/${bob.id}/context`, "GET")).status, 403);
  assert.equal((await call(admin, `/api/schedule/${bob.id}/pause`, "POST")).status, 200);
  assert.equal(schedule.get(bob.id)!.enabled, false);
  assert.equal((await call(admin, `/api/schedule/${legacy.id}`, "PATCH", { prompt: "updated legacy" })).status, 200);
  assert.equal((await call(admin, `/api/schedule/${bob.id}`, "DELETE")).status, 200);
  assert.equal(schedule.get(bob.id), undefined);

  // Server work keeps full access.
  const system = { ...as("system:schedule", "viewer"), authority: { kind: "system" } } as SpaceContext;
  assert.deepEqual((await list(system)).map((item) => item.prompt).sort(), ["ada's new charter", "updated legacy"]);
});
