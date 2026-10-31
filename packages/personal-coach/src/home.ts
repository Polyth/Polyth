import type {
  CoachCheckIn,
  CoachCommitment,
  CoachDayWindow,
  CoachGoal,
  CoachInsight,
  CoachOccurrenceStatus,
  CoachProfile,
  CoachRoutine,
  CoachStore,
} from "./index.ts";

/** Visible caps. Counts travel beside every list so the UI can say "+N" and
 *  never has to render an endless column to be honest about the total. */
export const TODAY_VISIBLE = 5;
export const OVERDUE_VISIBLE = 3;
export const UPCOMING_VISIBLE = 3;
export const GOALS_VISIBLE = 3;
export const ROUTINES_VISIBLE = 5;

/** A routine that falls due on the projected day, with the user's decision for
 *  that day when one exists. Undefined status means "still open". */
export interface CoachDueRoutine {
  routine: CoachRoutine;
  dateKey: string;
  status?: CoachOccurrenceStatus;
}

/**
 * What the day actually holds. `focus` is drawn only from `actions`; a future
 * commitment can never be promoted here, which is the whole point of keeping
 * today, attention and upcoming apart.
 */
export interface CoachToday {
  focus?: CoachCommitment;
  actions: CoachCommitment[];
  total: number;
  routines: CoachDueRoutine[];
}

/** Work that needs replanning rather than doing. Never merged into Today. */
export interface CoachAttention {
  overdue: CoachCommitment[];
  overdueTotal: number;
  /** More landed on today than the visible cap — a prompt to make room. */
  overloaded: boolean;
}

/** Future or deliberately unscheduled work. `next` is a preview, not a task. */
export interface CoachUpcoming {
  next?: CoachCommitment;
  items: CoachCommitment[];
  total: number;
}

export interface CoachHomeProjection {
  revision: number;
  /** Local calendar day this projection describes, `YYYY-MM-DD`. */
  date: string;
  profile: CoachProfile;
  today: CoachToday;
  attention: CoachAttention;
  upcoming: CoachUpcoming;
  activeGoals: CoachGoal[];
  activeGoalTotal: number;
  /** Today's check-in if one was recorded. Absent means unrecorded — never a
   *  fabricated default the user did not observe. */
  checkIn?: CoachCheckIn;
  insight?: CoachInsight;
  suggestionCount: number;
  reviewDue: boolean;
}

interface LocalDate {
  year: number;
  month: number;
  day: number;
  key: string;
  ordinal: number;
  weekDay: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatterCache.get(timeZone);
  if (value) return value;
  value = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  formatterCache.set(timeZone, value);
  return value;
}

export function isCoachTimeZone(value: string): boolean {
  if (!value || value.length > 96) return false;
  try {
    formatter(value).format(0);
    return true;
  } catch {
    formatterCache.delete(value);
    return false;
  }
}

