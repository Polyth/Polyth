import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWakeScript, runWakeScript, scriptEvents } from "../src/agentScript.ts";
import { createScheduleService, type AgentEvent, type AgentWake, type ScheduleRunner } from "../src/index.ts";
import { scheduleRoutes } from "../src/serverEntry.ts";

const event = (title: string, over: Partial<AgentEvent> = {}): AgentEvent => ({
  id: title, kind: "session", at: 1, projectId: "p", outcome: "failed", chainDepth: 0, fields: { title, error: "exit 1" }, ...over,
});
const input = (events: AgentEvent[]) => ({ events: scriptEvents(events), agent: { name: "Triage", runsToday: 2, lastRunAt: null } });

test("a wake script decides from the events it is given", async () => {
  const script = `
    const deploys = events.filter((e) => /deploy/i.test(e.fields.title));
    if (!deploys.length) return { action: "skip", reason: "no deploy failed" };
    if (agent.runsToday >= 5) return { action: "pause", reason: "too busy" };
    return { action: "run", note: deploys.map((e) => e.fields.title).join(", ") };`;
  const ran = await runWakeScript(script, input([event("Deploy api"), event("Docs")]));
  assert.ok(ran.ok);
  assert.deepEqual(ran.ok && ran.decision, { action: "run", note: "Deploy api" });
  const skipped = await runWakeScript(script, input([event("Docs")]));
  assert.ok(skipped.ok && skipped.decision.action === "skip" && skipped.decision.reason === "no deploy failed");
  const plain = await runWakeScript("return true", input([]));
  assert.ok(plain.ok && plain.decision.action === "run", "true means run");
});

test("the sandbox has no host access and bounded time and memory", async () => {
  const globals = await runWakeScript(
    `return { action: "run", note: [typeof process, typeof require, typeof fetch, typeof globalThis.__host, typeof setTimeout].join(",") };`,
    input([]),
  );
  assert.ok(globals.ok && globals.decision.action === "run");
  assert.equal(globals.ok && globals.decision.action === "run" ? globals.decision.note : "", "undefined,undefined,undefined,undefined,undefined");

  const loop = await runWakeScript("while (true) {}", input([]));
  assert.ok(!loop.ok && /longer than 50 ms/.test(loop.error));
  assert.ok(loop.ms < 1_000);
  const memory = await runWakeScript('let s = "x"; for (let i = 0; i < 30; i++) s += s; return true;', input([]));
  assert.ok(!memory.ok, "a 1 GB string cannot be built in a 16 MB sandbox");
  const deep = await runWakeScript("const f = () => f(); f();", input([]));
  assert.ok(!deep.ok, "unbounded recursion stops at the stack limit");

  const escape = await runWakeScript(`return { action: "run", note: String(this.constructor.constructor("return typeof process")()) };`, input([]));
  assert.ok(!escape.ok || (escape.decision.action === "run" && escape.decision.note === "undefined"), "constructor tricks only reach the sandbox itself");
  assert.ok(!(await runWakeScript('return { action: "delete-everything" }', input([]))).ok);
  assert.ok(!(await runWakeScript("return 42", input([]))).ok);
  assert.match((await checkWakeScript("return {"))!, /SyntaxError/);
  assert.equal(await checkWakeScript("return true;"), undefined);
});

function tempFile(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agent-scripts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "schedule.json");
}

