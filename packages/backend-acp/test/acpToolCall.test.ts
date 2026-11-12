import assert from "node:assert/strict";
import { test } from "node:test";
import {
    eventsFromAcpToolCallUpdate,
    formatAcpToolInput,
    formatAcpToolOutput,
    mergeAcpToolCallUpdate,
    type AcpToolCallState,
} from "../src/acpToolCall.ts";

const state = (): AcpToolCallState => ({
    toolCallId: "call-1",
    startedEmitted: false,
    finished: false,
});

test("formatAcpToolInput prefers rawInput and avoids generic titles", () => {
    const call = state();
    mergeAcpToolCallUpdate(call, {
        kind: "search",
        title: "grep",
        rawInput: { pattern: "executionPresentation", path: "apps/web/src" },
    });
    assert.deepEqual(formatAcpToolInput(call), {
        pattern: "executionPresentation",
        path: "apps/web/src",
    });
});

test("formatAcpToolInput derives path from locations when rawInput is missing", () => {
    const call = state();
    mergeAcpToolCallUpdate(call, {
        kind: "read",
        title: "Read File",
        locations: [{ path: "/workspace/apps/web/src/execution.ts", line: 12 }],
    });
    assert.deepEqual(formatAcpToolInput(call), {
        path: "/workspace/apps/web/src/execution.ts",
        offset: 12,
    });
});

test("formatAcpToolOutput flattens search rawOutput into path:line:context lines", () => {
    const call = state();
    mergeAcpToolCallUpdate(call, {
        rawOutput: {
            matches: [
                { path: "src/a.ts", line: 10, context: "const x = 1;" },
                { path: "src/b.ts", line: 4, context: "export function y()" },
            ],
        },
    });
    assert.equal(
        formatAcpToolOutput(call).text,
        "src/a.ts:10:const x = 1;\nsrc/b.ts:4:export function y()",
    );
});

test("formatAcpToolOutput reads text content and diff patches", () => {
    const call = state();
    mergeAcpToolCallUpdate(call, {
        content: [
            { type: "content", content: { type: "text", text: "export const a = 1;" } },
            {
                type: "content",
                content: {
                    type: "diff",
                    path: "src/a.ts",
                    oldText: "a",
                    newText: "b",
                },
            },
        ],
    });
    const formatted = formatAcpToolOutput(call);
    assert.equal(formatted.text, "export const a = 1;");
    assert.deepEqual(formatted.inputPatch, {
        filePath: "src/a.ts",
        oldString: "a",
        newString: "b",
    });
});

test("eventsFromAcpToolCallUpdate merges late rawInput before completion", () => {
    const states = new Map<string, AcpToolCallState>();
    const initial = eventsFromAcpToolCallUpdate(states, {
        sessionUpdate: "tool_call",
        toolCallId: "search-1",
        kind: "search",
        title: "Find",
    });
    assert.deepEqual(initial, [{
        type: "tool/started",
        callId: "search-1",
        tool: "search",
        input: {},
    }]);
    const enriched = eventsFromAcpToolCallUpdate(states, {
        sessionUpdate: "tool_call_update",
        toolCallId: "search-1",
        kind: "search",
        rawInput: { pattern: "Timeline" },
        locations: [{ path: "apps/web/src" }],
    });
    assert.deepEqual(enriched, [{
        type: "tool/started",
        callId: "search-1",
        tool: "search",
        input: { pattern: "Timeline", path: "apps/web/src" },
    }]);
    const done = eventsFromAcpToolCallUpdate(states, {
        sessionUpdate: "tool_call_update",
        toolCallId: "search-1",
        kind: "search",
        status: "completed",
        rawOutput: { matches: [{ path: "apps/web/src/Timeline.tsx", line: 2, context: "export function Timeline()" }] },
    });
    assert.deepEqual(done, [{
        type: "tool/result",
        callId: "search-1",
        tool: "search",
        output: "apps/web/src/Timeline.tsx:2:export function Timeline()",
        input: { pattern: "Timeline", path: "apps/web/src" },
    }]);
});

test("formatAcpToolOutput handles top-level v1 diff and terminal siblings", () => {
    const diffCall = state();
    mergeAcpToolCallUpdate(diffCall, {
        content: [{ type: "diff", path: "/abs/file.ts", oldText: "a", newText: "b" }],
    });
    const diff = formatAcpToolOutput(diffCall);
    assert.equal(diff.text, "");
    assert.deepEqual(diff.inputPatch, {
        filePath: "/abs/file.ts",
        oldString: "a",
        newString: "b",
    });

    const terminalCall = state();
    mergeAcpToolCallUpdate(terminalCall, {
        content: [{ type: "terminal", terminalId: "term_1" }],
    });
    assert.equal(formatAcpToolOutput(terminalCall).text, "Output streamed to terminal term_1");
});

test("formatAcpToolOutput falls back to all locations when content is empty", () => {
    const call = state();
    mergeAcpToolCallUpdate(call, {
        kind: "search",
        title: "grep",
        locations: [
            { path: "src/a.ts", line: 10, context: "const x = 1;" },
            { path: "src/b.ts", line: 4 },
        ],
        status: "completed",
    });
    assert.equal(
        formatAcpToolOutput(call).text,
        "src/a.ts:10:const x = 1;\nsrc/b.ts:4",
    );
});

