import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, rm } from "node:fs/promises";
import type { RuntimeEvent } from "@polyth/contracts";
import { createAcpRuntime } from "../src/index.ts";
import { fakeRpc } from "../../harness-runtime/test/rpcPeer.ts";
import { setCapabilityLaunchSink, setCapabilityReceiptSink } from "@polyth/harness-runtime";
const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
const binding = { canonicalSessionId: "canonical", backendSessionId: "native", authorityId: "authority", generation: 1, continuity: "generation-only" as const, location: { directory: "/tmp" } };
test("ACP admission requires prompt evidence; cancellation has no fictional acknowledgement or stop", async () => {
    const f = fakeRpc();
    let finish!: (value: unknown) => void;
    f.handle(async (method) => method === "session/new" ? { sessionId: "native" } : new Promise(resolve => { finish = resolve; }));
    const rt = createAcpRuntime(context, f.rpc);
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, e) => events.push(e));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "task" }, "submit");
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private reasoning" } } });
    assert.equal(events.length, 0);
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } });
    assert.equal((await admission).kind, "confirmed");
    assert.equal((await rt.abortOperation!("canonical", "cancel")).kind, "unknown");
    assert.ok(!events.some(e => e.type === "turn/stopped"));
    finish({ stopReason: "cancelled" });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(events.some(e => e.type === "turn/stopped" && e.reason === "aborted"));
    const snap = await rt.reconcile!(binding);
    assert.equal(snap.completeness.events, "partial");
    assert.equal(snap.acceptedOperations?.[0]?.operationId, "submit");
    assert.doesNotMatch(JSON.stringify(events), /private reasoning/);
});

test("ACP keeps the final answer after tool activity in its own assistant part", async () => {
    const f = fakeRpc();
    let finish!: (value: unknown) => void;
    f.handle(async (method) => {
        if (method === "session/new") return { sessionId: "native" };
        if (method === "session/prompt") return new Promise((resolve) => { finish = resolve; });
        return {};
    });
    const rt = createAcpRuntime(context, f.rpc, "cursor");
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");

    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "task" }, "submit");
    f.emit("session/update", {
        sessionId: "native",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I will inspect." } },
    });
    assert.equal((await admission).kind, "confirmed");
    f.emit("session/update", {
        sessionId: "native",
        update: { sessionUpdate: "tool_call", toolCallId: "read", kind: "read", title: "Read file" },
    });
    f.emit("session/update", {
        sessionId: "native",
        update: { sessionUpdate: "tool_call_update", toolCallId: "read", kind: "read", status: "completed" },
    });
    f.emit("session/update", {
        sessionId: "native",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Final answer." } },
    });
    finish({ stopReason: "end_turn" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(events.filter((event) => event.type === "assistant/message"), [
        { type: "assistant/message", partId: "submit", text: "I will inspect." },
        { type: "assistant/message", partId: "submit:1", text: "Final answer." },
    ]);
    assert.deepEqual(
        events.filter((event) => event.type === "assistant/message" || event.type === "tool/started")
            .map((event) => event.type),
        ["assistant/message", "tool/started", "assistant/message"],
    );
    await rt.dispose();
});

test("ACP permissions map native option ids; a lost admitted prompt records a terminal error", async () => {
    const f = fakeRpc();
    let rejectPrompt!: (reason: unknown) => void;
    f.handle(async (method) => method === "session/new" ? { sessionId: "native" } : new Promise((_resolve, reject) => { rejectPrompt = reject; }));
    const rt = createAcpRuntime(context, f.rpc);
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, e) => events.push(e));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "task" }, "submit");
    const permission = f.request("session/request_permission", { sessionId: "native", toolCall: { toolCallId: "tool", kind: "execute", title: "command" }, options: [{ optionId: "allow", kind: "allow_once" }] });
    assert.equal((await admission).kind, "confirmed");
    await rt.replyPermission("canonical", "tool", "once");
    assert.deepEqual(await permission, { outcome: { outcome: "selected", optionId: "allow" } });
    rejectPrompt(Object.assign(new Error("lost"), { code: "outcome-unknown" }));
    f.disconnect();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(events.some(e => e.type === "turn/stopped"
        && e.reason === "error"
        && e.code === "unknown"));
    assert.equal((await rt.reconcile!(binding)).state?.value, "unknown");
    assert.equal((await rt.releaseExecution!(binding, "switch")).kind, "confirmed");
});

