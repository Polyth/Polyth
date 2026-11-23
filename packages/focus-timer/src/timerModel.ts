// The focus timer's engine: pure functions over one serialisable state. Time
// is the wall clock (`endsAt`), never a counted tick, so a throttled
// background tab, a sleeping laptop or a reload still lands on the right
// second. Nothing here touches the DOM, storage or audio.
import { MAX_STEPS, type CycleStep } from "./cycles.ts";
import { activeCycle, DEFAULT_SETTINGS, type FocusTimerSettings } from "./settings.ts";

/** `pomodoro` runs the active cycle's steps; `countdown` is one plain timer. */
export type TimerMode = "pomodoro" | "countdown";
export type TimerStatus = "idle" | "running" | "paused";

export const MINUTE = 60_000;
/** The longest segment, including time added while it runs. */
export const MAX_SEGMENT_MS = 12 * 60 * MINUTE;
/** A segment that ran out longer ago than this (the tab slept, the laptop was
 *  closed) finishes quietly: no sound or flash for something long past. */
export const STALE_FINISH_MS = 90_000;
/** Ready-made lengths for the plain countdown, in minutes. */
export const COUNTDOWN_PRESETS: readonly number[] = [1, 5, 10, 15, 30, 45, 60, 90];

export interface FinishedSegment {
  segmentId: string;
  mode: TimerMode;
  /** The cycle step that ran out (a copy, so a later edit does not rename
   *  the notice); null for the countdown. */
  step: CycleStep | null;
  /** Wall-clock end of the segment. */
  at: number;
  /** Ran out long ago: shown, never rung. */
  stale: boolean;
}

export interface TimerState {
  version: 2;
  mode: TimerMode;
  /** The cycle the step index belongs to. */
  cycleId: string;
  /** Index of the current step in that cycle; kept while the countdown is shown. */
  step: number;
  status: TimerStatus;
  /** Length of the current segment. */
  durationMs: number;
  /** Wall-clock end while running, else null. */
  endsAt: number | null;
  /** What is left while idle or paused. */
  remainingMs: number;
  /** Focus finished today (local day), for the window's quiet tally. */
  today: { day: string; count: number; focusMs: number };
  /** Id of the started segment: alerts and other tabs key on it. */
  segmentId: string | null;
  /** The segment that ran out last, until the person sees it. */
  finished: FinishedSegment | null;
  /** The countdown's chosen length in minutes. */
  countdownMin: number;
}

export function localDay(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The step at `index` of the running cycle (clamped into it). */
export function stepAt(settings: Pick<FocusTimerSettings, "cycles" | "cycleId">, index: number): CycleStep {
  const steps = activeCycle(settings).steps;
  return steps[Math.min(Math.max(0, index), steps.length - 1)]!;
}

/** The step the timer is on, or null while the countdown is shown. */
export function currentStep(state: Pick<TimerState, "mode" | "step">, settings: FocusTimerSettings): CycleStep | null {
  return state.mode === "countdown" ? null : stepAt(settings, state.step);
}

function segmentMs(state: Pick<TimerState, "mode" | "step" | "countdownMin">, settings: FocusTimerSettings): number {
  return state.mode === "countdown" ? state.countdownMin * MINUTE : stepAt(settings, state.step).minutes * MINUTE;
}

export function initialState(settings: FocusTimerSettings = DEFAULT_SETTINGS, now = Date.now()): TimerState {
  const durationMs = stepAt(settings, 0).minutes * MINUTE;
  return {
    version: 2,
    mode: "pomodoro",
    cycleId: settings.cycleId,
    step: 0,
    status: "idle",
    durationMs,
    endsAt: null,
    remainingMs: durationMs,
    today: { day: localDay(now), count: 0, focusMs: 0 },
    segmentId: null,
    finished: null,
    countdownMin: 5,
  };
}

export function remainingMs(state: TimerState, now: number): number {
  if (state.status === "running" && state.endsAt !== null) return Math.max(0, state.endsAt - now);
  return Math.max(0, state.remainingMs);
}

/** 0 at the start of the segment, 1 at its end. */
export function progress(state: TimerState, now: number): number {
  if (state.durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - remainingMs(state, now) / state.durationMs));
}

/** Same day, or a fresh tally for a new one. */
export function rollDay(state: TimerState, now: number): TimerState {
  const day = localDay(now);
  return state.today.day === day ? state : { ...state, today: { day, count: 0, focusMs: 0 } };
}

