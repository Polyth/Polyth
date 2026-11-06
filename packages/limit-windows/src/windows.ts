// How one account's limit windows read: which can be started on purpose, which
// are running, and which model class each group (meter) answers to. Pure and
// browser-safe over the Limits snapshot.
import { sourceFamily, type LimitSourceRef } from "@polyth/usage/limit-sources";

export interface LimitWindow {
  id: string;
  label: string;
  used: number;
  limit: number;
  unit: string;
  resetsAt?: number;
  periodMs?: number;
}

/** The part of a Usage Limits snapshot this package reads. */
export interface LimitSource extends LimitSourceRef {
  windows: LimitWindow[];
  fetchedAt: number;
  stale: boolean;
  error?: { code: string; message: string };
  accountLabel?: string;
}

/** Shorter windows are bursts a request cannot usefully line up with an hour. */
const MIN_PERIOD_MS = 60 * 60_000;
/** A window nobody started yet reports its reset one full period ahead of every
 *  read. This much difference still reads as that; a started window leaves this
 *  band within two minutes, which is why a ping is judged only after that. */
export const SLIDE_TOLERANCE_MS = 2 * 60_000;

/** Account-wide windows with a known length. A `<model>/<period>` window belongs
 *  to one model, which a cheap request would never touch. */
export const isSteerable = (window: LimitWindow): boolean =>
  window.limit > 0 && (window.periodMs ?? 0) >= MIN_PERIOD_MS && !window.id.includes("/");

export type WindowPhase = "idle" | "running" | "unknown";

/** `idle`: the next request starts a new window. Either no reset is reported, or
 *  the reset passed, or the reset slides forward with the clock on an empty
 *  window. A fixed calendar reset (Monday 00:00) reads as running: no request
 *  can move it. */
export function phaseOf(window: LimitWindow, fetchedAt: number, now: number): WindowPhase {
  if (window.resetsAt === undefined) return window.used === 0 ? "idle" : "unknown";
  if (window.resetsAt <= now) return "idle";
  if (window.used === 0 && window.periodMs
    && Math.abs(window.resetsAt - fetchedAt - window.periodMs) <= SLIDE_TOLERANCE_MS) return "idle";
  return "running";
}

/** Windows that one model class answers to. */
export interface Meter {
  id: string;
  label?: string;
  /** Every account-wide window of the meter, shortest first. */
  windows: LimitWindow[];
  /** The shortest steerable window: the one a chosen hour lines up. */
  primary: LimitWindow;
}

const meterIdOf = (source: LimitSourceRef, windowId: string): string => {
  if (sourceFamily(source) !== "antigravity") return "all";
  if (/^google[-_]/i.test(windowId)) return "google";
  if (/^third[-_]party[-_]/i.test(windowId)) return "third-party";
  return "all";
};

const METER_LABELS: Readonly<Record<string, string>> = { google: "Google models", "third-party": "Third-party models" };

/** One meter per model class that has a steerable window. */
export function metersOf(source: LimitSource): Meter[] {
  const groups = new Map<string, LimitWindow[]>();
  for (const window of source.windows) {
    if (window.id.includes("/") || window.limit <= 0) continue;
    const id = meterIdOf(source, window.id);
    groups.set(id, [...(groups.get(id) ?? []), window]);
  }
  const meters: Meter[] = [];
  for (const [id, windows] of groups) {
    const ordered = windows.filter(isSteerable).sort((a, b) => (a.periodMs ?? 0) - (b.periodMs ?? 0));
    const primary = ordered[0];
    if (!primary) continue;
    meters.push({
      id,
      ...(METER_LABELS[id] ? { label: METER_LABELS[id] } : {}),
      windows: [...ordered, ...windows.filter((window) => !isSteerable(window))],
      primary,
    });
  }
  return meters;
}

export interface MeterTiming {
  /** The window a plan is timed by. */
  window: LimitWindow;
  /** When it is over; 0 for one already free, which no margin after a reset applies
   *  to. Absent: unknown. */
  idleFrom?: number;
}

/** When the next window can start. A chosen hour lines up the shortest window; a
 *  plan that follows resets starts whichever window comes free first. */
export function meterTiming(meter: Meter, mode: "hour" | "reset", fetchedAt: number, now: number): MeterTiming {
  const windows = mode === "hour" ? [meter.primary] : meter.windows.filter(isSteerable);
  let best: MeterTiming | undefined;
  for (const window of windows) {
    const phase = phaseOf(window, fetchedAt, now);
    const idleFrom = phase === "idle" ? 0 : phase === "running" ? window.resetsAt : undefined;
    if (idleFrom === undefined) continue;
    if (!best || idleFrom < best.idleFrom!) best = { window, idleFrom };
  }
  return best ?? { window: meter.primary };
}

/** A used-up window refuses every request until its reset. Infinity: no reset is
 *  known. Absent: nothing is used up. */
export function exhaustedUntil(meter: Meter, now: number): number | undefined {
  let until: number | undefined;
  for (const window of meter.windows) {
    if (window.used < window.limit) continue;
    if (window.resetsAt !== undefined && window.resetsAt <= now) continue;
    until = Math.max(until ?? 0, window.resetsAt ?? Infinity);
  }
  return until;
}
