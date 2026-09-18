import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import type { createProcessAuthority } from "@polyth/harness-runtime";
import { createClaudeRuntime } from "../src/index.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function openClaudeRuntime() {
    let input!: AsyncIterator<any>;
    let push: (message: any) => void = () => {};
    let closed = false;
    const receipts: Record<string, string> = {};
    const sdk = {
        query(args: any) {
            input = args.prompt[Symbol.asyncIterator]();
            assert.equal(args.options.includePartialMessages, true);
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
        authorityId: "owned",
        generation: 1,
        receipts,
        releasedAuthorities: [],
        spawn() { throw new Error("SDK fake does not spawn"); },
        receipt: async (operationId: string, id: string) => { receipts[operationId] = id; },
        close: async () => {},
    } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const runtime = await createClaudeRuntime(context, sdk, authority);
    const events: RuntimeEvent[] = [];
    runtime.onEvent((_sessionId, event) => events.push(event));
    await runtime.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    return {
        runtime,
        events,
        nextInput: () => input.next(),
        push: (message: any) => push(message),
    };
}

test("Claude follow-ups admit on native requesting status and stream public activity", async () => {
    const { runtime, events, nextInput, push } = await openClaudeRuntime();

    // Complete one turn so the regression exercises the follow-up path.
    const first = runtime.startTurnOperation!({ sessionId: "canonical", text: "first" }, "turn-1");
    assert.equal((await nextInput()).value.uuid, "turn-1");
    push({ type: "system", subtype: "status", status: "requesting", uuid: "status-1" });
    assert.equal((await first).kind, "confirmed");
    push({ type: "assistant", uuid: "assistant-1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "done" }] } });
    push({ type: "result", uuid: "result-1", is_error: false });
    await flush();

    events.length = 0;
    const followUp = runtime.startTurnOperation!({ sessionId: "canonical", text: "follow up" }, "turn-2");
    assert.equal((await nextInput()).value.uuid, "turn-2");

    // Native request-start evidence must clear admission before any final answer.
    push({ type: "system", subtype: "status", status: "requesting", uuid: "status-2" });
    assert.equal((await followUp).kind, "confirmed");
    await flush();
    assert.equal(events[0]?.type, "turn/started");

    push({ type: "stream_event", uuid: "stream-1", event: { type: "message_start", message: { model: "sonnet" } } });
    push({ type: "stream_event", uuid: "stream-2", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    push({ type: "stream_event", uuid: "stream-3", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } });
    push({ type: "stream_event", uuid: "stream-private", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "private scratch" } } });
    await flush();

    const chunk = events.find((event) => event.type === "assistant/chunk");
    assert.ok(chunk && chunk.type === "assistant/chunk");
    assert.equal(chunk.text, "Hel");
    assert.doesNotMatch(JSON.stringify(events), /private scratch/);

    push({ type: "assistant", uuid: "assistant-2", parent_tool_use_id: null, message: { model: "sonnet", content: [{ type: "text", text: "Hello" }] } });
    push({ type: "result", uuid: "result-2", is_error: false });
    await flush();

    const final = events.find((event) => event.type === "assistant/message");
    assert.ok(final && final.type === "assistant/message");
    assert.equal(final.partId, chunk.partId, "final message must finalize the streamed row instead of duplicating it");
    assert.equal(final.text, "Hello");
    assert.equal((await runtime.capabilities()).streaming, true);
    await runtime.dispose();
});

test("Claude per-block assistant messages finalize streamed text after a thinking block", async () => {
    const { runtime, events, nextInput, push } = await openClaudeRuntime();
    const turn = runtime.startTurnOperation!({ sessionId: "canonical", text: "Heey" }, "turn-1");
    assert.equal((await nextInput()).value.uuid, "turn-1");
    push({ type: "system", subtype: "status", status: "requesting", uuid: "status-1" });
    assert.equal((await turn).kind, "confirmed");

    push({ type: "stream_event", uuid: "stream-start", event: { type: "message_start", message: { model: "haiku" } } });
    push({ type: "stream_event", uuid: "stream-think-start", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    push({ type: "stream_event", uuid: "stream-think", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private scratch" } } });
    push({ type: "stream_event", uuid: "stream-think-stop", event: { type: "content_block_stop", index: 0 } });
    push({ type: "assistant", uuid: "assistant-think", parent_tool_use_id: null, message: { model: "haiku", content: [{ type: "thinking", thinking: "private scratch" }] } });
    push({ type: "stream_event", uuid: "stream-text-start", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } });
    push({ type: "stream_event", uuid: "stream-text", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hey! Ready to work. What's the task?" } } });
    await flush();

    const chunk = events.find((event) => event.type === "assistant/chunk");
    assert.ok(chunk && chunk.type === "assistant/chunk");
    assert.equal(chunk.partId, "turn-1:stream:0:1");
    assert.doesNotMatch(JSON.stringify(events), /private scratch/);

    // Streaming CLI: one assistant message per completed block, content holds
    // only that block. Body index 0 is therefore not stream index 1.
    push({ type: "assistant", uuid: "assistant-text", parent_tool_use_id: null, message: { model: "haiku", content: [{ type: "text", text: "Hey! Ready to work. What's the task?" }] } });
    push({ type: "assistant", uuid: "assistant-complete", parent_tool_use_id: null, message: { model: "haiku", content: [
        { type: "thinking", thinking: "private scratch" },
        { type: "text", text: "Hey! Ready to work. What's the task?" },
    ] } });
    push({ type: "result", uuid: "result-1", is_error: false });
    await flush();

    const finals = events.filter((event) => event.type === "assistant/message");
    assert.equal(finals.length, 2);
    assert.ok(finals.every((event) => event.type === "assistant/message" && event.partId === chunk.partId));
    assert.equal(new Set(finals.map((event) => event.type === "assistant/message" ? event.partId : "")).size, 1);
    await runtime.dispose();
});
