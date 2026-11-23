import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_CYCLES, type CycleSet } from "../src/cycles.ts";
import { DEFAULT_SETTINGS, type FocusTimerSettings } from "../src/settings.ts";
import {
  acknowledge,
  addTime,
  applySettings,
  formatClock,
  initialState,
  MINUTE,
  parseState,
  pause,
  progress,
  remainingMs,
  reset,
  selectMode,
  selectStep,
  setCountdown,
  skip,
  STALE_FINISH_MS,
  start,
  tick,
  type TimerState,
} from "../src/timerModel.ts";

const T0 = new Date(2026, 10, 23, 9, 0, 0).getTime();
const settings: FocusTimerSettings = { ...DEFAULT_SETTINGS };

/** Settings running an own cycle made of `steps` ([minutes, kind] pairs). */
function own(steps: Array<[number, "focus" | "break"]>, extra: Partial<FocusTimerSettings> = {}): FocusTimerSettings {
  const cycle: CycleSet = {
    id: "c-test",
    name: "Test",
    steps: steps.map(([minutes, kind]) => ({ name: "", minutes, kind, color: kind === "focus" ? "accent" : "green" })),
  };
  return { ...settings, cycles: [cycle], cycleId: cycle.id, ...extra };
}

/** Run the current segment to its end and tick just after it. */
function finish(state: TimerState, s: FocusTimerSettings = settings, late = 10): ReturnType<typeof tick> {
  const running = state.status === "running" ? state : start(state, T0);
  return tick(running, s, (running.endsAt ?? T0) + late);
}

test("a fresh timer is a 25-minute focus, idle, at the start of a cycle", () => {
  const state = initialState(settings, T0);
  assert.equal(state.mode, "pomodoro");
  assert.equal(state.cycleId, "builtin:pomodoro");
  assert.equal(state.step, 0);
  assert.equal(state.status, "idle");
  assert.equal(remainingMs(state, T0), 25 * MINUTE);
  assert.equal(progress(state, T0), 0);
});

test("time is wall clock: start, pause and resume keep the exact remainder", () => {
  let state = start(initialState(settings, T0), T0);
  assert.equal(state.endsAt, T0 + 25 * MINUTE);
  assert.equal(remainingMs(state, T0 + 10 * MINUTE), 15 * MINUTE);
  state = pause(state, T0 + 10 * MINUTE);
  assert.equal(state.status, "paused");
  // An hour paused does not count.
  assert.equal(remainingMs(state, T0 + 70 * MINUTE), 15 * MINUTE);
  const segment = state.segmentId;
  state = start(state, T0 + 70 * MINUTE);
  assert.equal(state.endsAt, T0 + 85 * MINUTE);
  assert.equal(state.segmentId, segment, "resuming keeps the segment's identity");
  assert.equal(progress(state, T0 + 77.5 * MINUTE), 0.7);
});

test("ticking before the end changes nothing", () => {
  const state = start(initialState(settings, T0), T0);
  const result = tick(state, settings, T0 + 24 * MINUTE);
  assert.equal(result.finished, null);
  assert.equal(result.state, state);
});

test("a finished focus counts, and the next step is a short break waiting to start", () => {
  const { state, finished } = finish(initialState(settings, T0));
  assert.ok(finished);
  assert.equal(finished.step?.kind, "focus");
  assert.equal(finished.step?.preset, "focus");
  assert.equal(finished.stale, false);
  assert.equal(state.step, 1);
  assert.equal(state.status, "idle");
  assert.equal(remainingMs(state, T0), 5 * MINUTE);
  assert.equal(state.today.count, 1);
  assert.equal(state.today.focusMs, 25 * MINUTE);
  assert.equal(state.finished?.segmentId, finished.segmentId);
  // Ticking again is idempotent.
  assert.equal(tick(state, settings, T0 + 60 * MINUTE).finished, null);
});

