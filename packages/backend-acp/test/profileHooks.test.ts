import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import { acpModelDescriptors, createAcpRuntime, parseSessionConfig, type AcpModelIdCodec } from "../src/index.ts";
import { discoverAcpModels, invalidateAcpDiscovery } from "../src/discovery.ts";
import { fakeRpc } from "../../harness-runtime/test/rpcPeer.ts";
import { setCapabilityReceiptSink } from "@polyth/harness-runtime";
import type { HarnessCapabilityApplicationReceipt, HarnessProvisioningPlan } from "@polyth/contracts";
import { acpOverlays, createAcpProvisioner } from "../src/provisioner.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
const settle = () => new Promise((resolve) => setImmediate(resolve));

// An agent that names routes as opaque JSON pairs, like DeepSeek Harness.
const pairCodec: AcpModelIdCodec = {
    canonical(value) {
        try {
            const [provider, model] = JSON.parse(value) as [string, string];
            return provider === "official" ? model : `${provider}/${model}`;
        } catch {
            return value;
        }
    },
};
const modelSelect = (current: string) => ({
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: JSON.stringify(["official", current]),
    options: [{
        group: "official",
        name: "Official",
        options: [
            { value: JSON.stringify(["official", "flash"]), name: "Flash" },
            { value: JSON.stringify(["official", "pro"]), name: "Pro" },
        ],
    }],
});
const effortSelect = {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [{ value: "off", name: "Off" }, { value: "high", name: "High" }, { value: "max", name: "Max" }],
};

test("a model id codec gives Polyth ids while changes send the advertised native value", async () => {
    const f = fakeRpc();
    f.handle(async (method, params) => {
        if (method === "session/new") return { sessionId: "native", configOptions: [modelSelect("flash"), effortSelect] };
        if (method === "session/set_config_option") {
            return { configOptions: [params.configId === "model" ? modelSelect(JSON.parse(params.value)[1]) : modelSelect("pro"), { ...effortSelect, currentValue: params.configId === "reasoning_effort" ? params.value : "high" }] };
        }
        if (method === "session/prompt") return { stopReason: "end_turn" };
        return {};
    });
    // Discovery rows carry the canonical ids, so their variants apply.
    const models = [{ providerID: "ds", modelID: "pro", name: "Pro", variants: ["off", "high", "max"] }];
    const rt = createAcpRuntime(context, f.rpc, "ds", undefined, "DeepSeek", { modelIdCodec: pairCodec, models });
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    assert.deepEqual((await rt.models()).map((model) => model.modelID), ["flash", "pro"]);
    const outcome = await rt.startTurnOperation!({ sessionId: "canonical", text: "hi", model: { providerID: "ds", modelID: "pro", variant: "max" } }, "turn");
    assert.equal(outcome.kind, "confirmed", JSON.stringify(outcome));
    const sets = f.calls.filter((call) => call.method === "session/set_config_option").map((call) => [call.params.configId, call.params.value]);
    assert.deepEqual(sets, [["model", JSON.stringify(["official", "pro"])], ["reasoning_effort", "max"]]);
    await rt.dispose();
});

test("a colliding codec keeps the agent's own values instead of guessing", () => {
    const config = parseSessionConfig({ configOptions: [modelSelect("flash")] }, { canonical: () => "same" });
    assert.deepEqual(acpModelDescriptors(config, "ds").map((model) => model.modelID), [
        JSON.stringify(["official", "flash"]),
        JSON.stringify(["official", "pro"]),
    ]);
});