test("formatAcpToolOutput flattens JSON matches inside text content", () => {
    const call = state();
    mergeAcpToolCallUpdate(call, {
        content: [{
            type: "content",
            content: {
                type: "text",
                text: JSON.stringify({
                    matches: [{ path: "src/a.ts", line: 3, context: "export const a = 1;" }],
                }),
            },
        }],
    });
    assert.equal(formatAcpToolOutput(call).text, "src/a.ts:3:export const a = 1;");
});

test("completion with unchanged input emits only tool/result", () => {
    const states = new Map<string, AcpToolCallState>();
    const initial = eventsFromAcpToolCallUpdate(states, {
        toolCallId: "read-1",
        kind: "read",
        locations: [{ path: "src/a.ts" }],
    });
    assert.equal(initial.filter((event) => event.type === "tool/started").length, 1);
    const unchanged = eventsFromAcpToolCallUpdate(states, {
        toolCallId: "read-1",
        kind: "read",
        rawInput: { path: "src/a.ts" },
    });
    assert.deepEqual(unchanged, []);
    const done = eventsFromAcpToolCallUpdate(states, {
        toolCallId: "read-1",
        kind: "read",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "hello" } }],
    });
    assert.deepEqual(done, [{
        type: "tool/result",
        callId: "read-1",
        tool: "read",
        output: "hello",
        input: { path: "src/a.ts" },
    }]);
});

test("eventsFromAcpToolCallUpdate preserves failed tools", () => {
    const states = new Map<string, AcpToolCallState>();
    eventsFromAcpToolCallUpdate(states, {
        toolCallId: "fail-1",
        kind: "execute",
        title: "Run",
    });
    const failed = eventsFromAcpToolCallUpdate(states, {
        toolCallId: "fail-1",
        kind: "execute",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "Permission denied" } }],
    });
    assert.deepEqual(failed.filter((event) => event.type === "tool/error"), [{
        type: "tool/error",
        callId: "fail-1",
        tool: "execute",
        error: "Permission denied",
    }]);
});

test("eventsFromAcpToolCallUpdate reports terminal-only execute output honestly", () => {
    const states = new Map<string, AcpToolCallState>();
    eventsFromAcpToolCallUpdate(states, {
        toolCallId: "shell-1",
        kind: "execute",
        title: "Shell",
    });
    const done = eventsFromAcpToolCallUpdate(states, {
        toolCallId: "shell-1",
        kind: "execute",
        status: "completed",
        content: [{ type: "terminal", terminalId: "term-7" }],
    });
    assert.deepEqual(done.at(-1), {
        type: "tool/result",
        callId: "shell-1",
        tool: "execute",
        output: "Output streamed to terminal term-7",
    });
});

test("formatAcpToolOutput shows a result once when rawOutput repeats the content text", () => {
    // Copilot CLI 1.0.109 sends a finished shell call in both forms.
    const call = state();
    mergeAcpToolCallUpdate(call, {
        kind: "execute",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "hi\n<shellId: 0 completed with exit code 0>" } }],
        rawOutput: {
            content: "hi\n<shellId: 0 completed with exit code 0>",
            detailedContent: "hi\n<shellId: 0 completed with exit code 0>",
            contents: [{ type: "shell_exit", shellId: "0", exitCode: 0 }],
            structuredContent: { shellId: "0" },
        },
    });
    assert.equal(formatAcpToolOutput(call).text, "hi\n<shellId: 0 completed with exit code 0>");
    // A rawOutput that says something else is still appended.
    const other = state();
    mergeAcpToolCallUpdate(other, {
        content: [{ type: "content", content: { type: "text", text: "done" } }],
        rawOutput: { message: "2 files changed" },
    });
    assert.match(formatAcpToolOutput(other).text, /^done\n.*2 files changed/s);
});

test("a prose title describes a call whose input says nothing readable", () => {
    // Shapes from Copilot CLI 1.0.109 (`stop_bash`, `skill`, `bash`, `view`).
    const stop = state();
    mergeAcpToolCallUpdate(stop, { kind: "execute", title: "Stopping shell session", rawInput: { shellId: "0" } });
    assert.deepEqual(formatAcpToolInput(stop, { toolNameFromTitle: true }), { shellId: "0", description: "Stopping shell session" });

    const skill = state();
    mergeAcpToolCallUpdate(skill, { kind: "other", title: "Using skill: review", rawInput: { skill: "review" } });
    assert.deepEqual(formatAcpToolInput(skill, { toolNameFromTitle: true }), { skill: "review", description: "Using skill: review" });

    const shell = state();
    mergeAcpToolCallUpdate(shell, { kind: "execute", title: "List files", rawInput: { command: "ls -la" } });
    assert.deepEqual(formatAcpToolInput(shell, { toolNameFromTitle: true }), { command: "ls -la" });

    const view = state();
    mergeAcpToolCallUpdate(view, { kind: "read", title: "Viewing ...src/a.ts", rawInput: { path: "/w/src/a.ts" } });
    assert.deepEqual(formatAcpToolInput(view, { toolNameFromTitle: true }), { path: "/w/src/a.ts" });
});
