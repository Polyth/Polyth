import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@polyth/contracts";
import {
  composeAgentPrompt,
  createScheduleService,
  rollingKeyOf,
  settleScheduledRun,
  threadDecision,
  type AgentWake,
  type ScheduleRunner,
  type ScheduleRunSettlement,
  type ScheduleTask,
  type ThreadInput,
} from "../src/index.ts";
import { parseAgentDraft } from "../src/agentDraft.ts";

function tempFile(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agents-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "schedule.json");
}

/** Admits immediately; each run ends with the next queued settlement. */
function scriptedRunner(results: ScheduleRunSettlement[]) {
  const wakes: AgentWake[] = [];
  const runner: ScheduleRunner = {
    async run(_task, _runId, wake) {
      wakes.push(wake);
      return { sessionId: `s${wakes.length}`, markerSeq: 1 };
    },
    async settle() {
      return results.shift() ?? { status: "ok" };
    },
  };
  return { runner, wakes };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a manual run carries its trigger and input to the runner and the journal", async (t) => {
  const { runner, wakes } = scriptedRunner([{ status: "ok", summary: "Reviewed 3 PRs.", tokens: { input: 900, output: 100 }, cost: 0.02 }]);
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => 5_000 });
  const agent = svc.create({ projectId: "p", prompt: "Review merged PRs.", kind: "every", everyMinutes: 60, title: "Reviewer" });

  await svc.runNow(agent.id, { input: "  only the API repo  " });
  await flush();

  assert.deepEqual(wakes, [{ trigger: "manual", at: 5_000, input: "only the API repo" }]);
  const [run] = svc.runsOf(agent.id);
  assert.equal(run!.trigger, "manual");
  assert.equal(run!.status, "ok");
  assert.equal(run!.summary, "Reviewed 3 PRs.");
  assert.deepEqual(run!.tokens, { input: 900, output: 100 });
  assert.equal(run!.cost, 0.02);
});

test("a manual-only agent never becomes due but still runs by hand", async (t) => {
  const { runner, wakes } = scriptedRunner([]);
  let now = 0;
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => now });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 1, manualOnly: true });
  assert.equal(agent.nextRunAt, null);
  now = 10 * 60_000;
  assert.equal(await svc.tick(), 0);
  await svc.runNow(agent.id);
  assert.equal(wakes.length, 1);
});

test("an exhausted daily budget trips the agent before a scheduled run and lifts by itself", async (t) => {
  const { runner, wakes } = scriptedRunner([]);
  let now = 60_000;
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => now, missedGraceMs: Infinity });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, budget: { runsPerDay: 1 } });

  now += 60 * 60_000;
  assert.equal(await svc.tick(), 1);
  await flush();
  now += 60 * 60_000;
  assert.equal(await svc.tick(), 0, "the second scheduled run is over the daily limit");
  const tripped = svc.get(agent.id)!;
  assert.equal(tripped.tripped?.reason, "budget");
  assert.equal(tripped.nextRunAt, null);
  assert.equal(svc.runsOf(agent.id)[0]!.status, "skipped");
  assert.equal(wakes.length, 1);

  // A manual run is an explicit decision and is not blocked by the budget.
  await svc.runNow(agent.id);
  assert.equal(wakes.length, 2);

  now += 25 * 60 * 60_000;
  await svc.tick();
  assert.equal(svc.get(agent.id)!.tripped, undefined, "the window has room again");
  assert.notEqual(svc.get(agent.id)!.nextRunAt, null);
});

test("consecutive failures trip the agent until the user resumes it", async (t) => {
  const { runner } = scriptedRunner([
    { status: "failed", error: "a" },
    { status: "unknown", error: "lost" },
    { status: "failed", error: "b" },
  ]);
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => 1_000 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, pauseAfterFailures: 2 });

  await svc.runNow(agent.id);
  await flush();
  await svc.runNow(agent.id);
  await flush();
  assert.equal(svc.get(agent.id)!.tripped, undefined, "an unknown outcome does not count as a failure");
  await svc.runNow(agent.id);
  await flush();
  assert.equal(svc.get(agent.id)!.tripped?.reason, "failures");
  assert.equal(svc.get(agent.id)!.nextRunAt, null);

  svc.setEnabled(agent.id, true);
  assert.equal(svc.get(agent.id)!.tripped, undefined);
  assert.notEqual(svc.get(agent.id)!.nextRunAt, null);
});

