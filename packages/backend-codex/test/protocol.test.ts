import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodexRuntime } from "../src/index.ts";
import { codexOverlays, createCodexProvisioner } from "../src/provisioner.ts";
import { fakeRpc } from "../../harness-runtime/test/rpcPeer.ts";
import type { HarnessContext, HarnessProvisioningPlan, RuntimeEvent, SpaceContext } from "@polyth/contracts";
import { setCapabilityLaunchSink, setCapabilityReceiptSink } from "@polyth/harness-runtime";
const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
const binding = { canonicalSessionId: "canonical", backendSessionId: "native", authorityId: "authority", generation: 1, continuity: "verified" as const, location: { directory: "/tmp" } };
test("Codex uses native thread ids and turn receipts, reconciles stable observations, and excludes reasoning", async () => {
    const f = fakeRpc();
    let turnItems: any[] = [];
    f.handle(async (method, params) => {
        if (method === "thread/start")
            return { thread: { id: "native" } };
        if (method === "turn/start") {
            turnItems = [{ type: "userMessage", id: "u", clientId: params.clientUserMessageId }, { type: "reasoning", id: "private", text: "scratch" }, { type: "agentMessage", id: "a", text: "done" }];
            return { turn: { id: "t" } };
        }
        if (method === "thread/read")
            return { thread: { id: "native", status: { type: "idle" }, historyMode: "legacy", turns: [{ id: "t", status: "completed", itemsView: "full", items: turnItems }] } };
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    assert.equal((await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create")).kind, "confirmed");
    assert.equal(f.rpc.receipts.create, "native");
    assert.equal((await rt.startTurnOperation!({ sessionId: "canonical", text: "task" }, "submit")).kind, "confirmed");
    const snapshot = await rt.reconcile!({ ...binding, reconciliationOrdinal: 9 });
    assert.equal(snapshot.acceptedOperations?.[0]?.operationId, "submit");
    assert.equal(snapshot.completeness.events, "complete");
    assert.doesNotMatch(JSON.stringify(snapshot), /scratch/);
    const events: RuntimeEvent[] = [];
    rt.onObservation!((_sid, o) => { assert.equal(o.reconciliationOrdinal, 9); events.push(...o.events); });
    f.emit("item/started", { threadId: "native", item: { type: "agentMessage", id: "reply", text: "" } });
    assert.equal(events.length, 0, "an empty started item is not a finalized canonical answer");
    f.emit("item/completed", { threadId: "native", item: { type: "agentMessage", id: "reply", text: "confirmed answer" } });
    assert.equal(events.length, 1);
    f.emit("item/completed", { threadId: "native", item: { type: "fileChange", id: "file", status: "failed" } });
    assert.match(JSON.stringify(events), /not confirmed/);
    assert.equal(events.find(event => "callId" in event && event.callId === "file")?.type, "tool/error");
    const approval = f.request("item/commandExecution/requestApproval", { threadId: "native", itemId: "tool", command: "git status" });
    assert.ok(events.some(e => e.type === "permission/requested"));
    await rt.replyPermission("canonical", "tool", "once");
    assert.deepEqual(await approval, { decision: "accept" });
    assert.equal((await rt.releaseExecution!(binding, "switch")).kind, "confirmed");
});
test("Codex transport loss and partial histories remain uncertain, and unsupported attachments are rejected", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "thread/start")
            throw Object.assign(new Error("response lost"), { code: "outcome-unknown" });
        if (method === "thread/read")
            return { thread: { id: "native", status: { type: "systemError" }, historyMode: "paginated", turns: [{ id: "t", status: "completed", itemsView: "summary", items: [] }] } };
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    assert.equal((await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create")).kind, "unknown");
    assert.deepEqual(await rt.sessions(), []);
    const snapshot = await rt.reconcile!(binding);
    assert.equal(snapshot.state?.value, "unknown");
    assert.equal(snapshot.completeness.events, "partial");
    assert.equal((await rt.startTurnOperation!({ sessionId: "canonical", text: "x", attachments: [{} as never] }, "turn")).kind, "rejected");
    assert.equal((await rt.releaseExecution!({ ...binding, generation: 2 }, "switch")).kind, "unknown");
});
test("Codex thread/start receives developerInstructions and config.mcp_servers from overlay", async () => {
    const { codexOverlays } = await import("../src/provisioner.ts");
    codexOverlays.set(context, { developerInstructions: "Be brief.", mcpServers: { ping: { command: "node", args: [] } } }, "codex");
    const f = fakeRpc();
    let started: any;
    f.handle(async (method, params) => {
        if (method === "thread/start") {
            started = params;
            return { thread: { id: "native" } };
        }
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    assert.equal((await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create")).kind, "confirmed");
    assert.equal(started.developerInstructions, "Be brief.");
    assert.deepEqual(started.config, { mcp_servers: { ping: { command: "node", args: [] } } });
    assert.equal(started.approvalPolicy, "on-request");
    assert.equal(started.sandbox, "workspace-write");
    await rt.dispose();
});

test("Codex verifies native skills and MCP with split evidence before claiming application", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "polyth-codex-protocol-"));
    const cwd = mkdtempSync(join(tmpdir(), "polyth-codex-workspace-"));
    const space: SpaceContext = {
        spaceId: "space",
        spaceSlug: "space",
        userId: "user",
        role: "owner",
        deployment: "local-trusted",
        storageDir,
    };
    mkdirSync(storageDir, { recursive: true });
    const nativeContext: HarnessContext = {
        spaceId: space.spaceId,
        projectId: "project",
        sessionId: "canonical-native",
        cwd,
        space,
    };
    const plan: HarnessProvisioningPlan = {
        harnessId: "codex",
        desiredRevision: "bundle-r1",
        items: [{
            capability: {
                id: "example.instructions",
                kind: "instruction",
                owner: "example",
                scope: "session",
                revision: "instruction-r1",
                text: "Be brief.",
            },
            mode: "config",
            mutability: "session-create",
        }, {
            capability: {
                id: "example.docs",
                kind: "skill",
                owner: "example",
                scope: "session",
                revision: "skill-r1",
                name: "docs",
                title: "Docs",
                description: "Write docs",
                instructions: "Use sources.",
            },
            mode: "native",
            mutability: "session-create",
        }, {
            capability: {
                id: "polyth.agent-tools",
                kind: "mcp-server",
                owner: "polyth",
                scope: "session",
                revision: "mcp-r1",
                name: "polyth-agent-tools",
                enabled: true,
                transport: { kind: "stdio", command: "node", args: ["bridge.mjs"], envKeys: [] },
            },
            mode: "config",
            mutability: "session-create",
        }, {
            capability: {
                id: "example.lookup",
                kind: "tool",
                owner: "example",
                scope: "session",
                revision: "tool-r1",
                name: "lookup",
                description: "Look up a value",
                inputSchema: { type: "object" },
                trust: "pure",
                mutating: false,
            },
            mode: "mcp",
            mutability: "session-create",
        }],
    };
    await createCodexProvisioner().apply(nativeContext, plan, { mcpSecrets: () => ({}) });
    const overlay = codexOverlays.peek(nativeContext, "codex")!.value;
    const expectedSkill = overlay.nativeSkills!.skills[0]!;
    const f = fakeRpc();
    f.handle(async (method, params) => {
        if (method === "skills/extraRoots/set") return {};
        if (method === "skills/list") return {
            data: [{ cwd, skills: [{ name: "docs", path: expectedSkill.path, enabled: true }], errors: [] }],
        };
        if (method === "thread/start") return { thread: { id: "native" } };
        if (method === "mcpServerStatus/list") return {
            data: [{
                name: "polyth-agent-tools",
                runtimeStatus: "connected",
                tools: { lookup: { name: "lookup" } },
            }],
            nextCursor: null,
        };
        return {};
    });
    const receipts: Array<{
        ids: string[];
        outcome: string;
        stage?: string;
    }> = [];
    const disposeReceipt = setCapabilityReceiptSink((receipt) => receipts.push({
        ids: receipt.capabilityIds,
        outcome: receipt.outcome,
        stage: receipt.evidence?.stage,
    }));
    const rt = await createCodexRuntime(nativeContext, f.rpc);
    try {
        assert.equal((await rt.createSessionOperation!({
            projectId: "project",
            sessionId: "canonical-native",
            title: "x",
            cwd,
        }, "create-native")).kind, "confirmed");
        assert.deepEqual(f.calls.map((call) => call.method), [
            "skills/extraRoots/set",
            "skills/list",
            "thread/start",
            "mcpServerStatus/list",
        ]);
        assert.deepEqual(f.calls[0]?.params, { extraRoots: [overlay.nativeSkills!.root] });
        assert.deepEqual(f.calls[1]?.params, { cwds: [cwd], forceReload: true });
        assert.deepEqual(receipts, [{
            ids: ["example.instructions"], outcome: "unverifiable", stage: "staged",
        }, {
            ids: ["example.docs"], outcome: "applied", stage: "discovered",
        }, {
            ids: ["polyth.agent-tools"], outcome: "applied", stage: "connected",
        }, {
            ids: ["example.lookup"], outcome: "unverifiable", stage: "discovered",
        }]);
    } finally {
        disposeReceipt();
        codexOverlays.delete(nativeContext, "codex");
        await rt.dispose();
    }
});

test("Codex fails errored native skills and does not call MCP discovery connected", async () => {
    const scopedContext = { ...context, sessionId: "negative-native" };
    codexOverlays.set(scopedContext, {
        nativeSkills: {
            root: "/private/revision/skills",
            skills: [{ capabilityId: "example.docs", name: "docs", path: "/private/revision/skills/docs/SKILL.md" }],
        },
        nativeMcp: [{ capabilityId: "example.mcp", name: "example", tools: [] }],
        stagedCapabilityIds: [],
    }, "codex", { desiredRevision: "negative-r1", capabilityIds: ["example.docs", "example.mcp"] });
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "skills/extraRoots/set") return {};
        if (method === "skills/list") return {
            data: [{
                cwd: "/tmp",
                skills: [{ name: "docs", path: "/private/revision/skills/docs/SKILL.md", enabled: true }],
                errors: [{ path: "/private/revision/skills/docs/SKILL.md", message: "invalid" }],
            }],
        };
        if (method === "thread/start") return { thread: { id: "native" } };
        if (method === "mcpServerStatus/list") return {
            data: [{ name: "example", runtimeStatus: "starting", tools: {} }],
            nextCursor: null,
        };
        return {};
    });
    const receipts: Array<{ id?: string; outcome: string; stage?: string }> = [];
    const disposeReceipt = setCapabilityReceiptSink((receipt) => receipts.push({
        id: receipt.capabilityIds[0], outcome: receipt.outcome, stage: receipt.evidence?.stage,
    }));
    const rt = await createCodexRuntime(scopedContext, f.rpc);
    try {
        assert.equal((await rt.createSessionOperation!({ projectId: "p", sessionId: "negative-native", title: "x", cwd: "/tmp" }, "create-negative")).kind, "confirmed");
        assert.deepEqual(receipts, [
            { id: "example.docs", outcome: "failed", stage: "discovered" },
            { id: "example.mcp", outcome: "unverifiable", stage: "discovered" },
        ]);
    } finally {
        disposeReceipt();
        codexOverlays.delete(scopedContext, "codex");
        await rt.dispose();
    }
});

test("Codex captures R1 before blocked thread/start and preserves staged R2 on success", async () => {
    const { codexOverlays } = await import("../src/provisioner.ts");
    codexOverlays.set(context, { developerInstructions: "R1" }, "codex", {
        desiredRevision: "R1",
        capabilityIds: ["cap-r1"],
    });
    const f = fakeRpc();
    let resolveStart!: (value: { thread: { id: string } }) => void;
    f.handle(async (method) => {
        if (method === "thread/start") {
            return new Promise((resolve) => { resolveStart = resolve; });
        }
        return {};
    });
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
    const rt = await createCodexRuntime(context, f.rpc);
    try {
        const creating = rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create-r1");
        assert.deepEqual(launches, [{ desiredRevision: "R1", outcome: "captured", sessionId: "canonical" }]);
        codexOverlays.set(context, { developerInstructions: "R2" }, "codex", {
            desiredRevision: "R2",
            capabilityIds: ["cap-r2"],
        });
        resolveStart({ thread: { id: "native-r1" } });
        assert.equal((await creating).kind, "confirmed");
        assert.equal(codexOverlays.peek(context, "codex")?.desiredRevision, "R2");
        assert.deepEqual(receipts, [{ desiredRevision: "R1", outcome: "unverifiable" }]);
    } finally {
        disposeReceipt();
        disposeLaunch();
        codexOverlays.delete(context, "codex");
        await rt.dispose();
    }
});

test("Codex releases R1 after blocked thread/start fails and preserves staged R2", async () => {
    const { codexOverlays } = await import("../src/provisioner.ts");
    codexOverlays.set(context, { developerInstructions: "R1" }, "codex", {
        desiredRevision: "R1",
        capabilityIds: ["cap-r1"],
    });
    const f = fakeRpc();
    let rejectStart!: (error: Error) => void;
    f.handle(async (method) => {
        if (method === "thread/start") {
            return new Promise((_resolve, reject) => { rejectStart = reject; });
        }
        return {};
    });
    const launches: Array<{ desiredRevision: string; outcome: string }> = [];
    const disposeLaunch = setCapabilityLaunchSink((event) => launches.push({
        desiredRevision: event.desiredRevision,
        outcome: event.outcome,
    }));
    const rt = await createCodexRuntime(context, f.rpc);
    try {
        const creating = rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create-r1");
        codexOverlays.set(context, { developerInstructions: "R2" }, "codex", {
            desiredRevision: "R2",
            capabilityIds: ["cap-r2"],
        });
        rejectStart(new Error("start failed"));
        assert.equal((await creating).kind, "unknown");
        assert.deepEqual(launches, [
            { desiredRevision: "R1", outcome: "captured" },
            { desiredRevision: "R1", outcome: "failed" },
        ]);
        assert.equal(codexOverlays.peek(context, "codex")?.desiredRevision, "R2");
    } finally {
        disposeLaunch();
        codexOverlays.delete(context, "codex");
        await rt.dispose();
    }
});

test("Codex create receipt replay does not capture or consume a staged overlay", async () => {
    const { codexOverlays } = await import("../src/provisioner.ts");
    codexOverlays.set(context, { developerInstructions: "R2" }, "codex", {
        desiredRevision: "R2",
        capabilityIds: ["cap-r2"],
    });
    const f = fakeRpc();
    f.rpc.receipts.replay = "existing-native";
    const launches: string[] = [];
    const disposeLaunch = setCapabilityLaunchSink((event) => launches.push(event.outcome));
    const rt = await createCodexRuntime(context, f.rpc);
    try {
        const outcome = await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "replay");
        assert.equal(outcome.kind, "confirmed");
        assert.equal(f.calls.some((call) => call.method === "thread/start"), false);
        assert.deepEqual(launches, []);
        assert.equal(codexOverlays.peek(context, "codex")?.desiredRevision, "R2");
    } finally {
        disposeLaunch();
        codexOverlays.delete(context, "codex");
        await rt.dispose();
    }
});

test("Codex reports prompt titles as emulated instead of waiting for native generation", async () => {
    const f = fakeRpc();
    const rt = await createCodexRuntime(context, f.rpc);
    assert.equal((await rt.capabilities()).title, "emulated");
    await rt.dispose();
});

test("Codex separates lifetime token totals from current context occupancy", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "thread/start") return { thread: { id: "native" } };
        if (method === "thread/read") {
            return { thread: { id: "native", status: { type: "idle" }, historyMode: "legacy", turns: [] } };
        }
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    const events: RuntimeEvent[] = [];
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    await rt.reconcile!({ ...binding, reconciliationOrdinal: 4 });
    rt.onObservation!((_sid, observation) => events.push(...observation.events));

    f.emit("thread/tokenUsage/updated", {
        threadId: "native",
        turnId: "turn-3",
        tokenUsage: {
            total: { totalTokens: 604_900, inputTokens: 580_000, outputTokens: 24_900 },
            last: { totalTokens: 84_200, inputTokens: 80_000, outputTokens: 4_200 },
            modelContextWindow: 258_400,
        },
    });

    const occupancy = events.findLast((event) => event.type === "context/updated");
    assert.equal(occupancy?.usedTokens, 84_200);
    assert.equal(occupancy?.limitTokens, 258_400);
    assert.ok((occupancy?.fraction ?? 1) < 1);
    const usage = events.findLast((event) => event.type === "usage/recorded");
    assert.equal(usage?.tokens.input, 80_000);
    await rt.dispose();
});

