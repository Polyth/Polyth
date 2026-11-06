// What a person asked for one account, and when that makes the next window
// start. Pure and browser-safe: the server decides with it and the settings
// page draws the same projection.
import { insideDailyRange, isClockTime, isValidTimeZone, nextOccurrence } from "./schedule.ts";

/** `hour`: a new window starts at the chosen hour. `reset`: a new window starts
 *  right after every reset. */
export type PlanMode = "off" | "hour" | "reset";

export interface PlanModel {
  providerID: string;
  modelID: string;
}

export interface WindowPlan {
  mode: PlanMode;
  /** `hour`: local "HH:MM" times a new window starts at. */
  times: string[];
  /** `hour`: weekdays those times apply to, 0 = Sunday. Empty: every day. */
  days: number[];
  /** `hour`: windows started ahead of the hour, so that their boundary lands on
   *  it even if something runs in the night. */
  lead: number;
  /** `hour`: restart each window right after its reset for as long as the new
   *  one still ends by the next chosen hour. */
  rolling: boolean;
  /** `reset`: only start windows inside this local daily range. Absent: always. */
  activeFrom?: string;
  activeUntil?: string;
  timeZone: string;
  /** Absent: the account's cheapest model. */
  model?: PlanModel;
  /** Meters (`windows.ts`) this plan leaves alone. */
  skipMeters?: string[];
}

export const MAX_TIMES = 6;
export const MAX_LEAD = 3;
const MAX_ID = 200;
const METER_ID = /^[a-z][a-z-]{0,39}$/;

/** A boundary ping goes out just after the mark, because a provider that rounds
 *  a window's start down to its grid then still lands exactly on it. A provider
 *  that does not round ends up less than a minute late. */
export const START_MARGIN_MS = 45_000;
/** The provider needs a moment to report the old window as over. */
export const RESET_MARGIN_MS = 5_000;
/** A chosen hour missed by this much (a restart, a person's window that ran over
 *  it) still starts late; any later waits for the next one. */
export const HOUR_GRACE_MS = 20 * 60_000;
/** A window started late ahead of the hour would run past it. */
export const LEAD_GRACE_MS = 3 * 60_000;
/** A rolled window may overrun the next hour by this much. */
const FIT_SLACK_MS = 5 * 60_000;

export const defaultPlan = (timeZone: string): WindowPlan => ({
  mode: "off",
  times: ["09:00"],
  days: [],
  lead: 1,
  rolling: false,
  timeZone,
});

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

const shortId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ID;

/** Validate an untrusted plan into its canonical form. */
export function parsePlan(raw: unknown): WindowPlan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("plan must be an object");
  const input = raw as Record<string, unknown>;
  if (input.mode !== "off" && input.mode !== "hour" && input.mode !== "reset") throw invalid("unsupported plan mode");
  if (!isValidTimeZone(input.timeZone)) throw invalid("timeZone must be an IANA time zone");
  const times = input.times ?? [];
  if (!Array.isArray(times) || times.length > MAX_TIMES || !times.every(isClockTime)) {
    throw invalid(`times must be up to ${MAX_TIMES} HH:MM values`);
  }
  if (input.mode === "hour" && times.length === 0) throw invalid("choose at least one hour");
  const days = input.days ?? [];
  if (!Array.isArray(days) || !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
    throw invalid("days must be weekdays 0-6");
  }
  const lead = input.lead ?? 0;
  if (!Number.isInteger(lead) || (lead as number) < 0 || (lead as number) > MAX_LEAD) throw invalid(`lead must be 0-${MAX_LEAD}`);
  if (input.rolling !== undefined && typeof input.rolling !== "boolean") throw invalid("rolling must be true or false");
  const hasFrom = input.activeFrom !== undefined && input.activeFrom !== null;
  const hasUntil = input.activeUntil !== undefined && input.activeUntil !== null;
  if (hasFrom !== hasUntil) throw invalid("an active range needs both ends");
  if (hasFrom && (!isClockTime(input.activeFrom) || !isClockTime(input.activeUntil))) throw invalid("the active range must be HH:MM");
  const model = input.model ?? undefined;
  if (model !== undefined) {
    const ref = model as Record<string, unknown>;
    if (!ref || typeof ref !== "object" || !shortId(ref.providerID) || !shortId(ref.modelID)) throw invalid("model must name a provider and a model");
  }
  const skipMeters = input.skipMeters ?? [];
  if (!Array.isArray(skipMeters) || skipMeters.length > 8 || !skipMeters.every((id) => typeof id === "string" && METER_ID.test(id))) {
    throw invalid("skipMeters must be meter ids");
  }
  return {
    mode: input.mode,
    times: [...new Set(times as string[])].sort(),
    days: [...new Set(days as number[])].sort(),
    lead: lead as number,
    rolling: input.rolling === true,
    ...(hasFrom ? { activeFrom: input.activeFrom as string, activeUntil: input.activeUntil as string } : {}),
    timeZone: input.timeZone,
    ...(model ? { model: { providerID: (model as PlanModel).providerID, modelID: (model as PlanModel).modelID } } : {}),
    ...((skipMeters as string[]).length ? { skipMeters: [...new Set(skipMeters as string[])] } : {}),
  };
}

