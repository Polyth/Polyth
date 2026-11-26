import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import { createAcpRuntime, parseSessionConfig, type AcpSettleTurnInput } from "../src/index.ts";
import { fakeRpc } from "../../harness-runtime/test/rpcPeer.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const modelSelect = {
    id: "model", name: "Model", category: "model", type: "select", currentValue: "large",
    options: [{ value: "large", name: "Large" }, { value: "medium", name: "Medium" }],
};

test("the session-update observer sees every update, and settleTurn gets the prompt answer and the selected model", async () => {
    const f = fakeRpc();
    let finish!: (value: unknown) => void;
    f.handle(async (method) => {
        if (method === "session/new") return { sessionId: "native", configOptions: [modelSelect] };
        if (method === "session/prompt") return new Promise((resolve) => { finish = resolve; });
        return {};
    });
    const observed: string[] = [];
    const settledWith: AcpSettleTurnInput[] = [];
    const rt = createAcpRuntime(context, f.rpc, "vibe", undefined, "Vibe", {
        observeSessionUpdate({ backendSessionId, update }) {
            observed.push(`${backendSessionId}:${String(update.sessionUpdate)}`);
            if (update.sessionUpdate === "plan") throw new Error("an observer failure is ignored");
        },
        reportsUsage: true,
        async settleTurn(input) {
            settledWith.push(input);
            return [];
        },
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    // Updates outside a turn reach the observer too, and so do the ones of a
    // session the runtime has not been told about yet.
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "usage_update", used: 0, size: 10, _meta: { promptTokens: 4 } } });
    f.emit("session/update", { sessionId: "other", update: { sessionUpdate: "usage_update", used: 0, size: 10 } });
    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "hi" }, "turn");
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } } });
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "plan", entries: [] } });
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
    assert.equal((await admission).kind, "confirmed");
    finish({ stopReason: "end_turn", usage: { inputTokens: 9, outputTokens: 2 } });
    await settle(); await settle();
    assert.deepEqual(observed, ["native:usage_update", "other:usage_update", "native:user_message_chunk", "native:plan", "native:agent_message_chunk"]);
    assert.deepEqual(settledWith, [{
        backendSessionId: "native",
        turnId: "turn",
        promptResult: { stopReason: "end_turn", usage: { inputTokens: 9, outputTokens: 2 } },
        modelId: "large",
    }]);
    assert.equal(events.at(-1)?.type, "turn/stopped");
    await rt.dispose();
});

test("a native tool name from the update replaces a generic kind but never a real one", async () => {
    const f = fakeRpc();
    f.handle(async (method) => method === "session/new" ? { sessionId: "native" } : new Promise(() => {}));
    const rt = createAcpRuntime(context, f.rpc, "vibe", undefined, "Vibe", {
        nativeToolName: (update) => {
            const meta = update._meta as { tool_name?: string } | undefined;
            return meta?.tool_name === "mcp_polyth_agent_tools.polyth_todo" ? "mcp__polyth-agent-tools__polyth_todo" : meta?.tool_name;
        },
    });
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const admission = rt.startTurnOperation!({ sessionId: "canonical", text: "hi" }, "turn");
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "tool_call", toolCallId: "m", title: "mcp_polyth_agent_tools.polyth_todo", kind: "other", status: "in_progress", rawInput: { items: [] }, _meta: { tool_name: "mcp_polyth_agent_tools.polyth_todo" } } });
    await admission;
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "tool_call", toolCallId: "b", title: "bash: ls", kind: "execute", status: "in_progress", rawInput: { command: "ls" }, _meta: { tool_name: "bash" } } });
    // A later update without `_meta` keeps the name already learned.
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "tool_call_update", toolCallId: "m", kind: "other", status: "completed", content: [] } });
    await settle();
    const started = events.filter((event) => event.type === "tool/started") as Array<Extract<RuntimeEvent, { type: "tool/started" }>>;
    assert.deepEqual([...new Set(started.map((event) => event.tool))], ["mcp__polyth-agent-tools__polyth_todo", "execute"]);
    const result = events.find((event) => event.type === "tool/result") as Extract<RuntimeEvent, { type: "tool/result" }>;
    assert.equal(result.tool, "mcp__polyth-agent-tools__polyth_todo");
    await rt.dispose();
});

test("a `thinking` category is read as the thought-level select", () => {
    const config = parseSessionConfig({
        configOptions: [
            modelSelect,
            { id: "thinking", name: "Thinking", category: "thinking", type: "select", currentValue: "off", options: [{ value: "off", name: "Off" }, { value: "high", name: "High" }] },
        ],
    });
    assert.equal(config.thoughtLevel?.id, "thinking");
    assert.deepEqual(config.thoughtLevel?.options.map((option) => option.value), ["off", "high"]);
    // Another custom category is still not guessed at.
    assert.equal(parseSessionConfig({ configOptions: [{ ...modelSelect, id: "x", category: "style" }] }).thoughtLevel, undefined);
});

test("an agent whose titles are not titles publishes none and reports no native title", async () => {
    const f = fakeRpc();
    f.handle(async (method) => method === "session/new" ? { sessionId: "native" } : new Promise(() => {}));
    const rt = createAcpRuntime(context, f.rpc, "vibe", undefined, "Vibe", { nativeTitles: false });
    const events: RuntimeEvent[] = [];
    rt.onEvent((_sid, event) => events.push(event));
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "session_info_update", title: "say hi <polyth-people> Speaking now" } });
    await settle();
    assert.equal(events.some((event) => event.type === "session/title-generated"), false);
    assert.equal((await rt.capabilities()).title, "unsupported");
    const native = createAcpRuntime(context, fakeRpc().rpc, "x");
    assert.equal((await native.capabilities()).title, "native");
    await rt.dispose();
});
