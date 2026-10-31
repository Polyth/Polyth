import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import type { createProcessAuthority } from "@polyth/harness-runtime";
import { createClaudeRuntime } from "../src/index.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

async function openRuntime(options: { info?: () => unknown; contextUsage?: () => unknown } = {}) {
    let input!: AsyncIterator<any>;
    let push: (message: any) => void = () => {};
    let closed = false;
    let contextCalls = 0;
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
                getContextUsage: async () => {
                    contextCalls += 1;
                    return options.contextUsage?.() ?? { totalTokens: 1_200, maxTokens: 200_000 };
                },
                setModel: async () => {},
                interrupt: async () => {},
                close() { closed = true; wake?.(); },
            } as any;
        },
        getSessionInfo: async () => options.info?.() as any,
    };
    const authority = {
        authorityId: "owned",
        generation: 1,
        receipts,
        releasedAuthorities: [],
        spawn() { throw new Error("SDK fake does not spawn"); },
        receipt: async (operationId: string, id: string) => { receipts[operationId] = id; },
        close: async () => { closed = true; },
    } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const runtime = await createClaudeRuntime(context, sdk, authority);
    const events: RuntimeEvent[] = [];
    runtime.onEvent((_sid, event) => events.push(event));
    await runtime.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const begin = async (operationId: string) => {
        const admission = runtime.startTurnOperation!({ sessionId: "canonical", text: operationId }, operationId);
        await input.next();
        push({ type: "system", subtype: "status", status: "requesting", uuid: `status-${operationId}` });
        assert.equal((await admission).kind, "confirmed");
    };
    /** One streamed API request, as the CLI forwards it with partial messages. */
    const request = (model: string, start: Record<string, number>, end: Record<string, number>) => {
        push({ type: "stream_event", uuid: "s", parent_tool_use_id: null, event: { type: "message_start", message: { model, usage: start } } });
        push({ type: "stream_event", uuid: "s", parent_tool_use_id: null, event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: end } });
        push({ type: "stream_event", uuid: "s", parent_tool_use_id: null, event: { type: "message_stop" } });
    };
    return { runtime, events, push, begin, request, contextCalls: () => contextCalls };
}