test("an event wake with a script runs, skips or pauses the agent as the script says", async (t) => {
  const wakes: AgentWake[] = [];
  const runner: ScheduleRunner = { async run(_task, _id, wake) { wakes.push(wake); return { sessionId: "s", markerSeq: 1 }; } };
  let now = 0;
  const svc = createScheduleService({
    file: tempFile(t), runner, now: () => now,
    runScript: (task, script, events) => runWakeScript(script, { events: scriptEvents(events), agent: { name: task.title ?? "", runsToday: 0, lastRunAt: null } }),
  });
  const pace = { quietMs: 0, coalesce: "latest", maxPerHour: 60 };
  const agent = svc.create({
    projectId: "p", prompt: "Fix deploys.", kind: "every", everyMinutes: 60, manualOnly: true,
    eventTriggers: [{
      id: "fails", kind: "session", on: ["failed"], pace,
      script: `const t = events[0].fields.title;
        if (t === "boom") throw new Error("bad data");
        if (t === "stop") return { action: "pause", reason: "maintenance" };
        return t.startsWith("Deploy") ? { action: "run", note: "Look at " + t } : { action: "skip", reason: "not a deploy" };`,
    }],
  });
  const offer = async (title: string) => {
    now += 1_000;
    svc.dispatchEvent(event(title, { at: now }));
    now += 1;
    await svc.flushEvents();
  };
  await offer("Docs");
  await offer("Deploy api");
  await offer("boom");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.note, "Look at Deploy api", "the script's note reaches the agent");
  assert.equal(wakes[0]!.input, undefined, "and is not the person's words");
  assert.deepEqual(svc.get(agent.id)!.eventLog!.map((entry) => [entry.outcome, entry.text]), [
    ["script-error", "Error: bad data"],
    ["fired", undefined],
    ["script-skip", "not a deploy"],
  ]);
  await offer("stop");
  assert.equal(svc.get(agent.id)!.enabled, false, "pause pauses the agent");
  assert.equal(svc.get(agent.id)!.eventLog![0]!.outcome, "script-pause");
});

test("a stop while the script runs keeps its events and those that came meanwhile, on disk", async (t) => {
  const wakes: AgentWake[] = [];
  const runner: ScheduleRunner = { async run(_task, _id, wake) { wakes.push(wake); return { sessionId: "s", markerSeq: 1 }; } };
  const file = tempFile(t);
  let decide!: () => void;
  let now = 1_000;
  const svc = createScheduleService({
    file, runner, now: () => now,
    runScript: () => new Promise((resolve) => { decide = () => resolve({ ok: true, decision: { action: "run" } }); }),
  });
  const agent = svc.create({
    projectId: "p", prompt: "Fix deploys.", kind: "every", everyMinutes: 60, manualOnly: true,
    eventTriggers: [{ id: "fails", kind: "session", on: ["failed"], pace: { quietMs: 0, coalesce: "batch", maxPerHour: 60 }, script: "return true" }],
  });
  svc.start();
  svc.dispatchEvent(event("Deploy api", { at: now }));
  now += 1;
  const flushing = svc.flushEvents();
  await new Promise((resolve) => setTimeout(resolve, 0));
  svc.dispatchEvent(event("Deploy web", { at: now }));
  svc.stop();
  decide();
  await flushing;
  assert.equal(wakes.length, 0, "nothing woke while stopped");
  const reloaded = createScheduleService({ file, runner, now: () => now });
  assert.deepEqual(reloaded.get(agent.id)!.paceState!.fails!.pending.map((item) => item.fields.title), ["Deploy api", "Deploy web"]);
  svc.start();
  now += 1;
  const again = svc.flushEvents();
  await new Promise((resolve) => setTimeout(resolve, 0));
  decide();
  await again;
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.events?.length, 2, "one wake carries both");
  svc.stop();
});

test("a wake removed while its script ran is not brought back by a stop", async (t) => {
  const runner: ScheduleRunner = { async run() { return { sessionId: "s", markerSeq: 1 }; } };
  const file = tempFile(t);
  let decide!: () => void;
  const svc = createScheduleService({
    file, runner, now: () => 2_000,
    runScript: () => new Promise((resolve) => { decide = () => resolve({ ok: true, decision: { action: "run" } }); }),
  });
  const agent = svc.create({
    projectId: "p", prompt: "Fix deploys.", kind: "every", everyMinutes: 60, manualOnly: true,
    eventTriggers: [{ id: "fails", kind: "session", on: ["failed"], pace: { quietMs: 0, coalesce: "batch", maxPerHour: 60 }, script: "return true" }],
  });
  svc.start();
  svc.dispatchEvent(event("Deploy api", { at: 1_999 }));
  const flushing = svc.flushEvents();
  await new Promise((resolve) => setTimeout(resolve, 0));
  svc.update(agent.id, { eventTriggers: [] });
  svc.stop();
  decide();
  await flushing;
  assert.equal(svc.get(agent.id)!.paceState?.fails, undefined);
  const reloaded = createScheduleService({ file, runner, now: () => 2_000 });
  assert.equal(reloaded.get(agent.id)!.paceState?.fails, undefined, "nothing left for the timer to chase");
});

