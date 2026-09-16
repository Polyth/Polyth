import type { RuntimeEvent } from "@polyth/contracts";

type TaskStatus = "pending" | "active" | "done" | "failed";

const TASK_STATUS: Record<string, TaskStatus> = {
    pending: "pending",
    in_progress: "active",
    active: "active",
    completed: "done",
    done: "done",
    cancelled: "failed",
    canceled: "failed",
    failed: "failed",
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const normalizeTodoItems = (
    todos: unknown,
): Array<{ id: string; text: string; status: TaskStatus }> => {
    if (!Array.isArray(todos)) return [];
    const items: Array<{ id: string; text: string; status: TaskStatus }> = [];
    for (let index = 0; index < todos.length; index++) {
        const row = asRecord(todos[index]);
        const text = typeof row?.content === "string" ? row.content.trim() : "";
        if (!text) continue;
        const nativeId = typeof row?.id === "string" && row.id.trim() ? row.id.trim() : undefined;
        items.push({
            id: nativeId ?? `cursor-todo:${index}:${text}`,
            text,
            status: TASK_STATUS[String(row?.status ?? "pending")] ?? "pending",
        });
    }
    return items;
};

export type CursorClientMethodTranslation =
    | { handled: false }
    | { handled: true; events: RuntimeEvent[]; requestResult?: unknown };

export type CursorClientTranslator = {
    translateClientMethod(method: string, params: unknown): CursorClientMethodTranslation;
};

const UPDATE_TODOS_METHOD = "cursor/update_todos";
const CREATE_PLAN_METHOD = "cursor/create_plan";
const PLACEHOLDER_TITLE = /^new session|^untitled|^acp session$/i;

const parseUpdateTodos = (params: unknown): { merge: boolean; items: Array<{ id: string; text: string; status: TaskStatus }> } | undefined => {
    const row = asRecord(params);
    if (!row || !Array.isArray(row.todos)) return undefined;
    return {
        merge: row.merge === true,
        items: normalizeTodoItems(row.todos),
    };
};

const parseCreatePlan = (params: unknown): { name?: string; items: Array<{ id: string; text: string; status: TaskStatus }> } => {
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

const acceptedOutcome = (items: Array<{ id: string; text: string; status: TaskStatus }>) => ({
    outcome: {
        outcome: "accepted" as const,
        todos: items.map((item) => ({
            id: item.id,
            content: item.text,
            status: item.status === "active"
                ? "in_progress"
                : item.status === "done"
                    ? "completed"
                    : item.status === "failed"
                        ? "cancelled"
                        : "pending",
        })),
    },
});

export const createCursorClientTranslator = (): CursorClientTranslator => {
    let taskRevision = 0;
    let lastTaskKey = "";
    let lastItems: Array<{ id: string; text: string; status: TaskStatus }> = [];

    const snapshotEvents = (
        items: Array<{ id: string; text: string; status: TaskStatus }>,
    ): RuntimeEvent[] => {
        const key = JSON.stringify(items);
        if (key === lastTaskKey) return [];
        if (items.length === 0 && lastTaskKey === "") return [];
        lastTaskKey = key;
        lastItems = items;
        return [{
            type: "task/snapshot",
            listId: "todo",
            revision: ++taskRevision,
            items,
        }];
    };

    const mergeItems = (
        base: Array<{ id: string; text: string; status: TaskStatus }>,
        updates: Array<{ id: string; text: string; status: TaskStatus }>,
    ): Array<{ id: string; text: string; status: TaskStatus }> => {
        const byId = new Map(base.map((item) => [item.id, item]));
        for (const item of updates) byId.set(item.id, item);
        return [...byId.values()];
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
            const items = parsed.merge ? mergeItems(lastItems, parsed.items) : parsed.items;
            const events = snapshotEvents(items);
            return {
                handled: true,
                events,
                requestResult: acceptedOutcome(items),
            };
        },
    };
};
