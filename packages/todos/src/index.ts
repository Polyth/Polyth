// Canonical todo model shared by every harness adapter and Polyth surface.
//
// Polyth already tracks a session's todo list as the revisioned, full-state
// `task/snapshot` event (contracts `RuntimeEvent`), reduced into
// `SessionModel.tasks` and rendered by the timeline plan, desktop status and
// mobile island. This module is the one place that turns any native todo/plan
// shape into that snapshot, so adapters stop re-implementing status maps and
// UI fallbacks agree with adapter output. Browser-safe: no Node imports.
import type { RuntimeEvent, TaskItemStatus, TaskSnapshotData } from "@polyth/contracts";

export type TodoStatus = TaskItemStatus;
export type TodoItem = TaskSnapshotData["items"][number];
export type TodoSnapshotEvent = Extract<RuntimeEvent, { type: "task/snapshot" }>;

/** The single list id every harness publishes today. */
export const DEFAULT_TODO_LIST_ID = "todo";

const STATUS: Record<string, TodoStatus> = {
  pending: "pending",
  queued: "pending",
  todo: "pending",
  not_started: "pending",
  notstarted: "pending",
  in_progress: "active",
  inprogress: "active",
  active: "active",
  running: "active",
  working: "active",
  started: "active",
  completed: "done",
  complete: "done",
  done: "done",
  finished: "done",
  success: "done",
  succeeded: "done",
  cancelled: "failed",
  canceled: "failed",
  failed: "failed",
  error: "failed",
  blocked: "failed",
};

/** Map any known native status (TodoWrite, Codex `inProgress`, ACP plan,
 *  Cursor, OpenCode) to Polyth's four canonical states. Unknown → pending. */
export const normalizeTodoStatus = (value: unknown): TodoStatus =>
  typeof value === "string"
    ? STATUS[value.trim().toLowerCase().replace(/[\s-]+/g, "_")] ?? "pending"
    : "pending";

/** Inverse map for harnesses that expect TodoWrite-style statuses back. */
export const nativeTodoStatus = (status: TodoStatus): "pending" | "in_progress" | "completed" | "cancelled" =>
  status === "active" ? "in_progress" : status === "done" ? "completed" : status === "failed" ? "cancelled" : "pending";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const TEXT_FIELDS = ["content", "text", "step", "subject", "title", "description", "task", "name"] as const;

export interface NormalizeTodoOptions {
  /** Stable id for rows without a native id. Defaults to `todo:<index>`. */
  fallbackId?(index: number, text: string): string;
}

/** Normalize a native todo array. Rows without text are dropped; a plain
 *  string row is accepted as a pending item. Returns `undefined` when the
 *  value is not an array (no todo information), `[]` for an explicit clear. */
export function normalizeTodoItems(value: unknown, options: NormalizeTodoOptions = {}): TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fallbackId = options.fallbackId ?? ((index: number) => `todo:${index}`);
  const items: TodoItem[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    const row = asRecord(raw);
    let text = typeof raw === "string" ? raw.trim() : "";
    if (row) {
      for (const field of TEXT_FIELDS) {
        const candidate = row[field];
        if (typeof candidate === "string" && candidate.trim()) {
          text = candidate.trim();
          break;
        }
      }
    }
    if (!text) continue;
    const nativeId = typeof row?.id === "string" && row.id.trim()
      ? row.id.trim()
      : typeof row?.id === "number" && Number.isFinite(row.id) ? String(row.id) : undefined;
    let id = nativeId ?? fallbackId(index, text);
    // Duplicate ids would make the reducer's per-item activity ambiguous.
    if (seen.has(id)) id = `${id}#${index}`;
    seen.add(id);
    items.push({ id, text, status: normalizeTodoStatus(row?.status ?? row?.state) });
  }
  return items;
}

const TODO_TOOLS = new Set([
  "todowrite",
  "todo_write",
  "todo",
  "todos",
  "write_todos",
  "update_todos",
  "updatetodos",
  "update_plan",
  "updateplan",
]);

/** True for a tool whose input is a complete replacement todo list. */
export const isTodoToolName = (tool: unknown): boolean => {
  if (typeof tool !== "string") return false;
  const name = tool.trim().toLowerCase();
  // MCP-qualified names (`mcp__server__TodoWrite`) keep the native suffix.
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return TODO_TOOLS.has(bare);
};

