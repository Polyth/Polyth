import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPlannerService,
  type PlannerRunner,
  type PlannerRunSettlement,
} from "../src/index.ts";

/** A runner whose admission is immediate but whose turn ends only when the
 *  test settles it — the gap the planner used to report as success. */
function deferredRunner() {
  const pending: Array<(result: PlannerRunSettlement) => void> = [];
  let admitted = 0;
  const runner: PlannerRunner = {
    async run() {
      admitted += 1;
      return { sessionId: `s${admitted}`, markerSeq: 1 };
    },
    settle(_task, _run, signal) {
      return new Promise((resolve, reject) => {
        pending.push(resolve);
        signal.addEventListener("abort", () => reject(Object.assign(new Error("detached"), { name: "AbortError" })), { once: true });
      });
    },
  };
  return {
    runner,
    admitted: () => admitted,
    finishNext: async (result: PlannerRunSettlement) => {
      pending.shift()!(result);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function tempFile(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "polyth-planner-outcome-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "planner.json");
}

test("a run stays running after admission and records the real turn outcome", async (t) => {
  const file = tempFile(t);
  const runner = deferredRunner();
  const svc = createPlannerService({ file, runner: runner.runner, now: () => 1_000 });
  const task = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60 });

  await svc.runNow(task.id);
  assert.equal(svc.runsOf(task.id)[0]!.status, "running");
  assert.equal(svc.runsOf(task.id)[0]!.sessionId, "s1");
  assert.equal(svc.runsOf(task.id)[0]!.markerSeq, 1);

  await runner.finishNext({ status: "failed", error: "turn failed" });
  assert.equal(svc.runsOf(task.id)[0]!.status, "failed");
  assert.equal(svc.get(task.id)!.lastError, "turn failed");

  await svc.runNow(task.id);
  await runner.finishNext({ status: "ok" });
  assert.equal(svc.runsOf(task.id)[0]!.status, "ok");
  assert.equal(svc.get(task.id)!.lastError, undefined);
});

test("overlap skip holds for the whole turn, not just admission", async (t) => {
  const runner = deferredRunner();
  const svc = createPlannerService({ file: tempFile(t), runner: runner.runner, now: () => 1_000 });
  const task = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, overlapPolicy: "skip" });

  await svc.runNow(task.id);
  await svc.runNow(task.id);
  assert.equal(runner.admitted(), 1, "the second fire was skipped while the first turn ran");
  assert.equal(svc.runsOf(task.id)[0]!.status, "skipped");

  await runner.finishNext({ status: "ok" });
  await svc.runNow(task.id);
  assert.equal(runner.admitted(), 2);
});

test("overlap queue keeps at most one successor behind the active turn", async (t) => {
  const runner = deferredRunner();
  const svc = createPlannerService({ file: tempFile(t), runner: runner.runner, now: () => 1_000 });
  const task = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, overlapPolicy: "queue" });

  await svc.runNow(task.id);
  await svc.runNow(task.id);
  await svc.runNow(task.id);
  assert.equal(runner.admitted(), 1);
  assert.equal(svc.runsOf(task.id).filter((run) => run.status === "skipped").length, 1);

  await runner.finishNext({ status: "ok" });
  assert.equal(runner.admitted(), 2, "the queued successor ran after the first turn ended");
  await runner.finishNext({ status: "ok" });
});

test("a tick never waits for a running turn", async (t) => {
  let clock = 1_000;
  const runner = deferredRunner();
  const svc = createPlannerService({ file: tempFile(t), runner: runner.runner, now: () => clock });
  svc.create({ projectId: "p", prompt: "a", kind: "every", everyMinutes: 1 });
  svc.create({ projectId: "p", prompt: "b", kind: "every", everyMinutes: 1 });
  clock += 61_000;
  assert.equal(await svc.tick(), 2);
  assert.equal(runner.admitted(), 2);
});

test("stop detaches observers; start resumes them; unadmitted runs become unknown", async (t) => {
  const file = tempFile(t);
  const runner = deferredRunner();
  const svc = createPlannerService({ file, runner: runner.runner, now: () => 1_000 });
  const task = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60 });
  svc.start();
  await svc.runNow(task.id);
  svc.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(svc.runsOf(task.id)[0]!.status, "running", "detaching is not an outcome");

  // A new process: the admitted run resumes settlement…
  const resumed = deferredRunner();
  const reloaded = createPlannerService({ file, runner: resumed.runner, now: () => 2_000 });
  reloaded.start();
  t.after(() => reloaded.stop());
  await resumed.finishNext({ status: "ok" });
  assert.equal(reloaded.runsOf(task.id)[0]!.status, "ok");

  // …while a run that never confirmed admission is unknown, never replayed.
  const persisted = JSON.parse(readFileSync(file, "utf8"));
  persisted.tasks[0].history.unshift({ runId: "lost", startedAt: 1_500, status: "running" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, JSON.stringify(persisted));
  let replays = 0;
  const third = createPlannerService({
    file,
    runner: { async run() { replays += 1; } },
    now: () => 3_000,
  });
  third.start();
  t.after(() => third.stop());
  const lost = third.runsOf(task.id).find((run) => run.runId === "lost")!;
  assert.equal(lost.status, "unknown");
  assert.match(lost.error ?? "", /stopped before/);
  assert.equal(replays, 0);
});

test("catch-up: a missed run fires once marked late, or is skipped on request", async (t) => {
  let clock = 1_000_000;
  const fired: string[] = [];
  const svc = createPlannerService({
    file: tempFile(t),
    runner: { async run(task) { fired.push(task.prompt); } },
    now: () => clock,
  });
  const once = svc.create({ projectId: "p", prompt: "once", kind: "every", everyMinutes: 60 });
  const skip = svc.create({ projectId: "p", prompt: "skip", kind: "every", everyMinutes: 60, catchUp: "skip" });
  const onTime = svc.create({ projectId: "p", prompt: "on-time", kind: "every", everyMinutes: 60, catchUp: "skip" });
  // Polyth was down for hours; on-time is only due now.
  clock += 6 * 60 * 60_000;
  svc.update(onTime.id, { cadence: { kind: "at", at: clock - 1_000 } });

  assert.equal(await svc.tick(), 2);
  assert.deepEqual(fired.sort(), ["on-time", "once"]);
  assert.equal(svc.runsOf(once.id)[0]!.late, true);
  assert.equal(svc.runsOf(onTime.id)[0]!.late, undefined);
  const skipped = svc.runsOf(skip.id)[0]!;
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.error ?? "", /missed/);
  assert.equal(svc.get(skip.id)!.nextRunAt, clock + 60 * 60_000);
  assert.equal(await svc.tick(), 0, "a skipped catch-up does not fire on the next tick");
});
