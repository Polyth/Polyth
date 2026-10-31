import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import type { createProcessAuthority } from "@polyth/harness-runtime";
import { CLAUDE_CAPABILITIES, claudeCompactSummary, createClaudeRuntime } from "../src/index.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const SUMMARY_MESSAGE = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent:\n   Ship the CSV importer.";

async function openClaudeRuntime() {
    let input!: AsyncIterator<any>;
    let push: (message: any) => void = () => {};
    let closed = false;
    const receipts: Record<string, string> = {};
    const sdk = {
        query(args: any) {
            input = args.prompt[Symbol.asyncIterator]();
            const pending: any[] = [];
            let wake: (() => void) | undefined;
            push = (message) => { pending.push(message); wake?.(); };
            return {
                async *[Symbol.asyncIterator]() {
                    while (!closed) {
                        if (!pending.length) await new Promise<void>((resolve) => { wake = resolve; });
                        while (pending.length) yield pending.shift();
                    }
                },
                initializationResult: async () => ({}),
                supportedModels: async () => [{ value: "sonnet", displayName: "Sonnet" }],
                setModel: async () => {},
                applyFlagSettings: async () => {},
                interrupt: async () => {},
                close() { closed = true; wake?.(); },
            } as any;
        },
        getSessionInfo: async () => undefined,
    };
    const authority = {
        authorityId: "owned", generation: 1, receipts, releasedAuthorities: [],
        spawn() { throw new Error("SDK fake does not spawn"); },
        receipt: async (operationId: string, id: string) => { receipts[operationId] = id; },
        close: async () => {},
    } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const runtime = await createClaudeRuntime(context, sdk, authority);
    const events: RuntimeEvent[] = [];
    runtime.onEvent((_sessionId, event) => events.push(event));
    await runtime.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    return { runtime, events, nextInput: () => input.next(), push: (message: any) => push(message) };
}

test("Claude declares native compaction", () => {
    assert.equal(CLAUDE_CAPABILITIES.compaction, true);
});

test("the summary is read from Claude Code's continuation message only", () => {
    assert.equal(claudeCompactSummary(SUMMARY_MESSAGE), "1. Primary Request and Intent:\n   Ship the CSV importer.");
    assert.equal(claudeCompactSummary([{ type: "text", text: SUMMARY_MESSAGE }]), "1. Primary Request and Intent:\n   Ship the CSV importer.");
    assert.equal(claudeCompactSummary("an ordinary prompt"), undefined);
    assert.equal(claudeCompactSummary([{ type: "tool_result", content: SUMMARY_MESSAGE }]), undefined);
});

test("compactOperation runs Claude Code's /compact and reports the marker with its summary", async () => {
    const f = await openClaudeRuntime();
    try {
        const outcome = f.runtime.compactOperation!("canonical", "compact-1");
        const sent = (await f.nextInput()).value;
        assert.equal(sent.uuid, "compact-1");
        assert.deepEqual(sent.message.content, [{ type: "text", text: "/compact" }]);

        f.push({ type: "system", subtype: "status", status: "compacting", uuid: "s1" });
        assert.deepEqual(await outcome, { kind: "confirmed", value: { completion: "pending" }, receipt: "compact-1" });
        // The CLI's summarizing request is not a turn and is not content.
        f.push({ type: "stream_event", event: { type: "message_start", message: { model: "claude-sonnet", usage: { input_tokens: 9000 } } } });
        f.push({ type: "assistant", uuid: "a1", message: { model: "claude-sonnet", content: [{ type: "text", text: "<summary>…</summary>" }] } });
        f.push({ type: "system", subtype: "compact_boundary", uuid: "boundary-1", compact_metadata: { trigger: "manual", pre_tokens: 120000 } });
        f.push({ type: "user", uuid: "u1", isSynthetic: true, message: { role: "user", content: SUMMARY_MESSAGE } });
        f.push({ type: "system", subtype: "status", status: null, compact_result: "success", uuid: "s2" });
        f.push({ type: "result", uuid: "r1", is_error: false, result: "Compacted." });
        await flush();

        const compacted = f.events.filter((event) => event.type === "session/compacted");
        assert.deepEqual(compacted, [{ type: "session/compacted", backendEventId: "boundary-1", summary: "1. Primary Request and Intent:\n   Ship the CSV importer." }]);
        assert.equal(f.events.some((event) => event.type === "turn/stopped" || event.type === "assistant/message" || event.type === "usage/recorded"), false);
        assert.equal(f.events.some((event) => event.type === "session/compaction-failed"), false);

        // The next turn is a normal turn again.
        const turn = f.runtime.startTurnOperation!({ sessionId: "canonical", text: "continue" }, "turn-1");
        await f.nextInput();
        f.push({ type: "system", subtype: "status", status: "requesting", uuid: "s3" });
        assert.equal((await turn).kind, "confirmed");
        f.push({ type: "result", uuid: "r2", is_error: false });
        await flush();
        assert.equal(f.events.filter((event) => event.type === "turn/stopped").length, 1);
    } finally {
        await f.runtime.dispose();
    }
});

