import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import { isPlaceholderTitle, type createProcessAuthority } from "@polyth/harness-runtime";
import { createClaudeRuntime } from "../src/index.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function openClaudeRuntime(failWorkspaceApply = false) {
    let input!: AsyncIterator<any>;
    let push: (message: any) => void = () => {};
    let closed = false;
    let nativeTitle = "";
    const receipts: Record<string, string> = {};
    const applyCalls: unknown[] = [];
    let interrupts = 0;
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
                applyFlagSettings: async (settings: unknown) => { applyCalls.push(settings); if (failWorkspaceApply) throw new Error("workspace apply failed"); },
                interrupt: async () => { interrupts += 1; },
                close() { closed = true; wake?.(); },
            } as any;
        },
        getSessionInfo: async () => nativeTitle ? {
            sessionId: Object.values(receipts)[0]!,
            customTitle: nativeTitle,
            summary: "",
            lastModified: 0,
        } : undefined,
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
        applyCalls,
        interrupts: () => interrupts,
        setNativeTitle: (title: string) => { nativeTitle = title; },
    };
}

test("Claude receipt names remain placeholders until the SDK publishes a semantic title", async () => {
    const f = await openClaudeRuntime();
    try {
        const initial = await f.runtime.sessions();
        assert.equal(initial.length, 1, "the native receipt remains discoverable without a title");
        assert.equal(initial[0]!.operationId, "create");
        assert.equal(isPlaceholderTitle(initial[0]!.title, initial[0]!.id), true,
            "an adapter label must not claim canonical native-title authority");

        const finish = async (operationId: string) => {
            const admission = f.runtime.startTurnOperation!({ sessionId: "canonical", text: "Fix session titles" }, operationId);
            await f.nextInput();
            f.push({ type: "system", subtype: "status", status: "requesting", uuid: `status-${operationId}` });
            assert.equal((await admission).kind, "confirmed");
            f.push({ type: "result", uuid: `result-${operationId}`, is_error: false });
            await flush();
        };
        await finish("no-title");
        assert.equal(isPlaceholderTitle((await f.runtime.sessions())[0]!.title), true);
        assert.equal(f.events.some((event) => event.type === "session/title-generated"), false);

        f.setNativeTitle("Repair custom session titles");
        await finish("native-title");
        const final = (await f.runtime.sessions())[0]!;
        assert.equal(final.id, initial[0]!.id);
        assert.equal(final.title, "Repair custom session titles");
        const generated = f.events.filter((event) => event.type === "session/title-generated");
        assert.equal(generated.length, 1);
        assert.equal(generated[0]!.title, final.title);
    } finally {
        await f.runtime.dispose();
    }
});

test("Claude applies canonical workspace roots before enqueue and shrinks them on the next turn", async () => {
    const { runtime, nextInput, push, applyCalls } = await openClaudeRuntime();
    const withSecondary = {
        projectId: "p", sessionId: "canonical",
        repositories: [
            { repositoryId: "primary", alias: "primary", path: "/tmp", state: "ready" as const },
            { repositoryId: "secondary", alias: "secondary", path: "/tmp/secondary", state: "ready" as const },
            { repositoryId: "missing", alias: "missing", path: "/tmp/missing", state: "missing" as const },
        ],
    };
    const first = runtime.startTurnOperation!({ sessionId: "canonical", text: "first", workspace: withSecondary }, "roots-1");
    assert.deepEqual(applyCalls, [{ permissions: { additionalDirectories: ["/tmp/secondary"] } }]);
    assert.equal((await nextInput()).value.uuid, "roots-1");
    push({ type: "system", subtype: "status", status: "requesting", uuid: "status-1" });
    assert.equal((await first).kind, "confirmed");
    push({ type: "result", uuid: "result-1", is_error: false });
    await flush();

    const second = runtime.startTurnOperation!({
        sessionId: "canonical", text: "second",
        workspace: { ...withSecondary, repositories: [withSecondary.repositories[0]!] },
    }, "roots-2");
    assert.deepEqual(applyCalls.at(-1), { permissions: { additionalDirectories: [] } });
    assert.equal((await nextInput()).value.uuid, "roots-2");
    push({ type: "system", subtype: "status", status: "requesting", uuid: "status-2" });
    assert.equal((await second).kind, "confirmed");
    push({ type: "result", uuid: "result-2", is_error: false });
    await runtime.dispose();
});