test("Claude reports each API request's usage while the turn runs and only the remainder at its result", async () => {
    const f = await openRuntime();
    try {
        await f.begin("turn-1");
        f.request("claude-opus-5-5",
            { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200, output_tokens: 1 },
            { output_tokens: 50 });
        await flush();
        const live = f.events.filter((event) => event.type === "usage/recorded");
        assert.equal(live.length, 1, "the first request is visible before the turn ends");
        assert.deepEqual(live[0]!.tokens, { input: 10, output: 50, cacheRead: 1_000, cacheWrite: 200 });
        assert.equal(live[0]!.quality, "exact");
        assert.equal(live[0]!.aggregate, undefined, "a single request is a context sample");
        assert.deepEqual(live[0]!.model, { providerID: "anthropic", modelID: "claude-opus-5-5" });

        f.request("claude-opus-5-5",
            { input_tokens: 5, cache_read_input_tokens: 1_250, cache_creation_input_tokens: 40, output_tokens: 1 },
            { output_tokens: 30 });
        await flush();
        // The turn total adds a side model's request the stream never showed.
        f.push({
            type: "result",
            uuid: "result-1",
            is_error: false,
            modelUsage: {
                "claude-opus-5-5": { inputTokens: 15, outputTokens: 80, cacheReadInputTokens: 2_250, cacheCreationInputTokens: 240 },
                "claude-haiku-4-5": { inputTokens: 300, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            },
            total_cost_usd: 0.25,
        });
        await flush();
        const usage = f.events.filter((event) => event.type === "usage/recorded");
        assert.equal(usage.length, 3);
        const remainder = usage[2]!;
        assert.deepEqual(remainder.tokens, { input: 300, output: 12, cacheRead: 0, cacheWrite: 0 });
        assert.equal(remainder.aggregate, true);
        assert.equal(remainder.cost, 0.25);
        const sum = usage.reduce((total, event) => total + event.tokens.input + event.tokens.output
            + (event.tokens.cacheRead ?? 0) + (event.tokens.cacheWrite ?? 0), 0);
        assert.equal(sum, 15 + 80 + 2_250 + 240 + 300 + 12, "streamed samples plus remainder equal the turn total");
        assert.ok(f.events.findIndex((event) => event.type === "usage/recorded" && event.aggregate)
            < f.events.findIndex((event) => event.type === "turn/stopped"));
    } finally {
        await f.runtime.dispose();
    }
});

test("Claude never labels usage with the CLI's synthetic error model", async () => {
    const f = await openRuntime();
    try {
        await f.begin("turn-1");
        f.request("claude-opus-5-5", { input_tokens: 3, output_tokens: 1 }, { output_tokens: 4 });
        f.push({
            type: "assistant",
            uuid: "synthetic",
            parent_tool_use_id: null,
            message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your limit" }] },
        });
        f.push({
            type: "result",
            uuid: "result-1",
            is_error: true,
            subtype: "error_during_execution",
            errors: ["limit"],
            modelUsage: { "claude-opus-5-5": { inputTokens: 3, outputTokens: 4 } },
            total_cost_usd: 0.01,
        });
        await flush();
        const usage = f.events.filter((event) => event.type === "usage/recorded");
        assert.ok(usage.length > 0);
        for (const event of usage) assert.equal(event.model.modelID, "claude-opus-5-5");
    } finally {
        await f.runtime.dispose();
    }
});

test("Claude's own limit line becomes the stop's error, not answer text, when the turn will resume", async () => {
    const f = await openRuntime();
    try {
        await f.begin("turn-1");
        const notice = "You've hit your session limit · resets 10:10pm (Europe/Kyiv)";
        f.push({
            type: "assistant",
            uuid: "synthetic",
            parent_tool_use_id: null,
            message: { model: "<synthetic>", content: [{ type: "text", text: notice }] },
        });
        // The CLI may report the rejection after its own message.
        f.push({ type: "rate_limit_event", uuid: "rl", rate_limit_info: { status: "rejected", resetsAt: 1_791_405_600 } });
        f.push({ type: "result", uuid: "result-1", is_error: true, subtype: "success" });
        await flush();
        assert.equal(f.events.some((event) => event.type === "assistant/message"), false);
        const stopped = f.events.find((event) => event.type === "turn/stopped");
        assert.equal(stopped?.type === "turn/stopped" && stopped.error, notice);
        assert.equal(stopped?.type === "turn/stopped" && stopped.code, "rate-limited");
        assert.equal(stopped?.type === "turn/stopped" && stopped.retry?.resetAt, 1_791_405_600_000);
    } finally {
        await f.runtime.dispose();
    }
});

test("Claude resumes a turn that hits a limit the CLI already reported, with no new rate_limit_event", async () => {
    const f = await openRuntime();
    const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
    const notice = "You've hit your weekly limit · resets 2am (Europe/Kyiv)";
    const limitStop = (id: string) => {
        f.push({
            type: "assistant",
            uuid: `synthetic-${id}`,
            parent_tool_use_id: null,
            error: "rate_limit",
            message: { model: "<synthetic>", content: [{ type: "text", text: notice }] },
        });
        f.push({ type: "result", uuid: `result-${id}`, is_error: true, subtype: "success" });
    };
    try {
        await f.begin("turn-1");
        f.push({ type: "rate_limit_event", uuid: "rl", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "seven_day" } });
        limitStop("1");
        await flush();
        // The CLI reports the state only when it changes: the next turn gets
        // just its own message, flagged `rate_limit`.
        await f.begin("turn-2");
        limitStop("2");
        await flush();
        assert.equal(f.events.some((event) => event.type === "assistant/message"), false, "the limit line is no answer");
        const stops = f.events.filter((event) => event.type === "turn/stopped");
        assert.equal(stops.length, 2);
        for (const stopped of stops) {
            assert.equal(stopped.type === "turn/stopped" && stopped.code, "rate-limited");
            assert.equal(stopped.type === "turn/stopped" && stopped.error, notice);
            assert.equal(stopped.type === "turn/stopped" && stopped.retry?.resetAt, resetsAt * 1000);
        }
    } finally {
        await f.runtime.dispose();
    }
});