test("the classic pomodoro runs four focus rounds, the last break a long one, then starts over", () => {
  const minutes = BUILTIN_CYCLES[0]!.steps.map((item) => item.minutes);
  assert.deepEqual(minutes, [25, 5, 25, 5, 25, 5, 25, 15]);
  let state = initialState(settings, T0);
  for (let index = 0; index < 7; index += 1) state = finish(state).state;
  assert.equal(state.step, 7);
  assert.equal(remainingMs(state, T0), 15 * MINUTE);
  state = finish(state).state;
  assert.equal(state.step, 0, "after the last step the cycle starts again");
  assert.equal(state.today.count, 4, "only focus steps count toward the day");
});

test("an own cycle runs its steps in order, whatever they are", () => {
  const s = own([[40, "focus"], [20, "focus"], [10, "break"]]);
  let state = initialState(s, T0);
  assert.equal(remainingMs(state, T0), 40 * MINUTE);
  state = finish(state, s).state;
  assert.equal(state.step, 1);
  assert.equal(remainingMs(state, T0), 20 * MINUTE);
  state = finish(state, s).state;
  assert.equal(remainingMs(state, T0), 10 * MINUTE);
  state = finish(state, s).state;
  assert.equal(state.step, 0);
  assert.equal(state.today.count, 2);
  assert.equal(state.today.focusMs, 60 * MINUTE);
});

test("skipping a focus moves on without counting it", () => {
  const state = skip(start(initialState(settings, T0), T0), settings, T0 + MINUTE);
  assert.equal(state.step, 1);
  assert.equal(state.status, "idle");
  assert.equal(state.today.count, 0);
});

test("auto-start follows the next step's kind and runs from a fresh finish only", () => {
  const breaks = { ...settings, autoStartBreaks: true };
  const fresh = finish(initialState(breaks, T0), breaks);
  assert.equal(fresh.state.step, 1);
  assert.equal(fresh.state.status, "running");
  assert.ok(fresh.state.finished, "the finished notice stays while the break runs");
  // Focus after focus follows "start focus on its own", not the break switch.
  const twoFocus = own([[40, "focus"], [20, "focus"]], { autoStartBreaks: true });
  assert.equal(finish(initialState(twoFocus, T0), twoFocus).state.status, "idle");
  const focusAuto = own([[40, "focus"], [20, "focus"]], { autoStartFocus: true });
  assert.equal(finish(initialState(focusAuto, T0), focusAuto).state.status, "running");

  // The laptop was closed for hours: show the end, do not chain segments.
  const stale = finish(initialState(breaks, T0), breaks, STALE_FINISH_MS + 1000);
  assert.equal(stale.finished?.stale, true);
  assert.equal(stale.state.status, "idle");
});

test("the countdown restarts ready at its own length and never touches the cycle", () => {
  let state = setCountdown(initialState(settings, T0), 10, T0, true);
  assert.equal(state.mode, "countdown");
  assert.equal(state.status, "running");
  assert.equal(state.endsAt, T0 + 10 * MINUTE);
  const result = tick(state, settings, T0 + 10 * MINUTE + 5);
  assert.equal(result.finished?.mode, "countdown");
  assert.equal(result.finished?.step, null);
  state = result.state;
  assert.equal(state.status, "idle");
  assert.equal(remainingMs(state, T0), 10 * MINUTE);
  assert.equal(state.today.count, 0);
  assert.equal(state.step, 0);
  state = selectMode(state, settings, "pomodoro");
  assert.equal(remainingMs(state, T0), 25 * MINUTE);
});

test("adding time extends a running segment and its length", () => {
  let state = setCountdown(initialState(settings, T0), 5, T0, true);
  state = addTime(state, MINUTE, T0 + 4 * MINUTE);
  assert.equal(remainingMs(state, T0 + 4 * MINUTE), 2 * MINUTE);
  assert.equal(state.durationMs, 6 * MINUTE);
  assert.equal(state.endsAt, T0 + 6 * MINUTE);
});

test("reset and step choice return to a full, stopped segment", () => {
  let state = start(initialState(settings, T0), T0);
  state = reset(state, settings);
  assert.equal(state.status, "idle");
  assert.equal(state.segmentId, null);
  state = selectStep(state, settings, 7);
  assert.equal(state.step, 7);
  assert.equal(remainingMs(state, T0), 15 * MINUTE);
  assert.equal(selectStep(state, settings, 99).step, 7, "a step past the end clamps to the last");
});

