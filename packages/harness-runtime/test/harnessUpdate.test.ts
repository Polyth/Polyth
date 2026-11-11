import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { HarnessRegistry, HarnessSnapshot, RouteRequest, SpaceContext } from "@polyth/contracts";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { freeHarnessExecutable, harnessRoutes, npmGlobalPrefixOf, runHarnessUpdate, updateCrashName, wrapperNote } from "../src/serverEntry.ts";
import { windowsCmdWrapperTarget } from "../src/executableDiscovery.ts";

test("runHarnessUpdate runs the argv without a shell and reports the exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-update-"));
    const bin = join(dir, "fake-cli");
    writeFileSync(bin, "#!/bin/sh\necho \"updating $1 $2\"\n[ \"$2\" = ok ] || exit 3\n");
    chmodSync(bin, 0o755);
    assert.deepEqual(await runHarnessUpdate([bin, "update", "ok"]), { ok: true, exitCode: 0, output: "updating update ok" });
    const failed = await runHarnessUpdate([bin, "update", "$(echo injected)"]);
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 3);
    assert.equal(failed.output, `updating update $(echo injected)\nProgram: ${bin}`, "arguments are not shell-interpreted; a failure names the program that ran");
    await assert.rejects(runHarnessUpdate([join(dir, "missing")]), /not installed/);
    // Node throws before spawning (here a NUL byte; on Windows a `.cmd` without
    // a shell): a failed run, never an unhandled 500.
    const refused = await runHarnessUpdate([bin, "update\0"]);
    assert.equal(refused.ok, false);
    assert.equal(refused.exitCode, null);
    assert.match(refused.output, new RegExp(`\nProgram: ${bin}$`));
});

test("runHarnessUpdate names the signal of an updater that crashed", { skip: process.platform === "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-update-crash-"));
    const bin = join(dir, "crashing-cli");
    writeFileSync(bin, "#!/bin/sh\nkill -ILL $$\n");
    chmodSync(bin, 0o755);
    const crashed = await runHarnessUpdate([bin, "update"]);
    assert.equal(crashed.ok, false);
    assert.equal(crashed.exitCode, null);
    assert.equal(crashed.output, `${bin} stopped with SIGILL\nProgram: ${bin}`);
});

/** `<prefix>/bin/<name>` → `<prefix>/lib/node_modules/<package>/cli.sh`, the
 *  layout of `npm install -g --prefix <prefix>`. */
function posixNpmInstall(prefix: string, packageName: string, name: string, script: string): string {
    const packageDir = join(prefix, "lib", "node_modules", ...packageName.split("/"));
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: packageName }));
    writeFileSync(join(packageDir, "cli.sh"), script);
    chmodSync(join(packageDir, "cli.sh"), 0o755);
    const launcher = join(prefix, "bin", name);
    symlinkSync(join(packageDir, "cli.sh"), launcher);
    return launcher;
}

/** A stand-in `npm` that prints its arguments and the prefix it was given. */
function fakeNpm(exit = 0): string {
    const npm = join(mkdtempSync(join(tmpdir(), "harness-update-npm-tool-")), "npm");
    writeFileSync(npm, `#!/bin/sh\necho "$* into $npm_config_prefix"\nexit ${exit}\n`);
    chmodSync(npm, 0o755);
    return npm;
}

test("an npm-installed CLI is updated by npm, into the prefix it lives in", { skip: process.platform === "win32" }, async () => {
    const prefix = mkdtempSync(join(tmpdir(), "harness-update-npm-"));
    // The CLI's own updater refuses, as Pi's and Codex's do on Windows.
    const launcher = posixNpmInstall(prefix, "@scope/fake-cli", "fake-cli", "#!/bin/sh\necho cannot self-update this installation >&2\nexit 1\n");
    const npm = fakeNpm();
    const target = { npmPackage: "@scope/fake-cli", npmCommand: npm };
    assert.deepEqual(await runHarnessUpdate([launcher, "update"], undefined, target), { ok: true, exitCode: 0, output: `install -g @scope/fake-cli@latest into ${prefix}` });
    assert.equal((await runHarnessUpdate([launcher, "update"], undefined, { ...target, npmDistTag: "beta" })).output, `install -g @scope/fake-cli@beta into ${prefix}`);
    // A failed npm run names npm and what it was asked, not the CLI.
    const failing = fakeNpm(3);
    const failed = await runHarnessUpdate([launcher, "update"], undefined, { ...target, npmCommand: failing });
    assert.deepEqual([failed.ok, failed.exitCode], [false, 3]);
    assert.match(failed.output, new RegExp(`\nProgram: ${failing} install -g @scope/fake-cli@latest$`));
    // A copy npm did not install keeps its own updater.
    const standalone = join(mkdtempSync(join(tmpdir(), "harness-update-own-")), "fake-cli");
    writeFileSync(standalone, "#!/bin/sh\necho self-updated\n");
    chmodSync(standalone, 0o755);
    assert.equal((await runHarnessUpdate([standalone, "update"], undefined, target)).output, "self-updated");
});

