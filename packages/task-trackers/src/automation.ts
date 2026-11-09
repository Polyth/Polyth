import type {
  TaskTrackerColumnDto,
  TaskTrackerProvider,
  TaskTrackerService,
  TaskTrackerStatusCategory,
  TaskTrackerStatusDto,
  TaskTrackerTaskDto,
} from "@polyth/contracts";
import type {
  TaskTrackerAgentStop,
  TaskTrackerAgentStopReceipt,
  TaskTrackerAutomationPreferences,
  TaskTrackerTaskLinkDto,
} from "./types.ts";

/**
 * Moving a linked task when its agent session stops.
 *
 * The rules are pure and the side effects are injected, so the board's own
 * limits stay testable without a tracker: a task is never moved into a `done`
 * status, never moved out of one, never moved twice for the same turn, and
 * every outcome — including every refusal — leaves a durable receipt on the
 * link the board reads.
 */

/** A status the automation may move a task to. */
export interface AutomationTarget {
  id: string;
  name: string;
  category: TaskTrackerStatusCategory;
}

export type AutomationResolution =
  | { ok: true; target: AutomationTarget }
  | { ok: false; refused: "no-column" | "no-target" };

const nameKey = (value: string): string => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();

/** The statuses of one column, if the board still has that status. */
function targetOfColumn(
  column: TaskTrackerColumnDto,
  statuses: readonly TaskTrackerStatusDto[],
): AutomationTarget | undefined {
  if (column.category === "done") return undefined;
  for (const statusId of column.statusIds) {
    const status = statuses.find((item) => item.id === statusId);
    if (!status || status.category === "done") continue;
    return { id: status.id, name: status.name, category: status.category };
  }
  const only = statuses.length === 1 ? statuses[0] : undefined;
  if (only && only.category !== "done") return { id: only.id, name: only.name, category: only.category };
  return undefined;
}

/**
 * The status a named column holds, in the task's own board.
 *
 * With the board's columns: the column matched by name must hold a status the
 * task can move to, and that status may not be `done`. Without them (the
 * board's columns did not load, or the provider has none) only the task's own
 * movable statuses are matched by name — a task is never moved to a status its
 * tracker would refuse.
 */
export function resolveAutomationTarget(
  columns: readonly TaskTrackerColumnDto[] | null,
  statuses: readonly TaskTrackerStatusDto[],
  columnName: string,
): AutomationResolution {
  const wanted = nameKey(columnName);
  if (!wanted) return { ok: false, refused: "no-column" };
  const movable = statuses.filter((status) => status.category !== "done");
  if (columns) {
    const column = columns.find((item) => nameKey(item.name) === wanted);
    if (!column) return { ok: false, refused: "no-column" };
    const target = targetOfColumn(column, statuses);
    return target ? { ok: true, target } : { ok: false, refused: "no-target" };
  }
  const status = movable.find((item) => nameKey(item.name) === wanted);
  return status
    ? { ok: true, target: { id: status.id, name: status.name, category: status.category } }
    : { ok: false, refused: "no-column" };
}

export interface AgentStopInput {
  provider: TaskTrackerProvider;
  taskId: string;
  sessionId: string;
  kind: TaskTrackerAgentStop;
  /** Identifies the turn that stopped; the same turn never moves a task twice. */
  turnAt?: number;
  /** The person the session acts for, when it has one. */
  actorUserId?: string;
}

export interface AgentStopDeps {
  now(): number;
  automation(): TaskTrackerAutomationPreferences;
  /** **Status updates** must be on before any tracker write. */
  statusUpdates(): boolean;
  /** The link as the index holds it now, or undefined when the task is unlinked. */
  link(provider: TaskTrackerProvider, taskId: string, sessionId: string): TaskTrackerTaskLinkDto | undefined;
  /** Trackers acting for the person the session acts for. */
  trackers(): TaskTrackerService;
  /** Persist the receipt on the link. */
  record(receipt: TaskTrackerAgentStopReceipt): void;
  /** Append `task/status-changed` to the session that caused the move. */
  moved(input: { task: TaskTrackerTaskDto; status: AutomationTarget }): void;
}

/**
 * Applies one agent stop. Returns the receipt it recorded, or undefined when
 * the same turn already produced one (a repeated stop is never replayed).
 * Never throws: automation must not take a session's turn down with it.
 */
export async function applyAgentStop(
  deps: AgentStopDeps,
  input: AgentStopInput,
): Promise<TaskTrackerAgentStopReceipt | undefined> {
  const base = {
    at: deps.now(),
    kind: input.kind,
    ...(input.turnAt !== undefined ? { turnAt: input.turnAt } : {}),
  } satisfies TaskTrackerAgentStopReceipt;

  const record = (receipt: TaskTrackerAgentStopReceipt) => {
    try {
      deps.record(receipt);
    } catch {
      // An index that cannot be written only decorates: the board still works.
    }
    return receipt;
  };

  try {
    const existing = deps.link(input.provider, input.taskId, input.sessionId);
    if (!existing) return undefined;
    if (input.turnAt !== undefined && existing.agentStop?.turnAt === input.turnAt) return undefined;

    const automation = deps.automation();
    if (!automation.enabled || !deps.statusUpdates()) return record({ ...base, refused: "off" });
    if (!automation.on.includes(input.kind)) return record({ ...base, refused: "not-listed" });

    const trackers = deps.trackers();
    let task: TaskTrackerTaskDto;
    try {
      task = await trackers.getTask(input.provider, input.taskId);
    } catch {
      // Nothing was written and nothing may be retried blindly; the edge still
      // tells the person the agent stopped here.
      return record({ ...base, refused: "write-refused" });
    }
    if (task.status.category === "done") return record({ ...base, refused: "done" });

    const columns = await boardColumns(trackers, task);
    const statuses = task.availableStatuses
      ?? (columns ?? []).flatMap((column) => column.statusIds.map((id) => ({
        id,
        name: column.name,
        category: column.category,
      })));
    const resolution = resolveAutomationTarget(columns, statuses, automation.column);
    if (!resolution.ok) return record({ ...base, refused: resolution.refused });
    if (resolution.target.id === task.status.id) return record({ ...base, refused: "same-status" });

    try {
      const updated = await trackers.updateStatus(input.provider, input.taskId, resolution.target.id);
      try {
        deps.moved({ task: updated, status: resolution.target });
      } catch {
        // The tracker write happened; a failed session append must not turn it
        // into a retry that would move the task again.
      }
      return record({
        ...base,
        moved: {
          statusId: resolution.target.id,
          statusName: resolution.target.name,
          column: automation.column,
        },
      });
    } catch {
      return record({ ...base, refused: "write-refused" });
    }
  } catch {
    // Never let decoration break the turn's stop handling.
    return undefined;
  }
}

/** The task's board columns; null when the board or the read is unavailable. */
async function boardColumns(
  trackers: TaskTrackerService,
  task: TaskTrackerTaskDto,
): Promise<TaskTrackerColumnDto[] | null> {
  if (!task.boardId || !trackers.listColumns) return null;
  try {
    return (await trackers.listColumns(task.provider, task.boardId)).columns;
  } catch {
    return null;
  }
}
