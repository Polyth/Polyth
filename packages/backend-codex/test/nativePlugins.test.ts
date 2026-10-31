import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessContext } from "@polyth/contracts";
import { createCodexNativePlugins, type CodexPluginRpc } from "../src/nativePlugins.ts";
import { createCodexProvider } from "../src/serverEntry.ts";

const context: HarnessContext = { spaceId: "space-a", projectId: "project-a", cwd: "/projects/a" };

const INSTALLED = {
    marketplaces: [
        {
            name: "openai-bundled",
            path: "/codex/bundled/marketplace.json",
            plugins: [{
                id: "visualize@openai-bundled", name: "visualize", version: null, localVersion: "1.0.45",
                source: { type: "local", path: "/codex/bundled/plugins/visualize" }, installed: true, enabled: true,
                installPolicy: "AVAILABLE", installPolicySource: null, availability: "AVAILABLE",
                interface: { displayName: "Visualize" },
            }],
        },
        {
            name: "openai-curated-remote",
            path: null,
            plugins: [
                {
                    id: "app-1@openai-curated-remote", name: "app-1", version: "2.0.0", localVersion: null,
                    source: { type: "remote" }, installed: true, enabled: false,
                    installPolicy: "AVAILABLE", installPolicySource: "WORKSPACE_SETTING", availability: "DISABLED_BY_ADMIN",
                    interface: { displayName: "Flixor" },
                },
                {
                    id: "pets@openai-curated-remote", name: "pets", version: "0.1.6", source: { type: "remote" }, installed: true, enabled: true,
                    installPolicy: "INSTALLED_BY_DEFAULT", installPolicySource: "IMPLICIT_CANONICAL_APP", availability: "AVAILABLE",
                },
                { id: "not-installed@openai-curated-remote", name: "not-installed", source: { type: "remote" }, installed: false, enabled: false },
            ],
        },
    ],
    marketplaceLoadErrors: [{ marketplacePath: "/broken.json", message: "invalid marketplace file" }],
};
const DETAIL = {
    plugin: {
        skills: [{ name: "chart" }, { name: "map" }],
        hooks: [{ key: "a", eventName: "PreToolUse" }, { key: "b", eventName: "PreToolUse" }],
        apps: [{ id: "drive", name: "Drive" }],
        mcpServers: ["viz"],
    },
};
const CATALOG = {
    marketplaces: [
        { name: "openai-bundled", path: "/codex/bundled/marketplace.json", plugins: [] },
        { name: "openai-curated-remote", path: null, plugins: [] },
    ],
};

type Call = { method: string; params: unknown; timeoutMs?: number };
const fakeRpc = (respond: (call: Call) => unknown) => {
    const calls: Call[] = [];
    let closed = 0;
    const rpc: CodexPluginRpc = {
        async request<T>(method: string, params: unknown, timeoutMs?: number) {
            const call = { method, params, timeoutMs };
            calls.push(call);
            return await respond(call) as T;
        },
        async close() { closed += 1; },
    };
    return { rpc, calls, closed: () => closed };
};
const rejectedRpc = (message: string) => Object.assign(new Error(`runtime rejected: ${message}`), { code: "runtime-rejected" });
const lostRpc = () => Object.assign(new Error("Runtime response timed out"), { code: "outcome-unknown" });

