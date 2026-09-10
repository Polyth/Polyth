// ACP publishes model controls per session, in two protocol generations, and
// only ever what the agent actually advertised. These tests pin both
// generations, the selection lifecycle, and the refusals — an agent that
// exposes nothing must produce an empty catalog, never an invented one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, symlink, truncate, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createAcpRuntime, acpModelDescriptors, modelControl, parseSessionConfig } from "../src/index.ts";
import { discoverAcpModels, invalidateAcpDiscovery } from "../src/discovery.ts";
import { fakeRpc } from "../../harness-runtime/test/rpcPeer.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };

/** `session/new` result in the current `configOptions` generation. */
const configOptionsSession = {
    sessionId: "native",
    configOptions: [
        {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "fast-1",
            options: [
                { value: "fast-1", name: "Fast 1" },
                { value: "deep-2", name: "Deep 2", description: "slower" },
            ],
        },
        {
            id: "thinking",
            name: "Thinking",
            category: "thought_level",
            type: "select",
            currentValue: "medium",
            options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }],
        },
        { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "ask", name: "Ask" }] },
    ],
};

/** `session/new` result in the older, still-shipped `models` generation. */
const legacySession = {
    sessionId: "native",
    models: {
        currentModelId: "legacy-a",
        availableModels: [
            { modelId: "legacy-a", name: "Legacy A" },
            { modelId: "legacy-b", name: "Legacy B" },
        ],
    },
};

const startedRuntime = async (sessionResult: unknown, capabilities?: Parameters<typeof createAcpRuntime>[3]) => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "session/new") return sessionResult;
        if (method === "session/prompt") return { stopReason: "end_turn" };
        return {};
    });
    const rt = createAcpRuntime(context, f.rpc, "acp", capabilities, "Test Agent");
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    return { f, rt };
};

const paramsOf = (f: ReturnType<typeof fakeRpc>, method: string) =>
    f.calls.filter((call) => call.method === method).map((call) => call.params);

const sessionConfigAt = (model: string, thought: string) => ({
    ...configOptionsSession,
    configOptions: configOptionsSession.configOptions.map((option) => option.id === "model"
        ? { ...option, currentValue: model }
        : option.id === "thinking" ? { ...option, currentValue: thought } : option),
});

test("a configOptions model select becomes the session catalog", async () => {
    const { rt } = await startedRuntime(configOptionsSession);
    const models = await rt.models!();
    assert.deepEqual(models.map((model) => model.modelID), ["fast-1", "deep-2"]);
    assert.equal(models[0]!.name, "Fast 1");
    // ACP models carry no provider identity of their own.
    assert.equal(models[0]!.providerID, "acp");
});

test("a thought_level select exposes variants without treating mutable current state as a default", async () => {
    const { rt } = await startedRuntime(configOptionsSession);
    const [model] = await rt.models!();
    assert.deepEqual(model!.variants, ["low", "medium", "high"]);
    assert.equal(model!.defaultVariant, undefined);
});

test("cold discovery probes dependent thinking controls per model", async () => {
    invalidateAcpDiscovery();
    const result = await discoverAcpModels({
        harnessId: "acp",
        version: "dependent",
        authFingerprint: "true",
        cacheIdentity: "project-a",
        probe: {
            async open() {
                return {
                    result: configOptionsSession,
                    async setConfigOption(_id: string, value: string) {
                        return value === "deep-2"
                            ? { ...sessionConfigAt(value, "high"), configOptions: sessionConfigAt(value, "high").configOptions.filter((option) => option.category !== "thought_level") }
                            : sessionConfigAt(value, "medium");
                    },
                    close: async () => {},
                };
            },
        },
    });
    assert.deepEqual(result.state === "ready" ? result.models.map((model) => model.variants) : [], [
        ["low", "medium", "high"],
        undefined,
    ]);
});

