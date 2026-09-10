import type {
  CoachCheckIn,
  CoachCommitment,
  CoachGoal,
  CoachInsight,
  CoachProfile,
  CoachRoutine,
  CoachStore,
} from "./index.ts";

export interface CoachAttention {
  kind: "overdue" | "overloaded";
  count: number;
}

export interface CoachHomeProjection {
  revision: number;
  date: string;
  profile: CoachProfile;
  activeGoals: CoachGoal[];
  today: {
    mainFocus?: CoachCommitment;
    commitments: CoachCommitment[];
    overflowCount: number;
    overdueCount: number;
    dueRoutines: CoachRoutine[];
  };
  nextAction?: CoachCommitment;
  lastCheckIn?: CoachCheckIn;
  insight?: CoachInsight;
  attention?: CoachAttention;
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

function dueToday(routine: CoachRoutine, today: LocalDate, timeZone: string): boolean {
  if (routine.status !== "active") return false;
  if (routine.cadence.kind === "daily") return true;
  if (routine.cadence.kind === "weekly") return routine.cadence.days.includes(today.weekDay);
  const created = localDateAt(routine.createdAt, timeZone);
  const elapsed = Math.max(0, today.ordinal - created.ordinal);
  return elapsed % routine.cadence.everyDays === 0;
}

function localKey(epochMs: number | undefined, timeZone: string): string | undefined {
  return epochMs === undefined ? undefined : localDateAt(epochMs, timeZone).key;
}

function commitmentPriority(commitment: CoachCommitment, goals: Map<string, CoachGoal>): number {
  return commitment.goalId ? goals.get(commitment.goalId)?.priority ?? 0 : 0;
}

function compareCommitments(goals: Map<string, CoachGoal>) {
  return (a: CoachCommitment, b: CoachCommitment): number => {
    const priority = commitmentPriority(b, goals) - commitmentPriority(a, goals);
    if (priority) return priority;
    const aWhen = a.dueAt ?? a.plannedFor ?? Number.MAX_SAFE_INTEGER;
    const bWhen = b.dueAt ?? b.plannedFor ?? Number.MAX_SAFE_INTEGER;
    if (aWhen !== bWhen) return aWhen - bWhen;
    return a.createdAt - b.createdAt;
  };
}

function belongsToday(commitment: CoachCommitment, todayKey: string, timeZone: string): boolean {
  return localKey(commitment.plannedFor, timeZone) === todayKey
    || localKey(commitment.dueAt, timeZone) === todayKey;
}

function isOverdue(commitment: CoachCommitment, todayKey: string, timeZone: string): boolean {
  const planned = localKey(commitment.plannedFor, timeZone);
  const due = localKey(commitment.dueAt, timeZone);
  return Boolean((due && due < todayKey) || (!due && planned && planned < todayKey));
}

export function buildCoachHome(
  store: CoachStore,
  opts: { now?: number } = {},
): CoachHomeProjection {
  const now = opts.now ?? Date.now();
  const profile = store.profile();
  const timeZone = isCoachTimeZone(profile.timeZone) ? profile.timeZone : "UTC";
  const todayDate = localDateAt(now, timeZone);
  const allActiveGoals = store.listGoals("active");
  const activeGoals = allActiveGoals.slice(0, 3);
  const goals = new Map(allActiveGoals.map((goal) => [goal.id, goal]));
  const compare = compareCommitments(goals);

  // Home reads only the bounded working set. Resolved history remains in the
  // append-only event stream and is loaded only for review/activity views.
  const open = store.listCommitments({ status: "open", limit: 500 });
  const overdue = open
    .filter((commitment) => isOverdue(commitment, todayDate.key, timeZone))
    .sort(compare);
  const todayAll = open
    .filter((commitment) => belongsToday(commitment, todayDate.key, timeZone))
    .sort(compare);
  const visible = todayAll.slice(0, 3);

  const futureOrUnscheduled = open
    .filter((commitment) => !isOverdue(commitment, todayDate.key, timeZone)
      && !belongsToday(commitment, todayDate.key, timeZone))
    .sort(compare);
  const nextAction = visible[0] ?? overdue[0] ?? futureOrUnscheduled[0];

  const dueRoutines = store.listRoutines("active")
    .filter((routine) => dueToday(routine, todayDate, timeZone))
    .slice(0, 5);

  const latestCheckIn = store.listCheckIns({ limit: 1 })[0];
  const lastCheckIn = latestCheckIn
    && localDateAt(latestCheckIn.createdAt, timeZone).key === todayDate.key
    ? latestCheckIn
    : undefined;

  const insight = store.listInsights("accepted")[0];
  const attention: CoachAttention | undefined = overdue.length > 0
    ? { kind: "overdue", count: overdue.length }
    : todayAll.length > 3
      ? { kind: "overloaded", count: todayAll.length }
      : undefined;

  // A weekly Reflection is the canonical review record in v1. Avoid a second
  // table until reviews need fields that a dated reflection cannot represent.
  const lastWeeklyReview = store.listReflections(50).find((item) => item.kind === "weekly");
  const reviewAnchor = lastWeeklyReview?.createdAt ?? profile.updatedAt;
  const reviewDue = profile.onboardingState === "complete"
    && reviewAnchor > 0
    && todayDate.ordinal - localDateAt(reviewAnchor, timeZone).ordinal >= 7;

  return {
    revision: store.revision(),
    date: todayDate.key,
    profile: profile.timeZone === timeZone ? profile : { ...profile, timeZone },
    activeGoals,
    today: {
      ...(visible[0] ? { mainFocus: visible[0] } : {}),
      commitments: visible,
      overflowCount: Math.max(0, todayAll.length - visible.length),
      overdueCount: overdue.length,
      dueRoutines,
    },
    ...(nextAction ? { nextAction } : {}),
    ...(lastCheckIn ? { lastCheckIn } : {}),
    ...(insight ? { insight } : {}),
    ...(attention ? { attention } : {}),
    reviewDue,
  };
}