test("lists installed Codex plugins with components from local marketplaces only", async () => {
    const fake = fakeRpc(({ method }) => method === "plugin/installed" ? INSTALLED : method === "plugin/read" ? DETAIL : undefined);
    const manager = createCodexNativePlugins({ harnessId: "codex", connect: async () => fake.rpc });
    const result = await manager.list(context);

    assert.deepEqual(fake.calls.map((call) => [call.method, call.params]), [
        ["plugin/installed", { cwds: ["/projects/a"] }],
        ["plugin/read", { marketplacePath: "/codex/bundled/marketplace.json", pluginName: "visualize" }],
    ]);
    assert.equal(fake.closed(), 1);
    assert.deepEqual(result.support, { actions: ["install", "uninstall"], installScopes: ["user"], installHint: "plugin@marketplace", applies: "next-session", marketplaces: true });
    assert.deepEqual(result.marketplaces, [{ name: "openai-bundled", source: "local" }, { name: "openai-curated-remote", source: "remote" }]);
    assert.deepEqual(result.warnings, ["A Codex marketplace could not be loaded: invalid marketplace file"]);
    assert.deepEqual(result.plugins.map((plugin) => plugin.id), ["visualize@openai-bundled", "app-1@openai-curated-remote", "pets@openai-curated-remote"]);

    const [visualize, remote, pets] = result.plugins;
    assert.deepEqual([pets!.scope, pets!.readOnly, pets!.note], ["user", undefined, "Installed by default by Codex"],
        "a default install is not an administrator's policy");
    assert.equal(visualize!.name, "Visualize");
    assert.equal(visualize!.version, "1.0.45");
    assert.equal(visualize!.scope, "user");
    assert.equal(visualize!.enabled, true);
    assert.deepEqual(visualize!.source, { kind: "marketplace", ref: "openai-bundled" });
    assert.deepEqual(visualize!.evidence, { stage: "discovered", source: "codex app-server plugin/installed" });
    assert.deepEqual(visualize!.components?.map((component) => [component.kind, component.count, component.effect, component.names]), [
        ["skill", 2, "active", ["chart", "map"]],
        ["mcp-server", 1, "active", ["viz"]],
        ["hook", 2, "unknown", ["PreToolUse"]],
        ["tool", 1, "unknown", ["Drive"]],
    ]);

    assert.equal(remote!.components, undefined, "remote catalog plugins are not read per plugin");
    assert.equal(remote!.scope, "managed");
    assert.equal(remote!.readOnly, true);
    assert.equal(remote!.enabled, false);
    assert.equal(remote!.note, "Disabled by the workspace administrator");
});

test("a failed component read leaves the plugin listed without components", async () => {
    const fake = fakeRpc(({ method }) => {
        if (method === "plugin/read") throw rejectedRpc("nope");
        return INSTALLED;
    });
    const result = await createCodexNativePlugins({ harnessId: "codex", connect: async () => fake.rpc }).list(context);
    assert.equal(result.plugins[0]!.components, undefined);
    assert.equal(result.plugins.length, 3);
});

test("listing closes the App Server even when the list call fails", async () => {
    const fake = fakeRpc(() => { throw lostRpc(); });
    await assert.rejects(createCodexNativePlugins({ harnessId: "codex", connect: async () => fake.rpc }).list(context), /timed out/);
    assert.equal(fake.closed(), 1);
});

test("install resolves the marketplace and passes the operation id as the install attempt", async () => {
    const fake = fakeRpc(({ method }) => method === "plugin/list" ? CATALOG : { authPolicy: "ON_INSTALL", appsNeedingAuth: [{ id: "d", name: "Drive" }] });
    const manager = createCodexNativePlugins({ harnessId: "codex", connect: async () => fake.rpc });

    const local = await manager.mutate!(context, { action: "install", plugin: "visualize@openai-bundled" }, { operationId: "op-1" });
    assert.deepEqual(local, { kind: "confirmed", value: { pendingRestart: false, message: "Applies to new Codex sessions. Authorize these apps in Codex: Drive" } });
    assert.deepEqual(fake.calls.slice(0, 2).map((call) => [call.method, call.params]), [
        ["plugin/list", { cwds: ["/projects/a"] }],
        ["plugin/install", { marketplacePath: "/codex/bundled/marketplace.json", pluginName: "visualize", installAttemptId: "op-1" }],
    ]);

    await manager.mutate!(context, { action: "install", plugin: "app-1@openai-curated-remote", scope: "user" }, { operationId: "op-2" });
    assert.deepEqual(fake.calls[3]!.params, { remoteMarketplaceName: "openai-curated-remote", pluginName: "app-1", installAttemptId: "op-2" });
    assert.equal(fake.closed(), 2);
});