test("cold discovery probes each model with its native value and reports canonical ids", async () => {
    invalidateAcpDiscovery();
    const set: string[] = [];
    const result = await discoverAcpModels({
        harnessId: "ds",
        version: "1",
        authFingerprint: "x",
        modelIdCodec: pairCodec,
        probe: {
            async open() {
                return {
                    result: { sessionId: "probe", configOptions: [modelSelect("flash"), effortSelect] },
                    async setConfigOption(_configId: string, value: string) {
                        set.push(value);
                        return { configOptions: [modelSelect(JSON.parse(value)[1]), effortSelect] };
                    },
                    async close() {},
                };
            },
        },
    });
    assert.equal(result.state, "ready");
    assert.deepEqual(result.state === "ready" ? result.models.map((model) => [model.modelID, model.variants]) : [], [
        ["flash", ["off", "high", "max"]],
        ["pro", ["off", "high", "max"]],
    ]);
    assert.deepEqual(set, [JSON.stringify(["official", "pro"])]);
});

test("a classified admitted failure closes the turn with the agent's reason, code and retry hint", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "session/new") return { sessionId: "native" };
        if (method === "session/prompt") {
            throw Object.assign(new Error("runtime rejected"), { code: "runtime-rejected", rpcCode: -32603, remoteMessage: "Internal error: turn failed: Rate limit reached" });
        }
        return {};
    });
    const seen: Array<{ rpcCode?: number; message: string }> = [];
    const settled: string[] = [];
    const rt = createAcpRuntime(context, f.rpc, "ds", undefined, "DeepSeek", {
        classifyPromptFailure(error) {
            seen.push(error);
            return { admitted: true, message: "DeepSeek rate limit", code: "rate-limited", retry: { scope: "rate", provider: "deepseek", retryable: true } };
        },
        async settleTurn({ turnId }) {
            settled.push(turnId);
            return [{ type: "usage/recorded", model: { providerID: "ds", modelID: "flash" }, tokens: { input: 1, output: 1 }, turnId }];
        },
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const outcome = await rt.startTurnOperation!({ sessionId: "canonical", text: "hi" }, "turn");
    await settle();
    assert.equal(outcome.kind, "confirmed");
    assert.deepEqual(seen, [{ rpcCode: -32603, message: "Internal error: turn failed: Rate limit reached" }]);
    assert.deepEqual(settled, ["turn"]);
    assert.deepEqual(events.map((event) => event.type), ["turn/started", "usage/recorded", "turn/stopped"]);
    const stopped = events.at(-1) as Extract<RuntimeEvent, { type: "turn/stopped" }>;
    assert.equal(stopped.reason, "error");
    assert.equal(stopped.error, "DeepSeek rate limit");
    assert.equal(stopped.code, "rate-limited");
    assert.deepEqual(stopped.retry, { scope: "rate", provider: "deepseek", retryable: true });
    await rt.dispose();
});

test("a classified refusal rejects admission with the agent's reason and no turn", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "session/new") return { sessionId: "native" };
        if (method === "session/prompt") throw Object.assign(new Error("runtime rejected"), { code: "runtime-rejected", remoteMessage: "no key" });
        return {};
    });
    const rt = createAcpRuntime(context, f.rpc, "ds", undefined, "DeepSeek", {
        classifyPromptFailure: () => ({ admitted: false, message: "Sign in to DeepSeek", code: "auth-expired" }),
        settleTurn: async () => { throw new Error("must not read a refused prompt"); },
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    assert.deepEqual(await rt.startTurnOperation!({ sessionId: "canonical", text: "hi" }, "turn"), { kind: "rejected", code: "auth", message: "Sign in to DeepSeek" });
    assert.deepEqual(events, []);
    await rt.dispose();
});

test("unclassified prompt errors keep the generic rejection", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "session/new") return { sessionId: "native" };
        if (method === "session/prompt") throw Object.assign(new Error("runtime rejected"), { code: "runtime-rejected", remoteMessage: "odd" });
        return {};
    });
    const rt = createAcpRuntime(context, f.rpc, "ds", undefined, "DeepSeek", { classifyPromptFailure: () => undefined });
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    assert.deepEqual(await rt.startTurnOperation!({ sessionId: "canonical", text: "hi" }, "turn"), { kind: "rejected", code: "runtime-rejected", message: "ACP rejected the prompt" });
    await rt.dispose();
});