test("cold discovery probes models whose thinking levels appear only once selected", async () => {
    invalidateAcpDiscovery();
    // A fresh session that advertises no thought_level proves nothing about the
    // models it is not currently on: this agent adds the control on selection.
    const modelOnlySession = {
        ...configOptionsSession,
        configOptions: configOptionsSession.configOptions.filter((option) => option.category !== "thought_level"),
    };
    const result = await discoverAcpModels({
        harnessId: "acp",
        version: "late-thought-level",
        authFingerprint: "true",
        probe: {
            async open() {
                return {
                    result: modelOnlySession,
                    async setConfigOption(_id: string, value: string) { return sessionConfigAt(value, "medium"); },
                    close: async () => {},
                };
            },
        },
    });
    assert.deepEqual(result.state === "ready" ? result.models.map((model) => model.variants) : [], [
        undefined,
        ["low", "medium", "high"],
    ]);
});

test("the legacy models block becomes the same canonical catalog", async () => {
    const { rt } = await startedRuntime(legacySession);
    assert.deepEqual((await rt.models!()).map((model) => model.modelID), ["legacy-a", "legacy-b"]);
    // No thought_level option means no variants are invented.
    assert.equal((await rt.models!())[0]!.variants, undefined);
});

test("an agent that advertises no model control reports an empty catalog", async () => {
    const { rt } = await startedRuntime({ sessionId: "native" });
    assert.deepEqual(await rt.models!(), []);
    const rejection = await rt.startTurnOperation!(
        { sessionId: "canonical", text: "task", model: { providerID: "acp", modelID: "whatever" } },
        "submit",
    );
    assert.equal(rejection.kind, "rejected");
    assert.equal(rejection.kind === "rejected" && rejection.code, "unsupported");
    assert.match(rejection.kind === "rejected" ? rejection.message! : "", /does not expose model selection/i);
});

test("a model change is pushed with set_config_option before the prompt", async () => {
    const modelOnlySession = {
        ...configOptionsSession,
        configOptions: configOptionsSession.configOptions.filter((option) => option.category !== "thought_level"),
    };
    const { f, rt } = await startedRuntime(modelOnlySession);
    await rt.startTurnOperation!(
        { sessionId: "canonical", text: "task", model: { providerID: "acp", modelID: "deep-2" } },
        "submit",
    );
    const [set] = paramsOf(f, "session/set_config_option");
    assert.deepEqual(set, { sessionId: "native", configId: "model", value: "deep-2" });
    const order = f.calls.map((call) => call.method);
    assert.ok(order.indexOf("session/set_config_option") < order.indexOf("session/prompt"));
});

test("a variant change is pushed onto the thought_level option", async () => {
    const { f, rt } = await startedRuntime(configOptionsSession);
    await rt.startTurnOperation!(
        { sessionId: "canonical", text: "task", model: { providerID: "acp", modelID: "fast-1", variant: "high" } },
        "submit",
    );
    assert.deepEqual(paramsOf(f, "session/set_config_option"), [
        { sessionId: "native", configId: "thinking", value: "high" },
    ]);
});

test("high to Auto actively restores the native session default", async () => {
    const f = fakeRpc();
    let model = "fast-1";
    let thought = "medium";
    f.handle(async (method, params) => {
        if (method === "session/new") return sessionConfigAt(model, thought);
        if (method === "session/set_config_option") {
            if (params.configId === "model") model = params.value;
            if (params.configId === "thinking") thought = params.value;
            return sessionConfigAt(model, thought);
        }
        return { stopReason: "end_turn" };
    });
    const rt = createAcpRuntime(context, f.rpc, "acp", undefined, "Test Agent");
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "high", model: { providerID: "acp", modelID: model, variant: "high" } }, "high");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "auto", model: { providerID: "acp", modelID: model } }, "auto");
    assert.deepEqual(paramsOf(f, "session/set_config_option").map((call) => [call.configId, call.value]), [
        ["thinking", "high"],
        ["thinking", "medium"],
    ]);
});

