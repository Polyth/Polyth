// Harness install/sign-in terminals: the server picks the command and the
// machine, runs it through the system shell, and marks the terminal
// machine-wide so every Terminal view of the project shows it.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import type { HarnessDescriptor, HarnessRegistry, Project, RequestIngress, RouteRequest, SpaceContext } from "@polyth/contracts";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { harnessRoutes } from "../src/serverEntry.ts";
import { browserOnServer, openSetupTerminal, REMOTE_SETUP_PATH, setupCommand, setupTarget, type HarnessSetupTerminals } from "../src/setupTerminal.ts";

const codex: HarnessDescriptor = {
    id: "codex", name: "Codex", integration: "App Server", priority: 50,
    installCommand: "npm install -g @openai/codex",
    signInCommand: "'/home/u/.local/bin/codex' 'login'",
    deviceSignInCommand: "'/home/u/.local/bin/codex' 'login' '--device-auth'",
    remoteHost: { binary: "codex", installCommand: "sh -c 'install'", signInCommand: "codex login --device-auth", sessions: true },
};
const account: HarnessDescriptor = {
    ...codex, id: "codex-work", name: "Codex · work", accountOwnerUserId: "user-a",
    signInCommand: "CODEX_HOME='/data/codex-accounts/work' '/home/u/.local/bin/codex' 'login'",
    deviceSignInCommand: undefined,
    remoteHost: { binary: "codex", installCommand: "sh -c 'install'" },
};
const localProject: Project = { id: "p-local", path: "/work/app", name: "app", createdAt: 0 };
const sshProject = { id: "p-ssh", path: "/srv/app", name: "app", createdAt: 0, remote: { kind: "ssh", connectionId: "c1" } } as Project;

test("the target and command follow where the harness runs for the project", () => {
    assert.equal(setupTarget(codex, localProject), "local");
    assert.equal(setupTarget(codex, sshProject), "remote", "remote chats run on the host's own sign-in");
    assert.equal(setupTarget(account, sshProject), "local", "an extra account is a login directory on this machine");
    assert.deepEqual(setupCommand(codex, "sign-in", "local", true), { command: codex.signInCommand, deviceCode: false });
    assert.deepEqual(setupCommand(codex, "sign-in", "local", false), { command: codex.deviceSignInCommand, deviceCode: true },
        "a browser elsewhere cannot reach the CLI's localhost callback");
    assert.deepEqual(setupCommand(account, "sign-in", "local", false), { command: account.signInCommand, deviceCode: false },
        "without a device flow the plain sign-in stays");
    assert.deepEqual(setupCommand(codex, "install", "local", false), { command: codex.installCommand, deviceCode: false });
    assert.deepEqual(setupCommand(codex, "sign-in", "remote"), { command: "codex login --device-auth", deviceCode: false });
    assert.equal(setupCommand({ ...codex, remoteHost: { binary: "codex" } }, "sign-in", "remote"), undefined);
});

test("only a direct loopback request has its browser on the server", () => {
    const at = (ingress: RequestIngress) => browserOnServer({ ingress });
    assert.equal(at({ kind: "public-http", listenerId: "l", loopback: true, secure: false }), true);
    assert.equal(at({ kind: "public-http", listenerId: "l", loopback: true, secure: true, proxied: true }), false);
    assert.equal(at({ kind: "public-http", listenerId: "l", loopback: false, secure: true }), false);
    assert.equal(at({ kind: "polyth-link", connectionId: "c", transport: "relay" }), false);
});

const recorder = () => {
    const created: Array<Parameters<HarnessSetupTerminals["create"]>[0]> = [];
    const terminals: HarnessSetupTerminals = { async create(input) { created.push(input); return { id: `t-${created.length}` }; } };
    return { created, terminals };
};

test("a local setup terminal runs here, in the home directory, through the system shell", async () => {
    const { created, terminals } = recorder();
    const result = await openSetupTerminal({
        descriptor: codex, action: "sign-in", project: sshProject, localBrowser: false, terminals: undefined as unknown as HarnessSetupTerminals,
    }).catch((error: { code?: string }) => error.code);
    assert.equal(result, "unavailable", "without the terminal package nothing runs");
    const opened = await openSetupTerminal({
        descriptor: account, action: "sign-in", project: sshProject, localBrowser: true, terminals,
        env: { PATH: "/usr/bin", POLYTH_HARNESS_SHELL_PROBE: "0", HOME: "/home/u" },
    });
    assert.deepEqual({ ...created[0], env: undefined }, {
        projectId: "p-ssh", cwd: homedir(), cmd: account.signInCommand, systemShell: true, local: true,
        env: undefined, title: "Sign in · Codex · work", purpose: "harness-setup",
    });
    const path = created[0]!.env!.PATH!.split(":");
    assert.equal(path[0], "/usr/bin", "the inherited PATH comes first");
    assert.ok(path.includes("/home/u/.local/bin"), "installer locations are reachable from a desktop launch");
    assert.deepEqual(opened, {
        harnessId: "codex-work", action: "sign-in", target: "local", command: account.signInCommand,
        terminalId: "t-1", projectId: "p-ssh", title: "Sign in · Codex · work",
    });
});