test("Claude rejects an invalid workspace before native turn submission", async () => {
    const { runtime, applyCalls } = await openClaudeRuntime();
    const outcome = await runtime.startTurnOperation!({
        sessionId: "canonical", text: "blocked",
        workspace: { projectId: "p", sessionId: "canonical", repositories: [{ repositoryId: "missing", alias: "missing", path: "/tmp/missing", state: "missing" }] },
    }, "roots-invalid");
    assert.equal(outcome.kind, "rejected");
    assert.equal(applyCalls.length, 0);
    await runtime.dispose();
});

test("Claude does not enqueue a turn when native workspace authorization fails", async () => {
    const { runtime, applyCalls, nextInput } = await openClaudeRuntime(true);
    const outcome = await runtime.startTurnOperation!({
        sessionId: "canonical", text: "blocked",
        workspace: { projectId: "p", sessionId: "canonical", repositories: [{ repositoryId: "primary", alias: "primary", path: "/tmp", state: "ready" }] },
    }, "roots-failed");
    assert.equal(outcome.kind, "rejected");
    assert.deepEqual(applyCalls, [{ permissions: { additionalDirectories: [] } }]);
    const pending = await Promise.race([
        nextInput().then(() => "enqueued"),
        new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 10)),
    ]);
    assert.equal(pending, "idle");
    await runtime.dispose();
});

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
    push({ type: "stream_event", uuid: "stream-thinking-start", event: { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } } });
    push({ type: "stream_event", uuid: "stream-thinking", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "private scratch" } } });
    await flush();

    const chunk = events.find((event) => event.type === "assistant/chunk");
    assert.ok(chunk && chunk.type === "assistant/chunk");
    assert.equal(chunk.text, "Hel");
    const reasoningChunk = events.find((event) => event.type === "assistant/reasoning-chunk");
    assert.ok(reasoningChunk && reasoningChunk.type === "assistant/reasoning-chunk");
    assert.deepEqual(reasoningChunk, { type: "assistant/reasoning-chunk", partId: "turn-2:stream:0:1", text: "private scratch" });

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

test("Claude admits a native /compact on its compacting status and records the compaction", async () => {
    const { runtime, events, nextInput, push } = await openClaudeRuntime();
    const turn = runtime.startTurnOperation!({
        sessionId: "canonical",
        text: "/compact",
        command: { id: "native:claude:compact", owner: "native", name: "compact" },
    }, "turn-compact");
    const input = (await nextInput()).value;
    assert.equal(input.uuid, "turn-compact");
    assert.equal(input.message.content.at(-1).text, "/compact", "the command is the whole native input");

    // The summary runs before any ordinary request: compacting is the only
    // early admission evidence, so the turn must not wait for its result.
    push({ type: "system", subtype: "status", status: "compacting", uuid: "status-compacting" });
    assert.equal((await turn).kind, "confirmed");
    push({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 310_000 }, uuid: "boundary-1", session_id: "native" });
    push({ type: "system", subtype: "status", status: null, compact_result: "success", uuid: "status-done" });
    push({ type: "result", uuid: "result-compact", is_error: false });
    await flush();

    assert.equal(events.filter((event) => event.type === "turn/started").length, 1);
    assert.deepEqual(events.filter((event) => event.type === "session/compacted"), [
        { type: "session/compacted", backendEventId: "boundary-1" },
    ]);
    assert.ok(events.some((event) => event.type === "turn/stopped"));
    await runtime.dispose();
});