test("Auto to high to Auto restores a low native baseline", async () => {
    const f = fakeRpc();
    let thought = "low";
    f.handle(async (method, params) => {
        if (method === "session/new") return sessionConfigAt("fast-1", thought);
        if (method === "session/set_config_option") {
            thought = params.value;
            return sessionConfigAt("fast-1", thought);
        }
        return { stopReason: "end_turn" };
    });
    const rt = createAcpRuntime(context, f.rpc, "acp", undefined, "Test Agent");
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "auto-1", model: { providerID: "acp", modelID: "fast-1" } }, "auto-1");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "high", model: { providerID: "acp", modelID: "fast-1", variant: "high" } }, "high");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "auto-2", model: { providerID: "acp", modelID: "fast-1" } }, "auto-2");
    assert.deepEqual(paramsOf(f, "session/set_config_option").map((call) => call.value), ["high", "low"]);
});

test("an explicit ACP auto option is the reset target but not a visible variant", async () => {
    const explicitAuto = {
        ...configOptionsSession,
        configOptions: configOptionsSession.configOptions.map((option) => option.category === "thought_level"
            ? { ...option, currentValue: "auto", options: [{ value: "auto", name: "Auto" }, { value: "high", name: "High" }] }
            : option),
    };
    const f = fakeRpc();
    let thought = "auto";
    f.handle(async (method, params) => {
        if (method === "session/new") return explicitAuto;
        if (method === "session/set_config_option") {
            thought = params.value;
            return {
                ...explicitAuto,
                configOptions: explicitAuto.configOptions.map((option) => option.category === "thought_level"
                    ? { ...option, currentValue: thought }
                    : option),
            };
        }
        return { stopReason: "end_turn" };
    });
    const rt = createAcpRuntime(context, f.rpc, "acp", undefined, "Test Agent");
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    assert.deepEqual((await rt.models!())[0]!.variants, ["high"]);
    await rt.startTurnOperation!({ sessionId: "canonical", text: "high", model: { providerID: "acp", modelID: "fast-1", variant: "high" } }, "high");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "auto", model: { providerID: "acp", modelID: "fast-1" } }, "auto");
    assert.deepEqual(paramsOf(f, "session/set_config_option").map((call) => call.value), ["high", "auto"]);
});

test("model switch followed by Auto uses the new model's native state", async () => {
    const f = fakeRpc();
    let model = "fast-1";
    let thought = "medium";
    f.handle(async (method, params) => {
        if (method === "session/new") return sessionConfigAt(model, thought);
        if (method === "session/set_config_option") {
            if (params.configId === "model") { model = params.value; thought = "low"; }
            if (params.configId === "thinking") thought = params.value;
            return sessionConfigAt(model, thought);
        }
        return { stopReason: "end_turn" };
    });
    const rt = createAcpRuntime(context, f.rpc, "acp", undefined, "Test Agent");
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "high", model: { providerID: "acp", modelID: "fast-1", variant: "high" } }, "high");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "switch", model: { providerID: "acp", modelID: "deep-2" } }, "switch");
    assert.equal(thought, "low");
    assert.deepEqual(paramsOf(f, "session/set_config_option").at(-1), {
        sessionId: "native", configId: "model", value: "deep-2",
    });
});

test("switching across model-specific thinking support never sends stale effort", async () => {
    const f = fakeRpc();
    let model = "fast-1";
    const state = () => ({
        ...sessionConfigAt(model, "medium"),
        configOptions: sessionConfigAt(model, "medium").configOptions.filter((option) =>
            model === "fast-1" || option.category !== "thought_level"),
    });
    f.handle(async (method, params) => {
        if (method === "session/new") return state();
        if (method === "session/set_config_option") {
            if (params.configId === "model") model = params.value;
            return state();
        }
        return { stopReason: "end_turn" };
    });
    const models = [
        { providerID: "acp", modelID: "fast-1", name: "Fast 1", connected: true, variants: ["low", "medium", "high"] },
        { providerID: "acp", modelID: "deep-2", name: "Deep 2", connected: true },
    ];
    const rt = createAcpRuntime(context, f.rpc, "acp", undefined, "Test Agent", { models });
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "deep", model: { providerID: "acp", modelID: "deep-2" } }, "deep");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "fast", model: { providerID: "acp", modelID: "fast-1", variant: "high" } }, "fast");
    assert.deepEqual(paramsOf(f, "session/set_config_option").map((call) => [call.configId, call.value]), [
        ["model", "deep-2"],
        ["model", "fast-1"],
        ["thinking", "high"],
    ]);
});