test("new settings reach an untouched idle segment but never a running one", () => {
  const longer = own([[50, "focus"], [10, "break"]]);
  const idle = applySettings({ ...initialState(longer, T0), durationMs: 1, remainingMs: 1 }, longer);
  assert.equal(remainingMs(idle, T0), 50 * MINUTE);
  const running = start(initialState(longer, T0), T0);
  assert.equal(applySettings(running, own([[30, "focus"], [10, "break"]])), running);
});

test("a cycle chosen elsewhere starts from its first step unless a segment runs", () => {
  const s = own([[40, "focus"], [20, "focus"], [10, "break"]]);
  const idle = selectStep(initialState(s, T0), s, 2);
  const switched = applySettings(idle, settings);
  assert.equal(switched.cycleId, "builtin:pomodoro");
  assert.equal(switched.step, 0);
  assert.equal(remainingMs(switched, T0), 25 * MINUTE);
  // A running segment keeps going; its index is kept inside the new cycle.
  const running = start(selectStep(initialState(s, T0), s, 2), T0);
  const kept = applySettings(running, own([[30, "focus"]]));
  assert.equal(kept.status, "running");
  assert.equal(kept.endsAt, running.endsAt);
  assert.equal(kept.step, 0);
});

test("acknowledging clears only the finished notice", () => {
  const { state } = finish(initialState(settings, T0));
  const seen = acknowledge(state);
  assert.equal(seen.finished, null);
  assert.equal(seen.step, state.step);
  assert.equal(acknowledge(seen), seen);
});

test("the day's tally starts over on a new local day", () => {
  const { state } = finish(initialState(settings, T0));
  const tomorrow = T0 + 24 * 60 * MINUTE;
  const next = tick(state, settings, tomorrow).state;
  assert.equal(next.today.count, 0);
  assert.notEqual(next.today.day, state.today.day);
});

test("the clock rounds up and grows hours past sixty minutes", () => {
  assert.equal(formatClock(25 * MINUTE), "25:00");
  assert.equal(formatClock(25 * MINUTE - 1), "25:00");
  assert.equal(formatClock(999), "00:01");
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(90 * MINUTE), "1:30:00");
});

test("a stored state is repaired field by field, and garbage starts fresh", () => {
  assert.deepEqual(parseState("nope", settings, T0), initialState(settings, T0));
  assert.deepEqual(parseState({ version: 3 }, settings, T0), initialState(settings, T0));
  const running = start(initialState(settings, T0), T0);
  const round = parseState(JSON.parse(JSON.stringify(running)), settings, T0 + 1000);
  assert.deepEqual(round, running);
  const broken = parseState({ ...running, endsAt: "soon", step: -4 }, settings, T0);
  assert.equal(broken.status, "paused", "a running state without an end pauses instead of guessing");
  assert.equal(broken.step, 0);
  const finished = finish(initialState(settings, T0)).state;
  assert.deepEqual(parseState(JSON.parse(JSON.stringify(finished)), settings, T0 + 1000).finished, finished.finished);
});

test("a version 1 state (fixed phases) lands on the matching step of the classic cycle", () => {
  const v1 = (phase: string, cycleDone: number) => ({
    version: 1, mode: "pomodoro", phase, status: "paused", durationMs: 5 * MINUTE, endsAt: null,
    remainingMs: 2 * MINUTE, cycleDone, today: { day: "2026-11-23", count: 3, focusMs: 75 * MINUTE },
    segmentId: "old", finished: { segmentId: "x", mode: "pomodoro", phase: "focus", at: T0, stale: false }, countdownMin: 5,
  });
  const short = parseState(v1("short", 1), settings, T0);
  assert.equal(short.version, 2);
  assert.equal(short.step, 1);
  assert.equal(short.status, "paused");
  assert.equal(remainingMs(short, T0), 2 * MINUTE, "the paused remainder survives the upgrade");
  assert.equal(short.today.count, 3);
  assert.equal(short.finished, null);
  assert.equal(parseState(v1("focus", 2), settings, T0).step, 4);
  assert.equal(parseState(v1("long", 4), settings, T0).step, 7);
});
