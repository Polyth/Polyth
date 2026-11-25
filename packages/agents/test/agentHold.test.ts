import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventMark, eventMarks, HOLD_RECHECK_MS, holdDecision, lastReportOf } from "../src/agentHold.ts";
import { runWakeScript, scriptEvents } from "../src/agentScript.ts";
import {
  createScheduleService,
  type AgentEvent,
  type AgentWake,
  type ScheduleRunner,
  type ScheduleRunSettlement,
} from "../src/index.ts";

// A monitor that posts the same state every few minutes must not wake an
// agent that already asked its person to decide; anything new still does.

const webhook = (percent: number, over: Partial<AgentEvent["fields"]> = {}): AgentEvent => ({
  id: `e${Math.random()}`,
  kind: "webhook",
  at: 0,
  projectId: "p",
  outcome: "received",
  target: { agentId: "a", triggerId: "script" },
  chainDepth: 0,
  fields: {
    title: "watcher alert — resources: disk-watcher",
    event: "resource-high",
    text: JSON.stringify({ host: "watcher", severity: "warning", summary: `Disk usage on watcher: ${percent}% (threshold: 90%) at 07:29:36` }),
    ...over,
  },
});

test("the same news carries the same key; its figure is the largest percentage", () => {
  const first = eventMark(webhook(92));
  assert.equal(first.figure, 92);
  assert.equal(eventMark(webhook(94)).key, first.key, "numbers and times are not part of the news");
  assert.notEqual(eventMark(webhook(92, { event: "service-down" })).key, first.key);
  const critical = webhook(92);
  critical.fields.text = critical.fields.text!.replace("warning", "critical");
  assert.notEqual(eventMark(critical).key, first.key, "a new severity is news");
  assert.deepEqual(eventMarks([webhook(91), webhook(93)]), [{ key: first.key, figure: 93 }]);
});

test("a repeat is held only while a request is open, the last run saw it and the recheck is not due", () => {
  const now = 10 * 60_000;
  const marks = eventMarks([webhook(92)]);
  const asked = [{ runId: "r1", status: "ok", startedAt: 0, finishedAt: 1, trigger: "event", marks, needs: [{ text: "Clean the history in /home" }] }];
  assert.deepEqual(holdDecision(asked, [webhook(92.5)], now), { hold: true, since: 0, need: "Clean the history in /home" });
  assert.equal(holdDecision(asked, [webhook(94)], now).hold, false, "the figure moved");
  assert.equal(holdDecision(asked, [webhook(92, { event: "service-down" })], now).hold, false, "other news");
  assert.equal(holdDecision(asked, [webhook(92)], HOLD_RECHECK_MS).hold, false, "the recheck is due");
  const settled = [{ ...asked[0]!, needs: [{ text: "Clean the history in /home", done: { at: 5, by: "user" as const } }] }];
  assert.equal(holdDecision(settled, [webhook(92)], now).hold, false, "nothing waits for the person");
  const answered = [{ runId: "r2", status: "ok", startedAt: 5, trigger: "manual" }, ...asked];
  assert.equal(holdDecision(answered, [webhook(92)], now).hold, false, "the person answered since");
  const failed = [{ runId: "r2", status: "failed", startedAt: 5, trigger: "event", marks }, ...asked];
  assert.equal(holdDecision(failed, [webhook(92)], now).hold, false, "the last run did not finish");
});

function tempFile(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agent-hold-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "schedule.json");
}

test("through the engine: repeats are counted, not run, and the next wake hears about them", async (t) => {
  const wakes: AgentWake[] = [];
  const reports: ScheduleRunSettlement[] = [];
  const runner: ScheduleRunner = {
    async run(_task, _runId, wake) {
      wakes.push(wake);
      return { sessionId: `s${wakes.length}`, markerSeq: 1 };
    },
    async settle(_task, run) {
      return reports[Number(run.sessionId!.slice(1)) - 1]!;
    },
  };
  let now = 0;
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => now });
  const agent = svc.create({
    projectId: "p", prompt: "Keep the hosts healthy.", kind: "every", everyMinutes: 60, manualOnly: true,
    eventTriggers: [{ id: "script", kind: "session", on: ["failed"], pace: { quietMs: 60_000, coalesce: "batch", maxPerHour: 60 } }],
  });
  const settled = async () => {
    for (let i = 0; i < 50 && svc.runsOf(agent.id)[0]?.status === "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  };
  const disk = (percent: number): AgentEvent => ({
    id: `e${now}`, kind: "session", at: now, projectId: "p", outcome: "failed", chainDepth: 0,
    fields: { title: "watcher alert — disk", error: `Disk usage on watcher: ${percent}%` },
  });
  const deliver = async (percent: number): Promise<number> => {
    svc.dispatchEvent(disk(percent));
    now += 61_000;
    const fired = await svc.flushEvents();
    await settled();
    return fired;
  };

  reports.push({ status: "ok", summary: "Nothing safe is left to clean.\nNeeds you: clean the history in /home — only that frees /\nReport: alert — / at 92%" });
  assert.equal(await deliver(92), 1);
  assert.equal(svc.runsOf(agent.id)[0]!.signal, "alert");

  now += 15 * 60_000;
  assert.equal(await deliver(92), 0, "the same news is held");
  now += 15 * 60_000;
  assert.equal(await deliver(92.4), 0);
  assert.equal(wakes.length, 1);
  const log = svc.get(agent.id)!.eventLog!;
  assert.equal(log[0]!.outcome, "held");
  assert.equal(log[0]!.count, 2, "repeats share one log line");
  assert.equal(log[0]!.text, "clean the history in /home");

  reports.push({ status: "ok", summary: "It grows.\nNeeds you: clean the history in /home — / will fill\nReport: alert — / at 94%, growing" });
  now += 15 * 60_000;
  assert.equal(await deliver(94), 1, "a moved figure is news");
  assert.match(wakes[1]!.note ?? "", /^2 more events with the same news arrived/);
});