test("selecting what the session already runs issues no config call at all", async () => {
    const { f, rt } = await startedRuntime(configOptionsSession);
    await rt.startTurnOperation!(
        { sessionId: "canonical", text: "task", model: { providerID: "acp", modelID: "fast-1", variant: "medium" } },
        "submit",
    );
    assert.deepEqual(paramsOf(f, "session/set_config_option"), []);
});

test("the legacy generation is driven with set_model instead", async () => {
    const { f, rt } = await startedRuntime(legacySession);
    await rt.startTurnOperation!(
        { sessionId: "canonical", text: "task", model: { providerID: "acp", modelID: "legacy-b" } },
        "submit",
    );
    assert.deepEqual(paramsOf(f, "session/set_model"), [{ sessionId: "native", modelId: "legacy-b" }]);
    assert.deepEqual(paramsOf(f, "session/set_config_option"), []);
    // The selection is now current, so a second turn re-asserts nothing.
    await rt.startTurnOperation!(
        { sessionId: "canonical", text: "again", model: { providerID: "acp", modelID: "legacy-b" } },
        "submit-2",
    );
    assert.equal(paramsOf(f, "session/set_model").length, 1);
});

test("a variant the agent never advertised is rejected before any RPC", async () => {
    const { f, rt } = await startedRuntime(configOptionsSession);
    const rejection = await rt.startTurnOperation!(
        { sessionId: "canonical", text: "task", model: { providerID: "acp", modelID: "fast-1", variant: "ultra" } },
        "submit",
    );
    assert.equal(rejection.kind === "rejected" && rejection.code, "invalid-variant");
    assert.deepEqual(paramsOf(f, "session/prompt"), []);
});

test("a model the agent does not have is rejected as an unknown model", async () => {
    const { rt } = await startedRuntime(configOptionsSession);
    const rejection = await rt.startTurnOperation!(
        { sessionId: "canonical", text: "task", model: { providerID: "acp", modelID: "not-a-model" } },
        "submit",
    );
    assert.equal(rejection.kind === "rejected" && rejection.code, "invalid-model");
});

test("an agent that routes no model method is recorded as having none, not retried", async () => {
    const f = fakeRpc();
    let setModelCalls = 0;
    f.handle(async (method) => {
        if (method === "session/new") return legacySession;
        if (method === "session/set_model") {
            setModelCalls++;
            throw Object.assign(new Error("Method not found"), { rpcCode: -32601 });
        }
        return { stopReason: "end_turn" };
    });
    const rt = createAcpRuntime(context, f.rpc, "acp", undefined, "Test Agent");
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const first = await rt.startTurnOperation!(
        { sessionId: "canonical", text: "task", model: { providerID: "acp", modelID: "legacy-b" } },
        "submit",
    );
    assert.equal(first.kind === "rejected" && first.code, "unsupported");
    // The catalog stops claiming a control the agent demonstrably lacks.
    assert.deepEqual(await rt.models!(), []);
    const second = await rt.startTurnOperation!(
        { sessionId: "canonical", text: "task", model: { providerID: "acp", modelID: "legacy-b" } },
        "submit-2",
    );
    assert.equal(second.kind === "rejected" && second.code, "unsupported");
    assert.equal(setModelCalls, 1);
});

test("a config_option_update notification keeps the session's selection current", async () => {
    const { f, rt } = await startedRuntime(configOptionsSession);
    f.emit("session/update", {
        sessionId: "native",
        update: {
            sessionUpdate: "config_option_update",
            configOptions: [{
                id: "model",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: "deep-2",
                options: [{ value: "fast-1", name: "Fast 1" }, { value: "deep-2", name: "Deep 2" }],
            }],
        },
    });
    await rt.startTurnOperation!(
        { sessionId: "canonical", text: "task", model: { providerID: "acp", modelID: "deep-2" } },
        "submit",
    );
    // The agent already moved itself there, so nothing is re-asserted.
    assert.deepEqual(paramsOf(f, "session/set_config_option"), []);
});

