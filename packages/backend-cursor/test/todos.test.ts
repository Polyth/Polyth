import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import { createAcpRuntime } from "../../backend-acp/src/index.ts";
import { fakeRpc } from "../../harness-runtime/test/rpcPeer.ts";
import { createCursorClientTranslator } from "../src/todos.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };

const snapshotItems = (events: RuntimeEvent[]) =>
    events.filter((event) => event.type === "task/snapshot")
        .map((event) => event.type === "task/snapshot" ? event.items : []);

test("cursor/update_todos replace snapshot when merge is false", () => {
    const translator = createCursorClientTranslator();
    const first = translator.translateClientMethod("cursor/update_todos", {
        toolCallId: "todo-1",
        merge: false,
        todos: [
            { id: "a", content: "First", status: "pending" },
            { id: "b", content: "Second", status: "in_progress" },
        ],
    });
    assert.equal(first.handled, true);
    assert.equal(first.events.length, 1);
    assert.deepEqual(first.events[0], {
        type: "task/snapshot",
        listId: "todo",
        revision: 1,
        items: [
            { id: "a", text: "First", status: "pending" },
            { id: "b", text: "Second", status: "active" },
        ],
    });

    const second = translator.translateClientMethod("cursor/update_todos", {
        toolCallId: "todo-2",
        merge: false,
        todos: [{ id: "c", content: "Replaced", status: "completed" }],
    });
    assert.equal(second.events.length, 1);
    assert.deepEqual(second.events[0], {
        type: "task/snapshot",
        listId: "todo",
        revision: 2,
        items: [{ id: "c", text: "Replaced", status: "done" }],
    });
});

test("cursor/update_todos merge upserts by id and keeps unspecified items", () => {
    const translator = createCursorClientTranslator();
    translator.translateClientMethod("cursor/update_todos", {
        toolCallId: "todo-1",
        merge: false,
        todos: [
            { id: "a", content: "Keep me", status: "pending" },
            { id: "b", content: "Update me", status: "pending" },
        ],
    });
    const merged = translator.translateClientMethod("cursor/update_todos", {
        toolCallId: "todo-2",
        merge: true,
        todos: [{ id: "b", content: "Updated", status: "in_progress" }],
    });
    assert.deepEqual(merged.events[0], {
        type: "task/snapshot",
        listId: "todo",
        revision: 2,
        items: [
            { id: "a", text: "Keep me", status: "pending" },
            { id: "b", text: "Updated", status: "active" },
        ],
    });
});

test("cursor/update_todos maps cancelled to failed", () => {
    const translator = createCursorClientTranslator();
    const translated = translator.translateClientMethod("cursor/update_todos", {
        toolCallId: "todo-1",
        merge: false,
        todos: [
            { id: "a", content: "Cancelled", status: "cancelled" },
            { id: "b", content: "Canceled", status: "canceled" },
        ],
    });
    assert.deepEqual(translated.events[0]?.type === "task/snapshot" ? translated.events[0].items : [], [
        { id: "a", text: "Cancelled", status: "failed" },
        { id: "b", text: "Canceled", status: "failed" },
    ]);
});

test("cursor/update_todos deduplicates identical payloads", () => {
    const translator = createCursorClientTranslator();
    const payload = {
        toolCallId: "todo-1",
        merge: false,
        todos: [{ id: "a", content: "Same", status: "pending" }],
    };
    assert.equal(translator.translateClientMethod("cursor/update_todos", payload).events.length, 1);
    assert.equal(translator.translateClientMethod("cursor/update_todos", payload).events.length, 0);
});

test("cursor/update_todos empty list clears only after a populated snapshot", () => {
    const translator = createCursorClientTranslator();
    assert.equal(translator.translateClientMethod("cursor/update_todos", {
        toolCallId: "todo-1",
        merge: false,
        todos: [],
    }).events.length, 0);

    translator.translateClientMethod("cursor/update_todos", {
        toolCallId: "todo-2",
        merge: false,
        todos: [{ id: "a", content: "Task", status: "pending" }],
    });
    const cleared = translator.translateClientMethod("cursor/update_todos", {
        toolCallId: "todo-3",
        merge: false,
        todos: [],
    });
    assert.deepEqual(cleared.events[0], {
        type: "task/snapshot",
        listId: "todo",
        revision: 2,
        items: [],
    });
});