test("the host-wide run limit skips a due agent instead of piling up sessions", async (t) => {
  const pending: Array<() => void> = [];
  const runner: ScheduleRunner = {
    async run() { return { sessionId: "s", markerSeq: 1 }; },
    settle: () => new Promise((resolve) => pending.push(() => resolve({ status: "ok" }))),
  };
  let now = 0;
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => now, maxConcurrentRuns: 1, missedGraceMs: Infinity });
  const a = svc.create({ projectId: "p", prompt: "a", kind: "every", everyMinutes: 1 });
  const b = svc.create({ projectId: "p", prompt: "b", kind: "every", everyMinutes: 1 });
  now = 61_000;
  assert.equal(await svc.tick(), 1);
  const skipped = [a, b].map((x) => svc.runsOf(x.id)[0]!).find((run) => run.status === "skipped");
  assert.match(skipped!.error!, /already in progress/);
  pending.forEach((resolve) => resolve());
});

test("invalid agent fields are rejected without changing the agent", (t) => {
  const svc = createScheduleService({ file: tempFile(t), runner: scriptedRunner([]).runner, now: () => 0 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 5, title: "Keep" });
  assert.throws(() => svc.update(agent.id, { title: "Changed", budget: { runsPerDay: -1 } }), /runsPerDay/);
  assert.throws(() => svc.update(agent.id, { rotateAt: 1.5 }), /rotateAt/);
  assert.throws(() => svc.update(agent.id, { icon: "../x" }), /icon/);
  assert.equal(svc.get(agent.id)!.title, "Keep");
  const updated = svc.update(agent.id, { budget: { tokensPerDay: 50_000 }, color: "green", icon: "review", description: " Reviews PRs. " });
  assert.deepEqual(updated.budget, { tokensPerDay: 50_000 });
  assert.equal(updated.description, "Reviews PRs.");
  assert.equal(svc.update(agent.id, { budget: null }).budget, undefined);
});

const baseTask = (over: Partial<ScheduleTask> = {}): ScheduleTask => ({
  id: "a", projectId: "p", prompt: "You review merged pull requests.", kind: "cron",
  cadence: { kind: "cron", expression: "0 23 * * *", timeZone: "Europe/Kyiv" },
  enabled: true, createdAt: 0, updatedAt: 0, nextRunAt: null, runs: 0, ...over,
});

test("a new session gets the charter, recent journal notes and the wake", () => {
  const task = baseTask({
    history: [
      { runId: "r3", startedAt: Date.UTC(2026, 9, 11, 20), status: "ok", summary: "Merged 2 PRs, one flaky test." },
      { runId: "r2", startedAt: Date.UTC(2026, 9, 10, 20), status: "skipped", summary: "ignored" },
      { runId: "r1", startedAt: Date.UTC(2026, 9, 9, 20), status: "failed", summary: "CI was down." },
    ],
  });
  const text = composeAgentPrompt(task, { trigger: "schedule", at: Date.UTC(2026, 9, 12, 20), late: true }, { continuing: false });
  assert.ok(text.startsWith("You review merged pull requests.\n\n---\nWake: scheduled run · 2026-10-12 23:00 (Europe/Kyiv) · late"));
  assert.match(text, /- 2026-10-11 23:00 \(Europe\/Kyiv\) · completed: Merged 2 PRs, one flaky test\./);
  assert.match(text, /· failed: CI was down\./);
  assert.doesNotMatch(text, /ignored/);
});