test("ACP follow-up silence from an unresponsive peer times out with one terminal error and fences late completion", async () => {
    const f = fakeRpc();
    let promptCount = 0;
    let finishFollowUp!: (value: unknown) => void;
    f.handle(async (method) => {
        if (method === "session/new") return { sessionId: "native" };
        if (method === "session/prompt") {
            promptCount++;
            if (promptCount === 1) return { stopReason: "end_turn" };
            return new Promise((resolve) => { finishFollowUp = resolve; });
        }
        if (method === "_polyth/liveness")
            throw Object.assign(new Error("Runtime response timed out"), { code: "outcome-unknown" });
        return {};
    });
    const rt = createAcpRuntime(context, f.rpc, "cursor", undefined, "Cursor", {
        promptIdleTimeoutMs: 20,
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    assert.equal((await rt.startTurnOperation!({ sessionId: "canonical", text: "first" }, "first")).kind, "confirmed");

    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "follow up" }, "follow-up");
    f.emit("session/update", {
        sessionId: "native",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } },
    });
    assert.equal((await admission).kind, "confirmed");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const followUpStops = events.filter((event) => event.type === "turn/stopped" && event.turnId === "follow-up");
    assert.deepEqual(followUpStops, [{
        type: "turn/stopped",
        turnId: "follow-up",
        reason: "error",
        error: "ACP prompt timed out before a terminal result",
        code: "unknown",
    }]);
    assert.ok(f.calls.some((call) => call.method === "session/cancel"));

    finishFollowUp({ stopReason: "end_turn" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.filter((event) => event.type === "turn/stopped" && event.turnId === "follow-up").length, 1);
    await rt.dispose();
});
test("ACP silence from a responsive peer survives the idle window", async () => {
    const f = fakeRpc();
    let finishPrompt!: (value: unknown) => void;
    let probes = 0;
    f.handle(async (method) => {
        if (method === "session/new") return { sessionId: "native" };
        if (method === "session/prompt")
            return new Promise((resolve) => { finishPrompt = resolve; });
        if (method === "_polyth/liveness") {
            probes++;
            throw Object.assign(new Error("method not found"), { code: "runtime-rejected", rpcCode: -32601 });
        }
        return {};
    });
    const rt = createAcpRuntime(context, f.rpc, "cursor", undefined, "Cursor", {
        promptIdleTimeoutMs: 20,
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "long task" }, "long");
    f.emit("session/update", {
        sessionId: "native",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } },
    });
    assert.equal((await admission).kind, "confirmed");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(probes >= 1);
    assert.equal(events.filter((event) => event.type === "turn/stopped").length, 0);

    finishPrompt({ stopReason: "end_turn" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events.filter((event) => event.type === "turn/stopped"), [{
        type: "turn/stopped",
        turnId: "long",
        reason: "completed",
    }]);
    await rt.dispose();
});
test("ACP session/new forwards overlay mcpServers", async () => {
    const { acpOverlays } = await import("../src/provisioner.ts");
    acpOverlays.set(context, { mcpServers: [{ name: "ping", command: "node", args: ["x"], env: [] }], mcpHttp: false }, "cursor");
    const f = fakeRpc();
    let created: any;
    f.handle(async (method, params) => {
        if (method === "session/new") {
            created = params;
            return { sessionId: "native" };
        }
        return {};
    });
    const rt = createAcpRuntime(context, f.rpc, "cursor");
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    assert.equal(created.mcpServers[0].name, "ping");
    assert.equal((await rt.capabilities()).mcp, true);
    await rt.dispose();
});