test("a compaction that fails after it started is reported as a failure", async () => {
    const f = await openClaudeRuntime();
    try {
        const outcome = f.runtime.compactOperation!("canonical", "compact-2");
        await f.nextInput();
        f.push({ type: "system", subtype: "status", status: "compacting", uuid: "s1" });
        assert.equal((await outcome).kind, "confirmed");
        f.push({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "Conversation too long to summarize", uuid: "s2" });
        f.push({ type: "result", uuid: "r1", is_error: true, subtype: "error_during_execution", errors: ["Conversation too long to summarize"] });
        await flush();
        assert.deepEqual(f.events.filter((event) => event.type === "session/compaction-failed"),
            [{ type: "session/compaction-failed", error: "Conversation too long to summarize" }]);
        assert.equal(f.events.some((event) => event.type === "session/compacted" || event.type === "turn/stopped"), false);
    } finally {
        await f.runtime.dispose();
    }
});

test("a /compact Claude Code refuses before compacting is a definite rejection", async () => {
    const f = await openClaudeRuntime();
    try {
        const outcome = f.runtime.compactOperation!("canonical", "compact-3");
        await f.nextInput();
        f.push({ type: "result", uuid: "r1", is_error: false, result: "Not enough messages to compact." });
        assert.deepEqual(await outcome, { kind: "rejected", code: "native-failure", message: "Not enough messages to compact." });
        await flush();
        assert.equal(f.events.some((event) => event.type === "turn/stopped"), false);
    } finally {
        await f.runtime.dispose();
    }
});

test("turns and compactions do not overlap", async () => {
    const f = await openClaudeRuntime();
    try {
        const compaction = f.runtime.compactOperation!("canonical", "compact-4");
        await f.nextInput();
        f.push({ type: "system", subtype: "status", status: "compacting", uuid: "s1" });
        await compaction;
        const refused = await f.runtime.startTurnOperation!({ sessionId: "canonical", text: "too early" }, "turn-early");
        assert.equal(refused.kind, "rejected");
        assert.equal(refused.kind === "rejected" && refused.code, "conflict");
        f.push({ type: "system", subtype: "status", status: null, compact_result: "success", uuid: "s2" });
        f.push({ type: "result", uuid: "r1", is_error: false });
        await flush();

        const turn = f.runtime.startTurnOperation!({ sessionId: "canonical", text: "work" }, "turn-1");
        await f.nextInput();
        f.push({ type: "system", subtype: "status", status: "requesting", uuid: "s3" });
        await turn;
        const busy = await f.runtime.compactOperation!("canonical", "compact-5");
        assert.equal(busy.kind === "rejected" && busy.code, "conflict");
        f.push({ type: "result", uuid: "r2", is_error: false });
        await flush();
    } finally {
        await f.runtime.dispose();
    }
});

test("Claude Code's automatic compaction inside a turn is recorded too", async () => {
    const f = await openClaudeRuntime();
    try {
        const turn = f.runtime.startTurnOperation!({ sessionId: "canonical", text: "long work" }, "turn-1");
        await f.nextInput();
        f.push({ type: "system", subtype: "status", status: "requesting", uuid: "s1" });
        await turn;
        f.push({ type: "system", subtype: "status", status: "compacting", uuid: "s2" });
        f.push({ type: "system", subtype: "compact_boundary", uuid: "auto-1", compact_metadata: { trigger: "auto", pre_tokens: 190000 } });
        f.push({ type: "user", uuid: "u1", message: { role: "user", content: SUMMARY_MESSAGE } });
        f.push({ type: "result", uuid: "r1", is_error: false });
        await flush();
        assert.equal(f.events.filter((event) => event.type === "session/compacted").length, 1);
        assert.equal(f.events.filter((event) => event.type === "turn/stopped").length, 1);
    } finally {
        await f.runtime.dispose();
    }
});