test("without an npm to run, the CLI's own updater gets the npm prefix it lives in", { skip: process.platform === "win32" }, async () => {
    const prefix = mkdtempSync(join(tmpdir(), "harness-update-npm-"));
    const launcher = posixNpmInstall(prefix, "@scope/fake-cli", "fake-cli", "#!/bin/sh\necho \"prefix=$npm_config_prefix\"\n");
    const saved = process.env.NPM_CONFIG_PREFIX;
    // npm's configured prefix is elsewhere (Polyth's own Node.js, a user
    // setting): the CLI's prefix wins, whatever the variable's case.
    process.env.NPM_CONFIG_PREFIX = "/somewhere/else";
    try {
        assert.deepEqual(await runHarnessUpdate([launcher, "update"], undefined, { npmPackage: "@scope/fake-cli", npmCommand: join(prefix, "no-npm-here") }), { ok: true, exitCode: 0, output: `prefix=${prefix}` });
        // Without the package name nothing is assumed about the install.
        assert.equal((await runHarnessUpdate([launcher, "update"])).output, "prefix=");
    }
    finally {
        if (saved === undefined) delete process.env.NPM_CONFIG_PREFIX;
        else process.env.NPM_CONFIG_PREFIX = saved;
    }
});

test("a package-manager update goes into the prefix of the command the package installs", { skip: process.platform === "win32" }, async () => {
    const prefix = mkdtempSync(join(tmpdir(), "harness-update-npm-bin-"));
    const cli = posixNpmInstall(prefix, "@scope/dsh-like", "dsh-like", "#!/bin/sh\n");
    // `npm` lives with its own Node.js, elsewhere (Polyth's unpacked Node.js).
    const npmDir = mkdtempSync(join(tmpdir(), "harness-update-npm-tool-"));
    const npm = join(npmDir, "npm");
    writeFileSync(npm, "#!/bin/sh\necho \"$* into $npm_config_prefix\"\n");
    chmodSync(npm, 0o755);
    const command = [npm, "install", "-g", "@scope/dsh-like@latest"];
    assert.equal((await runHarnessUpdate(command, undefined, { npmPackage: "@scope/dsh-like", npmBin: cli })).output, `install -g @scope/dsh-like@latest into ${prefix}`);
    // Not the package-manager's own prefix, which holds no such package.
    assert.equal((await runHarnessUpdate(command, undefined, { npmPackage: "@scope/dsh-like" })).output, "install -g @scope/dsh-like@latest into");
});

