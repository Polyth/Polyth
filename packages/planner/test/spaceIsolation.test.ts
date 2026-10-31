import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, SpaceContext } from "@polyth/contracts";
import { createPlannerService } from "../src/index.ts";
import { plannerRoutes } from "../src/serverEntry.ts";

const a: Project = { id: "prj_a", path: "/a", name: "A", createdAt: 1, spaceId: "spc_a" };
const b: Project = { id: "prj_b", path: "/b", name: "B", createdAt: 1, spaceId: "spc_b" };
const space: SpaceContext = {
  spaceId: "spc_a", spaceSlug: "a", userId: "usr_a", role: "owner",
  deployment: "local-trusted", storageDir: "/tmp/a",
};

test("planner routes neither disclose nor mutate tasks owned by another Space", async t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-planner-space-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const schedule = createPlannerService({ file: join(root, "planner.json"), runner: { async run() {} }, now: () => 1_000 });
  const own = schedule.create({ projectId: a.id, prompt: "own", kind: "at", at: 10_000 });
  const foreign = schedule.create({ projectId: b.id, prompt: "foreign", kind: "at", at: 10_000 });
  const routes = plannerRoutes({
    planner: schedule,
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

  const listed = await call("/api/planner", "GET");
  assert.equal(listed.status, 200);
  assert.deepEqual((listed.payload as { tasks: Array<{ id: string }> }).tasks.map(task => task.id), [own.id]);

  const deniedDelete = await call(`/api/planner/${foreign.id}`, "DELETE");
  assert.equal(deniedDelete.status, 404);
  assert.ok(schedule.get(foreign.id));

  const deniedCreate = await call("/api/planner", "POST", {
    projectId: b.id, prompt: "cross-space", kind: "at", at: 20_000,
  });
  assert.equal(deniedCreate.status, 404);
  assert.equal(schedule.list(b.id).length, 1);
});

test("planner routes persist a validated execution route and ignore malformed values", async t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-planner-exec-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const schedule = createPlannerService({ file: join(root, "planner.json"), runner: { async run() {} }, now: () => 1_000 });
  const routes = plannerRoutes({
    planner: schedule,
    forSpace() {
      return {
        projects: { list: async () => [a], get: async (id: string) => id === a.id ? a : undefined },
        sessions: { snapshot: async () => { throw Object.assign(new Error("not found"), { code: "not-found" }); } },
      } as never;
    },
  });
  let status = 0;
  let payload: unknown;
  const call = async (method: string, body: Record<string, unknown>) => {
    status = 0;
    payload = undefined;
    assert.equal(await routes({
      path: "/api/planner",
      method,
      url: new URL("http://localhost/api/planner"),
      body: async () => body,
      json(code: number, value: unknown) { status = code; payload = value; },
      space,
    } as never), true);
    return { status, payload };
  };

  const created = await call("POST", {
    projectId: a.id,
    prompt: "exec",
    kind: "at",
    at: 20_000,
    model: { providerID: "anthropic", modelID: "claude-x", harnessId: "claude", variant: "high", ignored: true },
    harness: { mode: "pinned", harnessId: "claude" },
  });
  assert.equal(created.status, 200);
  assert.deepEqual((created.payload as { model?: unknown }).model, {
    providerID: "anthropic", modelID: "claude-x", harnessId: "claude", variant: "high",
  });
  assert.deepEqual((created.payload as { harness?: unknown }).harness, { mode: "pinned", harnessId: "claude" });

  const auto = await call("POST", {
    projectId: a.id,
    prompt: "auto",
    kind: "at",
    at: 30_000,
    harness: { mode: "auto" },
  });
  assert.equal(auto.status, 200);
  assert.deepEqual((auto.payload as { harness?: unknown }).harness, { mode: "auto" });

  const malformed = await call("POST", {
    projectId: a.id,
    prompt: "bad",
    kind: "at",
    at: 40_000,
    model: { providerID: "", modelID: "x" },
    harness: { mode: "pinned", harnessId: "  " },
  });
  assert.equal(malformed.status, 200);
  assert.equal((malformed.payload as { model?: unknown }).model, undefined);
  assert.equal((malformed.payload as { harness?: unknown }).harness, undefined);
});