test("uninstall sends the native plugin id", async () => {
    const fake = fakeRpc(() => ({}));
    const outcome = await createCodexNativePlugins({ harnessId: "codex", connect: async () => fake.rpc })
        .mutate!(context, { action: "uninstall", plugin: "visualize@openai-bundled" }, { operationId: "op" });
    assert.deepEqual(outcome, { kind: "confirmed", value: { pendingRestart: false, message: "Applies to new Codex sessions" } });
    assert.deepEqual(fake.calls.map((call) => [call.method, call.params]), [["plugin/uninstall", { pluginId: "visualize@openai-bundled" }]]);
});

test("refusals before any change are rejected; a lost response is unknown and never retried", async () => {
    let connects = 0;
    const respond = (call: Call) => {
        if (call.method === "plugin/list") return CATALOG;
        const params = call.params as { pluginName?: string; pluginId?: string };
        if (params.pluginName === "bad") throw rejectedRpc("plugin bad is not in the marketplace");
        if (params.pluginId === "lost@openai-bundled" || params.pluginName === "lost") throw lostRpc();
        return {};
    };
    const fake = fakeRpc(respond);
    const manager = createCodexNativePlugins({ harnessId: "codex", connect: async () => { connects += 1; return fake.rpc; } });
    const reject = async (input: Parameters<NonNullable<typeof manager.mutate>>[1]) =>
        await manager.mutate!(context, input, { operationId: "op" }) as { kind: string; code?: string };

    for (const [input, code] of [
        [{ action: "enable", plugin: "visualize@openai-bundled" }, "unsupported"],
        [{ action: "update", plugin: "visualize@openai-bundled" }, "unsupported"],
        [{ action: "install", plugin: "-c" }, "invalid-input"],
        [{ action: "install", plugin: "visualize" }, "invalid-input"],
        [{ action: "install", plugin: "visualize@" }, "invalid-input"],
        [{ action: "install", plugin: "visualize@openai-bundled", scope: "project" }, "invalid-input"],
    ] as const) {
        assert.deepEqual((await reject(input)).code, code, JSON.stringify(input));
    }
    assert.equal(connects, 0, "invalid requests never start an App Server");

    assert.equal((await reject({ action: "install", plugin: "x@unknown-market" })).code, "not-found");
    const refused = await reject({ action: "install", plugin: "bad@openai-bundled" });
    assert.deepEqual([refused.kind, refused.code], ["rejected", "native-command-failed"]);

    const before = fake.calls.length;
    const lost = await manager.mutate!(context, { action: "uninstall", plugin: "lost@openai-bundled" }, { operationId: "op-lost" });
    assert.deepEqual(lost, { kind: "unknown", operationId: "op-lost", message: "Runtime response timed out" });
    assert.equal(fake.calls.length - before, 1, "an unknown outcome is not retried");

    const unreadable = createCodexNativePlugins({ harnessId: "codex", connect: async () => fakeRpc(() => { throw lostRpc(); }).rpc });
    const lookup = await unreadable.mutate!(context, { action: "install", plugin: "visualize@openai-bundled" }, { operationId: "op" });
    assert.deepEqual([lookup.kind, (lookup as { code: string }).code], ["rejected", "native-command-failed"], "a failed marketplace lookup precedes any change");

    const absent = createCodexNativePlugins({ harnessId: "codex", connect: async () => { throw Object.assign(new Error("Codex CLI was not found"), { code: "not-installed" }); } });
    assert.deepEqual(await absent.mutate!(context, { action: "uninstall", plugin: "a@b" }, { operationId: "op" }),
        { kind: "rejected", code: "not-installed", message: "Codex CLI was not found" });
});

