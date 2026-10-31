import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCapabilityContribution, JsonObject, Project, SessionEvent, ToolExecutionContext } from "@polyth/contracts";
import { RUNTIME_SYSTEM_PRINCIPAL_ID, serverServiceKey } from "@polyth/plugins";
import { createPlannerService, plannerTurnAdmission, type PlannerService, type PlannerTask } from "../src/index.ts";
import registerPackage from "../src/serverEntry.ts";
import {
  createPlannerAgentTool,
  parseAt,
  PLANNER_TOOL_MAX_ACTIVE,
  PLANNER_TOOL_NAME,
  zonedEpoch,
} from "../src/agentTool.ts";

// 2026-10-18T12:00:00Z = 15:00 in Kyiv (EEST, +03:00).
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const ZONE = "Europe/Kyiv";

const ctx = (over: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  sessionId: "ses_a", projectId: "prj_a", cwd: "/a", spaceId: "spc_a", actorUserId: "usr_a", ...over,
});

function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "polyth-planner-tool-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = NOW;
  const sent: Array<{ task: PlannerTask }> = [];
  const planner = createPlannerService({
    spaceFile: (spaceId) => join(root, spaceId, "planner.json"),
    spaceOf: (projectId) => (projectId === "prj_a" ? "spc_a" : projectId === "prj_b" ? "spc_b" : undefined),
    runner: { async run(task) { sent.push({ task }); return { sessionId: task.target?.sessionId ?? task.sessionId }; } },
    now: () => clock,
  });
  // ses_a lives in prj_a / spc_a; ses_b in prj_b / spc_b. Anything else is foreign.
  const sessions: Record<string, { spaceId: string; projectId: string }> = {
    ses_a: { spaceId: "spc_a", projectId: "prj_a" },
    ses_a2: { spaceId: "spc_a", projectId: "prj_a" },
    ses_b: { spaceId: "spc_b", projectId: "prj_b" },
  };
  const tool = createPlannerAgentTool({
    planner,
    sessionProject: async (spaceId, sessionId) => {
      const session = sessions[sessionId];
      return session && session.spaceId === spaceId ? session.projectId : undefined;
    },
    now: () => clock,
    defaultTimeZone: () => ZONE,
  });
  const call = (input: Record<string, unknown>, context = ctx()) => tool.execute!(input as never, context);
  return { planner, tool, call, sent, advance: (ms: number) => { clock += ms; } };
}

test("polyth_planner is an auto-approved package tool owned by the planner", () => {
  const { tool } = setup({ after() {} });
  assert.equal(tool.descriptor.kind === "tool" && tool.descriptor.name, PLANNER_TOOL_NAME);
  assert.equal(tool.descriptor.owner, "planner");
  assert.equal(tool.descriptor.kind, "tool");
  assert.equal(tool.autoApprove?.({ spaceId: "spc_a", projectId: "prj_a", cwd: "/a" }), true);
});

