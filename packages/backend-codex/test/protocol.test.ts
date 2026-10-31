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
test("Codex rejects a missing permission reply before native delivery instead of recording uncertainty", async () => {
    const f = fakeRpc();
    f.handle(async () => ({ thread: { id: "native" } }));
    const rt = await createCodexRuntime(context, f.rpc);
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const missing = await rt.replyPermissionOperation!("canonical", "expired", "once", "late-reply");
    assert.equal(missing.kind, "rejected");
    if (missing.kind === "rejected") assert.equal(missing.code, "not-found");

    const approval = f.request("item/commandExecution/requestApproval", { threadId: "native", itemId: "approval", command: "git status" });
    assert.equal((await rt.replyPermissionOperation!("canonical", "approval", "once", "reply")).kind, "confirmed");
    assert.deepEqual(await approval, { decision: "accept" });
    const duplicate = await rt.replyPermissionOperation!("canonical", "approval", "once", "duplicate-reply");
    assert.equal(duplicate.kind, "rejected");
    if (duplicate.kind === "rejected") assert.equal(duplicate.code, "not-found");
    await rt.dispose();
});
test("Codex replaces writable roots for each canonical workspace and excludes missing repositories", async () => {
    const f = fakeRpc();
    f.handle(async (method) => method === "thread/start" ? { thread: { id: "native" } } : { turn: { id: "turn" } });
    const rt = await createCodexRuntime(context, f.rpc);
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const workspace = {
        projectId: "p", sessionId: "canonical", repositories: [
            { repositoryId: "main", alias: "main", path: "/tmp", state: "ready" as const },
            { repositoryId: "docs", alias: "docs", path: "/work/docs", state: "ready" as const },
            { repositoryId: "gone", alias: "gone", path: "/work/gone", state: "missing" as const },
        ],
    };
    assert.equal((await rt.startTurnOperation!({ sessionId: "canonical", text: "task", workspace }, "submit-1")).kind, "confirmed");
    assert.deepEqual(f.calls.find((call) => call.method === "turn/start")?.params.sandboxPolicy,
        { type: "workspaceWrite", writableRoots: ["/tmp", "/work/docs"], networkAccess: false });
    await rt.startTurnOperation!({ sessionId: "canonical", text: "task", workspace: { ...workspace, repositories: workspace.repositories.slice(0, 1) } }, "submit-2");
    assert.deepEqual(f.calls.filter((call) => call.method === "turn/start").at(-1)?.params.sandboxPolicy.writableRoots, ["/tmp"]);
    for (const invalid of [
        { ...workspace, projectId: "foreign" },
        { ...workspace, sessionId: "foreign" },
        { ...workspace, repositories: workspace.repositories.slice(1) },
        { ...workspace, repositories: [{ ...workspace.repositories[0]!, path: "relative" }] },
    ]) {
        assert.equal((await rt.startTurnOperation!({ sessionId: "canonical", text: "task", workspace: invalid }, "invalid")).kind, "rejected");
    }
    assert.equal(f.calls.filter((call) => call.method === "turn/start").length, 2);
    await rt.dispose();
});
test("Codex uses native thread ids and turn receipts, reconciles observations, and projects reasoning", async () => {
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
    assert.ok(snapshot.events?.some((entry) => entry.events.some((event) =>
        event.type === "assistant/message"
        && event.partId === "private"
        && event.text === ""
        && event.reasoning === "scratch")));
    const events: RuntimeEvent[] = [];
    rt.onObservation!((_sid, o) => { assert.equal(o.reconciliationOrdinal, 9); events.push(...o.events); });
    f.emit("item/reasoning/delta", { threadId: "native", itemId: "reasoning-live", delta: "Thinking now" });
    assert.deepEqual(events.at(-1), {
        type: "assistant/reasoning-chunk",
        partId: "reasoning-live",
        text: "Thinking now",
    });
    f.emit("item/completed", {
        threadId: "native",
        item: {
            type: "reasoning",
            id: "reasoning-final",
            content: [{ type: "text", text: "Consider " }, { type: "text", text: "the options" }, { type: "image" }],
        },
    });
    assert.deepEqual(events.at(-1), {
        type: "assistant/message",
        partId: "reasoning-final",
        text: "",
        reasoning: "Consider the options",
    });
    const eventCountBeforeEmptyAnswer = events.length;
    f.emit("item/started", { threadId: "native", item: { type: "agentMessage", id: "reply", text: "" } });
    assert.equal(events.length, eventCountBeforeEmptyAnswer, "an empty started item is not a finalized canonical answer");
    const eventCountBeforeFinalAnswer = events.length;
    f.emit("item/completed", { threadId: "native", item: { type: "agentMessage", id: "reply", text: "confirmed answer" } });
    assert.equal(events.length, eventCountBeforeFinalAnswer + 1);
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
test("Codex thread/start receives developerInstructions and MCP config from overlay", async () => {
    const { codexOverlays } = await import("../src/provisioner.ts");
    codexOverlays.set(context, {
        developerInstructions: "Global behavior.\n\nCodex-only behavior.",
        mcpServers: { ping: { enabled: true, startup_timeout_sec: 15, command: "node", args: [] } },
    }, "codex");
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
    assert.equal(started.developerInstructions, "Global behavior.\n\nCodex-only behavior.");
    assert.deepEqual(started.config, {
        "tools.update_plan.enabled": true,
        mcp_servers: { ping: { enabled: true, startup_timeout_sec: 15, command: "node", args: [] } },
        mcp_optional_startup_grace_ms: 0,
    });
    assert.equal(started.approvalPolicy, "on-request");
    assert.equal(started.sandbox, "workspace-write");
    await rt.dispose();
});

test("Codex replacement thread/start keeps staged MCP overlay", async () => {
    const { codexOverlays } = await import("../src/provisioner.ts");
    const mcpServers = {
        "polyth-agent-tools": {
            enabled: true,
            startup_timeout_sec: 15,
            command: "node",
            args: ["bridge.mjs"],
        },
    };
    codexOverlays.set(context, {
        mcpServers,
        nativeMcp: [{
            capabilityId: "polyth.agent-tools",
            name: "polyth-agent-tools",
            tools: [{ capabilityId: "browser.polyth-browser", name: "polyth_browser" }],
        }],
    }, "codex", { desiredRevision: "mcp-reset-r1", capabilityIds: ["polyth.agent-tools"] });
    const f = fakeRpc();
    let threads = 0;
    f.handle(async (method) => {
        if (method === "thread/start") {
            threads++;
            return { thread: { id: `native-${threads}` } };
        }
        if (method === "mcpServerStatus/list") {
            return {
                data: [{
                    name: "polyth-agent-tools",
                    runtimeStatus: "connected",
                    tools: { polyth_browser: { name: "polyth_browser" } },
                }],
                nextCursor: null,
            };
        }
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    try {
        assert.equal((await rt.createSessionOperation!({
            projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp",
        }, "create")).kind, "confirmed");
        assert.equal(codexOverlays.peek(context, "codex")?.desiredRevision, "mcp-reset-r1");
        assert.equal((await rt.resetSessionOperation!({
            projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp",
        }, "reset")).kind, "confirmed");
        const starts = f.calls.filter((call) => call.method === "thread/start");
        assert.equal(starts.length, 2);
        assert.equal(starts[1]?.params.cwd, "/tmp");
        for (const start of starts) {
            assert.deepEqual(start.params.config, {
        "tools.update_plan.enabled": true,
                mcp_servers: mcpServers,
                mcp_optional_startup_grace_ms: 0,
            });
        }
        assert.equal(f.rpc.receipts.reset, "native-2");
    } finally {
        codexOverlays.delete(context, "codex");
        await rt.dispose();
    }
});

test("Codex reconcile keeps a live thread when list_turns is unsupported", async () => {
    const f = fakeRpc();
    f.handle(async (method, params) => {
        if (method === "thread/start") return { thread: { id: "native" } };
        if (method === "thread/read") {
            if (params?.includeTurns) {
                throw Object.assign(
                    new Error('runtime rejected "thread/read": list_turns is not supported yet'),
                    { code: "runtime-rejected", remoteMessage: "list_turns is not supported yet" },
                );
            }
            return {
                thread: {
                    id: "native",
                    cwd: "/tmp",
                    status: { type: "idle" },
                    historyMode: "paginated",
                    name: "Kept thread",
                },
            };
        }
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    assert.equal((await rt.createSessionOperation!({
        projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp",
    }, "create")).kind, "confirmed");
    const snapshot = await rt.reconcile!(binding);
    assert.equal(snapshot.state?.value, "idle");
    assert.equal(snapshot.completeness.events, "partial");
    assert.equal(snapshot.backendSessionId, "native");
    assert.equal((await rt.sessions())[0]?.title, "Kept thread");
    const reads = f.calls.filter((call) => call.method === "thread/read");
    assert.equal(reads[0]?.params.includeTurns, true);
    assert.equal(reads[1]?.params.includeTurns, undefined);
    await rt.dispose();
});

test("Codex reconcile does not treat list_turns failure as a missing session", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "thread/start") return { thread: { id: "native" } };
        if (method === "thread/read") {
            throw Object.assign(
                new Error('runtime rejected "thread/read": list_turns is not supported yet'),
                { code: "runtime-rejected", remoteMessage: "list_turns is not supported yet" },
            );
        }
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    assert.equal((await rt.createSessionOperation!({
        projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp",
    }, "create")).kind, "confirmed");
    const snapshot = await rt.reconcile!(binding);
    assert.equal(snapshot.state?.value, "idle");
    assert.equal(snapshot.completeness.events, "partial");
    assert.equal(snapshot.backendSessionId, "native");
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
    let mcpChecks = 0;
    const f = fakeRpc();
    f.handle(async (method, params) => {
        if (method === "skills/extraRoots/set") return {};
        if (method === "skills/list") return {
            data: [{ cwd, skills: [{ name: "docs", path: expectedSkill.path, enabled: true }], errors: [] }],
        };
        if (method === "thread/start") return { thread: { id: "native" } };
        if (method === "mcpServerStatus/list") {
            mcpChecks++;
            return {
                data: [{
                    name: "polyth-agent-tools",
                    runtimeStatus: mcpChecks >= 2 ? "connected" : "starting",
                    tools: mcpChecks >= 2 ? { lookup: { name: "lookup" } } : {},
                }],
                nextCursor: null,
            };
        }
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
        assert.ok(mcpChecks >= 2);
        const methods = f.calls.map((call) => call.method);
        assert.deepEqual(methods.slice(0, 3), [
            "skills/extraRoots/set",
            "skills/list",
            "thread/start",
        ]);
        assert.ok(methods.slice(3).every((method) => method === "mcpServerStatus/list"));
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

test("Codex rejects session create when required MCP fails", async () => {
    const scopedContext = { ...context, sessionId: "mcp-gate-negative" };
    codexOverlays.set(scopedContext, {
        mcpServers: {
            "polyth-agent-tools": {
                enabled: true,
                startup_timeout_sec: 15,
                command: "node",
                args: ["bridge.mjs"],
            },
        },
        nativeMcp: [{
            capabilityId: "polyth.agent-tools",
            name: "polyth-agent-tools",
            tools: [{ capabilityId: "browser.polyth-browser", name: "polyth_browser" }],
        }],
        stagedCapabilityIds: [],
    }, "codex", { desiredRevision: "mcp-gate-r1", capabilityIds: ["polyth.agent-tools"] });
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "thread/start") return { thread: { id: "native-gated" } };
        if (method === "mcpServerStatus/list") return {
            data: [{ name: "polyth-agent-tools", runtimeStatus: "failed", tools: {} }],
            nextCursor: null,
        };
        return {};
    });
    const rt = await createCodexRuntime(scopedContext, f.rpc);
    try {
        const outcome = await rt.createSessionOperation!({
            projectId: "p",
            sessionId: "mcp-gate-negative",
            title: "x",
            cwd: "/tmp",
        }, "create-gated");
        assert.equal(outcome.kind, "rejected");
        assert.equal(outcome.kind === "rejected" && outcome.code, "native-failure");
        assert.match(outcome.kind === "rejected" ? outcome.message : "", /failed to connect/i);
        assert.equal((await rt.startTurnOperation!({ sessionId: "mcp-gate-negative", text: "task" }, "turn-gated")).kind, "rejected");
    } finally {
        codexOverlays.delete(scopedContext, "codex");
        await rt.dispose();
    }
});

test("Codex maps mcpToolCall items into canonical tool events", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "thread/start") return { thread: { id: "native" } };
        if (method === "thread/read") {
            return {
                thread: {
                    id: "native",
                    status: { type: "idle" },
                    historyMode: "legacy",
                    turns: [{
                        id: "t",
                        status: "completed",
                        itemsView: "full",
                        items: [{
                            type: "mcpToolCall",
                            id: "browser-call",
                            server: "polyth-agent-tools",
                            tool: "polyth_browser",
                            status: "completed",
                            arguments: { action: "browser.open", parameters: { url: "http://127.0.0.1:4400/" } },
                            result: { content: [{ type: "text", text: "opened" }] },
                        }],
                    }],
                },
            };
        }
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const snapshot = await rt.reconcile!({ ...binding, backendSessionId: "native", reconciliationOrdinal: 3 });
    const toolEvent = snapshot.events
        ?.flatMap((entry) => entry.events)
        .find((event) => event.type === "tool/result");
    assert.equal(toolEvent?.type, "tool/result");
    assert.equal(toolEvent && "tool" in toolEvent ? toolEvent.tool : "", "polyth_browser");
    assert.match(toolEvent && "output" in toolEvent ? toolEvent.output : "", /opened/);
    await rt.dispose();
});

test("Codex fails errored native skills while still verifying connected MCP", async () => {
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
            data: [{ name: "example", runtimeStatus: "connected", tools: {} }],
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
            { id: "example.mcp", outcome: "applied", stage: "connected" },
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

test("Codex maps native titles, per-response usage, occupancy, attachments, compaction, steering, and rate reset", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "thread/start") return { thread: { id: "native" }, model: "gpt-codex", modelProvider: "openai" };
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

    const usage = (turnId: string, inputTokens: number, cachedInputTokens: number) => f.emit(
        "thread/tokenUsage/updated",
        {
            threadId: "native",
            turnId,
            tokenUsage: {
                total: { totalTokens: 604_900 },
                last: {
                    totalTokens: inputTokens + 8,
                    inputTokens,
                    cachedInputTokens,
                    cacheWriteInputTokens: 2,
                    outputTokens: 4,
                    reasoningOutputTokens: 1,
                },
                modelContextWindow: 200,
            },
        },
    );
    // Real App Server sequence: `last` is each response's own usage, cached
    // tokens are already inside `inputTokens`, and one response is notified
    // once. The second sample must not be published as a prompt-growth delta
    // and the inclusive input must not reach the event as-is.
    usage("turn-1", 19_303, 9_984);
    usage("turn-1", 21_072, 18_176);
    usage("turn-1", 21_072, 18_176);
    usage("turn-2", 40, 3);
    const usageEvents = events.filter((event) => event.type === "usage/recorded");
    assert.deepEqual(usageEvents.map((event) => event.tokens.input), [9_319, 2_896, 37]);
    assert.deepEqual(usageEvents.map((event) => event.tokens.cacheRead), [9_984, 18_176, 3]);
    assert.deepEqual(usageEvents.map((event) => event.tokens.output), [4, 4, 4]);
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
    const steerCalls = () => f.calls.filter((call) => call.method === "turn/steer").length;
    assert.equal((await rt.steerOperation!(
        "canonical",
        "same model",
        "steer-same-model",
        { providerID: "openai", modelID: "gpt-codex" },
    )).kind, "confirmed");
    const admittedSteers = steerCalls();
    assert.equal(await rt.steer!("canonical", "switch", { providerID: "openai", modelID: "other" }), false);
    assert.equal((await rt.steerOperation!("canonical", "delegate", "steer-agent", undefined, "review")).kind, "rejected");
    assert.equal(steerCalls(), admittedSteers, "incompatible steering selections queue without reaching Codex");
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

const startCodexTurn = async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "thread/start") return { thread: { id: "native" } };
        if (method === "turn/start") return { turn: { id: "limited" } };
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "task" }, "submit");
    return { f, rt, events };
};

test("Codex usageLimitExceeded carries quota retry with exhausted-window reset", async () => {
    const { f, events } = await startCodexTurn();
    f.emit("account/rateLimits/updated", {
        rateLimits: {
            primary: { usedPercent: 40, resetsAt: 2_000_000_000 },
            secondary: { usedPercent: 100, resetsAt: 3_000_000_000 },
        },
    });
    f.emit("turn/completed", {
        threadId: "native",
        turn: {
            id: "limited",
            status: "failed",
            error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" },
        },
    });
    const stopped = events.findLast((event) => event.type === "turn/stopped");
    assert.equal(stopped?.code, "quota-exhausted");
    assert.equal(stopped?.retry?.scope, "quota");
    assert.equal(stopped?.retry?.provider, "openai");
    assert.equal(stopped?.retry?.resetAt, 3_000_000_000_000);
});

test("Codex usage-limit error notice is not a stop and classifies a sparse turn error", async () => {
    const { f, events } = await startCodexTurn();
    f.emit("account/rateLimits/updated", {
        rateLimits: { primary: { usedPercent: 100, resetsAt: 2_100_000_000 } },
    });
    f.emit("error", {
        threadId: "native",
        turnId: "limited",
        willRetry: false,
        error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" },
    });
    assert.equal(events.filter((event) => event.type === "turn/stopped").length, 0);
    f.emit("turn/completed", {
        threadId: "native",
        turn: { id: "limited", status: "failed", error: { message: "failed" } },
    });
    const stopped = events.findLast((event) => event.type === "turn/stopped");
    assert.equal(stopped?.code, "quota-exhausted");
    assert.equal(stopped?.retry?.resetAt, 2_100_000_000_000);
    assert.equal(stopped?.retry?.provider, "openai");
});

test("Codex usage-limit copy still plans a resume without a discriminant", async () => {
    const { f, events } = await startCodexTurn();
    f.emit("turn/completed", {
        threadId: "native",
        turn: { id: "limited", status: "failed", error: { message: "You've hit your usage limit." } },
    });
    const stopped = events.findLast((event) => event.type === "turn/stopped");
    assert.equal(stopped?.code, "quota-exhausted");
    assert.equal(stopped?.retry?.scope, "quota");
    assert.equal(stopped?.retry?.provider, "openai");
});

test("Codex snapshot rateLimitReachedType classifies an opaque failed turn", async () => {
    const { f, events } = await startCodexTurn();
    f.emit("account/rateLimits/updated", {
        rateLimits: {
            rateLimitReachedType: "workspace_member_usage_limit_reached",
            secondary: { usedPercent: 100, resetsAt: 2_200_000_000 },
        },
    });
    f.emit("turn/completed", {
        threadId: "native",
        turn: { id: "limited", status: "failed", error: { message: "failed" } },
    });
    const stopped = events.findLast((event) => event.type === "turn/stopped");
    assert.equal(stopped?.code, "quota-exhausted");
    assert.equal(stopped?.retry?.resetAt, 2_200_000_000_000);
});

test("Codex turn/plan/updated publishes canonical task snapshots only inside an admitted turn", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "thread/start") return { thread: { id: "native" }, model: "gpt-codex", modelProvider: "openai" };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        return {};
    });
    const rt = await createCodexRuntime(context, f.rpc);
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const plan = [{ step: "Inspect", status: "completed" }, { step: "Patch", status: "inProgress" }];

    f.emit("turn/plan/updated", { threadId: "native", turnId: "stray", explanation: null, plan });
    assert.equal(events.some((event) => event.type === "task/snapshot"), false, "no snapshot outside a turn");

    f.emit("turn/started", { threadId: "native", turn: { id: "turn-1" } });
    f.emit("turn/plan/updated", { threadId: "native", turnId: "turn-1", explanation: null, plan });
    f.emit("turn/plan/updated", { threadId: "native", turnId: "turn-1", explanation: null, plan });
    const snapshots = events.filter((event) => event.type === "task/snapshot");
    assert.equal(snapshots.length, 1, "an unchanged plan is not republished");
    assert.deepEqual(snapshots[0]!.type === "task/snapshot" ? snapshots[0]!.items : [], [
        { id: "codex-plan:0:Inspect", text: "Inspect", status: "done" },
        { id: "codex-plan:1:Patch", text: "Patch", status: "active" },
    ]);
    await rt.dispose();
});
