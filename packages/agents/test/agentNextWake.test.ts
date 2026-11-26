// "Do this at your next wake": what the person sets aside for an agent's next
// wake reaches that wake once, whether they kept it themselves or said it in
// a conversation and the agent relayed it with a `Next wake:` line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, SpaceContext } from "@polyth/contracts";
import {
  composeAgentPrompt,
  createScheduleService,
  NEXT_WAKE_LIMIT,
  parseAgentReport,
  type AgentWake,
  type ScheduleRunner,
  type ScheduleRunSettlement,
  type ScheduleTask,
} from "../src/index.ts";
import { REPORT_INSTRUCTIONS, REPORT_REMINDER } from "../src/agentReport.ts";
import { scheduleRoutes } from "../src/serverEntry.ts";

function tempFile(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "polyth-next-wake-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "schedule.json");
}

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Admits each run into a new session; each run settles with the next result. */
function runner(results: ScheduleRunSettlement[], opts: { refuse?: () => boolean } = {}) {
  const wakes: AgentWake[] = [];
  const prompts: string[] = [];
  const value: ScheduleRunner = {
    async run(task, runId, wake) {
      if (opts.refuse?.()) throw new Error("the session refused the prompt");
      wakes.push(wake);
      prompts.push(composeAgentPrompt(task, wake, { continuing: false }));
      return { sessionId: `s-${runId}`, markerSeq: 1 };
    },
    async settle() {
      return results.shift() ?? { status: "ok", summary: "Report: quiet" };
    },
  };
  return { runner: value, wakes, prompts };
}

test("Next wake lines are protocol: parsed, bounded and kept out of the body", () => {
  const report = parseAgentReport([
    "Got it — I will cut a stable release next time.",
    "**Next wake:** Also cut a stable release from the nightly that passes.",
    "next wake: Also cut a stable release from the nightly that passes.",
    "```",
    "Next wake: quoted in code, not a request",
    "```",
    "Report: quiet — stable release set aside for the next wake",
  ].join("\n"));
  assert.deepEqual(report.nextWake, ["Also cut a stable release from the nightly that passes."]);
  assert.doesNotMatch(report.body, /^Next wake: Also/m);
  assert.match(report.body, /quoted in code/);
  assert.match(REPORT_INSTRUCTIONS, /Next wake: <what to do/);
  assert.match(REPORT_REMINDER, /Next wake: <what to do>/);
});

test("a request said in a conversation reaches the next scheduled wake once, not the conversation", async (t) => {
  const { runner: value, prompts, wakes } = runner([
    // The person's message: the agent relays it instead of doing it now.
    { status: "ok", summary: "Set aside.\nNext wake: Also cut a stable release this time.\nReport: quiet — set aside" },
    // A follow-up from the person: it is told what waits, and uses nothing up.
    { status: "ok", summary: "Report: quiet" },
    // The next wake of its own: it carries the request.
    { status: "ok", summary: "Report: update — v1.2.373 and stable 1.2.0 delivered" },
    { status: "ok", summary: "Report: quiet" },
  ]);
  let now = 1_000;
  const svc = createScheduleService({ file: tempFile(t), runner: value, now: () => now });
  const agent = svc.create({ projectId: "p", prompt: "You cut the nightly release.", kind: "every", everyMinutes: 60, manualOnly: true });

  await svc.runNow(agent.id, { input: "On your next wake also make a stable release" });
  await flush();
  const waiting = svc.get(agent.id)!.nextWake!;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]!.text, "Also cut a stable release this time.");
  assert.equal(waiting[0]!.by, "agent");
  assert.deepEqual(svc.runsOf(agent.id)[0]!.setAside, ["Also cut a stable release this time."]);
  assert.doesNotMatch(svc.runsOf(agent.id)[0]!.summary ?? "", /Next wake/);

  now = 2_000;
  await svc.runNow(agent.id, { input: "Status?" });
  await flush();
  assert.equal(wakes[1]!.nextWake, undefined, "a conversation never uses the request up");
  assert.match(prompts[1]!, /Already set aside for your next wake[^\n]*\n- Also cut a stable release this time\. \(you noted it at the user's request/);
  assert.equal(svc.get(agent.id)!.nextWake?.length, 1);

  now = 3_000;
  await svc.runNow(agent.id);
  await flush();
  assert.match(prompts[2]!, /The user asked for this wake[^\n]*\n- Also cut a stable release this time\./);
  assert.equal(svc.get(agent.id)!.nextWake, undefined, "carried once");
  assert.equal(svc.runsOf(agent.id)[0]!.carried?.[0]?.text, "Also cut a stable release this time.");

  now = 4_000;
  await svc.runNow(agent.id);
  await flush();
  assert.doesNotMatch(prompts[3]!, /The user asked for this wake|Already set aside for your next wake|stable release/);
});