test("request-shaped cursor/update_todos returns accepted outcome and runtime emits snapshot", async () => {
    const f = fakeRpc();
    f.handle(async (method) => method === "session/new" ? { sessionId: "native" } : {});
    const rt = createAcpRuntime(context, f.rpc, "cursor", undefined, "Cursor", {
        clientTranslator: createCursorClientTranslator(),
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!(
        { projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" },
        "create",
    );

    const response = await f.request("cursor/update_todos", {
        toolCallId: "todo-1",
        merge: false,
        todos: [{ id: "a", content: "From request", status: "in_progress" }],
    });
    assert.deepEqual(response, {
        outcome: {
            outcome: "accepted",
            todos: [{ id: "a", content: "From request", status: "in_progress" }],
        },
    });
    assert.deepEqual(events.filter((event) => event.type === "task/snapshot"), [{
        type: "task/snapshot",
        listId: "todo",
        revision: 1,
        items: [{ id: "a", text: "From request", status: "active" }],
    }]);
    await rt.dispose();
});

test("cursor/create_plan emits title-generated, task snapshot, and accepted outcome", () => {
    const translator = createCursorClientTranslator();
    const translated = translator.translateClientMethod("cursor/create_plan", {
        toolCallId: "plan-1",
        name: "Fix mobile overview",
        plan: "# Plan\nDo not persist this markdown.",
        todos: [
            { id: "a", content: "Render title", status: "pending" },
            { id: "b", content: "Show prompt", status: "in_progress" },
        ],
    });
    assert.equal(translated.handled, true);
    assert.deepEqual(translated.requestResult, { outcome: { outcome: "accepted" } });
    assert.deepEqual(translated.events, [
        { type: "session/title-generated", title: "Fix mobile overview" },
        {
            type: "task/snapshot",
            listId: "todo",
            revision: 1,
            items: [
                { id: "a", text: "Render title", status: "pending" },
                { id: "b", text: "Show prompt", status: "active" },
            ],
        },
    ]);
});

test("cursor/create_plan flattens phase todos when top-level todos are empty", () => {
    const translator = createCursorClientTranslator();
    const translated = translator.translateClientMethod("cursor/create_plan", {
        toolCallId: "plan-2",
        phases: [{
            name: "Phase 1",
            todos: [{ id: "p1", content: "From phase", status: "pending" }],
        }],
    });
    assert.deepEqual(translated.events.filter((event) => event.type === "task/snapshot"), [{
        type: "task/snapshot",
        listId: "todo",
        revision: 1,
        items: [{ id: "p1", text: "From phase", status: "pending" }],
    }]);
});

test("cursor/create_plan skips placeholder titles", () => {
    const translator = createCursorClientTranslator();
    const translated = translator.translateClientMethod("cursor/create_plan", {
        toolCallId: "plan-3",
        name: "New Session",
        todos: [{ id: "a", content: "Task", status: "pending" }],
    });
    assert.equal(translated.events.some((event) => event.type === "session/title-generated"), false);
});

test("cursor/create_plan then update_todos merge shares revision state", () => {
    const translator = createCursorClientTranslator();
    translator.translateClientMethod("cursor/create_plan", {
        toolCallId: "plan-4",
        todos: [
            { id: "a", content: "Keep me", status: "pending" },
            { id: "b", content: "Update me", status: "pending" },
        ],
    });
    const merged = translator.translateClientMethod("cursor/update_todos", {
        toolCallId: "todo-1",
        merge: true,
        todos: [{ id: "b", content: "Updated", status: "in_progress" }],
    });
    assert.deepEqual(merged.events[0], {
        type: "task/snapshot",
        listId: "todo",
        revision: 2,
        items: [
            { id: "a", text: "Keep me", status: "pending" },
            { id: "b", text: "Updated", status: "active" },
        ],
    });
});

test("request-shaped cursor/create_plan returns accepted outcome through runtime", async () => {
    const f = fakeRpc();
    f.handle(async (method) => method === "session/new" ? { sessionId: "native" } : {});
    const rt = createAcpRuntime(context, f.rpc, "cursor", undefined, "Cursor", {
        clientTranslator: createCursorClientTranslator(),
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!(
        { projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" },
        "create",
    );

    const response = await f.request("cursor/create_plan", {
        toolCallId: "plan-5",
        name: "Runtime plan",
        todos: [{ id: "a", content: "From create_plan", status: "pending" }],
    });
    assert.deepEqual(response, { outcome: { outcome: "accepted" } });
    assert.deepEqual(events.filter((event) => event.type === "session/title-generated"), [{
        type: "session/title-generated",
        title: "Runtime plan",
    }]);
    assert.deepEqual(events.filter((event) => event.type === "task/snapshot"), [{
        type: "task/snapshot",
        listId: "todo",
        revision: 1,
        items: [{ id: "a", text: "From create_plan", status: "pending" }],
    }]);
    await rt.dispose();
});

test("notification-shaped cursor/update_todos emits snapshot through runtime", async () => {
    const f = fakeRpc();
    f.handle(async (method) => method === "session/new" ? { sessionId: "native" } : {});
    const rt = createAcpRuntime(context, f.rpc, "cursor", undefined, "Cursor", {
        clientTranslator: createCursorClientTranslator(),
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!(
        { projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" },
        "create",
    );

    f.emit("cursor/update_todos", {
        toolCallId: "todo-1",
        merge: false,
        todos: [{ id: "a", content: "From notification", status: "completed" }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events.filter((event) => event.type === "task/snapshot"), [{
        type: "task/snapshot",
        listId: "todo",
        revision: 1,
        items: [{ id: "a", text: "From notification", status: "done" }],
    }]);
    await rt.dispose();
});