test("Claude per-block assistant messages finalize streamed text after a thinking block", async () => {
    const { runtime, events, nextInput, push } = await openClaudeRuntime();
    const turn = runtime.startTurnOperation!({ sessionId: "canonical", text: "Heey" }, "turn-1");
    assert.equal((await nextInput()).value.uuid, "turn-1");
    push({ type: "stream_event", uuid: "stream-redacted-start", event: { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking" } } });
    push({ type: "stream_event", uuid: "stream-think-start", event: { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } } });
    push({ type: "stream_event", uuid: "stream-think", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "private scratch" } } });
    assert.equal((await turn).kind, "confirmed", "thinking delta accepts the submitted turn");
    push({ type: "stream_event", uuid: "stream-think-stop", event: { type: "content_block_stop", index: 1 } });
    push({ type: "assistant", uuid: "assistant-think", parent_tool_use_id: null, message: { model: "haiku", content: [{ type: "thinking", thinking: "private scratch" }] } });
    push({ type: "stream_event", uuid: "stream-text-start", event: { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } } });
    push({ type: "stream_event", uuid: "stream-text", event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Hey! Ready to work. What's the task?" } } });
    await flush();

    const chunk = events.find((event) => event.type === "assistant/chunk");
    assert.ok(chunk && chunk.type === "assistant/chunk");
    assert.equal(chunk.partId, "turn-1:stream:0:2");
    const reasoningChunk = events.find((event) => event.type === "assistant/reasoning-chunk");
    assert.ok(reasoningChunk && reasoningChunk.type === "assistant/reasoning-chunk");
    assert.equal(reasoningChunk.text, "private scratch");
    assert.equal(reasoningChunk.partId, "turn-1:stream:0:1");

    // Streaming CLI: one assistant message per completed block, content holds
    // only that block. Body index 0 is therefore not stream index 1.
    push({ type: "assistant", uuid: "assistant-text", parent_tool_use_id: null, message: { model: "haiku", content: [{ type: "text", text: "Hey! Ready to work. What's the task?" }] } });
    push({ type: "assistant", uuid: "assistant-complete", parent_tool_use_id: null, message: { model: "haiku", content: [
        { type: "thinking", thinking: "private scratch" },
        { type: "text", text: "Hey! Ready to work. What's the task?" },
    ] } });
    push({ type: "result", uuid: "result-1", is_error: false });
    await flush();

    const reasoningFinals = events.filter((event) => event.type === "assistant/message" && event.reasoning !== undefined);
    assert.equal(reasoningFinals.length, 2);
    assert.ok(reasoningFinals.every((event) => event.type === "assistant/message"
        && event.partId === reasoningChunk.partId
        && event.text === ""
        && event.reasoning === "private scratch"));

    const finals = events.filter((event) => event.type === "assistant/message" && event.text !== "");
    assert.equal(finals.length, 2);
    assert.ok(finals.every((event) => event.type === "assistant/message" && event.partId === chunk.partId));
    assert.equal(new Set(finals.map((event) => event.type === "assistant/message" ? event.partId : "")).size, 1);
    await runtime.dispose();
});

test("Claude refuses model output the native thread produced with no admitted turn", async () => {
    const { runtime, events, nextInput, push } = await openClaudeRuntime();

    // One real turn, completed: `active` is released and the admission is gone.
    const first = runtime.startTurnOperation!({ sessionId: "canonical", text: "first" }, "turn-1");
    assert.equal((await nextInput()).value.uuid, "turn-1");
    push({ type: "system", subtype: "status", status: "requesting", uuid: "status-1" });
    assert.equal((await first).kind, "confirmed");
    push({ type: "assistant", uuid: "assistant-1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "done" }] } });
    push({ type: "result", uuid: "result-1", is_error: false, modelUsage: { input_tokens: 5, output_tokens: 2 } });
    await flush();
    assert.ok(events.some((event) => event.type === "usage/recorded"), "an admitted turn still records its usage");
    events.length = 0;

    // The native thread now loops on its own: no submission, no admission, no
    // operation id. This used to be reported as a turn that never existed.
    push({ type: "stream_event", uuid: "zombie-start", event: { type: "message_start", message: { model: "sonnet" } } });
    push({ type: "stream_event", uuid: "zombie-block", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    push({ type: "stream_event", uuid: "zombie-delta", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "unowned" } } });
    push({ type: "stream_event", uuid: "zombie-tool", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-z", name: "Bash", input: { command: "ls" } } } });
    push({ type: "assistant", uuid: "zombie-assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "unowned" }] } });
    push({ type: "user", uuid: "zombie-tool-result", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tool-z", content: "ok" }] } });
    push({ type: "result", uuid: "zombie-result", is_error: false, modelUsage: { input_tokens: 9, output_tokens: 3 } });
    await flush();

    assert.deepEqual(events, [], "no turn content is reported for a turn Polyth never admitted");
    await runtime.dispose();
});

test("Claude keeps reporting content for a turn whose admission is still pending", async () => {
    const { runtime, events, nextInput, push } = await openClaudeRuntime();
    const turn = runtime.startTurnOperation!({ sessionId: "canonical", text: "live" }, "turn-1");
    assert.equal((await nextInput()).value.uuid, "turn-1");
    // The first output admits the turn, exactly as before the fence existed.
    push({ type: "stream_event", uuid: "start", event: { type: "message_start", message: { model: "sonnet" } } });
    push({ type: "stream_event", uuid: "delta", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } });
    assert.equal((await turn).kind, "confirmed");
    push({ type: "result", uuid: "result-1", is_error: false });
    await flush();

    assert.ok(events.some((event) => event.type === "assistant/chunk"), "an admitted turn still streams");
    assert.equal(
        (events.find((event) => event.type === "assistant/chunk") as { partId: string }).partId,
        "turn-1:stream:0:0",
        "part ids keep their admitted operation prefix",
    );
    const stopped = events.findLast((event) => event.type === "turn/stopped");
    assert.deepEqual(stopped, { type: "turn/stopped", turnId: "turn-1", reason: "completed" });
    await runtime.dispose();
});

test("Claude hands background work that settles while idle to Polyth as a wake request", async () => {
    const { runtime, events, nextInput, push, interrupts } = await openClaudeRuntime();
    const first = runtime.startTurnOperation!({ sessionId: "canonical", text: "start a background run" }, "turn-1");
    assert.equal((await nextInput()).value.uuid, "turn-1");
    push({ type: "system", subtype: "status", status: "requesting", uuid: "status-1" });
    assert.equal((await first).kind, "confirmed");
    push({ type: "result", uuid: "result-1", is_error: false });
    await flush();
    events.length = 0;

    // A notification for an ambient watcher is not a reason to run a turn.
    push({ type: "system", subtype: "task_notification", uuid: "note-ambient", task_id: "w1", status: "completed", output_file: "/tmp/w1", summary: "watch", ambient: true });
    // The backgrounded tests finish while the session is idle.
    push({ type: "system", subtype: "task_notification", uuid: "note-1", task_id: "b66", status: "completed", output_file: "/tmp/b66.output", summary: "Background command \"Run tests\" completed (exit code 0)" });
    await flush();
    const wakes = events.filter((event) => event.type === "runtime/wake-requested");
    assert.equal(wakes.length, 1);
    const wake = wakes[0]!;
    assert.ok(wake.type === "runtime/wake-requested");
    assert.equal(wake.wakeId, "note-1");
    assert.equal(wake.reason, "background-task");
    assert.match(wake.text, /Task: b66/);
    assert.match(wake.text, /Output file: \/tmp\/b66\.output/);

    // The CLI starts its own loop for the notification: it is stopped at once
    // rather than after a budget of refused events.
    const before = interrupts();
    push({ type: "system", subtype: "status", status: "requesting", uuid: "self-loop" });
    await flush();
    assert.equal(interrupts(), before + 1);

    // Polyth's wake turn arrives while that loop is still unwinding: it waits
    // for the loop's result instead of being admitted (and closed) by it.
    const woken = runtime.startTurnOperation!({ sessionId: "canonical", text: wake.text }, "turn-wake");
    let settled = false;
    void woken.then(() => { settled = true; });
    push({ type: "stream_event", uuid: "self-delta", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "unowned" } } });
    await flush();
    assert.equal(settled, false);
    push({ type: "result", uuid: "self-result", is_error: true, subtype: "error_during_execution" });
    assert.equal((await nextInput()).value.uuid, "turn-wake");
    push({ type: "system", subtype: "status", status: "requesting", uuid: "status-wake" });
    assert.equal((await woken).kind, "confirmed");
    push({ type: "stream_event", uuid: "wake-delta", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "tests passed" } } });
    push({ type: "result", uuid: "result-wake", is_error: false });
    await flush();

    assert.equal(events.some((event) => event.type === "assistant/chunk" && event.text === "unowned"), false);
    assert.ok(events.some((event) => event.type === "assistant/chunk" && event.text === "tests passed"));
    assert.deepEqual(events.findLast((event) => event.type === "turn/stopped"), { type: "turn/stopped", turnId: "turn-wake", reason: "completed" });
    await runtime.dispose();
});

test("Claude leaves a notification inside a live turn to that turn", async () => {
    const { runtime, events, nextInput, push } = await openClaudeRuntime();
    const turn = runtime.startTurnOperation!({ sessionId: "canonical", text: "work" }, "turn-1");
    assert.equal((await nextInput()).value.uuid, "turn-1");
    push({ type: "system", subtype: "status", status: "requesting", uuid: "status-1" });
    assert.equal((await turn).kind, "confirmed");
    push({ type: "system", subtype: "task_notification", uuid: "note-live", task_id: "b1", status: "completed", output_file: "/tmp/b1", summary: "done" });
    push({ type: "result", uuid: "result-1", is_error: false });
    await flush();
    assert.equal(events.some((event) => event.type === "runtime/wake-requested"), false);
    await runtime.dispose();
});
