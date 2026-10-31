import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, SpaceContext, SpaceRole, ToolExecutionContext } from "@polyth/contracts";
import { serverServiceKey } from "@polyth/plugins";
import { createScheduleService } from "../src/index.ts";
import registerPackage, { scheduleTaskAccess } from "../src/serverEntry.ts";
import { AGENTS_SKILL_ID, AGENTS_TOOL_ID, AGENTS_TOOL_NAME, agentsSkill, createAgentsTool } from "../src/agentTool.ts";

const projects: Record<string, { id: string; name: string; spaceId: string }> = {
  prj_food: { id: "prj_food", name: "nutricompass", spaceId: "spc_a" },
  prj_other: { id: "prj_other", name: "other", spaceId: "spc_b" },
};
const member = (userId: string, spaceId: string, role: SpaceRole = "member"): SpaceContext => ({
  spaceId, spaceSlug: spaceId, userId, role, deployment: "server-trusted", storageDir: "/tmp/x",
});
const members: Record<string, SpaceContext> = {
  "usr_ada:spc_a": member("usr_ada", "spc_a"),
  "usr_bob:spc_a": member("usr_bob", "spc_a"),
  "usr_vic:spc_a": member("usr_vic", "spc_a", "viewer"),
};

function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-agents-tool-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const woken: Array<{ id: string; input?: string }> = [];
  const service = createScheduleService({ file: join(root, "schedule.json"), runner: { async run() {} }, now: () => 1_000 });
  const runNow = service.runNow.bind(service);
  service.runNow = async (id, opts) => {
    woken.push({ id, ...(opts?.input ? { input: opts.input } : {}) });
    return service.get(id) ?? runNow(id, opts);
  };
  const tool = createAgentsTool({
    service,
    personSpace: (userId, spaceId) => members[`${userId}:${spaceId}`],
    project: async (space, id) => projects[id]?.spaceId === space.spaceId ? projects[id] : undefined,
    access: scheduleTaskAccess,
  });
  const call = (input: JsonObject, ctx: Partial<ToolExecutionContext> = {}) => tool.execute!(input, {
    sessionId: "ses_chat", projectId: "prj_food", cwd: "/food", spaceId: "spc_a", actorUserId: "usr_ada", ...ctx,
  });
  return { service, tool, call, woken };
}

const OTTO = {
  action: "create",
  name: "Otto",
  description: "Caring nutrition and health companion",
  charter: "You are Otto, a caring nutrition companion.",
  icon: "assist",
  color: "green",
  notebook: "Knows: the fridge has eggs.",
  heartbeat: { everyMinutes: 240, timeZone: "Europe/Kyiv", activeFrom: 540, activeTo: 1260, checklist: "Ask what was eaten if quiet." },
};

test("the skill routes 'create an agent in Polyth' to the tool instead of a child session or harness file", () => {
  const descriptor = agentsSkill.descriptor;
  const instructions = descriptor.kind === "skill" ? descriptor.instructions : "";
  assert.match(instructions, new RegExp(AGENTS_TOOL_NAME));
  assert.match(instructions, /not a delegated child session/);
  assert.equal(agentsSkill.descriptor.id.startsWith(`${agentsSkill.descriptor.owner}.`), true);
});

test("create makes an owned, on-demand Polyth Agent with rolling memory, heartbeat and notebook", async (t) => {
  const { service, call } = fixture(t);
  const result = await call(OTTO);
  const id = String(result.metadata?.agentId);
  const task = service.get(id)!;
  assert.equal(task.title, "Otto");
  assert.equal(task.projectId, "prj_food");
  assert.equal(task.spaceId, "spc_a");
  assert.equal(task.ownerUserId, "usr_ada");
  assert.equal(task.prompt, OTTO.charter);
  assert.equal(task.manualOnly, true);
  assert.equal(task.target?.mode, "dedicated-session");
  assert.equal(task.heartbeat?.everyMinutes, 240);
  assert.equal(task.icon, "assist");
  assert.equal(task.color, "green");
  assert.equal(task.notebook, OTTO.notebook);
  assert.equal(task.enabled, true);
  assert.match(result.output, /Created Polyth Agent “Otto”/);
  assert.match(result.output, /heartbeat every 240 min 09:00–21:00/);

  const listed = await call({ action: "list" });
  assert.match(listed.output, /1 Polyth Agent in project nutricompass/);
  assert.match(listed.output, new RegExp(id));
});

