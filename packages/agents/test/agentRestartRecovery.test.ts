// A run a Polyth restart cut: it is continued within a minute of boot
// instead of the ~15 min the generic cut waits allow, the card can say it
// waits for that, and what comes due meanwhile is run after it, not skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@polyth/contracts";
import { createScheduleService, type ScheduleRunner, type ScheduleRunSettlement } from "../src/index.ts";
import { RESTART_RECOVERY_MS, RUN_RESUMED_EVENT, settleScheduledRun } from "../src/runSettlement.ts";

const MINUTE = 60_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ev = (seq: number, type: string, data: Record<string, unknown> = {}, time = seq): SessionEvent =>
  ({ id: `e${seq}`, seq, type, data, sessionId: "s1", time } as unknown as SessionEvent);

const run = { sessionId: "s1", markerSeq: 10, startedAt: 0, runId: "r1" };

/** A session log the test grows, a clock that sleeps advance, and what the
 *  run asked for. */
function rig(initial: SessionEvent[], start = 1_000) {
  const log = [...initial];
  const state = { clock: start, cuts: [] as Array<{ at: number; cause: string }>, recovery: [] as Array<number | null> };
  return {
    log,
    state,
    base: {
      events: async (_sessionId: string, afterSeq: number) => log.filter((event) => event.seq > afterSeq),
      signal: new AbortController().signal,
      now: () => state.clock,
      sleep: async (ms: number) => { state.clock += ms; },
      onRecovery: (since: number | null) => { state.recovery.push(since); },
    },
  };
}

/** The run's own continuation: its marker, then the turn it starts. */
const continuation = (log: SessionEvent[], at: number, from: number, before: SessionEvent[] = []): void => {
  let seq = from;
  log.push(ev(seq++, RUN_RESUMED_EVENT, { runId: "r1", attempt: 1 }, at));
  for (const event of before) log.push({ ...event, seq: seq++, time: at } as SessionEvent);
  log.push(
    ev(seq++, "user/message", { text: "continue", hiddenUserMessage: true }, at),
    ev(seq++, "turn/started", {}, at + 1),
    ev(seq++, "assistant/message", { text: "Finished after the restart." }, at + 2),
    ev(seq++, "turn/stopped", { reason: "completed" }, at + 3),
  );
};

test("a run carried over a restart whose turn nothing closed continues itself within a minute", async () => {
  const { log, state, base } = rig([ev(11, "turn/started"), ev(12, "tool/started", { callId: "c1", tool: "bash" })]);
  const settled = await settleScheduledRun(run, {
    ...base,
    carriedOver: true,
    sessionStatus: async () => "unknown",
    onCut: async (_attempt, cause) => {
      state.cuts.push({ at: state.clock, cause });
      continuation(log, state.clock, 13);
      return true;
    },
  });
  assert.equal(settled.status, "ok");
  assert.equal(settled.resumed, 1);
  assert.equal(state.cuts.length, 1);
  const waited = state.cuts[0]!.at - 1_000;
  assert.ok(waited >= RESTART_RECOVERY_MS && waited < 2 * MINUTE, `continued after ${waited} ms`);
  assert.deepEqual(state.recovery, [1_000, null], "waits on recovery until its continuation's turn starts");
});

test("a carried-over run whose session still works is left to its live turn", async () => {
  const { log, state, base } = rig([ev(11, "turn/started")]);
  const settled = await settleScheduledRun(run, {
    ...base,
    carriedOver: true,
    sessionStatus: async () => {
      // The turn outlived the restart and goes on streaming.
      log.push(
        ev(12, "assistant/message", { text: "Still at it." }, state.clock),
        ev(13, "turn/stopped", { reason: "completed" }, state.clock + 1),
      );
      return "working";
    },
    onCut: async () => { state.cuts.push({ at: state.clock, cause: "cut" }); return true; },
  });
  assert.equal(settled.status, "ok");
  assert.equal(state.cuts.length, 0, "nothing is sent into a live turn");
  assert.deepEqual(state.recovery, [1_000, null]);
});

