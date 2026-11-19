// What keeps an agent working when nobody watches: a run that was cut says
// why, a stop someone asked for is never the agent's failure, a refused
// start is tried again, and what only the person can clear reaches them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeAgentPrompt,
  composeResumePrompt,
  createScheduleService,
  failureNeedsPerson,
  failureWords,
  openNeeds,
  parseAgentReport,
  sameNeed,
  spendInLastDay,
  unfinishedRun,
  WORKING_REMINDER,
  WORKING_RULES,
  type ScheduleRunner,
  type ScheduleRunRecord,
  type ScheduleRunSettlement,
  type ScheduleTask,
} from "../src/index.ts";

function deferredRunner(run?: ScheduleRunner["run"]) {
  const pending: Array<(result: ScheduleRunSettlement) => void> = [];
  let admitted = 0;
  const runner: ScheduleRunner = {
    run: run ?? (async () => {
      admitted += 1;
      return { sessionId: `s${admitted}`, markerSeq: 1 };
    }),
    settle(_task, _run, signal) {
      return new Promise((resolve, reject) => {
        pending.push(resolve);
        signal.addEventListener("abort", () => reject(Object.assign(new Error("detached"), { name: "AbortError" })), { once: true });
      });
    },
  };
  return {
    runner,
    finishNext: async (result: ScheduleRunSettlement) => {
      pending.shift()!(result);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function tempFile(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agent-autonomy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "schedule.json");
}

test("a run's record keeps why it ended, how often it continued itself and whether a person redirected it", async (t) => {
  const runner = deferredRunner();
  const svc = createScheduleService({ file: tempFile(t), runner: runner.runner, now: () => 1_000 });
  const task = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60 });

  await svc.runNow(task.id);
  await runner.finishNext({ status: "failed", cause: "cut", resumed: 2, error: "Cut off before it finished." });
  const cut = svc.runsOf(task.id)[0]!;
  assert.equal(cut.cause, "cut");
  assert.equal(cut.resumed, 2);

  await svc.runNow(task.id);
  await runner.finishNext({ status: "ok", steered: true, resumed: 1, summary: "Rebuilt.\n\nReport: update — rebuilt" });
  const done = svc.runsOf(task.id)[0]!;
  assert.equal(done.status, "ok");
  assert.equal(done.steered, true);
  assert.equal(done.resumed, 1);
  assert.equal(done.cause, undefined, "a finished run has no cause of failure");

  await svc.runNow(task.id);
  await runner.finishNext({ status: "failed", error: "boom" });
  assert.equal(svc.runsOf(task.id)[0]!.cause, "error", "an unexplained failure is the turn's");
});

test("a stop someone asked for in the session is theirs: it never trips the failure streak", async (t) => {
  const runner = deferredRunner();
  const notified: string[] = [];
  const svc = createScheduleService({
    file: tempFile(t), runner: runner.runner, now: () => 1_000,
    notify: (_task, _run, reason) => notified.push(reason),
  });
  const task = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, pauseAfterFailures: 2 });
  for (let round = 0; round < 3; round += 1) {
    await svc.runNow(task.id);
    await runner.finishNext({ status: "failed", stopped: true, cause: "person", error: "Stopped before it finished." });
  }
  const runs = svc.runsOf(task.id);
  assert.ok(runs.every((run) => run.stopped && run.cause === "person"));
  assert.equal(svc.get(task.id)!.tripped, undefined);
  assert.deepEqual(notified, [], "nobody is told about their own stop");

  // Real failures still trip it, and the person hears that it stopped.
  for (let round = 0; round < 2; round += 1) {
    await svc.runNow(task.id);
    await runner.finishNext({ status: "failed", cause: "cut", error: "Cut off before it finished." });
  }
  assert.equal(svc.get(task.id)!.tripped?.reason, "failures");
  assert.equal(notified.at(-1), "tripped");
});

test("a start refused while the session's runtime is being replaced is tried again instead of losing the wake", async (t) => {
  // The service's own waits never hold a process open; the test must.
  const keepAlive = setInterval(() => {}, 20);
  t.after(() => clearInterval(keepAlive));
  let calls = 0;
  const runner = deferredRunner(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("runtime replacement is pending a durable epoch transition"), { code: "epoch-pending" });
    return { sessionId: "s1", markerSeq: 1 };
  });
  const svc = createScheduleService({ file: tempFile(t), runner: runner.runner, now: () => 1_000, startRetryDelaysMs: [1, 1] });
  const task = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60 });
  await svc.runNow(task.id);
  assert.equal(calls, 3);
  assert.equal(svc.runsOf(task.id).length, 1, "one run, not three");
  assert.equal(svc.runsOf(task.id)[0]!.status, "running");
  await runner.finishNext({ status: "ok" });

  // Out of tries, or another refusal: the run records that it never started.
  calls = -10;
  await svc.runNow(task.id);
  const refused = svc.runsOf(task.id)[0]!;
  assert.equal(refused.status, "failed");
  assert.equal(refused.cause, "start");
  let other = 0;
  const strict = createScheduleService({
    file: tempFile(t), now: () => 1_000, startRetryDelaysMs: [1, 1],
    runner: { run: async () => { other += 1; throw Object.assign(new Error("signed out"), { code: "auth-expired" }); } },
  });
  const signedOut = strict.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60 });
  await strict.runNow(signedOut.id);
  assert.equal(other, 1, "a refused route is not retried blindly");
  assert.equal(strict.runsOf(signedOut.id)[0]!.cause, "route");
});