test("a bare HH:MM schedules the next occurrence in the zone, into this session, as its person", async t => {
  const { planner, call, sent, advance } = setup(t);
  const result = await call({ action: "create", prompt: "Scheduled check: git status", at: "17:00" });
  const [task] = planner.list();
  assert.ok(task);
  assert.equal(task.cadence.kind, "at");
  assert.equal(task.nextRunAt, Date.UTC(2026, 9, 18, 14, 0, 0));
  assert.deepEqual(task.target, { mode: "existing-session", sessionId: "ses_a" });
  assert.equal(task.spaceId, "spc_a");
  assert.equal(task.ownerUserId, "usr_a");
  assert.deepEqual(plannerTurnAdmission(task), { author: { userId: "usr_a", via: "schedule" } });
  assert.match(result.output, /2026-10-18 17:00 Europe\/Kyiv/);
  assert.match(result.output, /Now: 2026-10-18 15:00/);
  assert.equal(result.metadata?.taskId, task.id);

  advance(2 * 60 * 60_000);
  assert.equal(await planner.tick(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.task.prompt, "Scheduled check: git status");
  assert.equal(planner.get(task.id)?.enabled, false, "a one-shot disarms after it fires");
});

test("a time already passed today rolls to tomorrow; explicit offsets and wall clocks resolve exactly", () => {
  assert.equal(parseAt("09:30", ZONE, NOW), Date.UTC(2026, 9, 19, 6, 30, 0));
  assert.equal(parseAt("2026-10-20T08:00:00+02:00", ZONE, NOW), Date.UTC(2026, 9, 20, 6, 0, 0));
  assert.equal(parseAt("2026-10-20T08:00", "UTC", NOW), Date.UTC(2026, 9, 20, 8, 0, 0));
  // After the 2026-10-25 change Kyiv is back on +02:00.
  assert.equal(parseAt("2026-10-26 17:00", ZONE, NOW), Date.UTC(2026, 9, 26, 15, 0, 0));
  assert.equal(zonedEpoch(2026, 10, 18, 17, 0, 0, ZONE), Date.UTC(2026, 9, 18, 14, 0, 0));
  assert.throws(() => parseAt("25:00", ZONE, NOW), /valid time/);
  assert.throws(() => parseAt("2026-02-30T10:00", ZONE, NOW), /valid date/);
  assert.throws(() => parseAt("tomorrow at five", ZONE, NOW), /at must be/);
});

test("inMinutes, everyMinutes and cron cadences; exactly one is required", async t => {
  const { planner, call } = setup(t);
  await call({ action: "create", prompt: "in", inMinutes: 30 });
  await call({ action: "create", prompt: "every", everyMinutes: 15 });
  await call({ action: "create", prompt: "cron", cron: "0 9 * * 1-5", timeZone: "UTC" });
  const byPrompt = new Map(planner.list().map((task) => [task.prompt, task]));
  assert.equal(byPrompt.get("in")?.nextRunAt, NOW + 30 * 60_000);
  assert.deepEqual(byPrompt.get("every")?.cadence, { kind: "every", everyMinutes: 15 });
  assert.deepEqual(byPrompt.get("cron")?.cadence, { kind: "cron", expression: "0 9 * * 1-5", timeZone: "UTC" });

  await assert.rejects(call({ action: "create", prompt: "x" }), /exactly one/);
  await assert.rejects(call({ action: "create", prompt: "x", at: "17:00", inMinutes: 5 }), /exactly one/);
  await assert.rejects(call({ action: "create", prompt: "x", everyMinutes: 1 }), /everyMinutes must be/);
  await assert.rejects(call({ action: "create", prompt: "x", cron: "* * * * *" }), /cron:/);
  await assert.rejects(call({ action: "create", prompt: "x", at: "2026-10-18T10:00" }), /in the past/);
  await assert.rejects(call({ action: "create", prompt: "x", at: "2028-01-01T10:00" }), /within a year/);
  await assert.rejects(call({ action: "create", prompt: " ", at: "17:00" }), /prompt is required/);
  await assert.rejects(call({ action: "create", prompt: "x", at: "17:00", timeZone: "Mars/Base" }), /unknown IANA zone/);
  assert.equal(planner.list().length, 3);
});

test("list and cancel see only this session's own tasks", async t => {
  const { planner, call } = setup(t);
  const mine = await call({ action: "create", prompt: "mine", at: "17:00", title: "Repo check" });
  await call({ action: "create", prompt: "sibling", at: "18:00" }, ctx({ sessionId: "ses_a2" }));
  // A Planner task made in the UI for a fresh session per run is not this session's.
  planner.create({ projectId: "prj_a", spaceId: "spc_a", prompt: "ui", kind: "at", at: NOW + 60_000 });

  const listed = await call({ action: "list" });
  assert.equal(listed.metadata?.count, 1);
  assert.match(listed.output, /Repo check — once at 2026-10-18 17:00/);
  assert.doesNotMatch(listed.output, /sibling|ui/);

  const siblingId = planner.list().find((task) => task.prompt === "sibling")!.id;
  await assert.rejects(call({ action: "cancel", id: siblingId }), /no task/);
  assert.ok(planner.get(siblingId), "another session's task survives");

  const cancelled = await call({ action: "cancel", id: mine.metadata!.taskId as string });
  assert.match(cancelled.output, /^Cancelled /);
  assert.equal(planner.get(mine.metadata!.taskId as string), undefined);
  assert.equal((await call({ action: "list" })).metadata?.count, 0);
});

test("a session outside the grant Space or project is refused without scheduling", async t => {
  const { planner, call } = setup(t);
  await assert.rejects(call({ action: "create", prompt: "x", at: "17:00" }, ctx({ sessionId: "ses_b" })), /not available/);
  await assert.rejects(call({ action: "create", prompt: "x", at: "17:00" }, ctx({ projectId: "prj_b" })), /not available/);
  await assert.rejects(call({ action: "list" }, ctx({ spaceId: undefined })), /needs a Polyth session/);
  const foreign = planner.create({
    projectId: "prj_b", spaceId: "spc_b", prompt: "foreign", target: { mode: "existing-session", sessionId: "ses_a" }, kind: "at", at: NOW + 60_000,
  });
  assert.equal((await call({ action: "list" })).metadata?.count, 0, "a foreign-Space task naming this session stays invisible");
  await assert.rejects(call({ action: "cancel", id: foreign.id }), /no task/);
  assert.equal(planner.list().length, 1);
});

test("system work schedules without borrowing a person; active tasks per session are capped", async t => {
  const { planner, call } = setup(t);
  await call({ action: "create", prompt: "sys", inMinutes: 5 }, ctx({ actorUserId: "system:polyth-runtime" }));
  assert.equal(planner.list()[0]!.ownerUserId, undefined);
  for (let i = 1; i < PLANNER_TOOL_MAX_ACTIVE; i += 1) await call({ action: "create", prompt: `p${i}`, inMinutes: 5 + i });
  await assert.rejects(call({ action: "create", prompt: "one too many", inMinutes: 60 }), /already has/);
  assert.equal(planner.list().length, PLANNER_TOOL_MAX_ACTIVE);
});

test("the package registers polyth_planner on enable, runs a wake into the calling session and unregisters on disable", async t => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-planner-tool-pkg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project: Project = { id: "prj", path: join(dir, "p"), name: "P", createdAt: 1, spaceId: "spc_a" };
  const log: SessionEvent[] = [];
  const append = (type: string, data: JsonObject): SessionEvent => {
    const event = { id: `e${log.length + 1}`, seq: log.length + 1, sessionId: "ses", type, data, time: 1 } as unknown as SessionEvent;
    log.push(event);
    return event;
  };
  const created: JsonObject[] = [];
  const sent: Array<{ id: string; input: JsonObject; admission: unknown }> = [];
  const sessions = {
    async create(input: JsonObject) { created.push(input); return { id: "other" }; },
    async snapshot(id: string) {
      if (id !== "ses") throw Object.assign(new Error("not found"), { code: "not-found" });
      return { id: "ses", projectId: "prj", status: "idle" };
    },
    async send(id: string, input: JsonObject, admission?: unknown) {
      sent.push({ id, input, admission });
      append("turn/started", { turnId: "t1" });
      append("turn/stopped", { turnId: "t1", reason: "completed" });
      return { turnId: "t1" };
    },
  };
  const registered: Array<{ owner: string; contribution: AgentCapabilityContribution; disposed: boolean }> = [];
  const registry = {
    register(owner: string, contribution: AgentCapabilityContribution) {
      const entry = { owner, contribution, disposed: false };
      registered.push(entry);
      return { dispose: () => { entry.disposed = true; } };
    },
  };
  const services = new Map<string, unknown>([[serverServiceKey("harness.capabilities").id, registry]]);
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
  await pkg.onEnable!();
  let disabled = false;
  t.after(async () => { if (!disabled) await pkg.onDisable!(); });
  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.owner, "planner");
  const tool = registered[0]!.contribution;
  assert.equal(tool.descriptor.kind === "tool" && tool.descriptor.name, PLANNER_TOOL_NAME);

  const toolCtx = { sessionId: "ses", projectId: "prj", cwd: project.path, spaceId: "spc_a", actorUserId: "usr_owner" };
  await assert.rejects(tool.execute!({ action: "list" }, { ...toolCtx, sessionId: "ghost" }), /not available/);
  const result = await tool.execute!({ action: "create", prompt: "Scheduled check: git status", inMinutes: 90 }, toolCtx);
  const planner = services.get(serverServiceKey<PlannerService>("planner").id) as PlannerService;
  const taskId = result.metadata!.taskId as string;
  await planner.runNow(taskId);
  assert.equal(created.length, 0, "the wake goes into the calling session, not a new one");
  assert.equal(sent[0]!.id, "ses");
  assert.equal(sent[0]!.input.text, "Scheduled check: git status");
  assert.deepEqual(sent[0]!.admission, { author: { userId: "usr_owner", via: "schedule" } });
  assert.equal(log[0]!.type, "planner/run-started");

  await pkg.onDisable!();
  disabled = true;
  assert.equal(registered[0]!.disposed, true);
});
