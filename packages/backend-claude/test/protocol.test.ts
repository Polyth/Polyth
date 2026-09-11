import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import type { RuntimeEvent } from "@polyth/contracts";
import { createClaudeRuntime } from "../src/index.ts";
import {
    setCapabilityLaunchSink,
    setCapabilityReceiptSink,
    type createProcessAuthority,
} from "@polyth/harness-runtime";
const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
test("Claude SDK keeps one native session over turns, exposes permissions, drops thinking, and requires owned release", async () => {
    let options: any;
    let input: AsyncIterator<any>;
    let push: (message: any) => void = () => { };
    let closed = false;
    let released = false;
    const receipts: Record<string, string> = {};
    const sdk = { query(args: any) {
            options = args.options;
            input = args.prompt[Symbol.asyncIterator]();
            const pending: any[] = [];
            let wake: (() => void) | undefined;
            push = m => { pending.push(m); wake?.(); };
            return { async *[Symbol.asyncIterator]() { while (!closed) {
                    if (!pending.length)
                        await new Promise<void>(r => wake = r);
                    while (pending.length)
                        yield pending.shift();
                } }, initializationResult: async () => ({}), supportedModels: async () => [{ value: "sonnet", displayName: "Sonnet" }], setModel: async () => { }, interrupt: async () => { }, close() { closed = true; wake?.(); } } as any;
        }, getSessionInfo: async () => undefined, getSessionMessages: async () => [] };
    const authority = { authorityId: "owned", generation: 1, receipts, releasedAuthorities: [], spawn() { throw new Error("SDK fake does not spawn"); }, receipt: async (op: string, id: string) => { receipts[op] = id; }, close: async () => { released = true; } } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const rt = await createClaudeRuntime(context, sdk, authority);
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, e) => events.push(e));
    const native = await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, randomUUID());
    assert.equal(native.kind, "confirmed");
    assert.equal((await rt.sessions()).length, 1, "missing getSessionInfo still preserves receipt rows");
    const endpointBefore = await rt.endpoint!();
    const bindingBefore = { ...endpointBefore, canonicalSessionId: "canonical", backendSessionId: Object.values(receipts)[0]!, reconciliationOrdinal: 7 };
    await rt.reconcile!(bindingBefore);
    rt.onObservation!((_sid, observation) => { assert.equal(observation.reconciliationOrdinal, 7); events.push(...observation.events); });
    for (let turn = 0; turn < 2; turn++) {
        const op = randomUUID();
        const admission = rt.startTurnOperation!({ sessionId: "canonical", text: `task${turn}` }, op);
        assert.equal((await input!.next()).value.uuid, op);
        push({ type: "assistant", uuid: randomUUID(), parent_tool_use_id: null, message: { content: [{ type: "thinking", thinking: "private scratch" }, { type: "text", text: `answer${turn}` }] } });
        assert.equal((await admission).kind, "confirmed");
        const permission = options.canUseTool("Bash", { command: "git status" }, { signal: new AbortController().signal, toolUseID: "tool" });
        await rt.replyPermission("canonical", "tool", "once");
        assert.equal((await permission).behavior, "allow");
        push({ type: "result", is_error: false });
        await new Promise(r => setImmediate(r));
    }
    assert.equal(events.filter(e => e.type === "turn/stopped").length, 2);
    assert.doesNotMatch(JSON.stringify(events), /private scratch/);
    assert.ok(options.spawnClaudeCodeProcess);
    assert.equal(options.permissionMode, "default");
    assert.equal((await rt.capabilities()).subagents, false);
    const endpoint = await rt.endpoint!();
    const binding = { ...endpoint, canonicalSessionId: "canonical", backendSessionId: Object.values(receipts)[0]! };
    assert.equal((await rt.releaseExecution!({ ...binding, generation: 2 }, "wrong")).kind, "unknown");
    assert.equal(released, false);
    assert.equal((await rt.releaseExecution!(binding, "switch")).kind, "confirmed");
    assert.equal(released, true);
});
test("Claude query keeps the overlay when native initialization fails", async () => {
    const { claudeOverlays } = await import("../src/provisioner.ts");
    claudeOverlays.set(context, { append: "Keep me." }, "claude");
    const sdk = { query() {
        return { async *[Symbol.asyncIterator]() {}, initializationResult: async () => { throw new Error("init failed"); }, supportedModels: async () => [], setModel: async () => {}, interrupt: async () => {}, close() {} } as any;
    }, getSessionInfo: async () => undefined, getSessionMessages: async () => [] };
    const authority = { authorityId: "owned", generation: 1, receipts: {}, releasedAuthorities: [], spawn() { throw new Error("no"); }, receipt: async () => {}, close: async () => {} } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const rt = await createClaudeRuntime(context, sdk, authority);
    const outcome = await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, randomUUID());
    assert.equal(outcome.kind === "confirmed", false);
    assert.equal(claudeOverlays.peek(context, "claude")?.value.append, "Keep me.");
    await rt.dispose();
});