test("a native thought-level update becomes current without becoming a static default", async () => {
    const { f, rt } = await startedRuntime(configOptionsSession);
    f.emit("session/update", {
        sessionId: "native",
        update: { sessionUpdate: "config_option_update", ...sessionConfigAt("fast-1", "high") },
    });
    await rt.startTurnOperation!({
        sessionId: "canonical", text: "task",
        model: { providerID: "acp", modelID: "fast-1", variant: "high" },
    }, "submit");
    assert.deepEqual(paramsOf(f, "session/set_config_option"), []);
    assert.equal((await rt.models!())[0]!.defaultVariant, undefined);
});

test("category-less exact config ids are recognized without label guessing", () => {
    const config = parseSessionConfig({
        configOptions: [
            { id: "model", name: "Anything", type: "select", currentValue: "m", options: [{ value: "m", name: "M" }] },
            { id: "thought_level", name: "Anything", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }] },
            { id: "engine", name: "Model", type: "select", currentValue: "x", options: [{ value: "x", name: "X" }] },
        ],
    });
    assert.equal(config.model?.id, "model");
    assert.equal(config.thoughtLevel?.id, "thought_level");
    assert.deepEqual(acpModelDescriptors(config, "acp").map((model) => model.modelID), ["m"]);
});

test("a current_model_update notification tracks the legacy selection", async () => {
    const { f, rt } = await startedRuntime(legacySession);
    f.emit("session/update", { sessionId: "native", update: { sessionUpdate: "current_model_update", modelId: "legacy-b" } });
    await rt.startTurnOperation!(
        { sessionId: "canonical", text: "task", model: { providerID: "acp", modelID: "legacy-b" } },
        "submit",
    );
    assert.deepEqual(paramsOf(f, "session/set_model"), []);
});

test("a reloaded session has the conversation's selection asserted again", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "session/new" || method === "session/load") return legacySession;
        if (method === "session/prompt") return { stopReason: "end_turn" };
        return {};
    });
    const rt = createAcpRuntime(context, f.rpc, "acp", { loadSession: true }, "Test Agent");
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    await rt.startTurnOperation!(
        { sessionId: "canonical", text: "task", model: { providerID: "acp", modelID: "legacy-b" } },
        "submit",
    );
    assert.equal(paramsOf(f, "session/set_model").length, 1);
    // A reload comes back on the agent's own default, so the conversation's
    // choice has to be asserted again against the reloaded session.
    await rt.ensureSession!({ sessionId: "canonical", projectId: "p", backendSessionId: "reloaded", cwd: "/tmp" });
    assert.deepEqual(paramsOf(f, "session/set_model"), [
        { sessionId: "native", modelId: "legacy-b" },
        { sessionId: "reloaded", modelId: "legacy-b" },
    ]);
});

test("resume followed by Auto restores the remembered native default", async () => {
    const f = fakeRpc();
    let thought = "medium";
    f.handle(async (method, params) => {
        if (method === "session/new") return sessionConfigAt("fast-1", thought);
        if (method === "session/load") return sessionConfigAt("fast-1", "high");
        if (method === "session/set_config_option") {
            thought = params.value;
            return sessionConfigAt("fast-1", thought);
        }
        return { stopReason: "end_turn" };
    });
    const rt = createAcpRuntime(context, f.rpc, "acp", { loadSession: true }, "Test Agent");
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "high", model: { providerID: "acp", modelID: "fast-1", variant: "high" } }, "high");
    await rt.startTurnOperation!({ sessionId: "canonical", text: "auto", model: { providerID: "acp", modelID: "fast-1" } }, "auto");
    await rt.ensureSession!({ sessionId: "canonical", projectId: "p", backendSessionId: "reloaded", cwd: "/tmp" });
    assert.deepEqual(paramsOf(f, "session/set_config_option").at(-1), {
        sessionId: "reloaded", configId: "thinking", value: "medium",
    });
});