test("a run that never reached its session spends nothing of the daily budget", () => {
  const run = (over: Partial<ScheduleRunRecord>): ScheduleRunRecord =>
    ({ runId: "r", startedAt: 900, status: "failed", ...over });
  const spend = spendInLastDay([run({ cause: "start" }), run({ cause: "cut", cost: 1 }), run({ status: "ok", cost: 2 })], 1_000);
  assert.equal(spend.runs, 2);
  assert.equal(spend.cost, 3);
});

test("the person hears at once of a failure only they can clear, and of a failed run they started", () => {
  const run = (over: Partial<ScheduleRunRecord>) => ({ status: "failed" as const, trigger: "schedule" as const, ...over });
  assert.equal(failureNeedsPerson(run({ cause: "route" })), true);
  assert.equal(failureNeedsPerson(run({ cause: "approval" })), true);
  assert.equal(failureNeedsPerson(run({ cause: "cut", trigger: "manual" })), true);
  assert.equal(failureNeedsPerson(run({ cause: "cut" })), false, "a scheduled wake that was cut retries next wake");
  assert.equal(failureNeedsPerson(run({ cause: "person", stopped: true, trigger: "manual" })), false);
  assert.equal(failureNeedsPerson({ status: "ok", trigger: "manual" }), false);
  assert.match(failureWords({ cause: "cut", resumed: 2 }), /continued itself 2 times/);
  assert.match(failureWords({ cause: "route", error: "API key expired" }), /model refused.*API key expired/);
});

const task = (history: ScheduleRunRecord[]): Pick<ScheduleTask, "prompt" | "cadence" | "history"> => ({
  prompt: "You release the nightly.",
  cadence: { kind: "cron", expression: "30 4 * * *", timeZone: "Europe/Kyiv" },
  history,
});

test("every new session gets the working rules; a continuing one a reminder", () => {
  const first = composeAgentPrompt(task([]), { trigger: "schedule", at: 0 }, { continuing: false });
  assert.ok(first.includes(WORKING_RULES));
  assert.match(first, /Nobody is watching this run/);
  assert.match(first, /Keep every tool call under 5 minutes/);
  assert.ok(first.indexOf(WORKING_RULES) > first.indexOf("You release the nightly."), "after the charter, which may be stricter");
  const next = composeAgentPrompt(task([]), { trigger: "schedule", at: 0 }, { continuing: true });
  assert.ok(next.includes(WORKING_REMINDER));
  assert.ok(!next.includes(WORKING_RULES));
});

test("a run that follows a cut one is told so first, and not after the person stopped it or it finished", () => {
  const cut: ScheduleRunRecord = { runId: "a", startedAt: 0, finishedAt: 5, status: "failed", cause: "cut", error: "Cut off before it finished." };
  const running: ScheduleRunRecord = { runId: "now", startedAt: 10, status: "running" };
  assert.equal(unfinishedRun([running, cut])?.runId, "a");
  const prompt = composeAgentPrompt(task([running, cut]), { trigger: "schedule", at: 10 }, { continuing: true });
  assert.match(prompt, /Your previous run \(.*\) did not finish: it was cut off/);
  assert.match(prompt, /check what it left half-done/);

  assert.equal(unfinishedRun([running, { ...cut, stopped: true, cause: "person" }]), undefined);
  assert.equal(unfinishedRun([running, { runId: "ok", startedAt: 6, status: "ok" }, cut]), undefined, "a later run finished");
  assert.equal(unfinishedRun([running, { ...cut, cause: "start" }]), undefined, "a run that never started left nothing");
  const beat = composeAgentPrompt(task([running, cut]), { trigger: "heartbeat", at: 10 }, { continuing: true });
  assert.doesNotMatch(beat, /did not finish/);
});

test("the continuation a cut run sends itself tells the agent to inspect before repeating", () => {
  const text = composeResumePrompt("cut", 1);
  assert.match(text, /cut off before you finished/);
  assert.match(text, /The user did not stop you/);
  assert.match(text, /Do not repeat a step that already took effect/);
  assert.match(text, /Report: quiet\|update\|alert/);
  assert.match(composeResumePrompt("error", 2), /error from the model provider.*continuation 2/s);
});

// ---- what waits for the person ----

test("a report closes an earlier request with a Resolved line; the line is protocol, not prose", () => {
  const report = parseAgentReport([
    "devel is green.",
    "Resolved: Electron 45 desktop smoke test — you merged #32",
    "**Resolved:** Rotate the deploy key",
    "Needs you: Accept the Apple agreement — notarization fails until then — https://developer.apple.com/account",
    "Report: alert — Apple agreement expired",
  ].join("\n"));
  assert.deepEqual(report.resolved, ["Electron 45 desktop smoke test", "Rotate the deploy key"]);
  assert.equal(report.needs.length, 1);
  assert.equal(report.body, "devel is green.");
  assert.deepEqual(parseAgentReport("```\nResolved: not a line\n```\nReport: quiet").resolved, [], "code is content");
});