test("Claude captures R1 before blocked initialization and preserves staged R2 on success", async () => {
    const { claudeOverlays } = await import("../src/provisioner.ts");
    claudeOverlays.set(context, { append: "R1", verification: {
        promptIds: ["cap-r1"], skills: [], mcpServers: [], tools: [],
    } }, "claude", {
        desiredRevision: "R1",
        capabilityIds: ["cap-r1"],
    });
    let resolveInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => { resolveInitialization = resolve; });
    const launches: Array<{ desiredRevision: string; outcome: string; sessionId?: string }> = [];
    const receipts: Array<{ desiredRevision: string; outcome: string }> = [];
    const disposeLaunch = setCapabilityLaunchSink((event) => launches.push({
        desiredRevision: event.desiredRevision,
        outcome: event.outcome,
        sessionId: event.target.sessionId,
    }));
    const disposeReceipt = setCapabilityReceiptSink((receipt) => receipts.push({
        desiredRevision: receipt.desiredRevision,
        outcome: receipt.outcome,
    }));
    const sdk = {
        query() {
            return {
                async *[Symbol.asyncIterator]() {},
                initializationResult: () => initialization,
                supportedModels: async () => [],
                setModel: async () => {},
                interrupt: async () => {},
                close() {},
            } as any;
        },
        getSessionInfo: async () => undefined,
        getSessionMessages: async () => [],
    };
    const authority = { authorityId: "owned", generation: 1, receipts: {}, releasedAuthorities: [], spawn() { throw new Error("no"); }, receipt: async () => {}, close: async () => {} } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const rt = await createClaudeRuntime(context, sdk, authority);
    try {
        const creating = rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create-r1");
        assert.deepEqual(launches, [{ desiredRevision: "R1", outcome: "captured", sessionId: "canonical" }]);
        claudeOverlays.set(context, { append: "R2", verification: {
            promptIds: ["cap-r2"], skills: [], mcpServers: [], tools: [],
        } }, "claude", {
            desiredRevision: "R2",
            capabilityIds: ["cap-r2"],
        });
        resolveInitialization();
        assert.equal((await creating).kind, "confirmed");
        assert.equal(claudeOverlays.peek(context, "claude")?.desiredRevision, "R2");
        assert.deepEqual(receipts, [{ desiredRevision: "R1", outcome: "unverifiable" }]);
    } finally {
        disposeReceipt();
        disposeLaunch();
        claudeOverlays.delete(context, "claude");
        await rt.dispose();
    }
});