test("Codex maps native titles, delta usage, occupancy, attachments, compaction, steering, and rate reset", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "thread/start") return { thread: { id: "native" } };
        if (method === "thread/read") return { thread: { id: "native", name: "Read title" } };
        if (method === "turn/start") return { turn: { id: "turn-started" } };
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");

    f.emit("thread/name/updated", { threadId: "native", threadName: "Native title" });
    assert.ok(events.some((event) => event.type === "session/title-generated" && event.title === "Native title"));
    assert.equal((await rt.sessions())[0]?.title, "Read title");

    const usage = (turnId: string, lifetimeTokens: number, inputTokens: number) => f.emit(
        "thread/tokenUsage/updated",
        {
            threadId: "native",
            turnId,
            tokenUsage: {
                total: { totalTokens: lifetimeTokens },
                last: {
                    totalTokens: inputTokens + 8,
                    inputTokens,
                    cachedInputTokens: 3,
                    cacheWriteInputTokens: 2,
                    outputTokens: 4,
                    reasoningOutputTokens: 1,
                },
                modelContextWindow: 200,
            },
        },
    );
    usage("turn-1", 100, 100);
    usage("turn-2", 200, 100);
    usage("turn-2", 300, 100);
    usage("turn-2", 340, 40);
    const usageEvents = events.filter((event) => event.type === "usage/recorded");
    assert.deepEqual(usageEvents.map((event) => event.tokens.input), [100, 100, 40]);
    assert.equal(usageEvents.reduce((sum, event) => sum + event.tokens.input, 0), 240);
    const occupancy = events.findLast((event) => event.type === "context/updated" && event.source === "native");
    assert.equal(occupancy?.usedTokens, 48);
    assert.equal(occupancy?.limitTokens, 200);
    assert.equal(occupancy?.fraction, 0.24);

    await rt.startTurnOperation!({
        sessionId: "canonical",
        text: "image",
        attachments: [{ id: "img", name: "a.png", mime: "image/png", size: 1, kind: "file", path: "a.png" }],
    }, "image-turn");
    const imageCall = f.calls.findLast((call) => call.method === "turn/start");
    assert.deepEqual(imageCall?.params.input[1], { type: "localImage", path: "/tmp/a.png" });
    await rt.startTurnOperation!({
        sessionId: "canonical",
        text: "page",
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
                screenshot: { id: "shot", mime: "image/png", size: 1, localPath: "/tmp/shot.png" },
            },
        }],
    }, "browser-turn");
    const browserCall = f.calls.findLast((call) => call.method === "turn/start");
    assert.equal(browserCall?.params.input[0].type, "text");
    assert.match(browserCall?.params.input[0].text, /^page\n\n\[Browser context\]/);
    assert.deepEqual(browserCall?.params.input[1], { type: "localImage", path: "/tmp/shot.png" });
    assert.equal((await rt.startTurnOperation!({
        sessionId: "canonical",
        text: "file",
        attachments: [{ id: "file", name: "a.txt", mime: "text/plain", size: 1, kind: "file", path: "a.txt" }],
    }, "file-turn")).kind, "rejected");

    f.emit("turn/started", { threadId: "native", turn: { id: "active" } });
    assert.equal(await rt.steer!("canonical", "redirect"), true);
    assert.deepEqual(f.calls.findLast((call) => call.method === "turn/steer")?.params, {
        threadId: "native",
        expectedTurnId: "active",
        input: [{ type: "text", text: "redirect" }],
    });
    await rt.compact!("canonical");
    assert.deepEqual(f.calls.findLast((call) => call.method === "thread/compact/start")?.params, { threadId: "native" });
    f.emit("item/completed", { threadId: "native", item: { type: "contextCompaction", id: "compact-1" } });
    assert.ok(events.some((event) => event.type === "session/compacted"));
    assert.equal(events.findLast((event) => event.type === "context/updated")?.source, "unknown");

    f.emit("account/rateLimits/updated", { rateLimits: { primary: { resetsAt: 2_000_000_000 } } });
    f.emit("turn/completed", {
        threadId: "native",
        turn: { id: "limited", status: "failed", error: { message: "limited", codexErrorInfo: { code: "rate_limit" } } },
    });
    const stopped = events.findLast((event) => event.type === "turn/stopped");
    assert.equal(stopped?.code, "rate-limited");
    assert.equal(stopped?.retry?.resetAt, 2_000_000_000_000);
});

test("Codex maps string Unauthorized discriminant to auth-expired without regex", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "thread/start") return { thread: { id: "native" } };
        if (method === "turn/start") return { turn: { id: "turn-auth" } };
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "task" }, "submit");
    f.emit("turn/completed", {
        threadId: "native",
        turn: { id: "turn-auth", status: "failed", error: { message: "denied", codexErrorInfo: "Unauthorized" } },
    });
    const stopped = events.findLast((event) => event.type === "turn/stopped");
    assert.equal(stopped?.code, "auth-expired");
});

test("Codex ContextWindowExceeded maps to unknown without inventing invalid-input", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "thread/start") return { thread: { id: "native" } };
        if (method === "turn/start") return { turn: { id: "turn-window" } };
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "task" }, "submit");
    f.emit("turn/completed", {
        threadId: "native",
        turn: { id: "turn-window", status: "failed", error: { message: "too long", codexErrorInfo: "ContextWindowExceeded" } },
    });
    const stopped = events.findLast((event) => event.type === "turn/stopped");
    assert.equal(stopped?.code, "unknown");
});
