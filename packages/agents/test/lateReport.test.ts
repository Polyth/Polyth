import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@polyth/contracts";
import {
  createScheduleService,
  scanLateReport,
  type LateReportScan,
  type ScheduleRunner,
  type ScheduleRunSettlement,
} from "../src/index.ts";

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): SessionEvent =>
  ({ id: `e${seq}`, seq, type, data, sessionId: "s1", time: seq } as unknown as SessionEvent);
const wake = (seq: number) => ev(seq, "user/message", { text: "A background task you started has finished…", hiddenUserMessage: true });
const usage = (seq: number, output: number) => ev(seq, "usage/recorded", { tokens: { input: 1, output }, cost: 0.5 });

/** The run's first turn: it starts CI in the background and ends with an interim line. */
const firstTurn = [
  ev(2, "user/message", { text: "Nightly check." }),
  ev(3, "turn/started"),
  ev(4, "tool/started", { callId: "m1", tool: "Monitor", input: { description: "CI on devel" } }),
  ev(5, "assistant/message", { text: "The notebook entry is saved. I'll write the final report once CI finishes." }),
  usage(6, 10),
  ev(7, "turn/stopped", { reason: "completed" }),
];
const lateTurn = [
  wake(8),
  ev(9, "turn/started"),
  ev(10, "assistant/message", { text: "CI passed on devel.\n\nReport: update — Electron patches shipped to devel" }),
  usage(11, 20),
  ev(12, "turn/stopped", { reason: "completed" }),
];

test("the report written in a turn the run's background work woke is the run's", () => {
  const scan = scanLateReport([...firstTurn, ...lateTurn]);
  assert.equal(scan.closed, true);
  assert.match(scan.report!.text, /Report: update — Electron patches shipped/);
  assert.deepEqual(scan.report!.tokens, { input: 2, output: 30 });
  assert.equal(scan.report!.cost, 1);
});

test("a run that reported in its own turn has no other report", () => {
  const own = [ev(3, "turn/started"), ev(4, "assistant/message", { text: "All clear.\nReport: quiet" }), ev(5, "turn/stopped", { reason: "completed" })];
  const scan = scanLateReport([...own, ...lateTurn]);
  assert.equal(scan.report!.text, "All clear.\nReport: quiet");
});

test("a person, another run or an unwoken turn closes the scan without a report", () => {
  const person = scanLateReport([...firstTurn, ev(8, "user/message", { text: "how did it go?" }), ...lateTurn.slice(1)]);
  assert.deepEqual(person, { closed: true });
  const next = scanLateReport([...firstTurn, ev(8, "schedule/run-started"), ...lateTurn]);
  assert.deepEqual(next, { closed: true });
  const unwoken = scanLateReport([...firstTurn, ...lateTurn.slice(1)]);
  assert.deepEqual(unwoken, { closed: true });
  const failed = scanLateReport([ev(3, "turn/started"), ev(4, "turn/stopped", { reason: "error" }), ...lateTurn]);
  assert.deepEqual(failed, { closed: true });
});

test("a wake that has not come yet leaves the scan open", () => {
  assert.deepEqual(scanLateReport(firstTurn), { closed: false });
  assert.deepEqual(scanLateReport([...firstTurn, ...lateTurn.slice(0, 3)]), { closed: false });
});

test("a queued run's scan starts at its own dispatch", () => {
  const other = [ev(2, "turn/started"), ev(3, "assistant/message", { text: "Not the run.\nReport: alert — someone else" }), ev(4, "turn/stopped", { reason: "completed" })];
  const scan = scanLateReport([...other, ev(5, "queue/dispatched", { queueId: "q1" }), ...firstTurn.slice(1), ...lateTurn], "q1");
  assert.match(scan.report!.text, /Electron patches/);
});

function tempFile(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agents-late-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "schedule.json");
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function lateRunner(settled: ScheduleRunSettlement, scans: LateReportScan[]) {
  const reads: string[] = [];
  const runner: ScheduleRunner = {
    async run() {
      return { sessionId: "s1", markerSeq: 1 };
    },
    async settle() {
      return settled;
    },
    async lateReport(_task, run) {
      reads.push(run.runId);
      return scans.shift() ?? { closed: false };
    },
  };
  return { runner, reads };
}

