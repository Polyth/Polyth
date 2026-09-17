import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, SpaceContext } from "@polyth/contracts";
import { createScheduleService } from "../src/index.ts";
import { scheduleRoutes } from "../src/serverEntry.ts";

const a: Project = { id: "prj_a", path: "/a", name: "A", createdAt: 1, spaceId: "spc_a" };
const b: Project = { id: "prj_b", path: "/b", name: "B", createdAt: 1, spaceId: "spc_b" };
const space: SpaceContext = {
  spaceId: "spc_a", spaceSlug: "a", userId: "usr_a", role: "owner",
  deployment: "local-trusted", storageDir: "/tmp/a",
};

test("schedule routes neither disclose nor mutate tasks owned by another Space", async t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-schedule-space-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const schedule = createScheduleService({ file: join(root, "schedule.json"), runner: { async run() {} }, now: () => 1_000 });
  const own = schedule.create({ projectId: a.id, prompt: "own", kind: "at", at: 10_000 });
  const foreign = schedule.create({ projectId: b.id, prompt: "foreign", kind: "at", at: 10_000 });
  const routes = scheduleRoutes({
    schedule,
    forSpace() {
      return {
        projects: {
          list: async () => [a],
          get: async (id: string) => id === a.id ? a : undefined,
        },
        sessions: { snapshot: async () => { throw Object.assign(new Error("not found"), { code: "not-found" }); } },
      } as never;
    },
  });

  const call = async (path: string, method: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const handled = await routes({
      path,
      method,
      url: new URL(`http://localhost${path}`),
      body: async () => body,
      json(code: number, value: unknown) { status = code; payload = value; },
      space,
    } as never);
    assert.equal(handled, true);
    return { status, payload };
  };

  const listed = await call("/api/schedule", "GET");
  assert.equal(listed.status, 200);
  assert.deepEqual((listed.payload as { tasks: Array<{ id: string }> }).tasks.map(task => task.id), [own.id]);

  const deniedDelete = await call(`/api/schedule/${foreign.id}`, "DELETE");
  assert.equal(deniedDelete.status, 404);
  assert.ok(schedule.get(foreign.id));

  const deniedCreate = await call("/api/schedule", "POST", {
    projectId: b.id, prompt: "cross-space", kind: "at", at: 20_000,
  });
  assert.equal(deniedCreate.status, 404);
  assert.equal(schedule.list(b.id).length, 1);
});
