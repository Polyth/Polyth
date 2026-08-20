import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeNextRun, createScheduleService, type ScheduleTask } from "@polyth/schedule";

function make(overrides: { now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-schedule-"));
  const ran: ScheduleTask[] = [];
  let fail = false;
  const svc = createScheduleService({
    file: join(dir, "schedule.json"),
    runner: {
      run: async (t) => {
        if (fail) throw new Error("runner boom");
        ran.push({ ...t });
      },
    },
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  return { svc, ran, setFail: (v: boolean) => { fail = v; }, file: join(dir, "schedule.json") };
}

test("create validates input and computes nextRunAt", () => {
  const t0 = 1_000_000;
  const { svc } = make({ now: () => t0 });
  assert.throws(() => svc.create({ projectId: "", prompt: "x", kind: "at", at: 1 }), /projectId/);
  assert.throws(() => svc.create({ projectId: "p", prompt: " ", kind: "at", at: 1 }), /prompt/);
  assert.throws(() => svc.create({ projectId: "p", prompt: "x", kind: "at" }), /at \(epoch ms\)/);
  assert.throws(() => svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 0 }), /everyMinutes/);

  const once = svc.create({ projectId: "p", prompt: "run tests", kind: "at", at: t0 + 60_000 });
  assert.equal(once.nextRunAt, t0 + 60_000);
  const loop = svc.create({ projectId: "p", prompt: "standup", kind: "every", everyMinutes: 5 });
  assert.equal(loop.nextRunAt, t0 + 5 * 60_000);
});

test("tick fires due tasks; one-shots disable, intervals reschedule", async () => {
  let clock = 1_000_000;
  const { svc, ran } = make({ now: () => clock });
  const once = svc.create({ projectId: "p", prompt: "one", kind: "at", at: clock + 1_000 });
  const loop = svc.create({ projectId: "p", prompt: "loop", kind: "every", everyMinutes: 1 });

  assert.equal(await svc.tick(), 0); // nothing due yet

  clock += 61_000;
  assert.equal(await svc.tick(), 2);
  assert.deepEqual(ran.map((t) => t.prompt).sort(), ["loop", "one"]);

  const onceAfter = svc.get(once.id)!;
  assert.equal(onceAfter.enabled, false);
  assert.equal(onceAfter.nextRunAt, null);
  assert.equal(onceAfter.runs, 1);

  const loopAfter = svc.get(loop.id)!;
  assert.equal(loopAfter.enabled, true);
  assert.equal(loopAfter.nextRunAt, clock + 60_000);

  // Immediately ticking again must not double-fire (marked before running).
  assert.equal(await svc.tick(), 0);
});

test("runner errors are captured as lastError, not thrown", async () => {
  let clock = 5_000;
  const { svc, setFail } = make({ now: () => clock });
  const t = svc.create({ projectId: "p", prompt: "boom", kind: "at", at: clock });
  setFail(true);
  clock += 1;
  await svc.tick();
  assert.match(svc.get(t.id)!.lastError ?? "", /runner boom/);
});

test("pause/resume, update re-arms one-shots, remove deletes", async () => {
  let clock = 10_000;
  const { svc } = make({ now: () => clock });
  const t = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 2 });

  const paused = svc.setEnabled(t.id, false);
  assert.equal(paused.nextRunAt, null);
  const resumed = svc.setEnabled(t.id, true);
  assert.equal(resumed.nextRunAt, clock + 2 * 60_000);

  const once = svc.create({ projectId: "p", prompt: "later", kind: "at", at: clock + 100 });
  clock += 200;
  await svc.tick();
  assert.equal(svc.get(once.id)!.runs, 1);
  const rearmed = svc.update(once.id, { at: clock + 500, enabled: true });
  assert.equal(rearmed.runs, 0);
  assert.equal(rearmed.nextRunAt, clock + 500);

  assert.equal(svc.remove(once.id), true);
  assert.equal(svc.remove(once.id), false);
  assert.equal(svc.list("p").some((x) => x.id === once.id), false);
});