test("a schedule, updates and wakes go through the owner only", async (t) => {
  const { service, call, woken } = fixture(t);
  const { heartbeat: _heartbeat, ...scheduled } = OTTO;
  const id = String((await call({ ...scheduled, schedule: { cron: "0 9 * * *", timeZone: "Europe/Kyiv" } })).metadata?.agentId);
  assert.equal(service.get(id)?.manualOnly, undefined);
  assert.equal(service.get(id)?.cadence.kind, "cron");

  await call({ action: "update", agentId: id, description: "Gentle but firm", schedule: null });
  assert.equal(service.get(id)?.description, "Gentle but firm");
  assert.equal(service.get(id)?.manualOnly, true);

  await call({ action: "run", agentId: id, message: "What should I cook?" });
  assert.deepEqual(woken, [{ id, input: "What should I cook?" }]);

  // Another member neither reads, changes nor wakes it; they learn only that it is not theirs to see.
  const bob = { actorUserId: "usr_bob" };
  await assert.rejects(call({ action: "get", agentId: id }, bob), { code: "not-found" });
  await assert.rejects(call({ action: "update", agentId: id, name: "Hijack" }, bob), { code: "not-found" });
  await assert.rejects(call({ action: "run", agentId: id }, bob), { code: "not-found" });
  assert.match((await call({ action: "list" }, bob)).output, /No Polyth Agents/);
});

test("create refuses system turns, viewers, foreign projects and bad input", async (t) => {
  const { service, call } = fixture(t);
  await assert.rejects(call(OTTO, { actorUserId: undefined }), { code: "forbidden" });
  await assert.rejects(call(OTTO, { actorUserId: "system:schedule" }), { code: "forbidden" });
  await assert.rejects(call(OTTO, { actorUserId: "usr_vic" }), { code: "forbidden" });
  await assert.rejects(call(OTTO, { actorUserId: "usr_stranger" }), { code: "forbidden" });
  await assert.rejects(call({ ...OTTO, projectId: "prj_other" }), { code: "not-found" });
  await assert.rejects(call({ ...OTTO, charter: " " }), { code: "invalid-input" });
  await assert.rejects(call({ ...OTTO, icon: "skull" }), { code: "invalid-input" });
  await assert.rejects(call({ ...OTTO, memory: "fresh" }), { code: "invalid-input" });
  assert.equal(service.list().length, 0);
});

test("the package registers the skill and tool on enable and removes them on disable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agents-register-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registered = new Map<string, string>();
  const services = new Map<string, unknown>([[serverServiceKey("harness.capabilities").id, {
    register: (owner: string, contribution: { descriptor: { id: string; owner: string } }) => {
      assert.equal(contribution.descriptor.owner, owner);
      registered.set(contribution.descriptor.id, owner);
      return { dispose: () => { registered.delete(contribution.descriptor.id); } };
    },
  }]]);
  const host = {
    pluginId: "agents",
    deployment: "local-trusted",
    storageDir: join(dir, "shared"),
    projects: { list: async () => [], get: async () => undefined },
    systemSpaceContext: (spaceId: string) => ({ spaceId, userId: "system:test", storageDir: join(dir, spaceId) }),
    spaceStorage: (ctx: { spaceId: string }) => ({ root: join(dir, ctx.spaceId), packageDir: (id: string) => join(dir, ctx.spaceId, id), path: (relative: string) => join(dir, relative) }),
    forSpace: () => ({}),
    store: { projection: async () => undefined, events: async () => [] },
    services: {
      provide: (key: { id: string }, value: unknown) => { services.set(key.id, value); },
      get: (key: { id: string }) => services.get(key.id),
    },
  };
  const pkg = registerPackage(host as never);
  await pkg.onEnable!();
  assert.deepEqual([...registered.keys()].sort(), [AGENTS_SKILL_ID, AGENTS_TOOL_ID]);
  await pkg.onDisable!();
  assert.equal(registered.size, 0);
});