test("ACP session/new captures R1 before the blocked request and preserves staged R2", async () => {
    const { acpOverlays } = await import("../src/provisioner.ts");
    acpOverlays.set(context, { mcpServers: [], mcpHttp: false }, "cursor", {
        desiredRevision: "R1",
        capabilityIds: ["cap-r1"],
    });
    const f = fakeRpc();
    let resolveCreate!: (value: { sessionId: string }) => void;
    f.handle(async (method) => {
        if (method === "session/new") {
            return new Promise((resolve) => { resolveCreate = resolve; });
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
    const rt = createAcpRuntime(context, f.rpc, "cursor");
    try {
        const creating = rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create-r1");
        assert.deepEqual(launches, [{ desiredRevision: "R1", outcome: "captured", sessionId: "canonical" }]);
        acpOverlays.set(context, { mcpServers: [], mcpHttp: false }, "cursor", {
            desiredRevision: "R2",
            capabilityIds: ["cap-r2"],
        });
        resolveCreate({ sessionId: "native-r1" });
        assert.equal((await creating).kind, "confirmed");
        assert.equal(acpOverlays.peek(context, "cursor")?.desiredRevision, "R2");
        assert.deepEqual(receipts, [{ desiredRevision: "R1", outcome: "unverifiable" }]);
    } finally {
        disposeReceipt();
        disposeLaunch();
        acpOverlays.delete(context, "cursor");
        await rt.dispose();
    }
});

test("ACP command updates are available while idle and preserve harness identity", async () => {
    const f = fakeRpc();
    f.handle(async (method) => method === "session/new" ? { sessionId: "native" } : { stopReason: "end_turn" });
    const rt = createAcpRuntime(context, f.rpc, "cursor");
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    f.emit("session/update", {
        sessionId: "native",
        update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "review", description: "Review changes", input: { hint: "path" } }],
        },
    });
    assert.deepEqual((await rt.commands!("canonical"))[0], {
        id: "native:cursor:review",
        name: "review",
        description: "Review changes",
        owner: "native",
        harnessId: "cursor",
        invocation: "raw-native-input",
        availability: "session",
        acceptsArguments: true,
    });
    assert.ok(events.some((event) => event.type === "runtime/commands-changed"));
});

test("ACP includes images only when initialize capabilities advertise them", async () => {
    const path = `/tmp/acp-protocol-image-${process.pid}.png`;
    await writeFile(path, Buffer.from([1, 2, 3]));
    try {
        const make = async (image: boolean) => {
            const f = fakeRpc();
            let prompt: any;
            f.handle(async (method, params) => {
                if (method === "session/new") return { sessionId: "native" };
                if (method === "session/prompt") {
                    prompt = params.prompt;
                    return { stopReason: "end_turn" };
                }
                return {};
            });
            const rt = createAcpRuntime(context, f.rpc, "fx", {
                promptCapabilities: { image },
            });
            await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
            const outcome = rt.startTurnOperation!({
                sessionId: "canonical",
                text: "look",
                attachments: [{
                    id: "image",
                    name: "image.png",
                    mime: "image/png",
                    size: 3,
                    kind: "file",
                    path: path.slice("/tmp/".length),
                }],
            }, `image-${image}`);
            await new Promise((resolve) => setImmediate(resolve));
            return { rt, outcome: await outcome, prompt };
        };
        const supported = await make(true);
        assert.equal(supported.outcome.kind, "confirmed");
        assert.deepEqual(supported.prompt[0], {
            type: "image",
            data: Buffer.from([1, 2, 3]).toString("base64"),
            mimeType: "image/png",
        });
        const unsupported = await make(false);
        assert.equal(unsupported.outcome.kind, "rejected");
        assert.equal(unsupported.prompt, undefined);
    } finally {
        await rm(path, { force: true });
    }
});

test("ACP includes audio only when initialize capabilities advertise it", async () => {
    const path = `/tmp/acp-protocol-audio-${process.pid}.wav`;
    await writeFile(path, Buffer.from([4, 5, 6]));
    try {
        const f = fakeRpc();
        let prompt: any;
        f.handle(async (method, params) => {
            if (method === "session/new") return { sessionId: "native" };
            if (method === "session/prompt") {
                prompt = params.prompt;
                return { stopReason: "end_turn" };
            }
            return {};
        });
        const rt = createAcpRuntime(context, f.rpc, "acp", {
            promptCapabilities: { audio: true },
        });
        await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
        const outcome = rt.startTurnOperation!({
            sessionId: "canonical",
            text: "transcribe",
            attachments: [{
                id: "audio",
                name: "audio.wav",
                mime: "audio/wav",
                size: 3,
                kind: "file",
                path: path.slice("/tmp/".length),
            }],
        }, "audio");
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal((await outcome).kind, "confirmed");
        assert.deepEqual(prompt[0], {
            type: "audio",
            data: Buffer.from([4, 5, 6]).toString("base64"),
            mimeType: "audio/wav",
        });
    } finally {
        await rm(path, { force: true });
    }
});