test("asking again for what already waits, with the same figures, is filed quietly and notifies once", async (t) => {
  const reports: ScheduleRunSettlement[] = [
    { status: "ok", summary: "Needs you: clean the history in /home — only that frees /\nReport: alert — / on watcher at 92%, waiting for /home" },
    { status: "ok", summary: "Needs you: clean the history in /home — still the only way\nReport: update — Disk / on watcher 92%, still waiting" },
    { status: "ok", summary: "Needs you: clean the history in /home\nReport: alert — / on watcher 92%, waiting for a decision" },
    { status: "ok", summary: "Needs you: clean the history in /home — it grows\nReport: alert — / on watcher at 94%, growing" },
    { status: "ok", summary: "Needs you: clean the history in /home\nNeeds you: renew the TLS certificate — it expires Friday\nReport: alert — / at 94%, and a certificate expires" },
  ];
  let calls = 0;
  const runner: ScheduleRunner = {
    async run() { calls += 1; return { sessionId: `s${calls}`, markerSeq: 1 }; },
    async settle(_task, run) { return reports[Number(run.sessionId!.slice(1)) - 1]!; },
  };
  const notified: string[] = [];
  let now = 1_000;
  const svc = createScheduleService({
    file: tempFile(t), runner, now: () => now,
    notify: (_task, run, reason) => notified.push(`${reason}:${run.headline}`),
  });
  const agent = svc.create({ projectId: "p", prompt: "Keep the hosts healthy.", kind: "every", everyMinutes: 60, manualOnly: true, notify: "updates" });
  const run = async () => {
    now += 60_000;
    await svc.runNow(agent.id);
    for (let i = 0; i < 50 && svc.runsOf(agent.id)[0]?.status === "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    // The run is released just after it settles.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return svc.runsOf(agent.id)[0]!;
  };

  const first = await run();
  assert.equal(first.signal, "alert");
  const second = await run();
  assert.equal(second.signal, "quiet");
  assert.deepEqual(second.repeat, { of: first.runId, signal: "update" });
  const third = await run();
  assert.equal(third.signal, "quiet", "no stronger than the first ask");
  assert.deepEqual(third.repeat, { of: first.runId, signal: "alert" });
  assert.equal((await run()).signal, "alert", "new figures are news");
  assert.equal((await run()).signal, "alert", "a new request is news");
  assert.deepEqual(notified, [
    "report:/ on watcher at 92%, waiting for /home",
    "report:/ on watcher at 94%, growing",
    "report:/ at 94%, and a certificate expires",
  ]);
});

test("a wake script sees what waits for the person and the last report", async () => {
  const history = [
    { runId: "r2", status: "running", startedAt: 30 },
    { runId: "r1", status: "ok", startedAt: 10, finishedAt: 20, signal: "alert" as const, headline: "/ at 92%" },
  ];
  assert.deepEqual(lastReportOf(history), { signal: "alert", headline: "/ at 92%", at: 20 });
  assert.equal(lastReportOf([]), null);
  const result = await runWakeScript(
    `if (agent.waitingFor.length && agent.lastReport.headline.includes("92%")) return { action: "skip", reason: "still waiting: " + agent.waitingFor[0] };
     return { action: "run" };`,
    { events: scriptEvents([webhook(92)]), agent: { name: "Duty", runsToday: 3, lastRunAt: 10, waitingFor: ["clean /home"], lastReport: lastReportOf(history) } },
  );
  assert.deepEqual(result.ok && result.decision, { action: "skip", reason: "still waiting: clean /home" });
});
