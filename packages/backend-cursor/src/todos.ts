import type { RuntimeEvent } from "@polyth/contracts";
import {
    createTodoSnapshotTracker,
    mergeTodoItems,
    nativeTodoStatus,
    normalizeTodoItems as normalizeSharedTodoItems,
    type TodoItem,
    type TodoSnapshotTrackerOptions,
} from "@polyth/todos";

type CursorTodo = TodoItem;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const normalizeTodoItems = (todos: unknown): CursorTodo[] =>
    normalizeSharedTodoItems(todos, { fallbackId: (index, text) => `cursor-todo:${index}:${text}` }) ?? [];

export type CursorClientMethodTranslation =
    | { handled: false }
    | { handled: true; events: RuntimeEvent[]; requestResult?: unknown };

export type CursorClientTranslator = {
    translateClientMethod(method: string, params: unknown): CursorClientMethodTranslation;
};

const UPDATE_TODOS_METHOD = "cursor/update_todos";
const CREATE_PLAN_METHOD = "cursor/create_plan";
const PLACEHOLDER_TITLE = /^new session|^untitled|^acp session$/i;

const parseUpdateTodos = (params: unknown): { merge: boolean; items: CursorTodo[] } | undefined => {
    const row = asRecord(params);
    if (!row || !Array.isArray(row.todos)) return undefined;
    return {
        merge: row.merge === true,
        items: normalizeTodoItems(row.todos),
    };
};

const parseCreatePlan = (params: unknown): { name?: string; items: CursorTodo[] } => {
    const row = asRecord(params);
    if (!row) return { items: [] };
    let items = normalizeTodoItems(row.todos);
    if (items.length === 0 && Array.isArray(row.phases)) {
        for (const phase of row.phases) {
            items.push(...normalizeTodoItems(asRecord(phase)?.todos));
        }
    }
    const name = typeof row.name === "string" ? row.name.trim() : undefined;
    return { ...(name ? { name } : {}), items };
};

const acceptedOutcome = (items: CursorTodo[]) => ({
    outcome: {
        outcome: "accepted" as const,
        todos: items.map((item) => ({ id: item.id, content: item.text, status: nativeTodoStatus(item.status) })),
    },
});

export const createCursorClientTranslator = (
    options: Pick<TodoSnapshotTrackerOptions, "revisionClock"> = {},
): CursorClientTranslator => {
    const todos = createTodoSnapshotTracker(options);

    const snapshotEvents = (items: CursorTodo[]): RuntimeEvent[] => {
        const snapshot = todos.replace(items);
        return snapshot ? [snapshot] : [];
    };

    return {
        translateClientMethod(method, params) {
            if (method === CREATE_PLAN_METHOD) {
                const parsed = parseCreatePlan(params);
                const events: RuntimeEvent[] = [];
                if (parsed.name && !PLACEHOLDER_TITLE.test(parsed.name)) {
                    events.push({ type: "session/title-generated", title: parsed.name });
                }
                events.push(...snapshotEvents(parsed.items));
                return {
                    handled: true,
                    events,
                    requestResult: { outcome: { outcome: "accepted" as const } },
                };
            }
            if (method !== UPDATE_TODOS_METHOD) return { handled: false };
            const parsed = parseUpdateTodos(params);
            if (!parsed) return { handled: true, events: [] };
            const items = parsed.merge ? mergeTodoItems(todos.current(), parsed.items) : parsed.items;
            const events = snapshotEvents(items);
            return {
                handled: true,
                events,
                requestResult: acceptedOutcome(items),
            };
        },
    };
};