test("Claude releases R1 after blocked initialization fails and preserves staged R2", async () => {
    const { claudeOverlays } = await import("../src/provisioner.ts");
    claudeOverlays.set(context, { append: "R1" }, "claude", {
        desiredRevision: "R1",
        capabilityIds: ["cap-r1"],
    });
    let rejectInitialization!: (error: Error) => void;
    const initialization = new Promise<void>((_resolve, reject) => { rejectInitialization = reject; });
    const launches: Array<{ desiredRevision: string; outcome: string; sessionId?: string }> = [];
    const disposeLaunch = setCapabilityLaunchSink((event) => launches.push({
        desiredRevision: event.desiredRevision,
        outcome: event.outcome,
        sessionId: event.target.sessionId,
    }));
    const sdk = {
        query() {
            return {
                async *[Symbol.asyncIterator]() {},
                initializationResult: () => initialization,
                supportedModels: async () => [],
                setModel: async () => {},
                interrupt: async () => {},
                close() {},
            } as any;
        },
        getSessionInfo: async () => undefined,
        getSessionMessages: async () => [],
    };
    const authority = { authorityId: "owned", generation: 1, receipts: {}, releasedAuthorities: [], spawn() { throw new Error("no"); }, receipt: async () => {}, close: async () => {} } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const rt = await createClaudeRuntime(context, sdk, authority);
    try {
        const creating = rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create-r1");
        assert.equal(launches[0]?.outcome, "captured");
        claudeOverlays.set(context, { append: "R2" }, "claude", {
            desiredRevision: "R2",
            capabilityIds: ["cap-r2"],
        });
        rejectInitialization(new Error("init failed"));
        assert.equal((await creating).kind, "unknown");
        assert.deepEqual(launches.map(({ desiredRevision, outcome, sessionId }) => ({ desiredRevision, outcome, sessionId })), [
            { desiredRevision: "R1", outcome: "captured", sessionId: "canonical" },
            { desiredRevision: "R1", outcome: "failed", sessionId: "canonical" },
        ]);
        assert.equal(claudeOverlays.peek(context, "claude")?.desiredRevision, "R2");
    } finally {
        disposeLaunch();
        claudeOverlays.delete(context, "claude");
        await rt.dispose();
    }
});

test("Claude query receives overlay systemPrompt append and mcpServers", async () => {
    const { claudeOverlays } = await import("../src/provisioner.ts");
    claudeOverlays.set(context, { append: "Be brief.", mcpServers: { ping: { command: "node", args: ["x"] } } }, "claude");
    let options: any;
    const sdk = { query(args: any) {
        options = args.options;
        return { async *[Symbol.asyncIterator]() {}, initializationResult: async () => ({}), supportedModels: async () => [], setModel: async () => {}, interrupt: async () => {}, close() {} } as any;
    }, getSessionInfo: async () => undefined, getSessionMessages: async () => [] };
    const authority = { authorityId: "owned", generation: 1, receipts: {}, releasedAuthorities: [], spawn() { throw new Error("no"); }, receipt: async () => {}, close: async () => {} } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const rt = await createClaudeRuntime(context, sdk, authority);
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, randomUUID());
    assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code", append: "Be brief." });
    assert.deepEqual(options.mcpServers, { ping: { command: "node", args: ["x"] } });
    assert.deepEqual(options.disallowedTools, ["Agent", "Task"]);
    await rt.dispose();
});