test("settled turn events land before turn/stopped and a hanging read cannot hold the turn", async () => {
    const f = fakeRpc();
    let finish!: (value: unknown) => void;
    f.handle(async (method) => {
        if (method === "session/new") return { sessionId: "native" };
        if (method === "session/prompt") return new Promise((resolve) => { finish = resolve; });
        return {};
    });
    const rt = createAcpRuntime(context, f.rpc, "ds", undefined, "DeepSeek", {
        reportsUsage: true,
        settleTurn: async ({ backendSessionId, turnId }) => [{ type: "usage/recorded", model: { providerID: "ds", modelID: backendSessionId }, tokens: { input: 3, output: 2, cacheRead: 1 }, turnId }],
    });
    assert.equal((await rt.capabilities()).usage, true);
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "hi" }, "turn");
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
    assert.equal((await admission).kind, "confirmed");
    finish({ stopReason: "end_turn" });
    await settle(); await settle();
    assert.deepEqual(events.map((event) => event.type), ["turn/started", "assistant/chunk", "assistant/message", "usage/recorded", "turn/stopped"]);
    await rt.dispose();
});

test("a title that names the tool replaces a generic kind, and a todo tool publishes a task snapshot", async () => {
    const f = fakeRpc();
    let finish!: (value: unknown) => void;
    f.handle(async (method) => {
        if (method === "session/new") return { sessionId: "native" };
        if (method === "session/prompt") return new Promise((resolve) => { finish = resolve; });
        return {};
    });
    const rt = createAcpRuntime(context, f.rpc, "ds", undefined, "DeepSeek", { toolNameFromTitle: true });
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "hi" }, "turn");
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "tool_call", toolCallId: "b", title: "bash", kind: "other", status: "in_progress", rawInput: { command: "ls", description: "List files" } } });
    assert.equal((await admission).kind, "confirmed");
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "tool_call_update", toolCallId: "b", status: "completed", content: [{ type: "content", content: { type: "text", text: "a\nb" } }] } });
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "tool_call", toolCallId: "t", title: "todo_write", kind: "other", status: "in_progress", rawInput: { todos: [{ content: "Plan", status: "completed" }, { content: "Build", status: "in_progress" }] } } });
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "tool_call", toolCallId: "s", title: "Searching the web", kind: "other", status: "in_progress", rawInput: {} } });
    finish({ stopReason: "end_turn" });
    await settle();
    const started = events.filter((event) => event.type === "tool/started") as Array<Extract<RuntimeEvent, { type: "tool/started" }>>;
    assert.deepEqual(started.map((event) => event.tool), ["bash", "todo_write", "other"]);
    assert.deepEqual(started[0]!.input, { command: "ls", description: "List files" });
    assert.deepEqual(started[1]!.input, { todos: [{ content: "Plan", status: "completed" }, { content: "Build", status: "in_progress" }] }, "the list stays on the call");
    const result = events.find((event) => event.type === "tool/result") as Extract<RuntimeEvent, { type: "tool/result" }>;
    assert.equal(result.tool, "bash");
    const snapshot = events.find((event) => event.type === "task/snapshot") as Extract<RuntimeEvent, { type: "task/snapshot" }>;
    assert.deepEqual(snapshot.items.map((item) => [item.text, item.status]), [["Plan", "done"], ["Build", "active"]]);
    await rt.dispose();
});

test("without the option a generic kind still names the tool", async () => {
    const f = fakeRpc();
    f.handle(async (method) => method === "session/new" ? { sessionId: "native" } : new Promise(() => {}));
    const rt = createAcpRuntime(context, f.rpc, "ds");
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "hi" }, "turn");
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "tool_call", toolCallId: "t", title: "todo_write", kind: "other", status: "in_progress", rawInput: { todos: [{ content: "Plan", status: "pending" }] } } });
    await admission;
    assert.equal((events.find((event) => event.type === "tool/started") as { tool: string }).tool, "other");
    assert.equal(events.some((event) => event.type === "task/snapshot"), false);
    await rt.dispose();
});

