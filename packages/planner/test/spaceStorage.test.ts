import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, Project, SessionEvent } from "@polyth/contracts";
import { RUNTIME_SYSTEM_PRINCIPAL_ID, serverServiceKey } from "@polyth/plugins";
import { createPlannerService, type PlannerService } from "../src/index.ts";
import registerPackage from "../src/serverEntry.ts";

function root(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "polyth-planner-spaces-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { tasks: Array<{ id: string; spaceId?: string }> };

test("tasks persist in their own Space document; the shared file keeps only unresolved ones", (t) => {
  const dir = root(t);
  const legacy = join(dir, "planner.json");
  const spaceFile = (spaceId: string) => join(dir, "spaces", spaceId, "planner.json");
  const spaces: Record<string, string> = { pa: "spc_a", pb: "spc_b" };
  // A pre-split shared document with tasks from two Spaces and one orphan.
  const plain = createPlannerService({ file: legacy, runner: { async run() {} }, now: () => 1 });
  const a = plain.create({ projectId: "pa", prompt: "a", kind: "at", at: 10 });
  const b = plain.create({ projectId: "pb", prompt: "b", kind: "at", at: 10 });
  const orphan = plain.create({ projectId: "gone", prompt: "o", kind: "at", at: 10 });
  const original = readFileSync(legacy, "utf8");

  const svc = createPlannerService({
    file: legacy,
    spaceFile,
    spaceIds: ["spc_a", "spc_b"],
    spaceOf: (projectId) => spaces[projectId],
    runner: { async run() {} },
    now: () => 1,
  });
  assert.equal(svc.get(a.id)!.spaceId, "spc_a");
  assert.deepEqual(read(spaceFile("spc_a")).tasks.map((x) => x.id), [a.id]);
  assert.deepEqual(read(spaceFile("spc_b")).tasks.map((x) => x.id), [b.id]);
  assert.deepEqual(read(legacy).tasks.map((x) => x.id), [orphan.id]);
  assert.equal(readFileSync(`${legacy}.pre-space-split`, "utf8"), original, "pre-split bytes kept once");

  // New tasks go straight to their Space; removing the last one empties it.
  const c = svc.create({ projectId: "pa", spaceId: "spc_a", prompt: "c", kind: "at", at: 10 });
  assert.deepEqual(read(spaceFile("spc_a")).tasks.map((x) => x.id), [a.id, c.id]);
  svc.remove(a.id);
  svc.remove(c.id);
  assert.deepEqual(read(spaceFile("spc_a")).tasks, []);

  // A task smuggled into another Space's document belongs to that document's Space.
  const forged = read(spaceFile("spc_b"));
  forged.tasks.push({ ...read(spaceFile("spc_b")).tasks[0]!, id: "forged", spaceId: "spc_a" });
  writeFileSync(spaceFile("spc_b"), JSON.stringify(forged));
  const reloaded = createPlannerService({
    file: legacy, spaceFile, spaceIds: ["spc_a", "spc_b"], spaceOf: (p) => spaces[p],
    runner: { async run() {} }, now: () => 1,
  });
  assert.equal(reloaded.get("forged")!.spaceId, "spc_b");
  assert.equal(reloaded.get(orphan.id)!.spaceId, undefined);

  // Once the orphan's project resolves, it moves into its Space.
  spaces.gone = "spc_b";
  assert.equal(reloaded.assignSpaces(), 1);
  assert.deepEqual(read(legacy).tasks, []);
  assert.ok(read(spaceFile("spc_b")).tasks.some((x) => x.id === orphan.id));
});

test("without a shared file every task must belong to a Space", (t) => {
  const dir = root(t);
  const spaceFile = (spaceId: string) => join(dir, "spaces", spaceId, "planner.json");
  const spaces: Record<string, string> = { p: "spc_a" };
  const svc = createPlannerService({
    spaceFile, spaceIds: [], spaceOf: (p) => spaces[p], runner: { async run() {} }, now: () => 1,
  });
  const cadence = { kind: "every" as const, everyMinutes: 60 };
  assert.throws(() => svc.create({ projectId: "lost", prompt: "x", cadence }), /no Space/);
  const task = svc.create({ projectId: "p", prompt: "x", cadence });
  assert.throws(() => svc.update(task.id, { projectId: "lost" }), /no Space/);
  assert.equal(svc.get(task.id)!.projectId, "p", "a refused move leaves the task where it was");
  assert.deepEqual(read(spaceFile("spc_a")).tasks.map((x) => x.id), [task.id]);
  assert.deepEqual(readdirSync(dir), ["spaces"], "nothing outside the Space documents");
  assert.throws(() => createPlannerService({ runner: { async run() {} } }), /file or a spaceFile/);
});

test("the package runs a task for its owner, settles from the session log and ignores .agents/loops", async (t) => {
  const dir = root(t);
  const projectDir = join(dir, "project");
  // Repository loops belong to Agents; the Planner must never pick them up.
  mkdirSync(join(projectDir, ".agents", "loops"), { recursive: true });
  writeFileSync(join(projectDir, ".agents", "loops", "digest.md"), [
    "---",
    "id: digest",
    "cron: * * * * *",
    "timeZone: UTC",
    "---",
    "Summarize yesterday.",
  ].join("\n"));
  const project: Project = { id: "prj", path: projectDir, name: "P", createdAt: 1, spaceId: "spc_a" };
  const log: SessionEvent[] = [];
  const created: JsonObject[] = [];
  const sent: Array<{ input: JsonObject; admission: unknown }> = [];
  const append = (type: string, data: JsonObject): SessionEvent => {
    const event = { id: `e${log.length + 1}`, seq: log.length + 1, sessionId: "ses", type, data, time: 1 } as unknown as SessionEvent;
    log.push(event);
    return event;
  };
  const sessions = {
    async create(input: JsonObject) { created.push(input); return { id: "ses" }; },
    async snapshot() { return { id: "ses", projectId: "prj", status: "idle" }; },
    async send(_id: string, input: JsonObject, admission?: unknown) {
      sent.push({ input, admission });
      append("turn/started", { turnId: "t1" });
      append("turn/stopped", { turnId: "t1", reason: "completed" });
      return { turnId: "t1" };
    },
  };
  const services = new Map<string, unknown>();
  const host = {
    deployment: "local-trusted",
    storageDir: join(dir, "shared"),
    projects: { list: async () => [project], get: async (id: string) => id === project.id ? project : undefined },
    systemSpaceContext: (spaceId: string) => ({ spaceId, userId: RUNTIME_SYSTEM_PRINCIPAL_ID, storageDir: join(dir, "spaces", spaceId) }),
    spaceStorage: (ctx: { spaceId: string }) => ({
      root: join(dir, "spaces", ctx.spaceId),
      packageDir: (id: string) => join(dir, "spaces", ctx.spaceId, "packages", id),
      path: (relative: string) => join(dir, "spaces", ctx.spaceId, relative),
    }),
    forSpace: () => ({ projects: host.projects, sessions }),
    store: {
      projection: async (id: string) => id === "ses" ? { id: "ses", projectId: "prj", status: "idle" } : undefined,
      events: async (_id: string, afterSeq = 0) => log.filter((event) => event.seq > afterSeq),
    },
    events: { append: async (_id: string, type: string, data: JsonObject) => append(type, data) },
    services: {
      provide: (key: { id: string }, value: unknown) => { services.set(key.id, value); },
      get: (key: { id: string }) => services.get(key.id),
    },
  };
  const pkg = registerPackage(host as never);
  const planner = services.get(serverServiceKey<PlannerService>("planner").id) as PlannerService;
  assert.throws(() => planner.list(), /not enabled/);
  await pkg.onEnable!();
  t.after(() => pkg.onDisable!());
  assert.deepEqual(planner.list(), [], "loop files are not Planner tasks");

  let status = 0;
  let payload: { id: string; ownerUserId?: string; spaceId?: string } | undefined;
  const handled = await pkg.routes!({
    path: "/api/planner",
    method: "POST",
    url: new URL("http://local/api/planner"),
    space: { spaceId: "spc_a", userId: "usr_owner" },
    body: async () => ({ projectId: "prj", prompt: "Summarize yesterday.", ownerUserId: "usr_forged", cadence: { kind: "every", everyMinutes: 60 } }),
    json: (code: number, value: unknown) => { status = code; payload = value as typeof payload; },
  } as never);
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.equal(payload!.ownerUserId, "usr_owner", "ownership comes from the signed-in person, never the body");
  assert.equal(payload!.spaceId, "spc_a");

  await planner.runNow(payload!.id);
  assert.equal(created[0]!.projectId, "prj");
  assert.equal(sent[0]!.input.text, "Summarize yesterday.");
  assert.deepEqual(sent[0]!.admission, { author: { userId: "usr_owner", via: "schedule" } });
  assert.equal(log[0]!.type, "planner/run-started");
  for (let i = 0; i < 50 && planner.runsOf(payload!.id)[0]!.status === "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const run = planner.runsOf(payload!.id)[0]!;
  assert.equal(run.status, "ok");
  assert.equal(run.markerSeq, 1);
  assert.equal(run.manual, true);
  assert.ok(existsSync(join(dir, "spaces", "spc_a", "packages", "planner", "planner.json")));
  assert.equal(existsSync(join(dir, "shared", "planner.json")), false, "nothing tenant-owned in shared storage");
});