test("remote projects are read-only without starting an App Server", async () => {
    let connects = 0;
    const manager = createCodexNativePlugins({ harnessId: "codex", connect: async () => { connects += 1; return fakeRpc(() => ({})).rpc; } });
    const remote: HarnessContext = { ...context, remote: true };
    const result = await manager.list(remote);
    assert.deepEqual([result.plugins, result.support.actions], [[], []]);
    assert.equal((await manager.mutate!(remote, { action: "uninstall", plugin: "a@b" }, { operationId: "op" })).kind, "rejected");
    assert.equal(connects, 0);
});

/** A stand-in `codex app-server` speaking newline-delimited JSON-RPC over stdio. */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
if (process.argv[2] !== "app-server") process.exit(64);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ method: message.method, params: message.params, codexHome: process.env.CODEX_HOME ?? null }) + "\\n");
  if (message.id === undefined) return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "plugin/installed") return send({ jsonrpc: "2.0", id: message.id, result: { marketplaces: [{ name: "local-mk", path: "/mk.json", plugins: [{ id: "demo@local-mk", name: "demo", installed: true, enabled: true, source: { type: "local", path: "/p" } }] }], marketplaceLoadErrors: [] } });
  if (message.method === "plugin/read") return send({ jsonrpc: "2.0", id: message.id, result: { plugin: { skills: [{ name: "s" }], hooks: [], apps: [], mcpServers: [] } } });
  if (message.method === "plugin/uninstall" && message.params.pluginId === "crash@local-mk") process.exit(1);
  if (message.method === "plugin/uninstall" && message.params.pluginId === "refused@local-mk") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "plugin is not installed" } });
  return send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`;

test("the provider runs the account's App Server with its CODEX_HOME over real stdio", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "polyth-codex-plugins-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "codex");
    writeFileSync(bin, FAKE_CODEX);
    chmodSync(bin, 0o755);
    const log = join(root, "log.jsonl");
    writeFileSync(log, "");
    const accountDir = join(root, "account-work");
    mkdirSync(accountDir);
    const saved = { bin: process.env.POLYTH_CODEX_BIN, log: process.env.FAKE_LOG };
    process.env.POLYTH_CODEX_BIN = bin;
    process.env.FAKE_LOG = log;
    t.after(() => {
        for (const [key, value] of [["POLYTH_CODEX_BIN", saved.bin], ["FAKE_LOG", saved.log]] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    const host = { pluginId: "backend-codex" } as unknown as Parameters<typeof createCodexProvider>[0];
    const provider = createCodexProvider(host, { id: "work", harnessId: "codex-work", name: "Work", dir: accountDir });
    assert.ok(provider.plugins, "Codex exposes a native plugin manager");
    const ctx = { ...context, cwd: root };

    const result = await provider.plugins.list(ctx);
    assert.equal(result.harnessId, "codex-work");
    assert.deepEqual(result.plugins.map((plugin) => [plugin.harnessId, plugin.id, plugin.components?.[0]?.kind]), [["codex-work", "demo@local-mk", "skill"]]);

    assert.equal((await provider.plugins.mutate!(ctx, { action: "uninstall", plugin: "demo@local-mk" }, { operationId: "op-1" })).kind, "confirmed");
    const refused = await provider.plugins.mutate!(ctx, { action: "uninstall", plugin: "refused@local-mk" }, { operationId: "op-2" });
    assert.deepEqual([refused.kind, (refused as { code: string }).code], ["rejected", "native-command-failed"]);
    assert.match((refused as { message: string }).message, /plugin is not installed/);
    const crashed = await provider.plugins.mutate!(ctx, { action: "uninstall", plugin: "crash@local-mk" }, { operationId: "op-3" });
    assert.equal(crashed.kind, "unknown", "a transport lost mid-request leaves the outcome unconfirmed");

    const entries = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; codexHome: string | null });
    assert.ok(entries.length > 0);
    assert.ok(entries.every((entry) => entry.codexHome === accountDir), "every App Server runs with the account's CODEX_HOME");
    assert.deepEqual(entries.filter((entry) => entry.method.startsWith("plugin/")).map((entry) => entry.method), [
        "plugin/installed", "plugin/read", "plugin/uninstall", "plugin/uninstall", "plugin/uninstall",
    ]);
});