test("runNow fires immediately and persists across service reloads", async () => {
  const t0 = 42_000;
  const { svc, ran, file } = make({ now: () => t0 });
  const t = svc.create({ projectId: "p", prompt: "now", kind: "every", everyMinutes: 60 });
  await svc.runNow(t.id);
  assert.equal(ran.length, 1);

  const reloaded = createScheduleService({ file, runner: { run: async () => {} }, now: () => t0 });
  assert.equal(reloaded.get(t.id)?.runs, 1);
});

test("computeNextRun edge cases", () => {
  assert.equal(computeNextRun({ cadence: { kind: "at", at: 5 }, enabled: false, runs: 0 }, 0), null);
  assert.equal(computeNextRun({ cadence: { kind: "at", at: 5 }, enabled: true, runs: 1 }, 0), null);
  assert.equal(computeNextRun({ cadence: { kind: "every", everyMinutes: 2 }, enabled: true, runs: 3, lastRunAt: 100 }, 999), 100 + 120_000);
  assert.equal(computeNextRun({ cadence: { kind: "every", everyMinutes: 3 }, enabled: true, runs: 0 }, 500), 180_500);
  assert.equal(computeNextRun({ cadence: { kind: "at", at: Number.NaN }, enabled: true, runs: 0 }, 500), null);
});

test("interval validation rejects non-finite values", () => {
  const { svc } = make();
  for (const everyMinutes of [Number.NaN, Infinity, -Infinity]) {
    assert.throws(
      () => svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes }),
      /everyMinutes/,
    );
  }
});

test("disabled tasks stay unscheduled until enabled", async () => {
  let clock = 1_000;
  const { svc, ran } = make({ now: () => clock });
  const task = svc.create({
    projectId: "p",
    prompt: "wait",
    kind: "at",
    at: clock,
    enabled: false,
  });

  assert.equal(task.nextRunAt, null);
  assert.equal(await svc.tick(), 0);
  assert.deepEqual(ran, []);

  svc.setEnabled(task.id, true);
  assert.equal(svc.get(task.id)?.nextRunAt, clock);
  assert.equal(await svc.tick(), 1);
});

test("list filters by project and sorts unscheduled tasks last", () => {
  const now = 10_000;
  const { svc } = make({ now: () => now });
  const late = svc.create({ projectId: "a", prompt: "late", kind: "at", at: now + 2_000 });
  const disabled = svc.create({ projectId: "a", prompt: "off", kind: "at", at: now, enabled: false });
  const soon = svc.create({ projectId: "a", prompt: "soon", kind: "at", at: now + 1_000 });
  svc.create({ projectId: "b", prompt: "other", kind: "at", at: now + 500 });

  assert.deepEqual(svc.list("a").map((t) => t.id), [soon.id, late.id, disabled.id]);
  assert.equal(svc.list("b").length, 1);
});

test("unknown task mutations fail with a not-found code", async () => {
  const { svc } = make();
  const isNotFound = (value: unknown): boolean =>
    value instanceof Error && (value as Error & { code?: string }).code === "not-found";

  assert.throws(() => svc.update("missing", { prompt: "x" }), isNotFound);
  assert.throws(() => svc.setEnabled("missing", true), isNotFound);
  await assert.rejects(svc.runNow("missing"), isNotFound);
});

test("a successful retry clears a prior runner error", async () => {
  const { svc, setFail } = make({ now: () => 5_000 });
  const task = svc.create({ projectId: "p", prompt: "retry", kind: "every", everyMinutes: 1 });

  setFail(true);
  await svc.runNow(task.id);
  assert.equal(svc.get(task.id)?.lastError, "runner boom");

  setFail(false);
  await svc.runNow(task.id);
  assert.equal(svc.get(task.id)?.lastError, undefined);
  assert.equal(svc.get(task.id)?.runs, 2);
});