export type StartReason = "hour" | "lead" | "rolling" | "reset";

export interface WindowStart {
  /** When the request goes out. */
  at: number;
  reason: StartReason;
  /** The chosen hour this start serves. */
  targetAt?: number;
}

/** Inside the active range, or the moment it next opens. */
const nextActive = (plan: WindowPlan, at: number): number | null => {
  if (!plan.activeFrom || !plan.activeUntil) return at;
  if (insideDailyRange(at, plan.activeFrom, plan.activeUntil, plan.timeZone)) return at;
  return nextOccurrence([plan.activeFrom], [], plan.timeZone, at);
};

/**
 * The next window start, given when the current window is over (`idleFrom`).
 * `savedAt` keeps a plan saved just after an hour from firing for that hour.
 */
export function nextStart(plan: WindowPlan, periodMs: number, idleFrom: number, now: number, savedAt = 0): WindowStart | null {
  const free = Math.max(idleFrom, now);
  const afterReset = Math.max(idleFrom + RESET_MARGIN_MS, now);
  if (plan.mode === "off") return null;
  if (plan.mode === "reset") {
    const at = nextActive(plan, afterReset);
    return at === null ? null : { at, reason: "reset" };
  }
  const anchor = nextOccurrence(plan.times, plan.days, plan.timeZone, Math.max(free - HOUR_GRACE_MS, savedAt));
  if (anchor === null) return null;
  if (plan.rolling && free < anchor && afterReset + periodMs <= anchor + FIT_SLACK_MS) {
    return { at: afterReset, reason: "rolling" };
  }
  for (let windows = plan.lead; windows >= 1; windows -= 1) {
    const at = anchor - windows * periodMs + START_MARGIN_MS;
    if (idleFrom + RESET_MARGIN_MS <= at && at + LEAD_GRACE_MS >= now) {
      return { at: Math.max(at, now), reason: "lead", targetAt: anchor };
    }
  }
  return { at: Math.max(anchor + START_MARGIN_MS, afterReset), reason: "hour", targetAt: anchor };
}

export interface PlannedWindow {
  from: number;
  to: number;
  reason: StartReason;
  targetAt?: number;
}

/** The windows this plan would start before `until` if nothing else uses the
 *  account. What it draws is a forecast: a person's own turn can start one sooner. */
export function projectWindows(plan: WindowPlan, periodMs: number, idleFrom: number, now: number, until: number, savedAt = 0): PlannedWindow[] {
  const out: PlannedWindow[] = [];
  let free = idleFrom;
  let at = now;
  while (out.length < 48) {
    const start = nextStart(plan, periodMs, free, at, savedAt);
    if (!start || start.at >= until) break;
    out.push({ from: start.at, to: start.at + periodMs, reason: start.reason, ...(start.targetAt !== undefined ? { targetAt: start.targetAt } : {}) });
    free = start.at + periodMs;
    at = free;
  }
  return out;
}