test("Claude falls back to a paced resume when a rate_limit message comes with no known reset", async () => {
    const f = await openRuntime();
    try {
        await f.begin("turn-1");
        f.push({
            type: "assistant",
            uuid: "synthetic",
            parent_tool_use_id: null,
            error: "rate_limit",
            message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your limit" }] },
        });
        f.push({ type: "result", uuid: "result-1", is_error: true, subtype: "success" });
        await flush();
        const stopped = f.events.find((event) => event.type === "turn/stopped");
        assert.equal(stopped?.type === "turn/stopped" && stopped.code, "rate-limited");
        assert.deepEqual(stopped?.type === "turn/stopped" && stopped.retry, { scope: "rate", retryable: true });
    } finally {
        await f.runtime.dispose();
    }
});

test("Claude still shows its own message when the turn has no resume plan", async () => {
    const f = await openRuntime();
    try {
        await f.begin("turn-1");
        f.push({
            type: "assistant",
            uuid: "synthetic",
            parent_tool_use_id: null,
            message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 500" }] },
        });
        f.push({ type: "result", uuid: "result-1", is_error: true, subtype: "error_during_execution", errors: ["API Error: 500"] });
        await flush();
        const types = f.events.map((event) => event.type);
        assert.ok(types.indexOf("assistant/message") >= 0, "the message is published");
        assert.ok(types.indexOf("assistant/message") < types.indexOf("turn/stopped"), "before the turn closes");
        const message = f.events.find((event) => event.type === "assistant/message");
        assert.equal(message?.type === "assistant/message" && message.text, "API Error: 500");
    } finally {
        await f.runtime.dispose();
    }
});

test("Claude probes context occupancy during a turn, bounded, and again at its result", async () => {
    const f = await openRuntime();
    try {
        await f.begin("turn-1");
        f.request("sonnet", { input_tokens: 1 }, { output_tokens: 1 });
        await flush();
        const mid = f.events.filter((event) => event.type === "context/updated");
        assert.equal(mid.length, 1, "occupancy and its window limit appear before the result");
        assert.equal(mid[0]!.source, "native");
        assert.equal(mid[0]!.limitTokens, 200_000);
        f.request("sonnet", { input_tokens: 1 }, { output_tokens: 1 });
        f.request("sonnet", { input_tokens: 1 }, { output_tokens: 1 });
        await flush();
        assert.equal(f.contextCalls(), 1, "back-to-back requests do not each probe");
        f.push({ type: "result", uuid: "result-1", is_error: false, modelUsage: { sonnet: { inputTokens: 3, outputTokens: 3 } } });
        await flush();
        assert.equal(f.contextCalls(), 2, "the result always refreshes occupancy");
    } finally {
        await f.runtime.dispose();
    }
});

test("Claude publishes its AI title mid-turn and never a prompt-derived summary", async () => {
    let info: Record<string, unknown> | undefined = {
        sessionId: "x",
        summary: "<polyth-workspace-instructions> fix the titles please",
        lastModified: 0,
    };
    const f = await openRuntime({ info: () => info });
    try {
        await f.begin("turn-1");
        f.request("sonnet", { input_tokens: 1 }, { output_tokens: 1 });
        await flush();
        assert.equal(f.events.some((event) => event.type === "session/title-generated"), false,
            "`summary` falls back to the prompt; it is not a title");
        const placeholder = (await f.runtime.sessions())[0]!.title;
        assert.equal(placeholder, "New session");

        info = { ...info, customTitle: "Repair Claude session titles" };
        f.request("sonnet", { input_tokens: 1 }, { output_tokens: 1 });
        await flush();
        const titles = f.events.filter((event) => event.type === "session/title-generated");
        assert.deepEqual(titles.map((event) => event.title), ["Repair Claude session titles"]);
        assert.equal(f.events.some((event) => event.type === "turn/stopped"), false, "the title arrives before the turn ends");
        assert.equal((await f.runtime.sessions())[0]!.title, "Repair Claude session titles",
            "native-title polling sees the persisted title");

        f.push({ type: "result", uuid: "result-1", is_error: false });
        await flush();
        assert.equal(f.events.filter((event) => event.type === "session/title-generated").length, 1, "an unchanged title is not republished");
    } finally {
        await f.runtime.dispose();
    }
});