test("Claude verifies native skills and MCP servers without claiming listed tools are invocable", async () => {
    const { claudeOverlays } = await import("../src/provisioner.ts");
    claudeOverlays.set(context, {
        plugins: [{ type: "local", path: "/private/revision/plugin" }],
        skills: ["polyth-space:review-safe"],
        mcpServers: {
            connected: { command: "helper" },
            "polyth-agent-tools": { command: "bridge" },
        },
        verification: {
            promptIds: ["instruction"],
            skills: [{ capabilityId: "skill", canonicalName: "polyth-space:review-safe" }],
            mcpServers: [
                { capabilityId: "mcp", name: "connected", enabled: true },
                { capabilityId: "retired", name: "removed", enabled: false },
            ],
            tools: [{ capabilityId: "tool", name: "fixture_read" }],
        },
    }, "claude", {
        desiredRevision: "verified",
        capabilityIds: ["instruction", "skill", "mcp", "retired", "tool"],
    });
    let options: any;
    const sdk = { query(args: any) {
        options = args.options;
        return {
            async *[Symbol.asyncIterator]() {},
            initializationResult: async () => ({ plugins_applied: true }),
            supportedCommands: async () => [{ name: "polyth-space:review-safe", description: "review", argumentHint: "" }],
            mcpServerStatus: async () => [
                { name: "connected", status: "connected", tools: [] },
                { name: "polyth-agent-tools", status: "connected", tools: [{ name: "fixture_read" }] },
            ],
            supportedModels: async () => [], setModel: async () => {}, interrupt: async () => {}, close() {},
        } as any;
    }, getSessionInfo: async () => undefined };
    const authority = { authorityId: "owned", generation: 3, receipts: {}, releasedAuthorities: [], spawn() { throw new Error("no"); }, receipt: async () => {}, close: async () => {} } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const receipts: any[] = [];
    const disposeReceipt = setCapabilityReceiptSink((receipt) => receipts.push(receipt));
    const rt = await createClaudeRuntime(context, sdk, authority);
    try {
        assert.equal((await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create-verified")).kind, "confirmed");
        assert.deepEqual(options.plugins, [{ type: "local", path: "/private/revision/plugin" }]);
        assert.equal(options.pluginDelivery, "initialize");
        assert.deepEqual(options.skills, ["polyth-space:review-safe"]);
        const byId = new Map(receipts.map((receipt) => [receipt.capabilityIds[0], receipt]));
        assert.deepEqual([byId.get("skill")?.outcome, byId.get("skill")?.evidence?.stage], ["applied", "discovered"]);
        assert.deepEqual([byId.get("mcp")?.outcome, byId.get("mcp")?.evidence?.stage], ["applied", "connected"]);
        assert.deepEqual([byId.get("retired")?.outcome, byId.get("retired")?.evidence?.stage], ["applied", "discovered"]);
        assert.deepEqual([byId.get("tool")?.outcome, byId.get("tool")?.evidence?.stage], ["unverifiable", "discovered"]);
        assert.deepEqual([byId.get("instruction")?.outcome, byId.get("instruction")?.evidence?.stage], ["unverifiable", "staged"]);
    } finally {
        disposeReceipt();
        claudeOverlays.delete(context, "claude");
        await rt.dispose();
    }
});

test("Claude does not apply launch-only plugins, pending MCP, or foreign-server tool names", async () => {
    const { claudeOverlays } = await import("../src/provisioner.ts");
    claudeOverlays.set(context, {
        plugins: [{ type: "local", path: "/private/revision/plugin" }],
        skills: ["polyth-space:review-safe"],
        mcpServers: { pending: { command: "helper" }, "polyth-agent-tools": { command: "bridge" } },
        verification: {
            promptIds: [],
            skills: [{ capabilityId: "skill", canonicalName: "polyth-space:review-safe" }],
            mcpServers: [{ capabilityId: "mcp", name: "pending", enabled: true }],
            tools: [{ capabilityId: "tool", name: "fixture_read" }],
        },
    }, "claude", { desiredRevision: "not-applied", capabilityIds: ["skill", "mcp", "tool"] });
    const sdk = { query() {
        return {
            async *[Symbol.asyncIterator]() {},
            initializationResult: async () => ({ plugins_applied: false }),
            supportedCommands: async () => [{ name: "polyth-space:review-safe" }],
            mcpServerStatus: async () => [
                { name: "pending", status: "pending" },
                { name: "foreign-user-server", status: "connected", tools: [{ name: "fixture_read" }] },
            ],
            supportedModels: async () => [], setModel: async () => {}, interrupt: async () => {}, close() {},
        } as any;
    }, getSessionInfo: async () => undefined };
    const authority = { authorityId: "owned", generation: 1, receipts: {}, releasedAuthorities: [], spawn() { throw new Error("no"); }, receipt: async () => {}, close: async () => {} } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const receipts: any[] = [];
    const disposeReceipt = setCapabilityReceiptSink((receipt) => receipts.push(receipt));
    const rt = await createClaudeRuntime(context, sdk, authority);
    try {
        await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create-unverified");
        const byId = new Map(receipts.map((receipt) => [receipt.capabilityIds[0], receipt]));
        assert.equal(byId.get("skill")?.outcome, "failed");
        assert.equal(byId.get("mcp")?.outcome, "unverifiable");
        assert.equal(byId.get("tool")?.outcome, "failed");
    } finally {
        disposeReceipt();
        claudeOverlays.delete(context, "claude");
        await rt.dispose();
    }
});

test("Claude maps cumulative usage to deltas, deduplicates results, discovers commands, and sends image blocks", async () => {
    const imagePath = `/tmp/claude-protocol-${process.pid}.png`;
    await writeFile(imagePath, Buffer.from([1, 2, 3, 4]));
    let input: AsyncIterator<any>;
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
                supportedCommands: async () => [],
                getContextUsage: async () => ({ totalTokens: 50, maxTokens: 200 }),
                setModel: async () => {},
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
        close: async () => { closed = true; },
    } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const rt = await createClaudeRuntime(context, sdk, authority);
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");

    const submit = async (operationId: string, cumulative: number, resultId: string, image = false) => {
        const admission = rt.startTurnOperation!({
            sessionId: "canonical",
            text: operationId,
            ...(image ? {
                attachments: [{
                    id: "image",
                    name: "image.png",
                    mime: "image/png",
                    size: 4,
                    kind: "file",
                    path: imagePath.slice("/tmp/".length),
                }],
            } : {}),
        }, operationId);
        const prompt = (await input!.next()).value;
        push({
            type: "assistant",
            uuid: `${operationId}-assistant`,
            parent_tool_use_id: null,
            message: { model: "sonnet", content: [{ type: "text", text: "answer" }] },
        });
        assert.equal((await admission).kind, "confirmed");
        push({
            type: "result",
            uuid: resultId,
            is_error: false,
            modelUsage: {
                sonnet: {
                    inputTokens: cumulative,
                    outputTokens: cumulative / 10,
                    cacheReadInputTokens: cumulative / 20,
                },
            },
            total_cost_usd: cumulative / 100,
        });
        await new Promise((resolve) => setImmediate(resolve));
        return prompt;
    };
    const firstPrompt = await submit("turn-1", 100, "result-1", true);
    assert.deepEqual(firstPrompt.message.content[0], {
        type: "image",
        source: {
            type: "base64",
            media_type: "image/png",
            data: Buffer.from([1, 2, 3, 4]).toString("base64"),
        },
    });
    push({
        type: "result",
        uuid: "result-1",
        is_error: false,
        modelUsage: { sonnet: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5 } },
        total_cost_usd: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await submit("turn-2", 200, "result-2");
    await submit("turn-3", 0, "result-3");
    const usage = events.filter((event) => event.type === "usage/recorded");
    assert.deepEqual(usage.map((event) => event.tokens.input), [100, 100, 0]);
    assert.deepEqual(usage.map((event) => event.cost), [1, 1, 0]);

    push({
        type: "system",
        subtype: "commands_changed",
        uuid: "commands-1",
        commands: [{ name: "review", description: "Review changes", argumentHint: "path" }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await rt.commands!("canonical"))[0]?.id, "native:claude:review");
    assert.ok(events.some((event) => event.type === "runtime/commands-changed"));
    assert.ok(events.some((event) => event.type === "context/updated" && event.usedTokens === 50));
    await rt.dispose();
    await rm(imagePath, { force: true });
});

test("Claude rate_limit_event is not a stop; error results carry reset timing and rebase cumulative usage", async () => {
    let input: AsyncIterator<any>;
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
        close: async () => { closed = true; },
    } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const rt = await createClaudeRuntime(context, sdk, authority);
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");

    const finish = async (operationId: string, result: Record<string, unknown>) => {
        const admission = rt.startTurnOperation!({ sessionId: "canonical", text: operationId }, operationId);
        await input!.next();
        push({
            type: "assistant",
            uuid: `${operationId}-assistant`,
            parent_tool_use_id: null,
            message: { model: "sonnet", content: [{ type: "text", text: "answer" }] },
        });
        assert.equal((await admission).kind, "confirmed");
        push(result);
        await new Promise((resolve) => setImmediate(resolve));
    };
    await finish("turn-a", {
        type: "result",
        uuid: "result-a",
        is_error: false,
        modelUsage: { sonnet: { inputTokens: 200, outputTokens: 20 } },
        total_cost_usd: 2,
    });
    await finish("turn-b", {
        type: "result",
        uuid: "result-b",
        is_error: false,
        modelUsage: { sonnet: { inputTokens: 40, outputTokens: 4 } },
        total_cost_usd: 0.4,
    });
    const usage = events.filter((event) => event.type === "usage/recorded");
    assert.deepEqual(usage.map((event) => event.tokens.input), [200, 40]);

    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "limited" }, "turn-c");
    await input!.next();
    push({
        type: "rate_limit_event",
        uuid: "rl-1",
        rate_limit_info: { status: "rejected", resetsAt: 1_800_000_000 },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.filter((event) => event.type === "turn/stopped").length, 2);
    push({
        type: "assistant",
        uuid: "turn-c-assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "wait" }] },
    });
    assert.equal((await admission).kind, "confirmed");
    push({
        type: "result",
        uuid: "result-c",
        is_error: true,
        subtype: "error_during_execution",
        errors: ["rate limited"],
    });
    await new Promise((resolve) => setImmediate(resolve));
    const stopped = events.findLast((event) => event.type === "turn/stopped");
    assert.equal(stopped?.reason, "error");
    assert.equal(stopped?.code, "rate-limited");
    assert.equal(stopped?.retry?.resetAt, 1_800_000_000_000);
    await rt.dispose();
});

test("Claude browser-context uses materialized capture paths and formatted text", async () => {
    const imagePath = `/tmp/claude-browser-${process.pid}.png`;
    await writeFile(imagePath, Buffer.from([9, 8, 7, 6]));
    let input: AsyncIterator<any>;
    let push: (message: any) => void = () => {};
    let closed = false;
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
                supportedModels: async () => [],
                setModel: async () => {},
                interrupt: async () => {},
                close() { closed = true; wake?.(); },
            } as any;
        },
        getSessionInfo: async () => undefined,
    };
    const authority = {
        authorityId: "owned",
        generation: 1,
        receipts: {},
        releasedAuthorities: [],
        spawn() { throw new Error("SDK fake does not spawn"); },
        receipt: async () => {},
        close: async () => { closed = true; },
    } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const rt = await createClaudeRuntime(context, sdk, authority);
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const admission = rt.startTurnOperation!({
        sessionId: "canonical",
        text: "inspect",
        attachments: [{
            id: "bc",
            name: "page",
            mime: "application/vnd.polyth.browser-context+json",
            size: 0,
            kind: "browser-context",
            browserContext: {
                id: "bc",
                type: "page",
                browserSessionId: "b",
                projectId: "p",
                frameRevision: 1,
                url: "https://example.com",
                title: "Example",
                viewport: { width: 800, height: 600 },
                capturedAt: "2026-01-01T00:00:00.000Z",
                screenshot: { id: "shot", mime: "image/png", size: 4, localPath: imagePath },
            },
        }],
    }, "browser");
    const prompt = (await input!.next()).value;
    push({ type: "assistant", uuid: "a", parent_tool_use_id: null, message: { content: [{ type: "text", text: "ok" }] } });
    assert.equal((await admission).kind, "confirmed");
    assert.equal(prompt.message.content[0].type, "image");
    assert.equal(prompt.message.content[0].source.data, Buffer.from([9, 8, 7, 6]).toString("base64"));
    assert.match(prompt.message.content[1].text, /^inspect\n\n\[Browser context\]/);
    await rt.dispose();
    await rm(imagePath, { force: true });
});
