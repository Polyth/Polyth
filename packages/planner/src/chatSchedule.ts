// A chat's own schedule: which planned tasks post into a chat, how its line
// above the composer reads them, and which session events mean that schedule
// may have changed. Pure and browser-safe.
import { PLANNER_RUN_STARTED_EVENT, PLANNER_TOOL_NAME, type PlannerTask } from "./model.ts";
import { isPlannerTaskActive, taskDisplayTitle } from "./plannerList.ts";
import { isCompletedOnce, plannerTaskTarget } from "./plannerTask.ts";

/** The chat a task posts into: the chat it names, or the one a "keep one
 *  chat" task has been using since its first run. A task that opens a new
 *  chat for every run belongs to none. */
export function plannerTaskChat(task: Pick<PlannerTask, "target" | "sessionId" | "lastSessionId">): string | undefined {
  const target = plannerTaskTarget(task);
  if (target?.mode === "existing-session") return target.sessionId ?? task.sessionId;
  if (target?.mode === "dedicated-session") return task.lastSessionId;
  return undefined;
}

export interface ChatSchedule {
  /** Upcoming tasks soonest first, then those without a next run (paused,
   *  or a schedule that cannot fire) by title. */
  tasks: PlannerTask[];
  /** The soonest upcoming task. */
  next: PlannerTask | undefined;
  upcoming: number;
  /** Paused or unschedulable: still the chat's, not coming up. */
  idle: number;
}

const EMPTY: ChatSchedule = { tasks: [], next: undefined, upcoming: 0, idle: 0 };

/** The chat's tasks. A finished one-time task has left the schedule. */
export function chatSchedule(tasks: readonly PlannerTask[] | null | undefined, sessionId: string | null | undefined): ChatSchedule {
  if (!sessionId || !tasks?.length) return EMPTY;
  const mine = tasks.filter((task) => plannerTaskChat(task) === sessionId && !isCompletedOnce(task));
  if (mine.length === 0) return EMPTY;
  const upcoming = mine.filter(isPlannerTaskActive).sort((a, b) => a.nextRunAt! - b.nextRunAt! || a.createdAt - b.createdAt);
  const idle = mine.filter((task) => !isPlannerTaskActive(task))
    .sort((a, b) => taskDisplayTitle(a).localeCompare(taskDisplayTitle(b)));
  return { tasks: [...upcoming, ...idle], next: upcoming[0], upcoming: upcoming.length, idle: idle.length };
}

/** A run of this task is in flight (admitted, its turn not yet stopped). */
export const plannerTaskRunning = (task: Pick<PlannerTask, "history">): boolean => task.history?.[0]?.status === "running";

interface EventLike {
  type: string;
  data?: unknown;
}

const PENDING_CALL_LIMIT = 64;

/**
 * Follows a stream of session events and answers whether the schedule may
 * have changed with each one: a planned run started, or an agent's planner
 * call finished. A result names its call, not always its tool (some
 * harnesses report every result as `tool`), so the call's id is remembered
 * from its start.
 */
export function plannerScheduleWatch(): (event: EventLike) => boolean {
  const pending = new Set<string>();
  return (event) => {
    if (event.type === PLANNER_RUN_STARTED_EVENT) return true;
    const data = (event.data ?? {}) as { tool?: unknown; callId?: unknown };
    const callId = typeof data.callId === "string" ? data.callId : "";
    const planner = typeof data.tool === "string" && data.tool.includes(PLANNER_TOOL_NAME);
    if (event.type === "tool/call" || event.type === "tool/started") {
      if (planner && callId) {
        pending.add(callId);
        // Bounded: a call whose result never arrives must not pin memory.
        if (pending.size > PENDING_CALL_LIMIT) pending.delete(pending.values().next().value!);
      }
      return false;
    }
    if (event.type !== "tool/result" && event.type !== "tool/error") return false;
    const known = callId !== "" && pending.delete(callId);
    return known || planner;
  };
}