export function start(state: TimerState, now: number): TimerState {
  if (state.status === "running") return state;
  const left = state.remainingMs > 0 ? state.remainingMs : state.durationMs;
  return {
    ...state,
    status: "running",
    endsAt: now + left,
    remainingMs: left,
    segmentId: state.status === "paused" && state.segmentId ? state.segmentId : `${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    finished: null,
  };
}

export function pause(state: TimerState, now: number): TimerState {
  if (state.status !== "running") return state;
  return { ...state, status: "paused", remainingMs: remainingMs(state, now), endsAt: null };
}

export function toggle(state: TimerState, now: number): TimerState {
  return state.status === "running" ? pause(state, now) : start(state, now);
}

/** Back to the full length of the current segment, stopped. */
export function reset(state: TimerState, settings: FocusTimerSettings): TimerState {
  const durationMs = segmentMs(state, settings);
  return { ...state, status: "idle", durationMs, remainingMs: durationMs, endsAt: null, segmentId: null, finished: null };
}

/** Go to step `index` of the running cycle, stopped at its full length. */
export function selectStep(state: TimerState, settings: FocusTimerSettings, index: number): TimerState {
  const count = activeCycle(settings).steps.length;
  const step = Math.min(Math.max(0, Math.round(index)), count - 1);
  return reset({ ...state, mode: "pomodoro", cycleId: settings.cycleId, step }, settings);
}

/** The first focus step of the running cycle (or its first step). */
export function firstFocusStep(settings: FocusTimerSettings): number {
  return Math.max(0, activeCycle(settings).steps.findIndex((item) => item.kind === "focus"));
}

export function selectMode(state: TimerState, settings: FocusTimerSettings, mode: TimerMode): TimerState {
  if (state.mode === mode) return state;
  return reset({ ...state, mode }, settings);
}

/** Choose the countdown's length; `run` starts it at once. */
export function setCountdown(state: TimerState, minutes: number, now: number, run = false): TimerState {
  const countdownMin = Math.min(MAX_SEGMENT_MS / MINUTE, Math.max(1, Math.round(minutes)));
  const durationMs = countdownMin * MINUTE;
  const ready: TimerState = {
    ...state,
    mode: "countdown",
    countdownMin,
    status: "idle",
    durationMs,
    remainingMs: durationMs,
    endsAt: null,
    segmentId: null,
    finished: null,
  };
  return run ? start(ready, now) : ready;
}

/** Add (or with a negative value take) time from the current segment. */
export function addTime(state: TimerState, deltaMs: number, now: number): TimerState {
  const left = remainingMs(state, now);
  const nextLeft = Math.min(MAX_SEGMENT_MS, Math.max(MINUTE / 60, left + deltaMs));
  const change = nextLeft - left;
  const durationMs = Math.min(MAX_SEGMENT_MS, Math.max(nextLeft, state.durationMs + change));
  if (state.status === "running" && state.endsAt !== null) {
    return { ...state, durationMs, endsAt: now + nextLeft, remainingMs: nextLeft };
  }
  return { ...state, durationMs, remainingMs: nextLeft };
}

/** Move to the step after this one (after the last, back to the first).
 *  `completed` counts a finished focus step toward the day; a skipped one
 *  does not. `autoStart` follows the person's auto-start choices for the
 *  next step's kind. */
export function advance(
  state: TimerState,
  settings: FocusTimerSettings,
  now: number,
  completed: boolean,
  autoStart = false,
): TimerState {
  let next = rollDay(state, now);
  if (next.mode === "countdown") return reset(next, settings);
  const steps = activeCycle(settings).steps;
  const index = Math.min(Math.max(0, next.step), steps.length - 1);
  if (completed && steps[index]!.kind === "focus") {
    next = {
      ...next,
      today: { day: next.today.day, count: next.today.count + 1, focusMs: next.today.focusMs + next.durationMs },
    };
  }
  const following = (index + 1) % steps.length;
  const ready = reset({ ...next, cycleId: settings.cycleId, step: following }, settings);
  const run = autoStart && (steps[following]!.kind === "focus" ? settings.autoStartFocus : settings.autoStartBreaks);
  return run ? start(ready, now) : ready;
}

/** Skip the rest of this segment (a skipped focus does not count). */
export function skip(state: TimerState, settings: FocusTimerSettings, now: number): TimerState {
  return advance(state, settings, now, false, false);
}

export interface TickResult {
  state: TimerState;
  /** Set when this tick saw the running segment end. */
  finished: FinishedSegment | null;
}

/** Notice a running segment's end and move on. Idempotent: ticking again
 *  after the end changes nothing. */
export function tick(state: TimerState, settings: FocusTimerSettings, now: number): TickResult {
  if (state.status !== "running" || state.endsAt === null || now < state.endsAt) {
    const rolled = rollDay(state, now);
    return { state: rolled, finished: null };
  }
  const finished: FinishedSegment = {
    segmentId: state.segmentId ?? `${state.endsAt}`,
    mode: state.mode,
    step: currentStep(state, settings),
    at: state.endsAt,
    stale: now - state.endsAt > STALE_FINISH_MS,
  };
  // Auto-start chains only from a fresh finish: a laptop opened hours later
  // does not find a break that "already ran".
  const after = advance(state, settings, now, true, !finished.stale);
  return { state: { ...after, finished }, finished };
}

/** The person has seen the finished segment. */
export function acknowledge(state: TimerState): TimerState {
  return state.finished ? { ...state, finished: null } : state;
}

/** Settings changed: keep the step index inside the cycle, start a newly
 *  chosen cycle from its first step when nothing runs, and give an untouched
 *  idle segment the new length. */
export function applySettings(state: TimerState, settings: FocusTimerSettings): TimerState {
  const count = activeCycle(settings).steps.length;
  const sameCycle = state.cycleId === settings.cycleId;
  const restart = !sameCycle && (state.status === "idle" || state.mode === "countdown");
  const step = restart ? 0 : Math.min(state.step, count - 1);
  const moved = step !== state.step || !sameCycle;
  const placed = moved ? { ...state, cycleId: settings.cycleId, step } : state;
  if (state.status !== "idle") return placed;
  const durationMs = segmentMs(placed, settings);
  if (durationMs === placed.durationMs && placed.remainingMs === durationMs) return placed;
  return { ...placed, durationMs, remainingMs: durationMs };
}

/** `mm:ss`, or `h:mm:ss` from an hour. Rounds up, so a fresh 25-minute
 *  segment reads 25:00 and the last second reads 0:01, never 0:00 early. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${String(minutes).padStart(2, "0")}:${ss}`;
}

const MODES: readonly TimerMode[] = ["pomodoro", "countdown"];
const STATUSES: readonly TimerStatus[] = ["idle", "running", "paused"];

const finite = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

const record = (raw: unknown): Record<string, unknown> | null =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;

/** Where a version 1 state (focus, short and long phases with a count of
 *  finished focus rounds) stands in the classic cycle those phases became. */
function legacyStep(value: Record<string, unknown>, settings: FocusTimerSettings): number {
  const done = Math.round(finite(value.cycleDone, 0, 0, MAX_STEPS));
  const last = activeCycle(settings).steps.length - 1;
  if (value.phase === "long") return last;
  if (value.phase === "short") return Math.min(last, Math.max(0, done * 2 - 1));
  return Math.min(last, done * 2);
}

function parseStepCopy(raw: unknown): CycleStep | null {
  const value = record(raw);
  if (!value || typeof value.minutes !== "number" || (value.kind !== "focus" && value.kind !== "break")) return null;
  return {
    name: typeof value.name === "string" ? value.name : "",
    ...(typeof value.preset === "string" ? { preset: value.preset as CycleStep["preset"] } : {}),
    minutes: value.minutes,
    kind: value.kind,
    color: typeof value.color === "string" ? value.color as CycleStep["color"] : "accent",
  };
}

/** Read a stored state, repairing what it can and starting fresh otherwise.
 *  A version 1 state (fixed phases) moves onto the matching step. */
export function parseState(raw: unknown, settings: FocusTimerSettings, now: number): TimerState {
  const fresh = initialState(settings, now);
  const value = record(raw);
  if (!value || (value.version !== 1 && value.version !== 2)) return fresh;
  const legacy = value.version === 1;
  const mode = MODES.includes(value.mode as TimerMode) ? value.mode as TimerMode : "pomodoro";
  const cycleId = !legacy && typeof value.cycleId === "string" ? value.cycleId : settings.cycleId;
  // The step is checked against the cycle when the settings arrive
  // (applySettings): the saved cycle may be longer than the default one.
  const step = legacy ? legacyStep(value, settings) : Math.round(finite(value.step, 0, 0, MAX_STEPS - 1));
  let status = STATUSES.includes(value.status as TimerStatus) ? value.status as TimerStatus : "idle";
  const countdownMin = Math.round(finite(value.countdownMin, 5, 1, MAX_SEGMENT_MS / MINUTE));
  const durationMs = finite(value.durationMs, segmentMs({ mode, step, countdownMin }, settings), 1000, MAX_SEGMENT_MS);
  const endsAt = typeof value.endsAt === "number" && Number.isFinite(value.endsAt) ? value.endsAt : null;
  if (status === "running" && endsAt === null) status = "paused";
  const remaining = finite(value.remainingMs, durationMs, 0, durationMs);
  const todayRaw = record(value.today) ?? {};
  const today = typeof todayRaw.day === "string"
    ? { day: todayRaw.day, count: Math.round(finite(todayRaw.count, 0, 0, 10_000)), focusMs: finite(todayRaw.focusMs, 0, 0, 86_400_000) }
    : fresh.today;
  const finishedRaw = legacy ? null : record(value.finished);
  const finished: FinishedSegment | null = finishedRaw && typeof finishedRaw.segmentId === "string"
    && MODES.includes(finishedRaw.mode as TimerMode) && typeof finishedRaw.at === "number"
    ? {
      segmentId: finishedRaw.segmentId,
      mode: finishedRaw.mode as TimerMode,
      step: parseStepCopy(finishedRaw.step),
      at: finishedRaw.at,
      stale: finishedRaw.stale === true,
    }
    : null;
  return rollDay({
    version: 2,
    mode,
    cycleId,
    step,
    status,
    durationMs,
    endsAt: status === "running" ? endsAt : null,
    remainingMs: remaining,
    today,
    segmentId: typeof value.segmentId === "string" ? value.segmentId : null,
    finished,
    countdownMin,
  }, now);
}