test("ACP session/load is used only when the agent advertises native resume", async () => {
    const f = fakeRpc();
    f.handle(async () => ({}));
    const rt = createAcpRuntime(context, f.rpc, "acp", { loadSession: true });
    assert.equal(await rt.ensureSession({
        projectId: "p",
        sessionId: "canonical",
        cwd: "/tmp",
        backendSessionId: "existing",
    }), "existing");
    assert.deepEqual(f.calls.find((call) => call.method === "session/load")?.params, {
        sessionId: "existing",
        cwd: "/tmp",
        mcpServers: [],
    });
    assert.equal((await rt.capabilities()).resume, true);

    const conservative = createAcpRuntime(context, fakeRpc().rpc);
    await assert.rejects(conservative.ensureSession({
        projectId: "p",
        sessionId: "canonical",
        cwd: "/tmp",
        backendSessionId: "existing",
    }), { code: "unknown-session" });
});

test("ACP maps usage_update field aliases and session_info titles", async () => {
    const f = fakeRpc();
    f.handle(async (method) => method === "session/new" ? { sessionId: "native" } : { stopReason: "end_turn" });
    const rt = createAcpRuntime(context, f.rpc, "acp");
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    f.emit("session/update", {
        sessionId: "native",
        update: { sessionUpdate: "usage_update", usedTokens: 80, sizeTokens: 200 },
    });
    f.emit("session/update", {
        sessionId: "native",
        update: { sessionUpdate: "usage_update", used: 90, size: 200 },
    });
    f.emit("session/update", {
        sessionId: "native",
        update: { sessionUpdate: "session_info_update", title: "ACP native title" },
    });
    const occupancy = events.filter((event) => event.type === "context/updated");
    assert.equal(occupancy[0]?.usedTokens, 80);
    assert.equal(occupancy[0]?.limitTokens, 200);
    assert.equal(occupancy[1]?.usedTokens, 90);
    assert.equal((await rt.sessions())[0]?.title, "ACP native title");
    assert.ok(events.some((event) => event.type === "session/title-generated" && event.title === "ACP native title"));
    assert.equal((await rt.capabilities()).title, "native");
    assert.equal((await rt.capabilities()).contextOccupancy, "unknown");
});

test("ACP session/resume is used when sessionCapabilities.resume is advertised", async () => {
    const f = fakeRpc();
    f.handle(async () => ({}));
    const rt = createAcpRuntime(context, f.rpc, "acp", { sessionCapabilities: { resume: {} } });
    assert.equal(await rt.ensureSession({
        projectId: "p",
        sessionId: "canonical",
        cwd: "/tmp",
        backendSessionId: "existing",
    }), "existing");
    assert.ok(f.calls.some((call) => call.method === "session/resume"));
    assert.ok(!f.calls.some((call) => call.method === "session/load"));
    assert.deepEqual(f.calls.find((call) => call.method === "session/resume")?.params, {
        sessionId: "existing",
        cwd: "/tmp",
        mcpServers: [],
    });
    assert.equal((await rt.capabilities()).resume, true);
});

test("ACP session/resume forwards staged overlay then consumes it", async () => {
    const { acpOverlays } = await import("../src/provisioner.ts");
    acpOverlays.set(context, { mcpServers: [{ name: "ping", command: "node", args: ["x"], env: [] }], mcpHttp: false }, "cursor", {
        desiredRevision: "1",
        capabilityIds: ["cap-1"],
    });
    const f = fakeRpc();
    f.handle(async () => ({}));
    const rt = createAcpRuntime(context, f.rpc, "cursor", { sessionCapabilities: { resume: {} } });
    await rt.ensureSession({
        projectId: "p",
        sessionId: "canonical",
        cwd: "/tmp",
        backendSessionId: "existing",
    });
    assert.deepEqual(f.calls.find((call) => call.method === "session/resume")?.params?.mcpServers, [{
        name: "ping",
        command: "node",
        args: ["x"],
        env: [],
    }]);
    assert.equal(acpOverlays.peek(context, "cursor"), undefined);
    await rt.dispose();
});

