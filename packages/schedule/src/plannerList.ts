// Pure list grouping / filtering for the Planner UI. Inject `now` in tests.

import { isCompletedOnce } from "./plannerTask.ts";

export type PlannerStatusFilter = "all" | "active" | "paused";

export interface PlannerFilters {
  /** `null` means every project. */
  projectId: string | null;
  status: PlannerStatusFilter;
}

export const PLANNER_FILTERS_KEY = "polyth.planner.filters";

export interface PlannerTaskLike {
  id: string;
  projectId: string;
  enabled: boolean;
  nextRunAt: number | null;
  title?: string;
  prompt: string;
  kind?: string;
  cadence?: { kind?: string } | null;
  runs?: number;
  lastRunAt?: number;
  updatedAt?: number;
}

export type PlannerGroupKind = "today" | "tomorrow" | "date" | "paused" | "unscheduled" | "completed";

export interface PlannerGroup<T extends PlannerTaskLike = PlannerTaskLike> {
  id: string;
  kind: PlannerGroupKind;
  /** Local YYYY-MM-DD for date groups. */
  dateKey?: string;
  tasks: T[];
}

export function taskDisplayTitle(task: Pick<PlannerTaskLike, "title" | "prompt">): string {
  const titled = task.title?.trim();
  if (titled) return titled;
  return task.prompt.split("\n").find((line) => line.trim())?.trim() || task.prompt.trim();
}

/** Runnable / future-scheduled. Completed one-shots (`enabled` + no next run) are not active. */
export function isPlannerTaskActive(task: PlannerTaskLike): boolean {
  return task.enabled && task.nextRunAt !== null;
}

export function filterPlannerTasks<T extends PlannerTaskLike>(tasks: readonly T[], filters: PlannerFilters): T[] {
  return tasks.filter((task) => {
    if (filters.projectId && task.projectId !== filters.projectId) return false;
    if (filters.status === "active" && !isPlannerTaskActive(task)) return false;
    if (filters.status === "paused" && (task.enabled || isCompletedOnce(task))) return false;
    return true;
  });
}

/** Dated agenda groups show clock only — the heading already owns the date. */
export function formatPlannerRowTime(nextRunAt: number, groupKind: PlannerGroupKind, locale: string): string {
  if (groupKind === "paused" || groupKind === "unscheduled" || groupKind === "completed") return "";
  return new Date(nextRunAt).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function localDateKey(ms: number, nowDate = new Date(ms)): string {
  return `${nowDate.getFullYear()}-${pad2(nowDate.getMonth() + 1)}-${pad2(nowDate.getDate())}`;
}

function addCalendarDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const next = new Date(y!, (m ?? 1) - 1, (d ?? 1) + days);
  return localDateKey(next.getTime(), next);
}

function compareNextRun(a: PlannerTaskLike, b: PlannerTaskLike): number {
  return (a.nextRunAt ?? Number.POSITIVE_INFINITY) - (b.nextRunAt ?? Number.POSITIVE_INFINITY);
}

export function groupPlannerTasks<T extends PlannerTaskLike>(
  tasks: readonly T[],
  now: number,
): PlannerGroup<T>[] {
  const todayKey = localDateKey(now, new Date(now));
  const tomorrowKey = addCalendarDays(todayKey, 1);
  const dated = new Map<string, T[]>();
  const paused: T[] = [];
  const unscheduled: T[] = [];
  const completed: T[] = [];

  for (const task of tasks) {
    if (isCompletedOnce(task)) {
      completed.push(task);
      continue;
    }
    if (!task.enabled) {
      paused.push(task);
      continue;
    }
    if (task.nextRunAt === null) {
      unscheduled.push(task);
      continue;
    }
    const key = localDateKey(task.nextRunAt, new Date(task.nextRunAt));
    const bucket = dated.get(key) ?? [];
    bucket.push(task);
    dated.set(key, bucket);
  }

  const groups: PlannerGroup<T>[] = [];
  const keys = [...dated.keys()].sort();
  for (const key of keys) {
    const bucket = (dated.get(key) ?? []).slice().sort(compareNextRun);
    if (key === todayKey) groups.push({ id: "today", kind: "today", dateKey: key, tasks: bucket });
    else if (key === tomorrowKey) groups.push({ id: "tomorrow", kind: "tomorrow", dateKey: key, tasks: bucket });
    else groups.push({ id: `day:${key}`, kind: "date", dateKey: key, tasks: bucket });
  }
  if (unscheduled.length > 0) {
    groups.push({
      id: "unscheduled",
      kind: "unscheduled",
      tasks: unscheduled.slice().sort((a, b) => taskDisplayTitle(a).localeCompare(taskDisplayTitle(b))),
    });
  }
  if (completed.length > 0) {
    groups.push({
      id: "completed",
      kind: "completed",
      tasks: completed.slice().sort((a, b) => taskDisplayTitle(a).localeCompare(taskDisplayTitle(b))),
    });
  }
  if (paused.length > 0) {
    groups.push({
      id: "paused",
      kind: "paused",
      tasks: paused.slice().sort((a, b) => taskDisplayTitle(a).localeCompare(taskDisplayTitle(b))),
    });
  }
  return groups;
}

export interface PlannerCounts {
  active: number;
  paused: number;
  nextRunAt: number | null;
}

export function plannerCounts(tasks: readonly PlannerTaskLike[]): PlannerCounts {
  let active = 0;
  let paused = 0;
  let nextRunAt: number | null = null;
  for (const task of tasks) {
    if (isPlannerTaskActive(task)) {
      active += 1;
      if (nextRunAt === null || (task.nextRunAt !== null && task.nextRunAt < nextRunAt)) {
        nextRunAt = task.nextRunAt;
      }
    } else if (!task.enabled && !isCompletedOnce(task)) {
      paused += 1;
    }
  }
  return { active, paused, nextRunAt };
}

export function parsePlannerFilters(raw: string | null): PlannerFilters {
  const fallback: PlannerFilters = { projectId: null, status: "all" };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as { projectId?: unknown; status?: unknown };
    const projectId = typeof parsed.projectId === "string" && parsed.projectId.trim()
      ? parsed.projectId
      : null;
    const status = parsed.status === "active" || parsed.status === "paused" || parsed.status === "all"
      ? parsed.status
      : "all";
    return { projectId, status };
  } catch {
    return fallback;
  }
}

export function serializePlannerFilters(filters: PlannerFilters): string {
  return JSON.stringify({ projectId: filters.projectId, status: filters.status });
}

/** Keep completed off the future agenda; a short recent slice stays reachable. */
export const RECENT_COMPLETED_LIMIT = 5;

export function presentPlannerGroups<T extends PlannerTaskLike>(groups: PlannerGroup<T>[]): PlannerGroup<T>[] {
  return groups.map((group) => {
    if (group.kind !== "completed") return group;
    const ranked = group.tasks.slice().sort((a, b) =>
      (b.lastRunAt ?? b.updatedAt ?? 0) - (a.lastRunAt ?? a.updatedAt ?? 0));
    return { ...group, tasks: ranked.slice(0, RECENT_COMPLETED_LIMIT) };
  });
}