/** Extract the replacement list from a todo tool call input, if any. */
export function todoItemsFromToolInput(
  tool: unknown,
  input: unknown,
  options?: NormalizeTodoOptions,
): TodoItem[] | undefined {
  if (!isTodoToolName(tool)) return undefined;
  const row = asRecord(input);
  if (!row) return undefined;
  const source = row.todos ?? row.plan ?? row.tasks ?? row.items ?? row.entries;
  return normalizeTodoItems(source, options);
}

export interface TodoProgress {
  total: number;
  pending: number;
  active: number;
  done: number;
  failed: number;
  /** First active item, else the first pending item. */
  current?: TodoItem;
  /** True when every item is done or failed. */
  settled: boolean;
}

/** Aggregate counts used by progress chips, island and status surfaces. */
export function todoProgress(items: readonly TodoItem[] | null | undefined): TodoProgress {
  const progress: TodoProgress = { total: 0, pending: 0, active: 0, done: 0, failed: 0, settled: true };
  for (const item of items ?? []) {
    progress.total += 1;
    progress[item.status] += 1;
  }
  const list = items ?? [];
  const current = list.find((item) => item.status === "active") ?? list.find((item) => item.status === "pending");
  if (current) progress.current = current;
  progress.settled = progress.pending + progress.active === 0;
  return progress;
}

/** Stable comparison key for a snapshot body. */
export const todoItemsKey = (items: readonly TodoItem[]): string =>
  JSON.stringify(items.map((item) => [item.id, item.status, item.text]));

/** Merge partial updates by id into a base list (Cursor `merge: true`). */
export function mergeTodoItems(base: readonly TodoItem[], updates: readonly TodoItem[]): TodoItem[] {
  const byId = new Map(base.map((item) => [item.id, item]));
  for (const item of updates) byId.set(item.id, item);
  return [...byId.values()];
}

export interface TodoSnapshotTracker {
  /** Full replacement. Returns the event to emit, or undefined when the list
   *  did not change (or is an initial empty list, which carries no news). */
  replace(items: readonly TodoItem[]): TodoSnapshotEvent | undefined;
  /** Merge by id, then publish like `replace`. */
  merge(updates: readonly TodoItem[]): TodoSnapshotEvent | undefined;
  /** Last published list. */
  current(): TodoItem[];
  revision(): number;
}

export interface TodoSnapshotTrackerOptions {
  listId?: string;
  initialRevision?: number;
  /** Seed each revision from this clock (e.g. `Date.now`). Reducers apply only
   *  increasing revisions, so a counter restarting at 1 after a runtime
   *  restart or resume would be ignored until it overtook the old log; a
   *  clock-seeded revision stays ahead of every earlier leg. */
  revisionClock?: () => number;
}

/** Per-native-session publisher of revisioned `task/snapshot` events. One
 *  tracker per adapter session keeps revisions monotonic and drops repeats. */
export function createTodoSnapshotTracker(options: TodoSnapshotTrackerOptions = {}): TodoSnapshotTracker {
  const listId = options.listId ?? DEFAULT_TODO_LIST_ID;
  const clock = options.revisionClock;
  let revision = Math.max(0, Math.floor(options.initialRevision ?? 0));
  let lastKey = "";
  let last: TodoItem[] = [];
  const replace = (items: readonly TodoItem[]): TodoSnapshotEvent | undefined => {
    const key = todoItemsKey(items);
    if (lastKey === "" ? items.length === 0 : key === lastKey) return undefined;
    lastKey = key;
    last = items.map((item) => ({ ...item }));
    const seeded = clock ? Math.floor(Number(clock())) : 0;
    revision = Math.max(revision + 1, Number.isSafeInteger(seeded) ? seeded : 0);
    return { type: "task/snapshot", listId, revision, items: last.map((item) => ({ ...item })) };
  };
  return {
    replace,
    merge: (updates) => replace(mergeTodoItems(last, updates)),
    current: () => last.map((item) => ({ ...item })),
    revision: () => revision,
  };
}

const TASK_CREATE = new Set(["taskcreate", "task_create"]);
const TASK_UPDATE = new Set(["taskupdate", "task_update"]);
const TASK_LIST = new Set(["tasklist", "task_list"]);

const bareToolName = (tool: unknown): string => {
  if (typeof tool !== "string") return "";
  const name = tool.trim().toLowerCase();
  return name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
};

/** True for incremental task tools (Claude Code `TaskCreate`/`TaskUpdate`/
 *  `TaskList`). Not the subagent `Task` tool, `TaskGet` or `TaskStop`. */
