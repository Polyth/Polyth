// What an agent is doing right now and what its diary holds, as the navigator,
// the overview and the agent's page present it. DOM-free so it is tested
// directly; every view derives its state from these functions alone.
import type { ScheduleRunDto, ScheduleTaskDto } from "@polyth/session/web-api";
import { agentState } from "./agentModel.ts";

/** One word for the row's leading mark, most urgent first. */
export type AgentPhase =
  | "review" | "needs-you" | "stopped" | "working" | "alert" | "unread"
  | "idle" | "paused" | "draft";

export interface AgentWaiting {
  run: ScheduleRunDto;
  request: NonNullable<ScheduleRunDto["waiting"]>[number];
}

export interface AgentLive {
  phase: AgentPhase;
  /** Approvals and questions that wait for the person, oldest first. */
  waiting: AgentWaiting[];
  /** Reports (updates, alerts, failures) the person has not read. */
  unread: number;
  unreadAlerts: number;
  running?: ScheduleRunDto;
  /** Newest run with something to say. */
  lastReport?: ScheduleRunDto;
  nextWake: { at: number; kind: "schedule" | "heartbeat" } | null;
}

/** A run that says something: an update, an alert, a failure, or an older
 *  completed run with an answer. Quiet checks and skips say nothing. */
export function isReport(run: ScheduleRunDto): boolean {
  if (run.stopped && run.status !== "ok") return false;
  if (run.status === "failed") return true;
  if (run.status !== "ok") return false;
  if (run.signal) return run.signal !== "quiet";
  return !!run.summary?.trim();
}

/** Until the person first reads the diary, only the newest report counts as
 *  new; older history predates the read mark and would only be noise. */
function readMark(task: ScheduleTaskDto): number {
  if (task.seenAt !== undefined) return task.seenAt;
  const newest = (task.history ?? []).find((run) => isReport(run) && run.finishedAt);
  return newest ? (newest.finishedAt ?? 0) - 1 : Infinity;
}

export function isUnread(task: ScheduleTaskDto, run: ScheduleRunDto): boolean {
  return isReport(run) && (run.finishedAt ?? 0) > readMark(task);
}

/** The agent's own sessions: its rolling conversation and every run's. */
export function agentSessionIds(task: ScheduleTaskDto): Set<string> {
  const ids = new Set<string>();
  if (task.lastSessionId) ids.add(task.lastSessionId);
  for (const run of task.history ?? []) if (run.sessionId) ids.add(run.sessionId);
  return ids;
}

/** Tasks that post into one chosen chat are that chat's scheduled messages,
 *  not agents with a page of their own. */
export function isScheduledMessage(task: ScheduleTaskDto): boolean {
  return (task.target?.mode ?? (task.sessionId ? "existing-session" : "new-session-per-run")) === "existing-session";
}

export function agentLive(task: ScheduleTaskDto): AgentLive {
  const history = task.history ?? [];
  const running = history.find((run) => run.status === "running");
  const waiting = history
    .filter((run) => run.status === "running" && run.sessionId)
    .flatMap((run) => (run.waiting ?? []).map((request) => ({ run, request })))
    .sort((a, b) => a.request.since - b.request.since);
  const unreadRuns = history.filter((run) => isUnread(task, run));
  const unreadAlerts = unreadRuns.filter((run) => run.signal === "alert" || run.status === "failed").length;
  const state = agentState(task);
  const schedule = !task.manualOnly && typeof task.nextRunAt === "number" ? task.nextRunAt : null;
  const beat = typeof task.nextBeatAt === "number" ? task.nextBeatAt : null;
  const nextWake = state !== "active" ? null
    : schedule !== null && (beat === null || schedule <= beat) ? { at: schedule, kind: "schedule" as const }
      : beat !== null ? { at: beat, kind: "heartbeat" as const } : null;
  // A run in progress outranks an earlier stop: an agent stopped by its
  // failures and then run by hand is working, never "Stopped" beside Stop.
  const phase: AgentPhase = state === "review" ? "review"
    : waiting.length ? "needs-you"
      : running ? "working"
        : state === "tripped" ? "stopped"
          : unreadAlerts ? "alert"
            : unreadRuns.length ? "unread"
              : state === "paused" ? "paused"
                : state === "draft" ? "draft"
                  : "idle";
  const lastReport = history.find(isReport);
  return {
    phase,
    waiting,
    unread: unreadRuns.length,
    unreadAlerts,
    ...(running ? { running } : {}),
    ...(lastReport ? { lastReport } : {}),
    nextWake,
  };
}

/** Newest finish time among the reports, for the read mark. */
export function newestReportAt(task: ScheduleTaskDto): number | undefined {
  return (task.history ?? []).find((run) => isReport(run) && run.finishedAt)?.finishedAt;
}

export type DiaryItem =
  | { kind: "entry"; run: ScheduleRunDto }
  /** Quiet checks and skipped wakes in a row, folded into one line. */
  | { kind: "quiet"; runs: ScheduleRunDto[] };

export interface DiaryDay {
  /** Local calendar day, YYYY-MM-DD. */
  key: string;
  /** Midnight of that day (local), for its label. */
  at: number;
  items: DiaryItem[];
}

const dayKey = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

const quietRun = (run: ScheduleRunDto): boolean =>
  run.status === "skipped" || (run.status === "ok" && run.signal === "quiet")
  || (run.status === "ok" && !run.signal && !run.summary?.trim() && !run.headline);

/** Finished runs grouped by day, newest first; quiet ones fold together.
 *  The run in progress is shown on its own, never here. */
export function diaryDays(history: readonly ScheduleRunDto[] | undefined): DiaryDay[] {
  const days: DiaryDay[] = [];
  for (const run of history ?? []) {
    if (run.status === "running") continue;
    const key = dayKey(run.startedAt);
    let day = days.at(-1);
    if (!day || day.key !== key) {
      const midnight = new Date(run.startedAt);
      midnight.setHours(0, 0, 0, 0);
      day = { key, at: midnight.getTime(), items: [] };
      days.push(day);
    }
    const last = day.items.at(-1);
    if (quietRun(run)) {
      if (last?.kind === "quiet") last.runs.push(run);
      else day.items.push({ kind: "quiet", runs: [run] });
    } else {
      day.items.push({ kind: "entry", run });
    }
  }
  return days;
}

/** "3 min", "2 h 5 min", "45 s". */
export function shortDuration(ms: number, units: { s: string; min: string; h: string }): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} ${units.s}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${units.min}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ${units.h} ${rest} ${units.min}` : `${hours} ${units.h}`;
}