export function localDateAt(epochMs: number, timeZone: string): LocalDate {
  if (!Number.isFinite(epochMs)) throw Object.assign(new Error("invalid time"), { code: "invalid-input" });
  if (!isCoachTimeZone(timeZone)) throw Object.assign(new Error("invalid time zone"), { code: "invalid-input" });
  const parts = formatter(timeZone).formatToParts(epochMs);
  const get = (type: "year" | "month" | "day"): number => {
    const raw = parts.find((part) => part.type === type)?.value;
    const value = Number(raw);
    if (!Number.isInteger(value)) throw Object.assign(new Error("could not resolve local date"), { code: "invalid-input" });
    return value;
  };
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const ordinal = Math.trunc(Date.UTC(year, month - 1, day) / 86_400_000);
  return {
    year,
    month,
    day,
    key: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    ordinal,
    weekDay: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let value = offsetFormatterCache.get(timeZone);
  if (value) return value;
  value = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  offsetFormatterCache.set(timeZone, value);
  return value;
}

/** Zone offset in milliseconds at a given instant (positive east of UTC). */
function offsetAt(epochMs: number, timeZone: string): number {
  const parts = offsetFormatter(timeZone).formatToParts(epochMs);
  const at = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(at("year"), at("month") - 1, at("day"), at("hour"), at("minute"), at("second"));
  // The formatter has no sub-second resolution, so compare whole seconds.
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Epoch milliseconds of local midnight starting `date`. Two passes: the first
 * uses the offset at the naive UTC guess, the second re-reads the offset at the
 * corrected instant, which is what makes the DST-transition days come out
 * right. Range queries need this — comparing formatted date strings in SQL
 * would defeat every index.
 */
export function startOfLocalDay(date: Pick<LocalDate, "year" | "month" | "day">, timeZone: string): number {
  const guess = Date.UTC(date.year, date.month - 1, date.day);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

/** The half-open `[midnight, next midnight)` window of the given local day. */
export function localDayWindow(date: LocalDate, timeZone: string): CoachDayWindow {
  const start = startOfLocalDay(date, timeZone);
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  const end = startOfLocalDay(
    { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() },
    timeZone,
  );
  return { start, end };
}

function dueToday(routine: CoachRoutine, today: LocalDate, timeZone: string): boolean {
  if (routine.status !== "active") return false;
  if (routine.cadence.kind === "daily") return true;
  if (routine.cadence.kind === "weekly") return routine.cadence.days.includes(today.weekDay);
  const created = localDateAt(routine.createdAt, timeZone);
  const elapsed = Math.max(0, today.ordinal - created.ordinal);
  return elapsed % routine.cadence.everyDays === 0;
}

export function buildCoachHome(
  store: CoachStore,
  opts: { now?: number } = {},
): CoachHomeProjection {
  const now = opts.now ?? Date.now();
  const profile = store.profile();
  const timeZone = isCoachTimeZone(profile.timeZone) ? profile.timeZone : "UTC";
  const todayDate = localDateAt(now, timeZone);
  const day = localDayWindow(todayDate, timeZone);

  // Each bucket is one bounded, indexed query plus one count. Home never pulls
  // the open working set into memory to decide what the first few rows are.
  const actions = store.listBucket("today", day, TODAY_VISIBLE);
  const todayTotal = store.countBucket("today", day);
  const overdue = store.listBucket("overdue", day, OVERDUE_VISIBLE);
  const overdueTotal = store.countBucket("overdue", day);
  const upcomingItems = store.listBucket("upcoming", day, UPCOMING_VISIBLE + 1);
  const upcomingTotal = store.countBucket("upcoming", day);

  const allActiveGoals = store.listGoals("active");
  const dueRoutines = store.listRoutines("active")
    .filter((routine) => dueToday(routine, todayDate, timeZone))
    .slice(0, ROUTINES_VISIBLE);
  const resolved = new Map(
    store.listRoutineOccurrences({ dateKeys: [todayDate.key], limit: ROUTINES_VISIBLE })
      .map((occurrence) => [occurrence.routineId, occurrence.status] as const),
  );

  const latestCheckIn = store.listCheckIns({ limit: 1 })[0];
  const checkIn = latestCheckIn
    && localDateAt(latestCheckIn.createdAt, timeZone).key === todayDate.key
    ? latestCheckIn
    : undefined;

  const insight = store.listInsights("accepted")[0];

  // A weekly Reflection is the canonical review record. When none exists yet
  // the anchor is the moment setup was completed — never `profile.updatedAt`,
  // which every tone/timezone edit would push forward and thereby postpone the
  // first review indefinitely.
  const lastWeeklyReview = store.listReflections(50).find((item) => item.kind === "weekly");
  const reviewAnchor = lastWeeklyReview?.createdAt ?? profile.onboardingCompletedAt;
  const reviewDue = profile.onboardingState === "complete"
    && reviewAnchor !== undefined
    && reviewAnchor > 0
    && todayDate.ordinal - localDateAt(reviewAnchor, timeZone).ordinal >= 7;

  const [next, ...rest] = upcomingItems;

  return {
    revision: store.revision(),
    date: todayDate.key,
    profile: profile.timeZone === timeZone ? profile : { ...profile, timeZone },
    today: {
      // Focus is today's first action and nothing else. An empty day stays
      // visibly empty instead of borrowing tomorrow's work.
      ...(actions[0] ? { focus: actions[0] } : {}),
      actions,
      total: todayTotal,
      routines: dueRoutines.map((routine) => ({
        routine,
        dateKey: todayDate.key,
        ...(resolved.has(routine.id) ? { status: resolved.get(routine.id)! } : {}),
      })),
    },
    attention: {
      overdue,
      overdueTotal,
      overloaded: todayTotal > TODAY_VISIBLE,
    },
    upcoming: {
      ...(next ? { next } : {}),
      items: rest.slice(0, UPCOMING_VISIBLE - 1),
      total: upcomingTotal,
    },
    activeGoals: allActiveGoals.slice(0, GOALS_VISIBLE),
    activeGoalTotal: allActiveGoals.length,
    ...(checkIn ? { checkIn } : {}),
    ...(insight ? { insight } : {}),
    suggestionCount: store.countProposals("pending"),
    reviewDue,
  };
}