test("without a sandbox a scripted wake never fires", async (t) => {
  const wakes: AgentWake[] = [];
  const runner: ScheduleRunner = { async run(_task, _id, wake) { wakes.push(wake); return { sessionId: "s", markerSeq: 1 }; } };
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => 5 });
  svc.create({
    projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true,
    eventTriggers: [{ id: "fails", kind: "session", on: ["failed"], pace: { quietMs: 0, coalesce: "latest", maxPerHour: 60 }, script: "return true" }],
  });
  svc.dispatchEvent(event("Deploy"));
  await svc.flushEvents();
  assert.equal(wakes.length, 0);
});

test("a script that does not compile is refused before the agent is saved", async (t) => {
  const svc = createScheduleService({ file: tempFile(t), runner: { async run() {} }, now: () => 0 });
  const route = scheduleRoutes({
    schedule: svc,
    forSpace: (() => ({ projects: { get: async () => ({ id: "p", path: "/p" }), list: async () => [] }, sessions: {} })) as never,
    checkScript: checkWakeScript,
  });
  let status = 0;
  let payload: { message?: string } = {};
  await route({
    path: "/api/schedule", method: "POST", url: new URL("http://x/api/schedule"),
    body: async () => ({
      projectId: "p", prompt: "x", kind: "every", everyMinutes: 60,
      eventTriggers: [{ id: "fails", kind: "session", on: ["failed"], script: "return {" }],
    }),
    json: (code: number, value: { message?: string }) => { status = code; payload = value; },
    space: { spaceId: "spc", userId: "u" },
  } as never);
  assert.equal(status, 400);
  assert.match(payload.message!, /Wake "fails": SyntaxError/);
  assert.equal(svc.list().length, 0);
});

test("testing a script runs it on the newest matching event and changes nothing", async (t) => {
  const svc = createScheduleService({ file: tempFile(t), runner: { async run() {} }, now: () => 0 });
  const route = scheduleRoutes({
    schedule: svc,
    forSpace: (() => ({ projects: { get: async () => ({ id: "p", path: "/p" }), list: async () => [] }, sessions: {} })) as never,
    recentSessionEvents: async () => [event("Docs", { at: 1, outcome: "completed" }), event("Deploy web", { at: 2 }), event("Deploy api", { at: 3 })],
    testScript: (script, events) => runWakeScript(script, { events: scriptEvents(events), agent: { name: "", runsToday: 0, lastRunAt: null } }),
  });
  let payload: { events?: number; result?: { ok: boolean; decision?: { note?: string } } } = {};
  await route({
    path: "/api/schedule/script-test", method: "POST", url: new URL("http://x/api/schedule/script-test"),
    body: async () => ({
      projectId: "p",
      trigger: { id: "fails", kind: "session", on: ["failed"], pace: { quietMs: 0, coalesce: "latest", maxPerHour: 6 },
        script: 'return { action: "run", note: events.map((e) => e.fields.title).join("|") };' },
    }),
    json: (_code: number, value: typeof payload) => { payload = value; },
    space: { spaceId: "spc", userId: "u" },
  } as never);
  assert.equal(payload.events, 1, "latest coalescing hands the script one event");
  assert.equal(payload.result?.decision?.note, "Deploy api");
  assert.equal(svc.list().length, 0);
});
