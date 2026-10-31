// Polyth-owned `polyth_todo` agent tool. Harnesses with no native todo/plan
// surface (Pi, Antigravity, …) keep the same canonical `task/snapshot` list
// through it. Server-only: the executor reads and appends session history.
import type { AgentCapabilityContribution, JsonObject, SessionEvent, ToolExecutionContext } from "@polyth/contracts";
import {
  DEFAULT_TODO_LIST_ID,
  mergeTodoItems,
  normalizeTodoItems,
  todoProgress,
  type TodoItem,
} from "./index.ts";
import { TODOS_PACKAGE_ID } from "./rule.ts";

export const TODO_TOOL_ID = "todos.tool";
export const TODO_SKILL_ID = "todos.skill";
/** Deliberately not a native todo tool name (`isTodoToolName` is false), so
 *  adapters never re-publish this call as a second snapshot. */
export const TODO_TOOL_NAME = "polyth_todo";

export interface TodoToolDeps {
  /** Full event log of a session in `spaceId`; must reject a foreign session. */
  events(spaceId: string, sessionId: string): Promise<readonly SessionEvent[]>;
  /** Persist-then-broadcast append of one `task/snapshot` body. */
  append(sessionId: string, data: JsonObject): Promise<unknown>;
}

const STATUSES = ["pending", "in_progress", "completed", "cancelled"];

const inputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    todos: {
      type: "array",
      description: "The todo list. Replaces the whole list unless merge is true; [] clears it. Omit to read the current list.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["content"],
        properties: {
          id: { type: "string", description: "Stable item id. Reuse it to update an item." },
          content: { type: "string" },
          status: { type: "string", enum: STATUSES },
        },
      },
    },
    merge: {
      type: "boolean",
      description: "Update or append the given items by id and keep the rest of the list.",
    },
  },
};

const MARK = { pending: "[ ]", active: "[>]", done: "[x]", failed: "[-]" } as const;

const format = (items: readonly TodoItem[]): string => {
  if (items.length === 0) return "Todo list is empty.";
  const progress = todoProgress(items);
  return [
    `Todos (${progress.done}/${progress.total} completed):`,
    ...items.map((item) => `${MARK[item.status]} ${item.id}: ${item.text}`),
  ].join("\n");
};

/** The list the reducer currently shows: the highest-revision snapshot from
 *  any producer (native adapter, epoch replacement or this tool). */
export function latestTodoSnapshot(events: readonly SessionEvent[]): { revision: number; items: TodoItem[] } {
  let revision = 0;
  let items: TodoItem[] = [];
  for (const event of events) {
    if (event.type !== "task/snapshot") continue;
    const value = Number(event.data.revision);
    if (!Number.isSafeInteger(value) || value <= revision) continue;
    revision = value;
    items = normalizeTodoItems(event.data.items) ?? [];
  }
  return { revision, items };
}

export const todoSkill: AgentCapabilityContribution = {
  descriptor: {
    id: TODO_SKILL_ID,
    kind: "skill",
    owner: TODOS_PACKAGE_ID,
    scope: "deployment",
    revision: "1",
    name: "polyth-todo",
    title: "Polyth todo list",
    description: "Keep a visible todo list for multi-step work when the harness has no native todo tool.",
    instructions: `Prefer your harness's native todo/plan tool (TodoWrite, TaskCreate/TaskUpdate, update_plan, todowrite). Use ${TODO_TOOL_NAME} only when you have none, and never both in one session: both write the same Polyth list and the newest write wins.
For work with three or more steps, first call ${TODO_TOOL_NAME} with the full list. Keep exactly one item in_progress; mark it completed right after finishing it. Send merge: true with just the changed items (same ids) for status updates; send the full list without merge to reorder or remove items. Call it with no arguments to read the list.`,
  },
};

export function createTodoAgentTool(deps: TodoToolDeps): AgentCapabilityContribution {
  // ponytail: per-process chain per session; a native snapshot landing between
  // read and append still wins or loses on revision, which is the documented rule.
  const queues = new Map<string, Promise<unknown>>();

  const run = async (input: JsonObject, ctx: ToolExecutionContext): Promise<{ output: string; metadata?: JsonObject }> => {
    if (!ctx.sessionId || !ctx.spaceId) throw new Error(`${TODO_TOOL_NAME} needs a Polyth session`);
    // ponytail: full-log scan per call; add an indexed latest-snapshot read if logs get huge.
    const current = latestTodoSnapshot(await deps.events(ctx.spaceId, ctx.sessionId));
    if (input.todos === undefined) return { output: format(current.items), metadata: { revision: current.revision } };
    const taken = new Set(current.items.map((item) => item.id));
    let next = current.items.length;
    const items = normalizeTodoItems(input.todos, {
      fallbackId: () => {
        while (taken.has(`todo:${next}`)) next += 1;
        taken.add(`todo:${next}`);
        return `todo:${next}`;
      },
    });
    if (!items) throw new Error("todos must be an array");
    const list = input.merge === true ? mergeTodoItems(current.items, items) : items;
    const revision = current.revision + 1;
    await deps.append(ctx.sessionId, { listId: DEFAULT_TODO_LIST_ID, revision, items: list });
    return { output: format(list), metadata: { revision } };
  };

  return {
    descriptor: {
      id: TODO_TOOL_ID,
      kind: "tool",
      owner: TODOS_PACKAGE_ID,
      scope: "deployment",
      revision: "1",
      name: TODO_TOOL_NAME,
      description: "Read or update this session's todo list, shown to the user as the session plan. Use only when your harness has no native todo/plan tool.",
      inputSchema,
      trust: "workspace",
      mutating: true,
    },
    // Only touches the calling session's own plan.
    autoApprove: () => true,
    execute(input, ctx) {
      const result = (queues.get(ctx.sessionId) ?? Promise.resolve()).then(() => run(input, ctx));
      const settled = result.catch(() => undefined);
      queues.set(ctx.sessionId, settled);
      void settled.then(() => { if (queues.get(ctx.sessionId) === settled) queues.delete(ctx.sessionId); });
      return result;
    },
  };
}
