import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, Project, SessionEvent } from "@polyth/contracts";
import { RUNTIME_SYSTEM_PRINCIPAL_ID, serverServiceKey } from "@polyth/plugins";
import { createScheduleService, type ScheduleService } from "../src/index.ts";
import registerPackage from "../src/serverEntry.ts";

function root(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "polyth-schedule-spaces-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { tasks: Array<{ id: string; spaceId?: string }> };

test("tasks persist in their own Space document; the shared file keeps only unresolved ones", (t) => {
  const dir = root(t);
  const legacy = join(dir, "schedule.json");
  const spaceFile = (spaceId: string) => join(dir, "spaces", spaceId, "schedule.json");
  const spaces: Record<string, string> = { pa: "spc_a", pb: "spc_b" };
  // A pre-split shared document with tasks from two Spaces and one orphan.
  const plain = createScheduleService({ file: legacy, runner: { async run() {} }, now: () => 1 });
  const a = plain.create({ projectId: "pa", prompt: "a", kind: "at", at: 10 });
  const b = plain.create({ projectId: "pb", prompt: "b", kind: "at", at: 10 });
  const orphan = plain.create({ projectId: "gone", prompt: "o", kind: "at", at: 10 });
  const original = readFileSync(legacy, "utf8");

  const svc = createScheduleService({
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
  const reloaded = createScheduleService({
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

test("the package runs a trusted loop on its agent profile and settles from the session log", async (t) => {
  const dir = root(t);
  const projectDir = join(dir, "project");
  mkdirSync(join(projectDir, ".agents", "loops"), { recursive: true });
  writeFileSync(join(projectDir, ".agents", "loops", "digest.md"), [
    "---",
    "id: digest",
    "cron: 0 6 * * *",
    "timeZone: UTC",
    "agentProfile: prof_reviewer",
    "---",
    "Summarize yesterday.",
  ].join("\n"));
  const project: Project = { id: "prj", path: projectDir, name: "P", createdAt: 1, spaceId: "spc_a" };
  const log: SessionEvent[] = [];
  const created: JsonObject[] = [];
  const sent: JsonObject[] = [];
  const append = (type: string, data: JsonObject): SessionEvent => {
    const event = { id: `e${log.length + 1}`, seq: log.length + 1, sessionId: "ses", type, data, time: 1 } as unknown as SessionEvent;
    log.push(event);
    return event;
  };
  const sessions = {
    async create(input: JsonObject) { created.push(input); return { id: "ses" }; },
    async snapshot() { return { id: "ses", projectId: "prj", status: "idle" }; },
    async send(_id: string, input: JsonObject) {
      sent.push(input);
      append("turn/started", { turnId: "t1" });
      append("turn/stopped", { turnId: "t1", reason: "completed" });
      return { turnId: "t1" };
    },
  };
  const services = new Map<string, unknown>();
  const host = {
    pluginId: "agents",
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
  const schedule = services.get(serverServiceKey<ScheduleService>("agents").id) as ScheduleService;
  assert.throws(() => schedule.list(), /not enabled/);
  await pkg.onEnable!();
  t.after(() => pkg.onDisable!());

  const scan = (await import("../src/loops.ts")).scanLoopsDir(projectDir);
  const synced = schedule.syncLoops("prj", scan);
  const loop = synced.tasks[0]!;
  assert.equal(loop.spaceId, "spc_a");
  schedule.trustLoopVersion(loop.id, "spc_a", scan[0]!);
  await schedule.runNow(loop.id);

  assert.equal(created[0]!.agentProfileId, "prof_reviewer", "the session starts on the profile's route");
  assert.equal(sent[0]!.agentProfileId, "prof_reviewer");
  assert.equal(log[0]!.type, "schedule/run-started");
  for (let i = 0; i < 50 && schedule.runsOf(loop.id)[0]!.status === "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const run = schedule.runsOf(loop.id)[0]!;
  assert.equal(run.status, "ok");
  assert.equal(run.markerSeq, 1);
  assert.ok(existsSync(join(dir, "spaces", "spc_a", "packages", "agents", "schedule.json")));
  assert.equal(existsSync(join(dir, "shared", "schedule.json")), false, "nothing tenant-owned in shared storage");
});