test("Auto after a cold resume rejects when ACP exposes no truthful reset target", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "session/load") return sessionConfigAt("fast-1", "high");
        return { stopReason: "end_turn" };
    });
    const rt = createAcpRuntime(context, f.rpc, "acp", { loadSession: true }, "Test Agent");
    await rt.ensureSession!({ sessionId: "canonical", projectId: "p", backendSessionId: "reloaded", cwd: "/tmp" });
    const outcome = await rt.startTurnOperation!({
        sessionId: "canonical",
        text: "auto",
        model: { providerID: "acp", modelID: "fast-1" },
    }, "auto");
    assert.equal(outcome.kind === "rejected" && outcome.code, "unsupported");
    assert.match(outcome.kind === "rejected" ? outcome.message! : "", /native default thinking level/i);
    assert.deepEqual(paramsOf(f, "session/prompt"), []);
});

test("embedded context carries a text file as an ACP resource block", async () => {
    const path = `/tmp/acp-embedded-${process.pid}.txt`;
    await writeFile(path, "hello from the file");
    try {
        const { f, rt } = await startedRuntime(configOptionsSession, {
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
        });
        await rt.startTurnOperation!({
            sessionId: "canonical",
            text: "look",
            attachments: [{ kind: "file", name: "notes.txt", path, mime: "text/plain" }],
        }, "submit");
        const [prompt] = paramsOf(f, "session/prompt");
        const resource = prompt.prompt.find((block: { type: string }) => block.type === "resource");
        assert.equal(resource.resource.text, "hello from the file");
        assert.match(resource.resource.uri, /^file:\/\/.*acp-embedded/);
        assert.equal(resource.resource.mimeType, "text/plain");
    } finally {
        await rm(path, { force: true });
    }
});

test("embedded context rejects non-UTF-8 and NUL content", async () => {
    for (const [suffix, data] of [["invalid", Buffer.from([0xff])], ["nul", Buffer.from("a\0b")]] as const) {
        const path = `/tmp/acp-${suffix}-${process.pid}.txt`;
        await writeFile(path, data);
        try {
            const { rt } = await startedRuntime(configOptionsSession, { promptCapabilities: { embeddedContext: true } });
            const outcome = await rt.startTurnOperation!({
                sessionId: "canonical", text: "look",
                attachments: [{ kind: "file", name: "bad.txt", path, mime: "text/plain" }],
            }, `submit-${suffix}`);
            assert.equal(outcome.kind === "rejected" && outcome.code, "invalid-attachment");
        } finally {
            await rm(path, { force: true });
        }
    }
});

test("embedded context applies the canonical 64 KiB text ceiling", async () => {
    const path = `/tmp/acp-large-${process.pid}.txt`;
    await writeFile(path, "x".repeat(70 * 1024));
    try {
        const { f, rt } = await startedRuntime(configOptionsSession, { promptCapabilities: { embeddedContext: true } });
        await rt.startTurnOperation!({
            sessionId: "canonical", text: "look",
            attachments: [{ kind: "file", name: "large.txt", path, mime: "text/plain" }],
        }, "submit-large");
        const [prompt] = paramsOf(f, "session/prompt");
        const text = prompt.prompt.find((block: { type: string }) => block.type === "resource").resource.text as string;
        assert.equal(text.startsWith("x".repeat(64 * 1024)), true);
        assert.match(text, /\[truncated 6144 bytes\]$/);
    } finally {
        await rm(path, { force: true });
    }
});

test("embedded context honors a late line range with bounded canonical text", async () => {
    const path = `/tmp/acp-range-${process.pid}.txt`;
    await writeFile(path, `${Array.from({ length: 20_000 }, (_, index) => `line-${index + 1}`).join("\n")}\n`);
    try {
        const { f, rt } = await startedRuntime(configOptionsSession, { promptCapabilities: { embeddedContext: true } });
        await rt.startTurnOperation!({
            sessionId: "canonical", text: "look",
            attachments: [{ kind: "range", name: "late.txt", path, mime: "text/plain", range: [20_000, 20_000] }],
        }, "submit-range");
        const [prompt] = paramsOf(f, "session/prompt");
        assert.equal(prompt.prompt.find((block: { type: string }) => block.type === "resource").resource.text, "line-20000");
    } finally {
        await rm(path, { force: true });
    }
});

