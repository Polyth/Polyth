// Cursor rides the generic ACP transport; the only Cursor-specific pieces are
// its profile metadata and a version/auth gate on asking the CLI for models.
// This VM's `agent` is unauthenticated, so every protocol exchange here is
// faked — the tests pin the contract, not the local sign-in state.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { HarnessProbe } from "@polyth/contracts";
import { acpModelDescriptors, parseSessionConfig } from "@polyth/backend-acp";
import { discoverAcpModels, invalidateAcpDiscovery } from "../../backend-acp/src/discovery.ts";
import { createAcpRuntime } from "../../backend-acp/src/index.ts";
import { fakeRpc } from "../../harness-runtime/test/rpcPeer.ts";
import { CURSOR_MODEL_API_MIN_VERSION, cursorModelDiscoverySupport } from "../src/version.ts";

const probe = (overrides: Partial<HarnessProbe>): HarnessProbe => ({
    harnessId: "cursor",
    installed: true,
    authenticated: "unknown",
    healthy: true,
    ...overrides,
});

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };

/** What an authenticated Cursor build returns today: the legacy model block. */
const legacySession = {
    sessionId: "native",
    models: {
        currentModelId: "auto",
        availableModels: [
            { modelId: "auto", name: "Auto" },
            { modelId: "claude-4.5-sonnet", name: "Claude 4.5 Sonnet" },
        ],
    },
};

/** The newer form, in case a later build switches to config options. */
const configOptionsSession = {
    sessionId: "native",
    configOptions: [{
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "auto",
        options: [{ value: "auto", name: "Auto" }, { value: "gpt-6", name: "GPT-6" }],
    }],
};

test("an unsigned-in CLI names the sign-in as the cause, not an empty catalog", () => {
    const gate = cursorModelDiscoverySupport(probe({ authenticated: false }));
    assert.equal(gate.ok, false);
    assert.match(gate.ok === false ? gate.reason : "", /signed in|agent login/i);
});

test("a CLI older than the ACP model API says so, and names the version needed", () => {
    const gate = cursorModelDiscoverySupport(probe({ authenticated: true, version: "2026.08.01" }));
    assert.equal(gate.ok, false);
    assert.ok((gate.ok === false ? gate.reason : "").includes(CURSOR_MODEL_API_MIN_VERSION));
});

test("the first verified generation and anything newer are asked for models", () => {
    assert.equal(cursorModelDiscoverySupport(probe({ authenticated: true, version: CURSOR_MODEL_API_MIN_VERSION })).ok, true);
    assert.equal(cursorModelDiscoverySupport(probe({ authenticated: true, version: "2026.10.14" })).ok, true);
    assert.equal(cursorModelDiscoverySupport(probe({ authenticated: true, version: "2027.01.01" })).ok, true);
});

test("an unreadable version is not evidence of absence — the agent is asked", () => {
    assert.equal(cursorModelDiscoverySupport(probe({ authenticated: "unknown", version: "dev" })).ok, true);
    assert.equal(cursorModelDiscoverySupport(probe({ authenticated: "unknown" })).ok, true);
});

test("Cursor's legacy model block becomes a harness-qualified catalog", async () => {
    invalidateAcpDiscovery();
    const result = await discoverAcpModels({
        harnessId: "cursor",
        version: CURSOR_MODEL_API_MIN_VERSION,
        authFingerprint: "true",
        probe: { async open() { return { result: legacySession, close: async () => {} }; } },
    });
    assert.equal(result.state, "ready");
    const models = result.state === "ready" ? result.models : [];
    assert.deepEqual(models.map((model) => model.modelID), ["auto", "claude-4.5-sonnet"]);
    // Every row belongs to Cursor: no global or OpenCode model can leak in.
    assert.deepEqual([...new Set(models.map((model) => model.providerID))], ["cursor"]);
    // Cursor advertises no thought_level option, so no variants are invented.
    assert.deepEqual(models.filter((model) => model.variants?.length), []);
});

