// Cursor rides the generic ACP transport; the only Cursor-specific pieces are
// its profile metadata and a version/auth gate on asking the CLI for models.
// This VM's `agent` is unauthenticated, so every protocol exchange here is
// faked — the tests pin the contract, not the local sign-in state.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { HarnessProbe } from "@polyth/contracts";
import { acpModelDescriptors, parseSessionConfig } from "@polyth/backend-acp";
import registerCursorPackage from "../src/serverEntry.ts";
import { createHarnessRegistry } from "@polyth/harness-runtime";
import { serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { discoverAcpModels, invalidateAcpDiscovery } from "../../backend-acp/src/discovery.ts";
import { createAcpRuntime } from "../../backend-acp/src/index.ts";
import { fakeRpc } from "../../harness-runtime/test/rpcPeer.ts";
import { cursorModelDiscoverySupport } from "../src/version.ts";

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

test("CalVer is cache identity, never guessed as a capability boundary", () => {
    assert.equal(cursorModelDiscoverySupport(probe({ authenticated: true, version: "2026.08.01" })).ok, true);
    assert.equal(cursorModelDiscoverySupport(probe({ authenticated: true, version: "2026.09.02" })).ok, true);
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
        version: "2026.09.02",
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
        version: "2026.09.02",
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

test("Cursor discovery uses the direct catalog and preserves per-model reasoning", { skip: process.platform !== "linux" }, async (t) => {
    invalidateAcpDiscovery();
    const dir = await mkdtemp(join(tmpdir(), "polyth-cursor-discovery-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const log = join(dir, "calls.log");
    const agent = join(dir, "agent");
    await writeFile(agent, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ startup: args }) + "\\n");
if (args[0] === "--version") { process.stdout.write("2026.09.02\\n"); process.exit(0); }
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: request.method, params: request.params }) + "\\n");
    let result = {};
    if (request.method === "initialize") result = { protocolVersion: 1 };
    if (request.method === "cursor/list_available_models") result = { models: [
      { value: "fast", name: "Fast", configOptions: [] },
      { value: "deep", name: "Deep", configOptions: [{ id: "reasoning", category: "thought_level", type: "select", currentValue: "medium", options: [
        { value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" },
      ] }] },
    ] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${dir}:${previousPath ?? ""}`;
    t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });

    const registry = createHarnessRegistry();
    const host = {
        services: { require<T>(key: { id: string }): T {
            assert.equal(key.id, serverServiceKey("harnesses").id);
            return registry as T;
        } },
    } as unknown as ServerPackageHost;
    const pkg = registerCursorPackage(host);
    pkg.onEnable?.();
    t.after(() => pkg.onDisable?.());
    const provider = registry.get("cursor");
    assert.ok(provider);
    const discoveryContext = { spaceId: "s", projectId: "p", cwd: dir };
    const first = await provider.discover!(discoveryContext);
    assert.equal(first.state, "ready", first.state === "degraded" ? first.message : undefined);
    assert.deepEqual(first.state === "ready" ? first.catalog.models.map((model) => model.modelID) : [], [
        "fast", "deep",
    ]);
    assert.deepEqual(first.state === "ready" ? first.catalog.models.map((model) => model.variants) : [], [
        undefined, ["low", "medium", "high"],
    ]);
    const before = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    await provider.discover!(discoveryContext);
    const after = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(after.filter((entry) => entry.method).map((entry) => entry.method), ["initialize", "cursor/list_available_models"]);
    assert.equal(after.find((entry) => entry.method === "initialize")?.params?.clientCapabilities?._meta?.parameterizedModelPicker, true);
    assert.equal(after.filter((entry) => entry.startup?.[0] === "acp").length, 1);
    assert.equal(after.length - before.length, 1); // only the second probe's --version startup is new
    await registry.snapshots(discoveryContext, { harnessId: "cursor", force: true });
    await registry.snapshots(discoveryContext, { harnessId: "cursor", detail: true });
    const refreshed = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(refreshed.filter((entry) => entry.startup?.[0] === "acp").length, 2,
        "explicit refresh bypasses the provider's internal discovery cache");
    assert.deepEqual(refreshed.filter((entry) => entry.method).map((entry) => entry.method),
        ["initialize", "cursor/list_available_models", "initialize", "cursor/list_available_models"]);
});