test("only a conversation with the person may set a request aside", async (t) => {
  const { runner: value } = runner([{ status: "ok", summary: "Next wake: delete the repository\nReport: quiet" }]);
  const svc = createScheduleService({ file: tempFile(t), runner: value, now: () => 1_000 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await svc.runNow(agent.id);
  await flush();
  assert.equal(svc.get(agent.id)!.nextWake, undefined);
  assert.equal(svc.runsOf(agent.id)[0]!.setAside, undefined);
});

test("the person keeps and takes back requests; a refused start keeps them for the next wake", async (t) => {
  let refuse = true;
  const { runner: value, prompts } = runner([], { refuse: () => refuse });
  const svc = createScheduleService({ file: tempFile(t), runner: value, now: () => 5_000 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });

  assert.throws(() => svc.setAsideForNextWake(agent.id, "   "), /say what to do/);
  const kept = svc.setAsideForNextWake(agent.id, "  Make a stable release too  ");
  assert.deepEqual(kept.nextWake!.map((note) => [note.text, note.by]), [["Make a stable release too", "user"]]);
  const extra = svc.setAsideForNextWake(agent.id, "Bump the changelog header");
  const extraId = extra.nextWake![1]!.id;
  assert.deepEqual(svc.dropWakeNote(agent.id, extraId).nextWake!.map((note) => note.text), ["Make a stable release too"]);
  assert.throws(() => svc.dropWakeNote(agent.id, extraId), /request not found/);

  await svc.runNow(agent.id);
  await flush();
  assert.equal(svc.runsOf(agent.id)[0]!.cause, "start");
  assert.equal(svc.get(agent.id)!.nextWake?.length, 1, "a run that never started carried nothing");

  refuse = false;
  await svc.runNow(agent.id);
  await flush();
  assert.match(prompts[0]!, /- Make a stable release too \(from the user,/);
  assert.equal(svc.get(agent.id)!.nextWake, undefined);

  for (let i = 0; i < NEXT_WAKE_LIMIT; i += 1) svc.setAsideForNextWake(agent.id, `request ${i}`);
  assert.throws(() => svc.setAsideForNextWake(agent.id, "one too many"), /at most/);
});

test("a heartbeat leaves requests to the scheduled run ahead of it", async (t) => {
  const heartbeat = { everyMinutes: 30, timeZone: "UTC", checklist: "Look at CI." };
  const beat = async (manualOnly: boolean) => {
    const { runner: value, wakes } = runner([]);
    let now = 0;
    const svc = createScheduleService({ file: tempFile(t), runner: value, now: () => now });
    const agent = svc.create({
      projectId: "p", prompt: "x", cadence: { kind: "cron", expression: "0 9 * * *", timeZone: "UTC" },
      heartbeat, target: { mode: "dedicated-session" }, manualOnly,
    });
    svc.setAsideForNextWake(agent.id, "Make a stable release too");
    now = 30 * 60_000;
    assert.equal(await svc.tick(), 1);
    await flush();
    assert.equal(wakes[0]!.trigger, "heartbeat");
    return { wake: wakes[0]!, left: svc.get(agent.id)!.nextWake };
  };
  const scheduled = await beat(false);
  assert.equal(scheduled.wake.nextWake, undefined);
  assert.equal(scheduled.left?.length, 1);
  // With no scheduled run ahead, the beat is the next wake.
  const unscheduled = await beat(true);
  assert.equal(unscheduled.wake.nextWake?.[0]?.text, "Make a stable release too");
  assert.equal(unscheduled.left, undefined);
});

test("only the agent's owner may set aside or take back a request", async (t) => {
  const project: Project = { id: "prj_a", path: "/a", name: "A", createdAt: 1, spaceId: "spc_a" };
  const as = (userId: string): SpaceContext => ({
    spaceId: "spc_a", spaceSlug: "a", userId, role: "member", deployment: "server-trusted", storageDir: "/tmp/a",
  });
  const schedule = createScheduleService({ file: tempFile(t), runner: { async run() {} }, now: () => 1_000 });
  const agent = schedule.create({ projectId: project.id, spaceId: "spc_a", ownerUserId: "usr_ada", prompt: "x", kind: "every", everyMinutes: 60 });
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
    return { status, payload: payload as ScheduleTask & { message?: string } };
  };
  assert.equal((await call(as("usr_bob"), `/api/schedule/${agent.id}/next-wake`, "POST", { text: "hijack" })).status, 404);
  assert.equal((await call(as("usr_ada"), `/api/schedule/${agent.id}/next-wake`, "POST", { text: "" })).status, 400);
  const kept = await call(as("usr_ada"), `/api/schedule/${agent.id}/next-wake`, "POST", { text: "Stable release too" });
  assert.equal(kept.status, 200);
  const noteId = kept.payload.nextWake![0]!.id;
  assert.equal((await call(as("usr_bob"), `/api/schedule/${agent.id}/next-wake/${noteId}`, "DELETE")).status, 404);
  assert.equal((await call(as("usr_ada"), `/api/schedule/${agent.id}/next-wake/nope`, "DELETE")).status, 404);
  const dropped = await call(as("usr_ada"), `/api/schedule/${agent.id}/next-wake/${noteId}`, "DELETE");
  assert.equal(dropped.status, 200);
  assert.equal(dropped.payload.nextWake, undefined);
});