test("a remote setup terminal runs on the project's SSH host with the harness PATH", async () => {
    const { created, terminals } = recorder();
    const opened = await openSetupTerminal({ descriptor: codex, action: "install", project: sshProject, terminals });
    assert.deepEqual(created[0], {
        projectId: "p-ssh", cwd: "/srv/app", cmd: `${REMOTE_SETUP_PATH}; sh -c 'install'`, systemShell: true, local: false,
        title: "Install Codex", purpose: "harness-setup",
    });
    assert.equal(opened.target, "remote");
    assert.equal(opened.command, "sh -c 'install'", "the preview names the vendor command, not the PATH prefix");
});

// ---- route -------------------------------------------------------------

const ownerSpace = { spaceId: "space-a", spaceSlug: "space-a", userId: "user-a", role: "owner", deployment: "local-trusted", storageDir: "/tmp/polyth-space-a" } as SpaceContext;

function routeHost(created: unknown[], descriptors: HarnessDescriptor[]): ServerPackageHost {
    const services = createServerServiceRegistry();
    services.provide(serverServiceKey<HarnessRegistry>("harnesses"), {
        get: (id: string) => {
            const descriptor = descriptors.find((row) => row.id === id);
            return descriptor ? { descriptor } : undefined;
        },
        invalidate() {},
    } as unknown as HarnessRegistry);
    services.provide(serverServiceKey<HarnessSetupTerminals>("terminal"), {
        async create(input) { created.push(input); return { id: "term-9" }; },
    });
    const projects = [localProject, sshProject];
    return {
        services,
        spaceStorage: () => ({ path: (value: string) => `/tmp/${value}` }),
        forSpace: () => ({ projects: { async list() { return projects; }, async get(id: string) { return projects.find((row) => row.id === id); } } }),
    } as unknown as ServerPackageHost;
}

async function call(input: {
    method: "GET" | "POST"; path: string; body?: Record<string, unknown>; principal?: string;
    space?: Partial<SpaceContext> & Record<string, unknown>; ingress?: RequestIngress; descriptors?: HarnessDescriptor[];
}) {
    const created: unknown[] = [];
    let payload: unknown;
    const url = new URL(`http://localhost${input.path}`);
    const handled = await harnessRoutes(routeHost(created, input.descriptors ?? [codex, account]))({
        path: url.pathname, method: input.method, url,
        space: { ...ownerSpace, ...input.space },
        principal: { kind: input.principal ?? "local-user" },
        ingress: input.ingress ?? { kind: "public-http", listenerId: "l", loopback: false, secure: true, proxied: true },
        async body() { return input.body ?? {}; },
        json(_status: number, body: unknown) { payload = body; },
    } as unknown as RouteRequest);
    return { handled, payload, created };
}

test("the route previews and opens exactly the server-chosen command", async () => {
    const preview = await call({ method: "GET", path: "/api/harnesses/codex/setup-terminal?action=sign-in&projectId=p-local" });
    assert.deepEqual(preview.payload, { harnessId: "codex", action: "sign-in", target: "local", command: codex.deviceSignInCommand, deviceCode: true });
    const local = await call({
        method: "GET", path: "/api/harnesses/codex/setup-terminal?action=sign-in&projectId=p-local",
        ingress: { kind: "public-http", listenerId: "l", loopback: true, secure: false },
    });
    assert.equal((local.payload as { command: string }).command, codex.signInCommand, "the desktop window shares the server's browser");

    const opened = await call({ method: "POST", path: "/api/harnesses/codex/setup-terminal", body: { action: "sign-in", projectId: "p-ssh" } });
    assert.equal((opened.payload as { terminalId: string }).terminalId, "term-9");
    assert.equal((opened.payload as { target: string }).target, "remote");
    assert.equal((opened.created[0] as { cmd: string }).cmd, `${REMOTE_SETUP_PATH}; codex login --device-auth`);

    await assert.rejects(call({ method: "POST", path: "/api/harnesses/codex/setup-terminal", body: { action: "sign-in" } }), { code: "invalid-input" },
        "a terminal needs a project's Terminal view");
    await assert.rejects(call({ method: "POST", path: "/api/harnesses/codex/setup-terminal", body: { action: "rm -rf", projectId: "p-local" } }), { code: "invalid-input" });
    await assert.rejects(call({ method: "GET", path: "/api/harnesses/missing/setup-terminal?action=install" }), { code: "not-found" });
    await assert.rejects(call({ method: "GET", path: "/api/harnesses/codex/setup-terminal?action=install&projectId=other-space" }), { code: "not-found" });
});

test("installing and replacing a shared login need harness management; a private login its owner", async () => {
    const member = { instanceOwner: false, harnessPersonal: true, userId: "user-a" };
    await assert.rejects(call({ method: "POST", path: "/api/harnesses/codex/setup-terminal", body: { action: "install", projectId: "p-local" }, principal: "ui-session", space: member }), { code: "forbidden" });
    await assert.rejects(call({ method: "POST", path: "/api/harnesses/codex/setup-terminal", body: { action: "sign-in", projectId: "p-local" }, principal: "ui-session", space: member }), { code: "forbidden" });
    const own = await call({ method: "POST", path: "/api/harnesses/codex-work/setup-terminal", body: { action: "sign-in", projectId: "p-local" }, principal: "ui-session", space: member });
    assert.equal((own.payload as { terminalId: string }).terminalId, "term-9");
    await assert.rejects(call({ method: "POST", path: "/api/harnesses/codex/setup-terminal", body: { action: "sign-in", projectId: "p-local" }, space: { deployment: "multi-tenant-sandboxed" } }), { code: "forbidden" });
});
