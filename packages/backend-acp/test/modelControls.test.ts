// ACP publishes model controls per session, in two protocol generations, and
// only ever what the agent actually advertised. These tests pin both
// generations, the selection lifecycle, and the refusals — an agent that
// exposes nothing must produce an empty catalog, never an invented one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

test("a configOptions model select becomes the session catalog", async () => {
    const { rt } = await startedRuntime(configOptionsSession);
    const models = await rt.models!();
    assert.deepEqual(models.map((model) => model.modelID), ["fast-1", "deep-2"]);
    assert.equal(models[0]!.name, "Fast 1");
    // ACP models carry no provider identity of their own.
    assert.equal(models[0]!.providerID, "acp");
});

test("a thought_level select is the variant control, and its current value the default", async () => {
    const { rt } = await startedRuntime(configOptionsSession);
    const [model] = await rt.models!();
    assert.deepEqual(model!.variants, ["low", "medium", "high"]);
    assert.equal(model!.defaultVariant, "medium");
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
    const { f, rt } = await startedRuntime(configOptionsSession);
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

test("a failed start is degraded with its cause, and never cached as empty", async () => {
    invalidateAcpDiscovery();
    const probe = { async open(): Promise<never> { throw new Error("spawn agent ENOENT"); } };
    const result = await discoverAcpModels({ harnessId: "acp", version: "5.0.0", authFingerprint: "true", probe });
    assert.equal(result.state, "degraded");
    assert.match(result.state === "degraded" ? result.reason : "", /ENOENT/);
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