test("a continuing session gets only the wake and the user's input", () => {
  const text = composeAgentPrompt(baseTask({ history: [{ runId: "r", startedAt: 0, status: "ok", summary: "old" }] }),
    { trigger: "manual", at: Date.UTC(2026, 9, 12, 7), input: "Look at #42" }, { continuing: true });
  assert.doesNotMatch(text, /You review/);
  assert.doesNotMatch(text, /old/);
  assert.match(text, /^Wake: started by the user · 2026-10-12 10:00 \(Europe\/Kyiv\)/);
  assert.match(text, /Input from the user:\nLook at #42/);
});

test("a rolling agent rotates on changed instructions, a full context or a compaction", () => {
  const task = baseTask();
  const key = rollingKeyOf(task);
  const at = (fraction?: number, compactedAt?: number) => ({
    contextWindow: {
      source: "native" as const, updatedAt: 0,
      ...(fraction !== undefined ? { fraction } : {}),
      ...(compactedAt ? { compaction: { lastAt: compactedAt } } : {}),
    },
  });
  const decide = (over: Partial<ThreadInput>) => threadDecision({
    mode: "rolling", continuation: "auto", personal: false, now: 0, currentKey: key,
    candidate: { sessionId: "s", at: 0, key }, ...over,
  });
  assert.deepEqual(decide({ candidate: undefined }), { continue: false, reason: "none" });
  assert.deepEqual(decide({ candidate: { sessionId: "s", at: 0, key: "old" }, session: at(0.1) }), { continue: false, reason: "instructions-changed" });
  assert.deepEqual(decide({ session: at(0.65) }), { continue: false, reason: "context-full" });
  assert.deepEqual(decide({ session: at(0.65), rotateAt: 0.8 }), { continue: true, sessionId: "s", resendCharter: false });
  assert.deepEqual(decide({ session: at(0.1, 5) }), { continue: false, reason: "compacted" });
  assert.deepEqual(decide({ session: {} }), { continue: true, sessionId: "s", resendCharter: true },
    "unknown occupancy keeps the session but repeats the charter");
  assert.notEqual(rollingKeyOf({ ...task, prompt: "Other" }), key);
});

test("settlement keeps the run's last answer and sums its usage", async () => {
  const ev = (seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
    ({ seq, type, data, time: seq, sessionId: "s" }) as unknown as SessionEvent;
  const events = [
    ev(2, "assistant/message", { text: "from an earlier turn" }),
    ev(3, "turn/started", {}),
    ev(4, "assistant/message", { text: "Checking…" }),
    ev(5, "usage/recorded", { tokens: { input: 100, output: 10, cacheRead: 50 }, cost: 0.01 }),
    ev(6, "usage/recorded", { tokens: { input: 20, output: 5 }, cost: 0.005 }),
    ev(7, "assistant/message", { text: "  All green; nothing to report.  " }),
    ev(8, "turn/stopped", { reason: "completed" }),
  ];
  const result = await settleScheduledRun(
    { sessionId: "s", markerSeq: 1, startedAt: 0 },
    { signal: new AbortController().signal, events: async (_id, after) => events.filter((e) => e.seq > after) },
  );
  assert.equal(result.status, "ok");
  assert.equal(result.summary, "All green; nothing to report.");
  assert.deepEqual(result.tokens, { input: 120, output: 15, cacheRead: 50 });
  assert.ok(Math.abs(result.cost! - 0.015) < 1e-9);
});

test("a model draft is accepted only with a name and charter; bad fields degrade safely", () => {
  const draft = parseAgentDraft(
    'Sure! {"name":"Nightly Reviewer","description":"Reviews merged PRs.","charter":"You review every pull request merged today and report risks.","icon":"review","cron":"0 23 * * *","context":"rolling"}',
    "Europe/Kyiv",
  );
  assert.deepEqual(draft, {
    name: "Nightly Reviewer",
    description: "Reviews merged PRs.",
    charter: "You review every pull request merged today and report risks.",
    icon: "review",
    schedule: { kind: "cron", expression: "0 23 * * *", timeZone: "Europe/Kyiv" },
    context: "rolling",
  });
  const degraded = parseAgentDraft('{"name":"X","charter":"Do the thing every minute please.","icon":"rm -rf","cron":"* * * * *"}', "UTC");
  assert.equal(degraded!.icon, "bot", "an unusable draft icon degrades to the default robot");
  assert.equal(degraded!.schedule, null, "faster than every 5 minutes is not accepted from a draft");
  assert.equal(degraded!.context, "fresh");
  assert.equal(parseAgentDraft('{"name":"","charter":"long enough charter text"}', "UTC"), undefined);
  assert.equal(parseAgentDraft("no json here", "UTC"), undefined);
});

test("a rolling agent continues its session with a short wake and rotates when its charter changes", async (t) => {
  const { default: registerPackage } = await import("../src/serverEntry.ts");
  const { RUNTIME_SYSTEM_PRINCIPAL_ID, serverServiceKey } = await import("@polyth/plugins");
  const dir = mkdtempSync(join(tmpdir(), "polyth-agents-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = { id: "prj", path: dir, name: "P", createdAt: 1, spaceId: "spc_a" };
  const logs = new Map<string, SessionEvent[]>();
  const append = (sessionId: string, type: string, data: Record<string, unknown>): SessionEvent => {
    const log = logs.get(sessionId) ?? [];
    logs.set(sessionId, log);
    const event = { id: `${sessionId}-${log.length + 1}`, seq: log.length + 1, sessionId, type, data, time: 1 } as unknown as SessionEvent;
    log.push(event);
    return event;
  };
  const sent: Array<{ sessionId: string; text: string }> = [];
  const sessions = {
    async create() { const id = `ses${logs.size + 1}`; logs.set(id, []); return { id }; },
    async snapshot(id: string) { return { id, projectId: "prj", status: "idle" }; },
    async send(sessionId: string, input: { text: string }) {
      sent.push({ sessionId, text: input.text });
      append(sessionId, "turn/started", { turnId: "t" });
      append(sessionId, "assistant/message", { text: `Answer ${sent.length}` });
      append(sessionId, "turn/stopped", { turnId: "t", reason: "completed" });
      return { turnId: "t" };
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
      projection: async (id: string) => logs.has(id)
        ? { id, projectId: "prj", status: "idle", contextWindow: { source: "exact", updatedAt: 1, fraction: 0.2 } }
        : undefined,
      events: async (id: string, afterSeq = 0) => (logs.get(id) ?? []).filter((event) => event.seq > afterSeq),
    },
    events: { append: async (id: string, type: string, data: Record<string, unknown>) => append(id, type, data) },
    services: {
      provide: (key: { id: string }, value: unknown) => { services.set(key.id, value); },
      get: (key: { id: string }) => services.get(key.id),
    },
  };
  const pkg = registerPackage(host as never);
  await pkg.onEnable!();
  t.after(() => pkg.onDisable!());
  const agents = services.get(serverServiceKey("agents").id) as ReturnType<typeof createScheduleService>;
  const settled = async (id: string) => {
    for (let i = 0; i < 100 && agents.runsOf(id)[0]!.status === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await flush(); // the overlap guard releases right after the record settles
  };
  const agent = agents.create({
    projectId: "prj", spaceId: "spc_a", prompt: "You watch the build.", kind: "every", everyMinutes: 60,
    target: { mode: "dedicated-session" },
  });

  await agents.runNow(agent.id);
  await settled(agent.id);
  assert.equal(sent[0]!.sessionId, "ses1");
  assert.match(sent[0]!.text, /^You watch the build\./);
  assert.equal(agents.runsOf(agent.id)[0]!.summary, "Answer 1");

  await agents.runNow(agent.id, { input: "check #7" });
  await settled(agent.id);
  assert.equal(sent[1]!.sessionId, "ses1", "the rolling session continues");
  assert.doesNotMatch(sent[1]!.text, /You watch the build/);
  assert.match(sent[1]!.text, /check #7/);

  agents.update(agent.id, { prompt: "You watch the build and the deploy." });
  await agents.runNow(agent.id);
  await settled(agent.id);
  assert.equal(sent[2]!.sessionId, "ses2", "a changed charter starts a new session");
  assert.match(sent[2]!.text, /^You watch the build and the deploy\.[\s\S]*Notes from your previous runs[\s\S]*Answer 2/);
  assert.equal(agents.runsOf(agent.id)[0]!.rotated, "instructions-changed");
});

test("the draft route stays inside the caller's Space and never drafts from a foreign session", async (t) => {
  const { scheduleRoutes } = await import("../src/serverEntry.ts");
  const svc = createScheduleService({ file: tempFile(t), runner: scriptedRunner([]).runner, now: () => 0 });
  const drafted: unknown[] = [];
  const route = scheduleRoutes({
    schedule: svc,
    forSpace: (() => ({
      projects: { get: async (id: string) => id === "mine" ? { id: "mine", path: "/p", name: "Mine", createdAt: 1 } : undefined },
      sessions: { snapshot: async (id: string) => ({ id, projectId: id === "ses-mine" ? "mine" : "other" }) },
    })) as never,
    draft: async (request) => {
      drafted.push(request);
      return { name: "A", description: "", charter: "Do the thing well.", icon: "assist", schedule: null, context: "fresh" };
    },
    conversationOf: async () => "User: fix the flaky test",
  });
  const call = async (body: Record<string, unknown>) => {
    let status = 0;
    let payload: unknown;
    await route({
      path: "/api/schedule/draft", method: "POST", url: new URL("http://x/api/schedule/draft"),
      body: async () => body, json: (code: number, value: unknown) => { status = code; payload = value; },
      space: { spaceId: "spc", userId: "u" },
    } as never);
    return { status, payload };
  };
  assert.equal((await call({ projectId: "theirs", description: "x" })).status, 404);
  assert.equal((await call({ projectId: "mine", sessionId: "ses-theirs" })).status, 404);
  assert.equal((await call({ projectId: "mine" })).status, 400, "nothing to draft from");
  assert.equal(drafted.length, 0, "no model call for refused requests");
  const ok = await call({ projectId: "mine", sessionId: "ses-mine", timeZone: "Not/AZone" });
  assert.equal(ok.status, 200);
  assert.deepEqual(drafted[0], {
    projectId: "mine", projectPath: "/p", description: "Turn the conversation below into a recurring agent.",
    conversation: "User: fix the flaky test", timeZone: "UTC", userId: "u",
  });
});