const interim = "The notebook entry is saved. I'll write the final report once CI finishes.";
const late = "CI passed on devel.\n\nRemember: CI takes 25 minutes\nReport: update — Electron patches shipped to devel";

test("a run that settled on an interim line takes its late report, notes and notice", async (t) => {
  const notified: string[] = [];
  const { runner, reads } = lateRunner({ status: "ok", summary: interim }, [
    { closed: false },
    { closed: true, report: { text: late, tokens: { input: 2, output: 30 }, cost: 1 } },
  ]);
  let now = 1_000;
  const svc = createScheduleService({
    file: tempFile(t), runner, now: () => now, notify: (_task, run, reason) => notified.push(`${reason}:${run.headline}`),
  });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true, title: "Sentry", notify: "updates" });
  await svc.runNow(agent.id);
  await flush();
  let [run] = svc.runsOf(agent.id);
  assert.equal(run!.headline, interim);
  assert.equal(run!.lateReport, "watch");
  notified.length = 0;

  await svc.tick(); await flush();
  [run] = svc.runsOf(agent.id);
  assert.equal(run!.lateReport, "watch", "no wake yet: it keeps waiting");
  assert.equal(reads.length, 1);
  await svc.tick(); await flush();
  assert.equal(reads.length, 1, "read at most once a minute");

  now += 60_000;
  await svc.tick(); await flush();
  [run] = svc.runsOf(agent.id);
  assert.equal(run!.lateReport, undefined);
  assert.equal(run!.signal, "update");
  assert.equal(run!.headline, "Electron patches shipped to devel");
  assert.equal(run!.summary, "CI passed on devel.");
  assert.deepEqual(run!.tokens, { input: 2, output: 30 });
  assert.deepEqual(run!.remembered, ["CI takes 25 minutes"]);
  assert.match(svc.get(agent.id)!.notebook ?? "", /CI takes 25 minutes/);
  assert.deepEqual(notified, ["report:Electron patches shipped to devel"]);
});

test("a run with its own report is never read again", async (t) => {
  const { runner, reads } = lateRunner({ status: "ok", summary: "Done.\nReport: update — all green" }, []);
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => 1_000 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await svc.runNow(agent.id);
  await flush();
  assert.equal(svc.runsOf(agent.id)[0]!.lateReport, undefined);
  await svc.tick(); await flush();
  assert.equal(reads.length, 0);
});

test("a late report that never comes stops being looked for after a day", async (t) => {
  const { runner, reads } = lateRunner({ status: "ok", summary: interim }, []);
  let now = 1_000;
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => now });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await svc.runNow(agent.id);
  await flush();
  now += 24 * 60 * 60_000;
  await svc.tick(); await flush();
  const [run] = svc.runsOf(agent.id);
  assert.equal(reads.length, 1);
  assert.equal(run!.lateReport, undefined);
  assert.equal(run!.headline, interim, "what it said stays");
});

test("records from before schema 6 are put right once, without a notice", async (t) => {
  const file = tempFile(t);
  const task = {
    id: "a1", projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true, enabled: true,
    title: "Sentry", notify: "updates", nextRunAt: null, createdAt: 1, updatedAt: 1,
    history: [
      { runId: "r2", startedAt: 20, finishedAt: 30, status: "ok", sessionId: "s1", markerSeq: 40, signal: "update", headline: interim, summary: interim },
      { runId: "r1", startedAt: 10, finishedAt: 15, status: "ok", sessionId: "s1", markerSeq: 1, signal: "quiet", headline: "all green", summary: "Nothing new." },
    ],
  };
  writeFileSync(file, JSON.stringify({ v: 5, tasks: [task] }));
  const notified: string[] = [];
  const { runner, reads } = lateRunner({ status: "ok" }, [
    { closed: true, report: { text: late } },
    { closed: true, report: { text: "Nothing new.\nReport: quiet — all green" } },
  ]);
  const svc = createScheduleService({ file, runner, now: () => 1_000, notify: () => notified.push("x") });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).v, 6, "the marks are saved once");
  await svc.tick(); await flush();
  assert.deepEqual(reads, ["r2", "r1"]);
  const [r2, r1] = svc.runsOf("a1");
  assert.equal(r2!.headline, "Electron patches shipped to devel");
  assert.equal(r2!.lateReport, undefined);
  assert.equal(r1!.headline, "all green");
  assert.equal(r1!.signal, "quiet");
  assert.deepEqual(notified, []);
});