test("a permission request naming only the tool call borrows the announced tool and target", async () => {
    const f = fakeRpc();
    f.handle(async (method) => method === "session/new" ? { sessionId: "native" } : new Promise(() => {}));
    const rt = createAcpRuntime(context, f.rpc, "ds", undefined, "DeepSeek", { toolNameFromTitle: true });
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "hi" }, "turn");
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "tool_call", toolCallId: "esc", title: "bash", kind: "other", status: "in_progress", rawInput: { command: "echo x > /outside", sandbox_permissions: "danger-full-access" } } });
    await admission;
    const reply = f.request("session/request_permission", { sessionId: "native", toolCall: { toolCallId: "esc" }, options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }] });
    await settle();
    const requested = events.find((event) => event.type === "permission/requested") as Extract<RuntimeEvent, { type: "permission/requested" }>;
    assert.equal(requested.permission, "bash");
    assert.deepEqual(requested.patterns, ["echo x > /outside"]);
    await rt.replyPermission("canonical", "esc", "reject");
    assert.deepEqual(await reply, { outcome: { outcome: "selected", optionId: "reject-once" } });
    await rt.dispose();
});

test("a silent wire is admitted once the agent's own record shows the prompt; polling stops after", async () => {
    const f = fakeRpc();
    let finish!: (value: unknown) => void;
    f.handle(async (method) => {
        if (method === "session/new") return { sessionId: "native" };
        if (method === "session/prompt") return new Promise((resolve) => { finish = resolve; });
        return {};
    });
    let probes = 0;
    let recorded = false;
    const rt = createAcpRuntime(context, f.rpc, "ds", undefined, "DeepSeek", {
        probeAdmission: async ({ backendSessionId, turnId, sentAt }) => {
            probes++;
            assert.equal(backendSessionId, "native");
            assert.equal(turnId, "turn");
            assert.ok(sentAt <= Date.now());
            return recorded;
        },
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    let admitted = false;
    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "think hard" }, "turn").then((outcome) => { admitted = true; return outcome; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(admitted, false, "no proof yet");
    assert.ok(probes >= 1);
    recorded = true;
    assert.equal((await admission).kind, "confirmed");
    assert.deepEqual(events.map((event) => event.type), ["turn/started"]);
    const after = probes;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(probes, after, "no polling once admitted");
    finish({ stopReason: "end_turn" });
    await settle();
    assert.equal(events.at(-1)?.type, "turn/stopped");
    await rt.dispose();
});

test("a session refused for one MCP server is created without it, and that server alone is recorded failed", async () => {
    const f = fakeRpc();
    const sent: string[][] = [];
    f.handle(async (method, params) => {
        if (method !== "session/new") return {};
        const names = (params.mcpServers as Array<{ name: string }>).map((server) => server.name);
        sent.push(names);
        if (names.includes("broken")) {
            throw Object.assign(new Error("runtime rejected"), { code: "runtime-rejected", rpcCode: -32603, remoteMessage: "Internal error", rpcData: { details: "mcp-client(broken): initial connection failed" } });
        }
        return { sessionId: "native" };
    });
    const receipts: HarnessCapabilityApplicationReceipt[] = [];
    const dispose = setCapabilityReceiptSink((receipt) => receipts.push(receipt));
    acpOverlays.set(context, {
        mcpServers: [
            { name: "broken", command: "/bin/false", args: [], env: [] },
            { name: "polyth-agent-tools", command: "/usr/bin/node", args: ["bridge.mjs"], env: [] },
        ],
        mcpHttp: true,
        mcpCapabilityIds: { broken: "cap.broken", "polyth-agent-tools": "cap.tools" },
    }, "ds", { desiredRevision: "R1", capabilityIds: ["cap.broken", "cap.tools"] });
    const seen: unknown[] = [];
    const rt = createAcpRuntime(context, f.rpc, "ds", undefined, "DeepSeek", {
        mcpServerFailure(error, servers) {
            seen.push(error.data);
            const name = /mcp-client\(([^)]+)\)/.exec(JSON.stringify(error.data))?.[1];
            const index = servers.findIndex((server) => server.name === name);
            return index >= 0 ? index : undefined;
        },
    });
    try {
        const created = await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
        assert.equal(created.kind, "confirmed");
        assert.deepEqual(sent, [["broken", "polyth-agent-tools"], ["polyth-agent-tools"]]);
        assert.deepEqual(seen, [{ details: "mcp-client(broken): initial connection failed" }]);
        assert.deepEqual(receipts.map((receipt) => [receipt.capabilityIds, receipt.outcome]), [
            [["cap.tools"], "unverifiable"],
            [["cap.broken"], "failed"],
        ]);
        assert.match(receipts[1]!.reason ?? "", /DeepSeek could not use this MCP server/);
    } finally {
        dispose();
        acpOverlays.delete(context, "ds");
        await rt.dispose();
    }
});

test("a refusal that names no staged server stays a refusal", async () => {
    const f = fakeRpc();
    let attempts = 0;
    f.handle(async (method) => {
        if (method !== "session/new") return {};
        attempts++;
        throw Object.assign(new Error("runtime rejected"), { code: "runtime-rejected", remoteMessage: "workspace missing" });
    });
    acpOverlays.set(context, { mcpServers: [{ name: "a", command: "/bin/true", args: [], env: [] }], mcpHttp: false }, "ds");
    const rt = createAcpRuntime(context, f.rpc, "ds", undefined, "DeepSeek", { mcpServerFailure: () => undefined });
    try {
        const created = await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
        assert.equal(created.kind, "rejected");
        assert.equal(attempts, 1);
    } finally {
        acpOverlays.delete(context, "ds");
        await rt.dispose();
    }
});

test("an agent that needs absolute stdio commands gets them; an unknown command is recorded failed, not sent", async () => {
    const plan: HarnessProvisioningPlan = {
        harnessId: "ds-abs",
        desiredRevision: "R1",
        items: ["node", "polyth-no-such-command-xyz"].map((command) => ({
            capability: {
                id: `cap.${command}`,
                kind: "mcp-server" as const,
                owner: "test",
                scope: "project" as const,
                revision: "1",
                name: command,
                enabled: true,
                transport: { kind: "stdio" as const, command, args: [], envKeys: [] },
            },
            mode: "native" as const,
            mutability: "session-create" as const,
        })) as unknown as HarnessProvisioningPlan["items"],
    };
    const absolute = createAcpProvisioner("ds-abs", true, { absoluteMcpCommands: true });
    try {
        const applied = await absolute.apply(context, plan, { mcpSecrets: () => ({}) });
        assert.deepEqual(applied.records.map((row) => [row.capabilityId, row.status]), [["cap.node", "pending"], ["cap.polyth-no-such-command-xyz", "failed"]]);
        assert.match(applied.records[1]!.reason ?? "", /was not found on this machine/);
        const staged = acpOverlays.peek(context, "ds-abs")!.value.mcpServers;
        assert.equal(staged.length, 1);
        assert.ok(staged[0]!.name === "node" && "command" in staged[0]! && staged[0].command.startsWith("/"), JSON.stringify(staged));
        // Without the option the command is passed through unchanged.
        await createAcpProvisioner("ds-abs", true).apply(context, plan, { mcpSecrets: () => ({}) });
        assert.deepEqual(acpOverlays.peek(context, "ds-abs")!.value.mcpServers.map((server) => "command" in server ? server.command : ""), ["node", "polyth-no-such-command-xyz"]);
    } finally {
        acpOverlays.delete(context, "ds-abs");
    }
});
