import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessContext, HarnessProvider, HarnessRegistry, RouteRequest, SpaceContext } from "@polyth/contracts";
import type {
    HarnessNativePluginManager,
    NativePluginListDto,
    NativePluginMutationInput,
    NativePluginMutationResponseDto,
} from "@polyth/contracts/capability-installations";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { nativePluginMutex, nativePluginRefError, readNativePluginCli, runNativePluginCli } from "../src/nativePlugins.ts";
import { handleNativePluginRequest } from "../src/nativePluginRoutes.ts";
import { harnessRoutes } from "../src/serverEntry.ts";
import { configurationSections } from "../widgets/presentation.ts";
import { componentChips, outcomeNotice, requestFailureText } from "../widgets/pluginPresentation.ts";

const tempDirs: string[] = [];
const tempDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
};
after(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const fakeCli = (body: string): string => {
    const bin = join(tempDir("native-plugin-cli-"), "fake-cli");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return bin;
};
const cwd = tmpdir();
const posixOnly = { skip: process.platform === "win32" ? "POSIX process groups" : false };
/** A command that starts a background child writing $MARKER after ~1 s. */
const backgroundWriter = (foreground: string) => {
    const marker = join(tempDir("native-plugin-marker-"), "late");
    return { marker, bin: fakeCli(`(sleep 1; echo late > "$MARKER") &\n${foreground}`), env: { PATH: process.env.PATH, MARKER: marker } };
};

test("plugin references reject flags, whitespace, control characters and oversize input", () => {
    assert.equal(nativePluginRefError("formatter@official"), undefined);
    assert.equal(nativePluginRefError("npm:@scope/pkg@1.2.3"), undefined);
    assert.equal(nativePluginRefError("file:///home/me/plugin"), undefined);
    assert.match(nativePluginRefError("")!, /required/);
    assert.match(nativePluginRefError("--accept-command")!, /must not start/);
    assert.match(nativePluginRefError("-y")!, /must not start/);
    assert.match(nativePluginRefError("a b")!, /whitespace/);
    assert.match(nativePluginRefError("a\nb")!, /whitespace/);
    assert.match(nativePluginRefError("a\u0000b")!, /control/);
    assert.match(nativePluginRefError("x".repeat(513))!, /too long/);
});

test("a mutation runs the argv without a shell and passes the given environment", async () => {
    const out = join(tempDir("native-plugin-out-"), "args");
    const bin = fakeCli(`printf '%s\\n' "$@" > "${out}"; echo "home=$PLUGIN_HOME"`);
    const outcome = await runNativePluginCli({ command: bin, args: ["install", "$(echo injected);x"], env: { PATH: process.env.PATH, PLUGIN_HOME: "/accounts/work" }, cwd, operationId: "op-1" });
    assert.equal(outcome.kind, "confirmed");
    assert.equal(outcome.kind === "confirmed" && outcome.value.stdout.trim(), "home=/accounts/work");
    assert.equal(readFileSync(out, "utf8"), "install\n$(echo injected);x\n", "arguments are not shell-interpreted");
});

test("a non-zero exit is a known refusal carrying the command's own diagnostics", async () => {
    const bin = fakeCli("printf '\\033[31mPlugin not found\\033[0m\\n' >&2; exit 4");
    const outcome = await runNativePluginCli({ command: bin, args: [], env: {}, cwd, operationId: "op-2" });
    assert.deepEqual(outcome, { kind: "rejected", code: "native-command-failed", message: "Plugin not found" });
});

test("a missing executable is a refusal, not an unknown outcome", async () => {
    const outcome = await runNativePluginCli({ command: join(tmpdir(), "definitely-missing-plugin-cli"), args: [], env: {}, cwd, operationId: "op-3" });
    assert.equal(outcome.kind, "rejected");
    assert.equal(outcome.kind === "rejected" && outcome.code, "not-installed");
});

test("a timeout or abort after the command started is unknown with the operation id", async () => {
    const bin = fakeCli("sleep 5");
    const timedOut = await runNativePluginCli({ command: bin, args: [], env: {}, cwd, operationId: "op-4", timeoutMs: 100 });
    assert.equal(timedOut.kind, "unknown");
    assert.equal(timedOut.kind === "unknown" && timedOut.operationId, "op-4");
    const controller = new AbortController();
    const pending = runNativePluginCli({ command: bin, args: [], env: {}, cwd, operationId: "op-5", signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const aborted = await pending;
    assert.equal(aborted.kind, "unknown");
    const early = new AbortController();
    early.abort();
    const notStarted = await runNativePluginCli({ command: bin, args: [], env: {}, cwd, operationId: "op-6", signal: early.signal });
    assert.deepEqual(notStarted.kind === "rejected" && notStarted.code, "cancelled");
});

test("a timeout stops the command's whole process group before it returns", posixOnly, async () => {
    const { marker, bin, env } = backgroundWriter("sleep 30");
    const startedAt = Date.now();
    const outcome = await runNativePluginCli({ command: bin, args: [], env, cwd, operationId: "op-7", timeoutMs: 200 });
    assert.ok(Date.now() - startedAt < 5_000, "the timeout returns within a bounded time");
    assert.deepEqual(outcome, { kind: "unknown", operationId: "op-7", message: "The command did not finish in time." });
    await delay(1_800);
    assert.equal(existsSync(marker), false, "the background child was stopped with the command");
});

test("an abort mid-run stops the command's whole process group", posixOnly, async () => {
    const { marker, bin, env } = backgroundWriter("sleep 30");
    const controller = new AbortController();
    const pending = runNativePluginCli({ command: bin, args: [], env, cwd, operationId: "op-8", signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    const outcome = await pending;
    assert.deepEqual(outcome, { kind: "unknown", operationId: "op-8", message: "Cancelled while the command was running." });
    await delay(1_800);
    assert.equal(existsSync(marker), false);
});

test("a command that exits normally does not leave a background child behind", posixOnly, async () => {
    const { marker, bin, env } = backgroundWriter("echo installed");
    const outcome = await runNativePluginCli({ command: bin, args: [], env, cwd, operationId: "op-9", timeoutMs: 10_000 });
    assert.equal(outcome.kind, "confirmed");
    assert.equal(outcome.kind === "confirmed" && outcome.value.stdout, "installed\n");
    await delay(1_800);
    assert.equal(existsSync(marker), false);
});

test("a command waiting for input gets end-of-file instead of hanging to the timeout", posixOnly, async () => {
    const startedAt = Date.now();
    const outcome = await runNativePluginCli({ command: fakeCli("read answer || { echo 'no input' >&2; exit 3; }; echo \"got $answer\""), args: [], env: { PATH: process.env.PATH }, cwd, operationId: "op-10", timeoutMs: 10_000 });
    assert.deepEqual(outcome, { kind: "rejected", code: "native-command-failed", message: "no input" });
    assert.ok(Date.now() - startedAt < 3_000);
});

test("output beyond the bound stops the group and is unknown", posixOnly, async () => {
    const outcome = await runNativePluginCli({ command: fakeCli("exec yes plugin-output-line"), args: [], env: { PATH: process.env.PATH }, cwd, operationId: "op-11", timeoutMs: 10_000 });
    assert.deepEqual(outcome, { kind: "unknown", operationId: "op-11", message: "The command produced more output than Polyth accepts." });
});

test("a process that escapes the group and keeps the output open is never reported as released", { skip: process.platform === "win32" || !existsSync("/usr/bin/setsid") ? "needs setsid" : false }, async () => {
    const outcome = await runNativePluginCli({ command: fakeCli("setsid sleep 2 &\necho done"), args: [], env: { PATH: process.env.PATH }, cwd, operationId: "op-12", timeoutMs: 10_000 });
    assert.equal(outcome.kind, "unknown");
    assert.match(outcome.kind === "unknown" ? outcome.message ?? "" : "", /may still be running/);
});

test("a read throws with a classified code instead of returning partial output", async () => {
    assert.deepEqual(await readNativePluginCli({ command: fakeCli("echo '[]'"), args: ["list"], env: {}, cwd }), { stdout: "[]\n", stderr: "" });
    await assert.rejects(readNativePluginCli({ command: fakeCli("echo nope >&2; exit 1"), args: [], env: {}, cwd }), (error: Error & { code?: string }) => error.code === "native-command-failed" && /nope/.test(error.message));
});

test("the mutex serializes work per key and survives a failure", async () => {
    const lock = nativePluginMutex();
    const order: string[] = [];
    const slow = lock("claude", async () => { await new Promise((resolve) => setTimeout(resolve, 30)); order.push("a"); throw new Error("boom"); });
    const next = lock("claude", async () => { order.push("b"); return 2; });
    const other = lock("codex", async () => { order.push("c"); return 3; });
    await assert.rejects(slow, /boom/);
    assert.equal(await next, 2);
    assert.equal(await other, 3);
    assert.deepEqual(order, ["c", "a", "b"]);
});

// ---------------------------------------------------------------- routes

const localSpace = { spaceId: "space-a", spaceSlug: "space-a", userId: "user-a", role: "owner", deployment: "local-trusted", storageDir: "/tmp/polyth-space-a" } as SpaceContext;

const listFor = (harnessId: string, names: string[]): NativePluginListDto => ({
    harnessId,
    support: { actions: ["install", "uninstall", "enable", "disable"], installScopes: ["user", "project"], installHint: "name@marketplace", applies: "next-session", marketplaces: true },
    plugins: names.map((name) => ({ harnessId, id: name, name, source: { kind: "marketplace", ref: "official" }, scope: "user", enabled: true, evidence: { stage: "discovered", source: "fake list" } })),
    checkedAt: 1,
});

function fakeManager(log: string[], outcome: Awaited<ReturnType<NonNullable<HarnessNativePluginManager["mutate"]>>> | ((input: NativePluginMutationInput) => Promise<Awaited<ReturnType<NonNullable<HarnessNativePluginManager["mutate"]>>>>), options: { listFails?: boolean } = {}): HarnessNativePluginManager {
    const installed = ["formatter@official"];
    return {
        support: (context) => listFor("claude", installed).support,
        async list(context: HarnessContext) {
            log.push(`list:${context.projectId}:${context.cwd}`);
            if (options.listFails) throw Object.assign(new Error("list failed"), { code: "timeout" });
            return listFor("claude", [...installed]);
        },
        async mutate(context, input, { operationId }) {
            log.push(`mutate:${input.action}:${input.plugin}:${input.scope ?? "-"}:${operationId ? "op" : "none"}`);
            const result = typeof outcome === "function" ? await outcome(input) : outcome;
            if (result.kind === "confirmed" && input.action === "install") installed.push(input.plugin);
            return result;
        },
    };
}

function pluginHost(log: string[], providers: Record<string, Partial<HarnessProvider>>, project: { remote?: boolean } = {}): ServerPackageHost {
    const services = createServerServiceRegistry();
    services.provide(serverServiceKey<HarnessRegistry>("harnesses"), {
        get: (id: string) => providers[id] ? { descriptor: { id }, ...providers[id] } : undefined,
        providers: () => Object.keys(providers).map((id) => ({ descriptor: { id }, ...providers[id] })),
        invalidate: (scope: { harnessId?: string }) => { log.push(`invalidate:${scope.harnessId}`); },
    } as unknown as HarnessRegistry);
    return {
        services,
        spaceStorage: () => ({ path: (value: string) => `/tmp/${value}` }),
        forSpace: () => ({ projects: { async list() { return []; }, async get(id: string) { return id === "p1" ? { id, path: `/projects/${id}`, ...project } : undefined; } } }),
    } as unknown as ServerPackageHost;
}

async function call(host: ServerPackageHost, method: "GET" | "POST", path: string, options: { body?: Record<string, unknown>; principal?: string; space?: SpaceContext } = {}): Promise<{ status?: number; body?: unknown }> {
    const url = new URL(`http://localhost${path}`);
    const result: { status?: number; body?: unknown } = {};
    const handled = await harnessRoutes(host)({
        path: url.pathname, method, url, space: options.space ?? localSpace, principal: { kind: options.principal ?? "local-user" },
        body: async () => options.body ?? {},
        json(status: number, body: unknown) { result.status = status; result.body = body; },
    } as unknown as RouteRequest);
    assert.equal(handled, true);
    return result;
}

const install = { action: "install", plugin: "lint@official", scope: "project", confirm: true };

test("GET lists the provider's native plugins for the requested project", async () => {
    const log: string[] = [];
    const host = pluginHost(log, { claude: { plugins: fakeManager(log, { kind: "confirmed", value: { pendingRestart: false } }) } });
    const result = await call(host, "GET", "/api/harnesses/claude/plugins?projectId=p1", { principal: "paired-device" });
    assert.equal(result.status, 200);
    assert.deepEqual((result.body as NativePluginListDto).plugins.map((plugin) => plugin.id), ["formatter@official"]);
    assert.deepEqual(log, ["list:p1:/projects/p1"]);
});

test("GET distinguishes an unknown harness from one without a plugin system", async () => {
    const host = pluginHost([], { cursor: {} });
    await assert.rejects(call(host, "GET", "/api/harnesses/missing/plugins"), (error: Error & { code?: string }) => error.code === "not-found");
    await assert.rejects(call(host, "GET", "/api/harnesses/cursor/plugins"), (error: Error & { code?: string }) => error.code === "unsupported");
});

test("a confirmed mutation invalidates the harness, re-lists and answers 200", async () => {
    const log: string[] = [];
    const host = pluginHost(log, { claude: { plugins: fakeManager(log, { kind: "confirmed", value: { pendingRestart: false } }) } });
    const result = await call(host, "POST", "/api/harnesses/claude/plugins?projectId=p1", { body: install });
    assert.equal(result.status, 200);
    const body = result.body as NativePluginMutationResponseDto;
    assert.equal(body.outcome, "confirmed");
    assert.equal(body.pendingRestart, false);
    assert.match(body.operationId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(body.list?.plugins.map((plugin) => plugin.id), ["formatter@official", "lint@official"]);
    assert.deepEqual(log, ["mutate:install:lint@official:project:op", "invalidate:claude", "list:p1:/projects/p1"]);
});

test("a refused or unconfirmed native command is reported in a 200 body, never as a thrown error", async () => {
    const rejected = await call(pluginHost([], { claude: { plugins: fakeManager([], { kind: "rejected", code: "native-command-failed", message: "not found in marketplace" }) } }), "POST", "/api/harnesses/claude/plugins?projectId=p1", { body: install });
    assert.equal(rejected.status, 200);
    assert.deepEqual({ ...(rejected.body as NativePluginMutationResponseDto), operationId: "x", list: undefined }, { outcome: "rejected", operationId: "x", code: "native-command-failed", message: "not found in marketplace", pendingRestart: false, list: undefined });
    const unknown = await call(pluginHost([], { claude: { plugins: fakeManager([], { kind: "unknown", operationId: "native-op", message: "The command did not finish in time." }) } }), "POST", "/api/harnesses/claude/plugins?projectId=p1", { body: install });
    const body = unknown.body as NativePluginMutationResponseDto;
    assert.equal(unknown.status, 200);
    assert.equal(body.outcome, "unknown");
    assert.equal(body.operationId, "native-op");
    assert.ok(body.list, "an unknown outcome still returns the re-read state");
});

test("a failed re-read omits the list instead of failing the confirmed mutation", async () => {
    const log: string[] = [];
    const result = await call(pluginHost(log, { claude: { plugins: fakeManager(log, { kind: "confirmed", value: { pendingRestart: true, message: "staged" } }, { listFails: true }) } }), "POST", "/api/harnesses/claude/plugins?projectId=p1", { body: install });
    const body = result.body as NativePluginMutationResponseDto;
    assert.equal(body.outcome, "confirmed");
    assert.equal(body.pendingRestart, true);
    assert.equal(body.message, "staged");
    assert.equal(body.list, undefined);
});

test("mutations require the instance owner and are refused in a sandboxed deployment", async () => {
    const log: string[] = [];
    const host = pluginHost(log, { claude: { plugins: fakeManager(log, { kind: "confirmed", value: { pendingRestart: false } }) } });
    await assert.rejects(call(host, "POST", "/api/harnesses/claude/plugins?projectId=p1", { body: install, principal: "paired-device" }), (error: Error & { code?: string }) => error.code === "forbidden");
    await assert.rejects(call(host, "POST", "/api/harnesses/claude/plugins?projectId=p1", { body: install, space: { ...localSpace, deployment: "multi-tenant-sandboxed", instanceOwner: true } as SpaceContext }), (error: Error & { code?: string }) => error.code === "forbidden");
    await assert.rejects(call(host, "GET", "/api/harnesses/claude/plugins?projectId=p1", { space: { ...localSpace, deployment: "multi-tenant-sandboxed" } as SpaceContext }), (error: Error & { code?: string }) => error.code === "forbidden");
    assert.deepEqual(log, [], "no native command ran");
});

test("mutations validate the action, reference, scope and explicit confirmation before running anything", async () => {
    const log: string[] = [];
    const host = pluginHost(log, { claude: { plugins: fakeManager(log, { kind: "confirmed", value: { pendingRestart: false } }) } });
    const invalid = async (body: Record<string, unknown>) => assert.rejects(call(host, "POST", "/api/harnesses/claude/plugins?projectId=p1", { body }), (error: Error & { code?: string }) => error.code === "invalid-input");
    await invalid({ ...install, action: "configure" });
    await invalid({ ...install, plugin: "--accept-command" });
    await invalid({ ...install, plugin: "lint official" });
    await invalid({ ...install, plugin: 7 });
    await invalid({ ...install, scope: "global" });
    await invalid({ ...install, confirm: undefined });
    await invalid({ ...install, confirm: "true" });
    assert.deepEqual(log, []);
});

test("an action or scope the harness does not support is refused as unsupported", async () => {
    const log: string[] = [];
    const host = pluginHost(log, {
        claude: { plugins: fakeManager(log, { kind: "confirmed", value: { pendingRestart: false } }) },
        readonly: { plugins: { support: () => listFor("readonly", []).support, list: async () => listFor("readonly", []) } },
    });
    const unsupported = (error: Error & { code?: string }) => error.code === "unsupported";
    await assert.rejects(call(host, "POST", "/api/harnesses/claude/plugins?projectId=p1", { body: { ...install, action: "update" } }), unsupported);
    await assert.rejects(call(host, "POST", "/api/harnesses/claude/plugins?projectId=p1", { body: { ...install, scope: "local" } }), unsupported);
    await assert.rejects(call(host, "POST", "/api/harnesses/readonly/plugins?projectId=p1", { body: install }), unsupported);
    const remote = pluginHost(log, { claude: { plugins: fakeManager(log, { kind: "confirmed", value: { pendingRestart: false } }) } }, { remote: true });
    await assert.rejects(call(remote, "POST", "/api/harnesses/claude/plugins?projectId=p1", { body: install }), unsupported);
    assert.deepEqual(log, []);
});

test("concurrent mutations of one harness run one at a time", async () => {
    const log: string[] = [];
    let running = 0;
    let overlap = false;
    const manager = fakeManager(log, async () => {
        running += 1;
        if (running > 1) overlap = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return { kind: "confirmed", value: { pendingRestart: false } };
    });
    const host = pluginHost(log, { claude: { plugins: manager } });
    const handler = harnessRoutes(host);
    const request = (plugin: string) => {
        const url = new URL("http://localhost/api/harnesses/claude/plugins?projectId=p1");
        return handler({ path: url.pathname, method: "POST", url, space: localSpace, principal: { kind: "local-user" }, body: async () => ({ ...install, plugin }), json() {} } as unknown as RouteRequest);
    };
    await Promise.all([request("a@m"), request("b@m"), request("c@m")]);
    assert.equal(overlap, false);
    assert.equal(log.filter((line) => line.startsWith("mutate:")).length, 3);
});

test("the route handler ignores other paths and methods", async () => {
    const registry = { get: () => undefined, invalidate() {} };
    const context = async () => ({ spaceId: "s", projectId: "p", cwd: "/" });
    const base = { space: localSpace, principal: { kind: "local-user" }, body: async () => ({}), json() {} } as never;
    assert.equal(await handleNativePluginRequest({ ...(base as object), method: "DELETE", path: "/api/harnesses/claude/plugins" } as never, { registry, context }), false);
    assert.equal(await handleNativePluginRequest({ ...(base as object), method: "GET", path: "/api/harnesses/claude/plugins/x" } as never, { registry, context }), false);
});

// ---------------------------------------------------------------- presentation

test("the Plugins section appears only on harnesses whose provider lists native plugins", () => {
    const items = [
        { id: "system", order: 5, meta: { harnessId: "*", sectionId: "system-prompt", label: "System prompt" } },
        { id: "plugins", order: 45, meta: { harnessId: "*", sectionId: "plugins", label: "Plugins", requires: "native-plugins" } },
    ];
    assert.deepEqual(configurationSections(items, "claude", { nativePlugins: true }).map((section) => section.id), ["system-prompt", "plugins"]);
    assert.deepEqual(configurationSections(items, "cursor", {}).map((section) => section.id), ["system-prompt"]);
    assert.deepEqual(configurationSections(items, "cursor").map((section) => section.id), ["system-prompt"]);
});

test("component chips name the effect and explain a component Polyth hides", () => {
    const chips = componentChips({ components: [
        { kind: "skill", count: 2, names: ["review", "lint"], effect: "hidden-by-polyth", reason: "Polyth sessions load only the skills Polyth provides." },
        { kind: "hook", count: 1, effect: "active" },
        { kind: "agent", count: 0, effect: "hidden-by-polyth" },
    ] });
    assert.deepEqual(chips.map((chip) => [chip.label, chip.effect, chip.tone]), [["2 skills", "Hidden by Polyth", "warning"], ["1 hook", "Active", "success"]]);
    assert.equal(chips[0]!.description, "Polyth sessions load only the skills Polyth provides. review, lint.");
});

test("outcome text separates a refusal from an unconfirmed result", () => {
    const list = listFor("claude", []);
    assert.equal(outcomeNotice("install", "lint", { outcome: "confirmed", operationId: "o", pendingRestart: false, list }, "next-session").tone, "success");
    assert.match(outcomeNotice("install", "lint", { outcome: "confirmed", operationId: "o", pendingRestart: true }, "runtime-restart").text, /Restart the runtime/);
    const refused = outcomeNotice("install", "lint", { outcome: "rejected", operationId: "o", code: "native-command-failed", message: "no such plugin", pendingRestart: false }, "next-session");
    assert.deepEqual(refused, { tone: "error", text: "Nothing changed: no such plugin" });
    assert.match(outcomeNotice("install", "lint", { outcome: "rejected", operationId: "o", code: "confirmation-required", message: "", pendingRestart: false }, "next-session").text, /extra confirmation/);
    const unknown = outcomeNotice("install", "lint", { outcome: "unknown", operationId: "o", pendingRestart: false, list }, "next-session");
    assert.equal(unknown.tone, "warning");
    assert.match(unknown.text, /not confirmed.*read again/);
    assert.match(requestFailureText(403, "Forbidden"), /instance owner/);
    assert.match(requestFailureText(undefined, "Failed to fetch"), /not confirmed/);
});
