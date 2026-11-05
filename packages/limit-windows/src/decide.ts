// The one decision for one meter of one account: start a window now, check what
// the last start did, or wait. Pure: the controller applies it and the settings
// page shows the same answer.
import { nextStart, type WindowPlan, type WindowStart } from "./plan.ts";
import { exhaustedUntil, meterTiming, phaseOf, type LimitSource, type LimitWindow, type Meter } from "./windows.ts";

export type PingOutcome =
  /** Written before the request goes out, so a crash leaves evidence. */
  | "sending"
  /** The model answered; what it did to the window is not read yet. */
  | "sent"
  /** A later reading shows the window running. */
  | "started"
  /** The model answered but the window still reads as not started. */
  | "no-effect"
  /** The request failed, or its outcome is unknown. */
  | "failed"
  /** No reading could confirm it; assumed to have started. */
  | "unconfirmed";

export interface PingRecord {
  id: string;
  at: number;
  /** The window the request was meant to start. */
  windowId: string;
  /** Its length at that time. */
  periodMs: number;
  reason: WindowStart["reason"] | "manual";
  targetAt?: number;
  providerID: string;
  modelID: string;
  outcome: PingOutcome;
  latencyMs?: number;
  /** The reset the window reported afterwards. */
  resetAt?: number;
  error?: string;
}

/** A started window leaves the sliding band of `SLIDE_TOLERANCE_MS` by then. */
export const VERIFY_DELAY_MS = 150_000;
/** A hard stop against misreading a provider: real plans start far fewer. */
export const MAX_PINGS_PER_DAY = 24;
const DAY_MS = 24 * 60 * 60_000;
const FAILURE_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 60 * 60_000, 3 * 60 * 60_000] as const;
const NO_EFFECT_HOLD_MS = 6 * 60 * 60_000;
/** Nothing to read: look again later. */
const RECHECK_MS = 10 * 60_000;

export type HoldReason =
  /** A window of this meter is used up, so the request would be refused. */
  | "exhausted"
  /** The source reports nothing usable. */
  | "no-reading"
  /** The reading does not say when the window is over. */
  | "unknown-reset"
  | "failing"
  /** Requests answered but did not start the window. */
  | "no-effect"
  | "budget";

export type Decision =
  | { kind: "off" }
  | { kind: "ping"; start: WindowStart; window: LimitWindow }
  | { kind: "verify"; at: number; record: PingRecord }
  | { kind: "wait"; at: number; start?: WindowStart; window?: LimitWindow; hold?: HoldReason };

const consecutive = (records: readonly PingRecord[], outcome: PingOutcome): number => {
  let count = 0;
  for (const record of records) {
    if (record.outcome !== outcome) break;
    count += 1;
  }
  return count;
};

/** Newest first. Requests that reached the provider or may have. */
const spent = (records: readonly PingRecord[], now: number): PingRecord[] =>
  records.filter((record) => record.at > now - DAY_MS);

export interface DecideInput {
  plan: WindowPlan;
  savedAt?: number;
  meter: Meter;
  source: LimitSource;
  /** This meter's starts, newest first. */
  records: readonly PingRecord[];
  now: number;
}

export function decide({ plan, savedAt = 0, meter, source, records, now }: DecideInput): Decision {
  const last = records[0];
  // A start's effect is read before anything else happens on this meter, even
  // after a plan was turned off, so its record does not stay open.
  if (last && (last.outcome === "sending" || last.outcome === "sent")) {
    return { kind: "verify", at: last.at + (last.latencyMs ?? 0) + VERIFY_DELAY_MS, record: last };
  }
  if (plan.mode === "off" || plan.skipMeters?.includes(meter.id)) return { kind: "off" };
  const today = spent(records, now);
  if (today.length >= MAX_PINGS_PER_DAY) {
    return { kind: "wait", at: today.at(-1)!.at + DAY_MS, hold: "budget" };
  }
  const failures = consecutive(records, "failed");
  if (failures > 0) {
    const until = last!.at + FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1]!;
    if (now < until) return { kind: "wait", at: until, hold: "failing" };
  }
  const noEffect = consecutive(records, "no-effect");
  if (noEffect >= 2) {
    const until = last!.at + NO_EFFECT_HOLD_MS * noEffect;
    if (now < until) return { kind: "wait", at: until, hold: "no-effect" };
  }
  const exhausted = exhaustedUntil(meter, now);
  if (exhausted === Infinity) return { kind: "wait", at: now + RECHECK_MS, hold: "exhausted" };
  const { window, idleFrom } = meterTiming(meter, plan.mode === "reset" ? "reset" : "hour", source.fetchedAt, now);
  if (idleFrom === undefined) return { kind: "wait", at: now + RECHECK_MS, window, hold: "unknown-reset" };
  const period = window.periodMs ?? 0;
  // A start nothing could confirm is taken at its word for one window's length.
  const assumedOver = last?.outcome === "unconfirmed" ? last.at + last.periodMs : 0;
  const free = Math.max(idleFrom, exhausted ?? 0, assumedOver);
  const start = nextStart(plan, period, free, now, savedAt);
  if (!start) return { kind: "wait", at: now + RECHECK_MS, window };
  if (exhausted !== undefined) return { kind: "wait", at: Math.max(now, exhausted), start, window, hold: "exhausted" };
  return now >= start.at ? { kind: "ping", start, window } : { kind: "wait", at: start.at, start, window };
}

/** What a reading says about a start. One that is too old or failed knows nothing,
 *  so the start stays unconfirmed. */
export function judgeStart(record: PingRecord, source: LimitSource, now: number): Pick<PingRecord, "outcome" | "resetAt"> {
  const window = source.windows.find((candidate) => candidate.id === record.windowId);
  if (!window) return { outcome: "unconfirmed" };
  if (source.stale || source.fetchedAt < record.at) return { outcome: "unconfirmed" };
  const phase = phaseOf(window, source.fetchedAt, now);
  if (phase === "idle") return { outcome: "no-effect" };
  if (phase === "unknown" || window.resetsAt === undefined) return { outcome: "unconfirmed" };
  return { outcome: "started", resetAt: window.resetsAt };
}