test("the server closing the cut turn after the run's own continuation does not end the run", async () => {
  const { log, state, base } = rig([ev(11, "turn/started")]);
  const settled = await settleScheduledRun(run, {
    ...base,
    carriedOver: true,
    sessionStatus: async () => "epoch-pending",
    onCut: async () => {
      continuation(log, state.clock, 12, [
        ev(0, "turn/abort-requested", { reason: "runtime-replaced", source: "runtime-epoch" }),
        ev(0, "turn/stopped", { reason: "aborted" }),
      ]);
      return true;
    },
  });
  assert.equal(settled.status, "ok");
  assert.equal(settled.summary, "Finished after the restart.");
});

test("a restart's continuation that never comes is sent by the run within minutes, not a quarter hour", async () => {
  const { log, state, base } = rig([
    ev(11, "turn/started"),
    ev(12, "turn/abort-requested", { reason: "runtime-replaced", source: "runtime-epoch" }),
    ev(13, "turn/stopped", { reason: "aborted" }),
  ], 20);
  const settled = await settleScheduledRun(run, {
    ...base,
    onCut: async (_attempt, cause) => {
      state.cuts.push({ at: state.clock, cause });
      continuation(log, state.clock, 14);
      return true;
    },
  });
  assert.equal(settled.status, "ok");
  assert.equal(state.cuts.length, 1);
  const waited = state.cuts[0]!.at - 13;
  assert.ok(waited >= 2 * MINUTE && waited < 15 * MINUTE, `continued after ${waited} ms`);
  assert.deepEqual(state.recovery, [13, null]);
});

test("what comes due while a restart-cut run waits to be continued runs after it instead of being skipped", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agent-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "schedule.json");
  let clock = 1_000;
  const detached = () => Object.assign(new Error("detached"), { name: "AbortError" });
  const admitted: string[] = [];
  const followers: Array<{
    resolve: (result: ScheduleRunSettlement) => void;
    recovery?: { carriedOver: boolean; onRecovery: (since: number | null) => void };
  }> = [];
  const runner: ScheduleRunner = {
    async run(_task, runId) {
      admitted.push(runId);
      return { sessionId: `s${admitted.length}`, markerSeq: 1 };
    },
    settle(_task, _run, signal, _waiting, _activity, _background, _stopped, recovery) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(detached());
        followers.push({ resolve, ...(recovery ? { recovery } : {}) });
        signal.addEventListener("abort", () => reject(detached()), { once: true });
      });
    },
  };

  // The process a restart replaces: its run is still at work when it stops.
  const before = createScheduleService({ file, runner, now: () => clock });
  const agent = before.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, overlapPolicy: "skip" });
  await before.runNow(agent.id);
  assert.equal(followers[0]!.recovery?.carriedOver, false, "a run this process started is not carried over");
  before.stop();
  for (let i = 0; i < 6; i += 1) await flush();

  const after = createScheduleService({ file, runner, now: () => clock });
  t.after(() => after.stop());
  after.start();
  for (let i = 0; i < 6; i += 1) await flush();
  const carried = followers.at(-1)!;
  assert.equal(carried.recovery?.carriedOver, true);
  carried.recovery!.onRecovery(clock);
  assert.equal(after.runsOf(agent.id).find((entry) => entry.status === "running")?.recovering, 1_000);

  clock += 61 * MINUTE;
  await after.tick();
  for (let i = 0; i < 6; i += 1) await flush();
  assert.equal(after.runsOf(agent.id).filter((entry) => entry.status === "skipped").length, 0, "the slot is not skipped");
  assert.equal(admitted.length, 1, "nor run beside the cut one");
  assert.ok(after.get(agent.id)!.nextRunAt! > clock, "the clock moved on");

  carried.resolve({ status: "ok" });
  for (let i = 0; i < 10; i += 1) await flush();
  assert.equal(admitted.length, 2, "the slot runs once the cut run settles");
  const settled = after.runsOf(agent.id).find((entry) => entry.status === "ok")!;
  assert.equal(settled.recovering, undefined);

  // A run at work for real keeps the ordinary policy: the next slot is skipped.
  clock += 61 * MINUTE;
  await after.tick();
  for (let i = 0; i < 6; i += 1) await flush();
  assert.equal(after.runsOf(agent.id).filter((entry) => entry.status === "skipped").length, 1);
  assert.equal(admitted.length, 2);
});