test("embedded context rejects oversized files and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-safe-root-"));
    const outside = join(tmpdir(), `acp-outside-${process.pid}.txt`);
    const oversized = join(root, "oversized.txt");
    await writeFile(outside, "outside");
    await writeFile(oversized, "x");
    await truncate(oversized, 20 * 1024 * 1024 + 1);
    await symlink(outside, join(root, "escape.txt"));
    try {
        const f = fakeRpc();
        f.handle(async (method) => method === "session/new" ? configOptionsSession : { stopReason: "end_turn" });
        const rt = createAcpRuntime({ ...context, cwd: root }, f.rpc, "acp", {
            promptCapabilities: { embeddedContext: true },
        }, "Test Agent");
        await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: root }, "create");
        for (const path of ["oversized.txt", "escape.txt"]) {
            const outcome = await rt.startTurnOperation!({
                sessionId: "canonical", text: "look",
                attachments: [{ kind: "file", name: path, path, mime: "text/plain" }],
            }, `submit-${path}`);
            assert.equal(outcome.kind === "rejected" && outcome.code, "invalid-attachment");
        }
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { force: true });
    }
});

test("without embedded context the adapter emits no file block — the server projected it", async () => {
    const { f, rt } = await startedRuntime(configOptionsSession, {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
    });
    const outcome = await rt.startTurnOperation!({
        sessionId: "canonical",
        text: "look\n\nnotes.txt\n```\nprojected by the server\n```",
    }, "submit");
    assert.equal(outcome.kind, "confirmed");
    const [prompt] = paramsOf(f, "session/prompt");
    assert.deepEqual(prompt.prompt.map((block: { type: string }) => block.type), ["text"]);
    assert.match(prompt.prompt[0].text, /projected by the server/);
});

test("a URL travels as a resource_link, which baseline ACP requires", async () => {
    const { f, rt } = await startedRuntime(configOptionsSession);
    await rt.startTurnOperation!({
        sessionId: "canonical",
        text: "read this",
        attachments: [{ kind: "url", name: "Docs", url: "https://example.com/doc" }],
    }, "submit");
    const [prompt] = paramsOf(f, "session/prompt");
    const link = prompt.prompt.find((block: { type: string }) => block.type === "resource_link");
    assert.equal(link.uri, "https://example.com/doc");
    assert.equal(link.name, "Docs");
});

test("a PDF is refused by the engine's display name, not adapter prose", async () => {
    const { rt } = await startedRuntime(configOptionsSession, {
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
    });
    const rejection = await rt.startTurnOperation!({
        sessionId: "canonical",
        text: "read",
        attachments: [{ kind: "file", name: "paper.pdf", path: "/tmp/paper.pdf", mime: "application/pdf" }],
    }, "submit");
    assert.equal(rejection.kind === "rejected" && rejection.code, "unsupported");
    assert.match(rejection.kind === "rejected" ? rejection.message! : "", /Test Agent/);
    assert.doesNotMatch(rejection.kind === "rejected" ? rejection.message! : "", /not implemented/i);
});

test("cold discovery reads the catalog from a throwaway session and caches it", async () => {
    invalidateAcpDiscovery();
    let opens = 0;
    let closes = 0;
    const probe = {
        async open() {
            opens++;
            return { result: configOptionsSession, close: async () => { closes++; } };
        },
    };
    const options = { harnessId: "acp", version: "1.0.0", authFingerprint: "true", probe };
    const first = await discoverAcpModels(options);
    assert.equal(first.state, "ready");
    assert.deepEqual(first.state === "ready" ? first.models.map((model) => model.modelID) : [], ["fast-1", "deep-2"]);
    // The throwaway process is always terminated.
    assert.equal(closes, 1);
    await discoverAcpModels(options);
    assert.equal(opens, 1, "a cached catalog must not spawn the agent again");
});

test("concurrent cold discovery spawns the agent exactly once", async () => {
    invalidateAcpDiscovery();
    let opens = 0;
    const probe = {
        async open() {
            opens++;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { result: legacySession, close: async () => {} };
        },
    };
    const options = { harnessId: "acp", version: "2.0.0", authFingerprint: "true", probe };
    const [a, b] = await Promise.all([discoverAcpModels(options), discoverAcpModels(options)]);
    assert.equal(opens, 1);
    assert.deepEqual(a, b);
});