export const isIncrementalTodoToolName = (tool: unknown): boolean => {
  const name = bareToolName(tool);
  return TASK_CREATE.has(name) || TASK_UPDATE.has(name) || TASK_LIST.has(name);
};

const resultText = (output: unknown): string => {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output.map((part) => typeof part === "string" ? part : asRecord(part)?.text).filter((text) => typeof text === "string").join("\n");
  }
  return "";
};

const stringId = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim()
    : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;

export interface TodoToolTracker {
  /** A todo tool call with its complete input. Full-list tools (TodoWrite,
   *  update_plan, …) and `TaskUpdate` publish immediately. */
  call(callId: string, tool: string, input: unknown): TodoSnapshotEvent | undefined;
  /** The call's result. `TaskCreate` needs it for the new id; `TaskList`
   *  returns the complete list. `structured` is the SDK's typed output. */
  result(callId: string, output: unknown, structured?: unknown): TodoSnapshotEvent | undefined;
  current(): TodoItem[];
}

/** One tracker per native session for harnesses whose todo tools are calls in
 *  the transcript: full-replacement lists and Claude Code's incremental task
 *  tools both become the same revisioned `task/snapshot`. */
export function createTodoToolTracker(options: TodoSnapshotTrackerOptions = {}): TodoToolTracker {
  const snapshots = createTodoSnapshotTracker(options);
  const pending = new Map<string, { kind: "create"; text: string; status: TodoStatus } | { kind: "list" }>();
  const update = (id: string, patch: Record<string, unknown>): TodoSnapshotEvent | undefined => {
    const items = snapshots.current();
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    if (patch.status === "deleted") {
      items.splice(index, 1);
      return snapshots.replace(items);
    }
    const subject = typeof patch.subject === "string" && patch.subject.trim() ? patch.subject.trim() : undefined;
    items[index] = {
      ...items[index]!,
      ...(subject ? { text: subject } : {}),
      ...(patch.status !== undefined ? { status: normalizeTodoStatus(patch.status) } : {}),
    };
    return snapshots.replace(items);
  };
  return {
    call(callId, tool, input) {
      const full = todoItemsFromToolInput(tool, input);
      if (full) return snapshots.replace(full);
      const name = bareToolName(tool);
      const row = asRecord(input) ?? {};
      if (TASK_CREATE.has(name)) {
        const text = [row.subject, row.content, row.title, row.description]
          .find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
        if (text) pending.set(callId, { kind: "create", text, status: normalizeTodoStatus(row.status) });
        return undefined;
      }
      if (TASK_UPDATE.has(name)) {
        const id = stringId(row.taskId) ?? stringId(row.id);
        return id ? update(id, row) : undefined;
      }
      if (TASK_LIST.has(name)) pending.set(callId, { kind: "list" });
      return undefined;
    },
    result(callId, output, structured) {
      const call = pending.get(callId);
      if (!call) return undefined;
      pending.delete(callId);
      const typed = asRecord(structured);
      if (call.kind === "list") {
        const items = normalizeTodoItems(typed?.tasks ?? asRecord(output)?.tasks, {
          fallbackId: (index) => `task:${index}`,
        });
        return items ? snapshots.replace(items) : undefined;
      }
      const id = stringId(asRecord(typed?.task)?.id)
        ?? /Task #([A-Za-z0-9_-]+) created/.exec(resultText(output))?.[1];
      if (!id) return undefined;
      return snapshots.replace(mergeTodoItems(snapshots.current(), [{ id, text: call.text, status: call.status }]));
    },
    current: () => snapshots.current(),
  };
}

/** UI fallback for sessions whose harness never published a snapshot: the
 *  newest todo tool call in the transcript (an explicit empty list included).
 *  Canonical snapshots always win over this. */
export function latestTodoItemsFromMessages(
  messages: ReadonlyArray<{ kind?: unknown; tool?: unknown; input?: unknown } | null | undefined>,
  options?: NormalizeTodoOptions,
): TodoItem[] | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.kind !== "tool") continue;
    const items = todoItemsFromToolInput(message.tool, message.input, options);
    if (items) return items;
  }
  return undefined;
}

export {
  DEFAULT_TODO_RULE,
  DEFAULT_TODO_RULE_SETTINGS,
  TODO_RULE_MAX_CHARS,
  TODOS_PACKAGE_ID,
  parseTodoRuleSettings,
  todoRuleSection,
  type TodoRuleSettings,
} from "./rule.ts";

export * from "./progress.ts";
