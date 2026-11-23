import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, type FocusTimerSettings } from "../src/settings.ts";
import {
  acknowledge,
  addTime,
  applySettings,
  formatClock,
  initialState,
  MINUTE,
  nextPhase,
  parseState,
  pause,
  progress,
  remainingMs,
  reset,
  selectMode,
  selectPhase,
  setCountdown,
  skip,
  STALE_FINISH_MS,
  start,
  tick,
  type TimerState,
} from "../src/timerModel.ts";

const T0 = new Date(2026, 10, 23, 9, 0, 0).getTime();
const settings: FocusTimerSettings = { ...DEFAULT_SETTINGS };

/** Run the current segment to its end and tick just after it. */
function finish(state: TimerState, s: FocusTimerSettings = settings, late = 10): ReturnType<typeof tick> {
  const running = state.status === "running" ? state : start(state, T0);
  return tick(running, s, (running.endsAt ?? T0) + late);
}

test("a fresh timer is a 25-minute focus, idle, at the start of a cycle", () => {
  const state = initialState(settings, T0);
  assert.equal(state.mode, "pomodoro");
  assert.equal(state.phase, "focus");
  assert.equal(state.status, "idle");
  assert.equal(remainingMs(state, T0), 25 * MINUTE);
  assert.equal(progress(state, T0), 0);
  assert.equal(state.cycleDone, 0);
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

test("a finished focus counts, and the next phase is a short break waiting to start", () => {
  const { state, finished } = finish(initialState(settings, T0));
  assert.ok(finished);
  assert.equal(finished.phase, "focus");
  assert.equal(finished.stale, false);
  assert.equal(state.phase, "short");
  assert.equal(state.status, "idle");
  assert.equal(remainingMs(state, T0), 5 * MINUTE);
  assert.equal(state.cycleDone, 1);
  assert.equal(state.today.count, 1);
  assert.equal(state.today.focusMs, 25 * MINUTE);
  assert.equal(state.finished?.segmentId, finished.segmentId);
  // Ticking again is idempotent.
  assert.equal(tick(state, settings, T0 + 60 * MINUTE).finished, null);
});

test("the last focus of a cycle leads to the long break, which starts a new cycle", () => {
  let state = initialState({ ...settings, rounds: 2 }, T0);
  const s = { ...settings, rounds: 2 };
  state = finish(state, s).state; // focus 1 → short
  assert.equal(state.phase, "short");
  state = finish(state, s).state; // short → focus
  assert.equal(state.phase, "focus");
  assert.equal(state.cycleDone, 1);
  state = finish(state, s).state; // focus 2 → long
  assert.equal(state.phase, "long");
  assert.equal(state.cycleDone, 2);
  assert.equal(remainingMs(state, T0), 15 * MINUTE);
  state = finish(state, s).state; // long → focus, new cycle
  assert.equal(state.phase, "focus");
  assert.equal(state.cycleDone, 0);
  assert.equal(state.today.count, 2);
});

test("skipping a focus moves on without counting it", () => {
  const state = skip(start(initialState(settings, T0), T0), settings, T0 + MINUTE);
  assert.equal(state.phase, "short");
  assert.equal(state.status, "idle");
  assert.equal(state.cycleDone, 0);
  assert.equal(state.today.count, 0);
  assert.equal(nextPhase("focus", 4, 4), "long");
  assert.equal(nextPhase("long", 0, 4), "focus");
});

test("auto-start runs the next phase from a fresh finish only", () => {
  const auto = { ...settings, autoStartBreaks: true, autoStartFocus: true };
  const fresh = finish(initialState(auto, T0), auto);
  assert.equal(fresh.state.phase, "short");
  assert.equal(fresh.state.status, "running");
  assert.ok(fresh.state.finished, "the finished notice stays while the break runs");

  // The laptop was closed for hours: show the end, do not chain segments.
  const stale = finish(initialState(auto, T0), auto, STALE_FINISH_MS + 1000);
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
  state = result.state;
  assert.equal(state.status, "idle");
  assert.equal(remainingMs(state, T0), 10 * MINUTE);
  assert.equal(state.today.count, 0);
  assert.equal(state.cycleDone, 0);
  state = selectMode(state, settings, "pomodoro");
  assert.equal(state.phase, "focus");
  assert.equal(remainingMs(state, T0), 25 * MINUTE);
});

test("adding time extends a running segment and its length", () => {
  let state = setCountdown(initialState(settings, T0), 5, T0, true);
  state = addTime(state, MINUTE, T0 + 4 * MINUTE);
  assert.equal(remainingMs(state, T0 + 4 * MINUTE), 2 * MINUTE);
  assert.equal(state.durationMs, 6 * MINUTE);
  assert.equal(state.endsAt, T0 + 6 * MINUTE);
});

test("reset and phase choice return to a full, stopped segment", () => {
  let state = start(initialState(settings, T0), T0);
  state = reset(state, settings);
  assert.equal(state.status, "idle");
  assert.equal(state.segmentId, null);
  state = selectPhase(state, settings, "long");
  assert.equal(state.phase, "long");
  assert.equal(remainingMs(state, T0), 15 * MINUTE);
});

test("new settings reach an untouched idle segment but never a running one", () => {
  const idle = applySettings(initialState(settings, T0), { ...settings, focusMin: 50 });
  assert.equal(remainingMs(idle, T0), 50 * MINUTE);
  const running = start(initialState(settings, T0), T0);
  assert.equal(applySettings(running, { ...settings, focusMin: 50 }), running);
});

test("acknowledging clears only the finished notice", () => {
  const { state } = finish(initialState(settings, T0));
  const seen = acknowledge(state);
  assert.equal(seen.finished, null);
  assert.equal(seen.phase, state.phase);
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
  assert.deepEqual(parseState({ version: 2 }, settings, T0), initialState(settings, T0));
  const running = start(initialState(settings, T0), T0);
  const round = parseState(JSON.parse(JSON.stringify(running)), settings, T0 + 1000);
  assert.deepEqual(round, running);
  const broken = parseState({ ...running, endsAt: "soon", phase: "nap", cycleDone: 99 }, settings, T0);
  assert.equal(broken.status, "paused", "a running state without an end pauses instead of guessing");
  assert.equal(broken.phase, "focus");
  assert.equal(broken.cycleDone, settings.rounds);
});