test("an agent needing a sign-in reports that cause instead of an empty list", async () => {
    invalidateAcpDiscovery();
    const options = {
        harnessId: "acp",
        version: "3.0.0",
        authFingerprint: "false",
        probe: {
            async open(): Promise<never> {
                throw Object.assign(new Error("Authentication required"), { rpcCode: -32000 });
            },
        },
    };
    const result = await discoverAcpModels(options);
    assert.equal(result.state, "auth-required");
    assert.match(result.state === "auth-required" ? result.reason : "", /Authentication required/i);
});

test("a version bump invalidates the cached catalog", async () => {
    invalidateAcpDiscovery();
    let opens = 0;
    const probe = { async open() { opens++; return { result: legacySession, close: async () => {} }; } };
    await discoverAcpModels({ harnessId: "acp", version: "4.0.0", authFingerprint: "true", probe });
    await discoverAcpModels({ harnessId: "acp", version: "4.0.1", authFingerprint: "true", probe });
    assert.equal(opens, 2);
});

test("cold catalogs are isolated by project/runtime identity", async () => {
    invalidateAcpDiscovery();
    let opens = 0;
    const probe = { async open() { opens++; return { result: legacySession, close: async () => {} }; } };
    const shared = { harnessId: "acp", version: "same", authFingerprint: "true", probe };
    await discoverAcpModels({ ...shared, cacheIdentity: "project-a" });
    await discoverAcpModels({ ...shared, cacheIdentity: "project-b" });
    assert.equal(opens, 2);
});

test("a failed start is degraded with its cause, and never cached as empty", async () => {
    invalidateAcpDiscovery();
    const probe = { async open(): Promise<never> { throw new Error("spawn agent ENOENT"); } };
    const result = await discoverAcpModels({ harnessId: "acp", version: "5.0.0", authFingerprint: "true", probe });
    assert.equal(result.state, "degraded");
    assert.match(result.state === "degraded" ? result.reason : "", /ENOENT/);
});

test("cold discovery is bounded and late probes are closed", async () => {
    invalidateAcpDiscovery();
    let closes = 0;
    const result = await discoverAcpModels({
        harnessId: "acp", version: "slow", authFingerprint: "true", timeoutMs: 5,
        probe: { async open() {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { result: configOptionsSession, close: async () => { closes++; } };
        } },
    });
    assert.equal(result.state, "degraded");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closes, 1);
});

test("model capability probing is bounded and closes a late session", async () => {
    invalidateAcpDiscovery();
    let closes = 0;
    const result = await discoverAcpModels({
        harnessId: "acp",
        version: "slow-options",
        authFingerprint: "true",
        timeoutMs: 5,
        probe: {
            async open() {
                return {
                    result: configOptionsSession,
                    async setConfigOption() {
                        await new Promise((resolve) => setTimeout(resolve, 20));
                        return configOptionsSession;
                    },
                    close: async () => { closes++; },
                };
            },
        },
    });
    assert.equal(result.state, "degraded");
    assert.equal(closes, 1);
});

test("session config parsing ignores what it does not understand", () => {
    const config = parseSessionConfig({
        sessionId: "native",
        configOptions: [
            { id: "flag", name: "Flag", category: "model", type: "boolean", value: true },
            { id: "empty", name: "Empty", category: "model", type: "select", options: [] },
            { id: "future", name: "Future", category: "something_new", type: "select", options: [{ value: "x", name: "X" }] },
        ],
        unknownFutureField: { nested: true },
    });
    assert.equal(modelControl(config).kind, "none");
    assert.deepEqual(acpModelDescriptors(config, "acp"), []);
});

test("the generic ACP adapter names no vendor", async () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    const files = (await readdir(src)).filter((name) => name.endsWith(".ts"));
    assert.ok(files.length > 0);
    for (const name of files) {
        const body = await readFile(join(src, name), "utf8");
        assert.doesNotMatch(body, /cursor/i, `${name} must stay provider-neutral`);
    }
});