test("ACP session/resume releases R1 after a blocked failure and preserves staged R2", async () => {
    const { acpOverlays } = await import("../src/provisioner.ts");
    acpOverlays.set(context, { mcpServers: [], mcpHttp: false }, "cursor", {
        desiredRevision: "R1",
        capabilityIds: ["cap-r1"],
    });
    const f = fakeRpc();
    let rejectResume!: (error: Error) => void;
    f.handle(async (method) => {
        if (method === "session/resume") {
            return new Promise((_resolve, reject) => { rejectResume = reject; });
        }
        return {};
    });
    const launches: Array<{ desiredRevision: string; outcome: string }> = [];
    const disposeLaunch = setCapabilityLaunchSink((event) => launches.push({
        desiredRevision: event.desiredRevision,
        outcome: event.outcome,
    }));
    const rt = createAcpRuntime(context, f.rpc, "cursor", { sessionCapabilities: { resume: {} } });
    try {
        const resuming = rt.ensureSession({
            projectId: "p",
            sessionId: "canonical",
            cwd: "/tmp",
            backendSessionId: "existing",
        });
        acpOverlays.set(context, { mcpServers: [], mcpHttp: false }, "cursor", {
            desiredRevision: "R2",
            capabilityIds: ["cap-r2"],
        });
        rejectResume(new Error("resume failed"));
        await assert.rejects(resuming, /resume failed/);
        assert.deepEqual(launches, [
            { desiredRevision: "R1", outcome: "captured" },
            { desiredRevision: "R1", outcome: "failed" },
        ]);
        assert.equal(acpOverlays.peek(context, "cursor")?.desiredRevision, "R2");
    } finally {
        disposeLaunch();
        acpOverlays.delete(context, "cursor");
        await rt.dispose();
    }
});

test("ACP session/load still used for loadSession without resume and forwards overlay", async () => {
    const { acpOverlays } = await import("../src/provisioner.ts");
    acpOverlays.set(context, { mcpServers: [{ name: "ping", command: "node", args: ["x"], env: [] }], mcpHttp: false }, "acp");
    const f = fakeRpc();
    f.handle(async () => ({}));
    const rt = createAcpRuntime(context, f.rpc, "acp", { loadSession: true });
    await rt.ensureSession({
        projectId: "p",
        sessionId: "canonical",
        cwd: "/tmp",
        backendSessionId: "existing",
    });
    assert.ok(f.calls.some((call) => call.method === "session/load"));
    assert.ok(!f.calls.some((call) => call.method === "session/resume"));
    assert.deepEqual(f.calls.find((call) => call.method === "session/load")?.params?.mcpServers, [{
        name: "ping",
        command: "node",
        args: ["x"],
        env: [],
    }]);
    assert.equal(acpOverlays.peek(context, "acp"), undefined);
    await rt.dispose();
});

test("ACP browser-context uses advertised image prompts", async () => {
    const path = `/tmp/acp-browser-${process.pid}.png`;
    await writeFile(path, Buffer.from([1, 2, 3]));
    try {
        const f = fakeRpc();
        let prompt: any;
        f.handle(async (method, params) => {
            if (method === "session/new") return { sessionId: "native" };
            if (method === "session/prompt") {
                prompt = params.prompt;
                return { stopReason: "end_turn" };
            }
            return {};
        });
        const rt = createAcpRuntime(context, f.rpc, "acp", { promptCapabilities: { image: true } });
        await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
        const outcome = rt.startTurnOperation!({
            sessionId: "canonical",
            text: "look",
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
                    screenshot: { id: "shot", mime: "image/png", size: 3, localPath: path },
                },
            }],
        }, "browser");
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal((await outcome).kind, "confirmed");
        assert.equal(prompt[0].type, "image");
        assert.match(prompt[1].text, /^look\n\n\[Browser context\]/);
    } finally {
        await rm(path, { force: true });
    }
});