test("the same request asked twice is one request; different requests stay apart", () => {
  assert.equal(sameNeed("Electron 45 desktop smoke test", "electron 45 desktop smoke test."), true);
  assert.equal(sameNeed("Accept the Apple agreement", "Accept the Apple agreement so notarization passes"), true);
  assert.equal(sameNeed("Electron 45 desktop smoke test", "Try the nightly desktop build on Electron 45"), false);
  assert.equal(sameNeed("Merge #3", "Merge #31"), false, "a short request never matches by its opening");
});

test("open requests: newest wording, first date, nothing settled, nothing ancient", () => {
  const day = 24 * 60 * 60_000;
  const now = 100 * day;
  const run = (runId: string, daysAgo: number, needs: Array<{ text: string; done?: { at: number; by: "user" | "agent" } }>, status = "ok") =>
    ({ runId, status, startedAt: now - daysAgo * day, finishedAt: now - daysAgo * day + 60_000, needs });
  const open = openNeeds([
    run("r5", 1, [{ text: "Accept the Apple agreement" }, { text: "Nightly #86 feed step fails" }]),
    run("r4", 2, [{ text: "Accept the Apple agreement" }]),
    run("r3", 3, [{ text: "Rotate the deploy key", done: { at: 1, by: "user" } }]),
    run("r2", 4, [{ text: "Rotate the deploy key" }]),
    run("r1", 40, [{ text: "Review the old plan" }]),
    run("r0", 1, [{ text: "From a run that failed" }], "failed"),
  ], now);
  assert.deepEqual(open.map((need) => [need.text, need.runId, need.index]), [
    ["Accept the Apple agreement", "r5", 0],
    ["Nightly #86 feed step fails", "r5", 1],
  ]);
  assert.equal(open[0]!.since, now - 2 * day + 60_000, "asked first two days ago");
});

test("a request is settled by the person or by the agent's own Resolved line, wherever it was asked", async (t) => {
  const runner = deferredRunner();
  const svc = createScheduleService({ file: tempFile(t), runner: runner.runner, now: () => 5_000 });
  const task = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60 });
  const report = async (summary: string) => {
    await svc.runNow(task.id);
    await runner.finishNext({ status: "ok", summary });
    return svc.runsOf(task.id)[0]!;
  };
  const first = await report("Held.\nNeeds you: Electron 45 desktop smoke test — merge or hold #32\nNeeds you: Rotate the deploy key\nReport: update — held");
  const second = await report("Still held.\nNeeds you: Electron 45 desktop smoke test\nReport: update — still held");
  assert.deepEqual(openNeeds(svc.runsOf(task.id), 5_000).map((need) => need.text), ["Electron 45 desktop smoke test", "Rotate the deploy key"]);

  // The person settles one: every copy of it, so it does not come back from the older report.
  svc.setNeedDone(task.id, second.runId, 0, true);
  assert.deepEqual(svc.runsOf(task.id).flatMap((run) => (run.needs ?? []).map((need) => `${need.text}:${need.done?.by ?? "open"}`)), [
    "Electron 45 desktop smoke test:user",
    "Electron 45 desktop smoke test:user", "Rotate the deploy key:open",
  ]);
  svc.setNeedDone(task.id, first.runId, 0, false);
  assert.equal(openNeeds(svc.runsOf(task.id), 5_000).length, 2, "reopened everywhere too");
  assert.throws(() => svc.setNeedDone(task.id, first.runId, 9, true), /request not found/);

  // The agent closes the other itself.
  await report("Key rotated by you.\nResolved: Rotate the deploy key\nReport: quiet");
  const key = svc.runsOf(task.id).flatMap((run) => run.needs ?? []).find((need) => need.text === "Rotate the deploy key")!;
  assert.equal(key.done?.by, "agent");
  assert.deepEqual(openNeeds(svc.runsOf(task.id), 5_000).map((need) => need.text), ["Electron 45 desktop smoke test"]);
});

test("each wake tells the agent what it already asked for, so it neither repeats nor forgets to close it", () => {
  const asked: ScheduleRunRecord = {
    runId: "a", startedAt: 0, finishedAt: 5, status: "ok", signal: "update",
    needs: [{ text: "Electron 45 desktop smoke test" }, { text: "Rotate the deploy key", done: { at: 6, by: "user" } }],
  };
  const prompt = composeAgentPrompt(task([{ runId: "now", startedAt: 10, status: "running" }, asked]), { trigger: "schedule", at: 10 }, { continuing: true });
  assert.match(prompt, /Still waiting for the user, from your earlier reports/);
  assert.match(prompt, /- Electron 45 desktop smoke test \(since 1970-01-01\)/);
  assert.doesNotMatch(prompt, /Rotate the deploy key/);
  assert.match(prompt, /Resolved: <the same words>/);
});