test("npmGlobalPrefixOf recognizes only a launcher that leads into the npm package", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "harness-npm-prefix-"));
    const launcher = posixNpmInstall(prefix, "fake-cli", "fake-cli", "#!/bin/sh\n");
    const hit = (path: string) => ({ launcherPath: path, executablePath: path });
    assert.equal(await npmGlobalPrefixOf({ launcherPath: launcher, executablePath: join(prefix, "lib", "node_modules", "fake-cli", "cli.sh") }, "fake-cli", "linux"), prefix);
    assert.equal(await npmGlobalPrefixOf({ launcherPath: launcher, executablePath: join(prefix, "lib", "node_modules", "fake-cli", "cli.sh") }, "other-cli", "linux"), undefined, "another package");
    // A standalone binary beside a stale npm copy of the same package.
    const standalone = join(prefix, "bin", "standalone");
    writeFileSync(standalone, "#!/bin/sh\n");
    assert.equal(await npmGlobalPrefixOf(hit(standalone), "fake-cli", "linux"), undefined, "not the npm copy");

    // Windows: `<prefix>\pi.cmd` is npm's cmd-shim into `<prefix>\node_modules`.
    const windowsPrefix = mkdtempSync(join(tmpdir(), "harness-npm-prefix-win-"));
    const script = join(windowsPrefix, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(join(windowsPrefix, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "{}");
    writeFileSync(script, "");
    const shim = join(windowsPrefix, "pi.cmd");
    writeFileSync(shim, '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*\r\n');
    assert.equal(await npmGlobalPrefixOf(hit(shim), "@earendil-works/pi-coding-agent", "win32"), windowsPrefix);
    // A package `bin` with no extension (a `#!/usr/bin/env node` script).
    const bare = join(windowsPrefix, "node_modules", "bare-cli", "bin", "bare");
    mkdirSync(dirname(bare), { recursive: true });
    writeFileSync(join(windowsPrefix, "node_modules", "bare-cli", "package.json"), "{}");
    writeFileSync(bare, "");
    const bareShim = join(windowsPrefix, "bare.cmd");
    writeFileSync(bareShim, '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\bare-cli\\bin\\bare" %*\r\n');
    assert.equal(await npmGlobalPrefixOf(hit(bareShim), "bare-cli", "win32"), windowsPrefix);
    const exe = join(windowsPrefix, "pi.exe");
    writeFileSync(exe, "");
    assert.equal(await npmGlobalPrefixOf(hit(exe), "@earendil-works/pi-coding-agent", "win32"), undefined, "a program that is not npm's shim");

    // A wrapper elsewhere on PATH (`~\.local\bin\pi.cmd`) that starts the npm
    // copy: by the shim, by the script, or through an environment variable.
    const elsewhere = mkdtempSync(join(tmpdir(), "harness-npm-wrapper-"));
    const wrapper = (name: string, body: string): { launcherPath: string; executablePath: string } => {
        writeFileSync(join(elsewhere, name), `@echo off\r\nrem "${exe}"\r\n${body}\r\n`);
        return hit(join(elsewhere, name));
    };
    const pi = "@earendil-works/pi-coding-agent";
    assert.equal(await npmGlobalPrefixOf(wrapper("shim.cmd", `"${shim}" %*`), pi, "win32"), windowsPrefix);
    assert.equal(await npmGlobalPrefixOf(wrapper("script.cmd", `node "${script}" %*`), pi, "win32"), windowsPrefix);
    assert.equal(await npmGlobalPrefixOf(wrapper("bare.cmd", `call ${shim} %*`), pi, "win32"), windowsPrefix);
    assert.equal(await npmGlobalPrefixOf(wrapper("other.cmd", `"${shim}" %*`), "bare-cli", "win32"), undefined, "the wrapper leads to another package");
    assert.equal(await npmGlobalPrefixOf(wrapper("native.cmd", `"${exe}" %*`), pi, "win32"), undefined, "a native program beside a stale npm copy");
    assert.equal(await npmGlobalPrefixOf(wrapper("gone.cmd", `"${join(elsewhere, "missing.exe")}" %*`), pi, "win32"), undefined);
    // A package in a store with no npm shim beside it (pnpm, a project install).
    const store = mkdtempSync(join(tmpdir(), "harness-npm-store-"));
    const stored = join(store, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    mkdirSync(dirname(stored), { recursive: true });
    writeFileSync(join(store, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "{}");
    writeFileSync(stored, "");
    assert.equal(await npmGlobalPrefixOf(wrapper("store.cmd", `node "${stored}" %*`), pi, "win32"), undefined, "no npm shim owns that folder");
    assert.equal(await windowsCmdWrapperTarget(join(elsewhere, "native.cmd")), exe, "a failed update can name what the wrapper starts");
    // A shim that picks its program at call time (the Codex desktop app's
    // `bin\<hash>\codex.exe`): the failure names the folder and says why.
    const bin = join(elsewhere, "OpenAI", "Codex", "bin");
    mkdirSync(join(bin, "abc123"), { recursive: true });
    writeFileSync(join(bin, "abc123", "codex.exe"), "");
    const late = wrapper("late.cmd", `for /f "delims=" %%D in ('dir /b /ad /o:-d "%APPBIN%" 2^>nul') do set "CODEX_EXE=%APPBIN%\\%%D\\codex.exe"\r\n"%CODEX_EXE%" --no-daemon %*`).launcherPath;
    assert.equal(await windowsCmdWrapperTarget(late, { APPBIN: bin }), undefined);
    const note = await wrapperNote(late, "win32", { APPBIN: bin });
    assert.match(note, /It starts a program in: .*bin\n/);
    assert.match(note, /cannot update it/);
    assert.match(await wrapperNote(join(elsewhere, "native.cmd"), "win32"), /It starts: .*\n/);
    assert.equal(await wrapperNote(exe, "win32"), "", "not a wrapper");
});

const space = { spaceId: "space-a", spaceSlug: "space-a", userId: "user-a", role: "owner", deployment: "local-trusted", storageDir: "/tmp/polyth-space-a" } as SpaceContext;

function maintenanceHost(log: string[]): ServerPackageHost {
    const services = createServerServiceRegistry();
    services.provide(serverServiceKey<HarnessRegistry>("harnesses"), {
        get: (id: string) => id === "codex" ? { descriptor: { id } } : undefined,
        invalidate: (scope: { harnessId?: string }) => { log.push(`invalidate:${scope.harnessId}`); },
        async snapshots(context: { projectId: string }, options: { harnessId?: string; force?: boolean }) {
            log.push(`snapshots:${context.projectId}:${options.harnessId}:${options.force}`);
            return [{ identity: { id: "codex" }, catalog: { models: [{ providerID: "openai", modelID: "gpt" }] } }];
        },
    } as unknown as HarnessRegistry);
    services.provide(serverServiceKey("runtime.catalog"), { invalidateModels: () => { log.push("catalog"); } });
    services.provide(serverServiceKey("harness.runtime.restart"), async () => { log.push("restart"); return { restarted: 1, failed: 0 }; });
    return {
        services,
        spaceStorage: () => ({ path: (value: string) => `/tmp/${value}` }),
        forSpace: () => ({ projects: { async list() { return []; }, async get(id: string) { return { id, path: `/projects/${id}` }; } } }),
    } as unknown as ServerPackageHost;
}

async function post(path: string, principal: string, log: string[]): Promise<unknown> {
    let payload: unknown;
    const url = new URL(`http://localhost${path}`);
    await harnessRoutes(maintenanceHost(log))({
        path: url.pathname, method: "POST", url, space, principal: { kind: principal },
        json(_status: number, body: unknown) { payload = body; },
    } as unknown as RouteRequest);
    return payload;
}

test("refresh-models drops both model caches and force-probes the harness for any member", async () => {
    const log: string[] = [];
    const snapshot = await post("/api/harnesses/codex/refresh-models?projectId=p1", "paired-device", log) as HarnessSnapshot;
    assert.equal(snapshot.catalog?.models?.length, 1);
    assert.deepEqual(log, ["invalidate:codex", "catalog", "snapshots:p1:codex:true", "catalog"]);
});

test("restart stays owner-only and invalidates the model catalog after the restart", async () => {
    const log: string[] = [];
    await assert.rejects(post("/api/harnesses/codex/restart", "paired-device", log), (error: unknown) => (error as { code?: string }).code === "forbidden");
    assert.deepEqual(log, []);
    assert.deepEqual(await post("/api/harnesses/codex/restart", "local-user", log), { restarted: 1, failed: 0 });
    assert.deepEqual(log, ["restart", "invalidate:codex", "catalog"]);
});

test("a Windows updater crash is named by its NTSTATUS exit code", () => {
    assert.equal(updateCrashName(null, 0xC000001D), "STATUS_ILLEGAL_INSTRUCTION (0xC000001D)");
    // Node can surface the same status as a negative 32-bit integer.
    assert.equal(updateCrashName(null, 0xC000001D | 0), "STATUS_ILLEGAL_INSTRUCTION (0xC000001D)");
    assert.equal(updateCrashName("SIGILL", null), "SIGILL");
    assert.equal(updateCrashName(null, 1), undefined);
    assert.equal(updateCrashName(null, null), undefined);
});

test("Windows frees a harness's idle chats before replacing its program and refuses while one works", async () => {
    const asked: string[] = [];
    const hostWith = (answer: { released: number; busy: number } | undefined) => ({
        services: {
            get: (key: unknown) => answer && String((key as { id?: string }).id ?? key).includes("harness.runtime.releaseIdle")
                ? async (harnessId: string) => { asked.push(harnessId); return answer; }
                : undefined,
        },
    }) as unknown as Parameters<typeof freeHarnessExecutable>[0];
    const grok = { id: "grok", name: "Grok Build" };
    // Other systems replace a running file safely: nothing is released.
    assert.deepEqual(await freeHarnessExecutable(hostWith({ released: 2, busy: 1 }), grok, "linux"), { released: 0 });
    assert.deepEqual(asked, []);
    assert.deepEqual(await freeHarnessExecutable(hostWith({ released: 2, busy: 0 }), grok, "win32"), { released: 2 });
    await assert.rejects(freeHarnessExecutable(hostWith({ released: 0, busy: 1 }), grok, "win32"),
        (error: Error & { code?: string }) => error.code === "conflict" && /Grok Build is still working in a chat/.test(error.message));
    assert.deepEqual(asked, ["grok", "grok"]);
    // A host without the release service (an older server) is not blocked.
    assert.deepEqual(await freeHarnessExecutable(hostWith(undefined), grok, "win32"), { released: 0 });
});