test("the newer config-options form yields the same canonical catalog", async () => {
    invalidateAcpDiscovery();
    const result = await discoverAcpModels({
        harnessId: "cursor",
        version: "2026.12.01",
        authFingerprint: "true",
        probe: { async open() { return { result: configOptionsSession, close: async () => {} }; } },
    });
    assert.deepEqual(
        result.state === "ready" ? result.models.map((model) => `${model.providerID}/${model.modelID}`) : [],
        ["cursor/auto", "cursor/gpt-6"],
    );
});

test("a build that advertises neither form reports no models rather than guessing", async () => {
    invalidateAcpDiscovery();
    const result = await discoverAcpModels({
        harnessId: "cursor",
        version: "2026.09.03",
        authFingerprint: "true",
        probe: { async open() { return { result: { sessionId: "native" }, close: async () => {} }; } },
    });
    assert.deepEqual(result.state === "ready" ? result.models : ["unexpected"], []);
});

test("an unauthenticated session/new is reported as needing a sign-in", async () => {
    invalidateAcpDiscovery();
    const result = await discoverAcpModels({
        harnessId: "cursor",
        version: CURSOR_MODEL_API_MIN_VERSION,
        authFingerprint: "false",
        probe: {
            async open(): Promise<never> {
                // Verified live on this VM: -32000 "Authentication required".
                throw Object.assign(new Error("Authentication required"), { rpcCode: -32000 });
            },
        },
    });
    assert.equal(result.state, "auth-required");
});

test("selecting a Cursor model drives set_model on the live session before the prompt", async () => {
    const f = fakeRpc();
    f.handle(async (method) => {
        if (method === "session/new") return legacySession;
        if (method === "session/prompt") return { stopReason: "end_turn" };
        return {};
    });
    const rt = createAcpRuntime(context, f.rpc, "cursor", { promptCapabilities: { image: true } }, "Cursor");
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    assert.deepEqual((await rt.models!()).map((model) => model.modelID), ["auto", "claude-4.5-sonnet"]);
    const outcome = await rt.startTurnOperation!({
        sessionId: "canonical",
        text: "task",
        model: { providerID: "cursor", modelID: "claude-4.5-sonnet" },
    }, "submit");
    assert.equal(outcome.kind, "confirmed");
    const methods = f.calls.map((call) => call.method);
    assert.ok(methods.indexOf("session/set_model") < methods.indexOf("session/prompt"));
    assert.deepEqual(
        f.calls.filter((call) => call.method === "session/set_model").map((call) => call.params),
        [{ sessionId: "native", modelId: "claude-4.5-sonnet" }],
    );
});

test("Cursor is never given an invented reasoning variant", async () => {
    const f = fakeRpc();
    f.handle(async (method) => (method === "session/new" ? legacySession : { stopReason: "end_turn" }));
    const rt = createAcpRuntime(context, f.rpc, "cursor", {}, "Cursor");
    await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    const rejection = await rt.startTurnOperation!({
        sessionId: "canonical",
        text: "task",
        model: { providerID: "cursor", modelID: "auto", variant: "high" },
    }, "submit");
    assert.equal(rejection.kind === "rejected" && rejection.code, "invalid-variant");
    assert.deepEqual(f.calls.filter((call) => call.method === "session/prompt"), []);
});

test("a model from another harness cannot be routed to Cursor", () => {
    const cursorCatalog = acpModelDescriptors(parseSessionConfig(legacySession), "cursor");
    assert.equal(cursorCatalog.some((model) => model.modelID === "gpt-5-codex"), false);
});

test("the Cursor profile never reaches for the flag that the CLI ignores", async () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    for (const name of (await readdir(src)).filter((file) => file.endsWith(".ts"))) {
        const body = await readFile(join(src, name), "utf8");
        // `agent acp --model x` parses and does nothing; injecting `/model foo`
        // into the prompt would be a fake control.
        assert.doesNotMatch(body, /acp["'\s,\]]+.*--model|\/model /);
    }
});
