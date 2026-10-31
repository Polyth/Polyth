// Background harness installs: the server runs the backend's own installer
// without a terminal, reports plain-language progress and failures, runs one
// install per machine at a time, and confirms the CLI is found afterwards.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessDescriptor, HarnessInstallDto, HarnessRegistry, HarnessSnapshot, Project, RemoteHost, RouteRequest, SpaceContext } from "@polyth/contracts";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    classifyInstallFailure,
    createHarnessInstallJobs,
    createInstallContainment,
    createInstallOutput,
    installEnvironment,
    installSources,
    localInstallLauncher,
    remoteInstallLauncher,
    type InstallProcess,
} from "../src/installJobs.ts";
import { npmCliInstallCommand, vendorScriptInstallCommand } from "../src/installers.ts";
import { harnessRoutes } from "../src/serverEntry.ts";
import { REMOTE_SETUP_PATH } from "../src/setupTerminal.ts";

const posix = process.platform !== "win32";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (check: () => boolean, label: string, ms = 5_000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

// ---- output ------------------------------------------------------------

test("installer output reads like a person sees it: no escapes, spinner redraws collapsed", () => {
    const output = createInstallOutput();
    output.append("\x1b[1;32m✓ Platform detected\x1b[0m: linux_amd64\n");
    output.append("⠋ Downloading release package...\r⠙ Downloading release package...\r");
    output.append("✓ Download complete and checksum verified.\r\n");
    output.append("\x1b]0;title\x07npm warn deprecated inflight@1.0.6: leaks memory\n");
    assert.equal(output.text(), "✓ Platform detected: linux_amd64\n✓ Download complete and checksum verified.\nnpm warn deprecated inflight@1.0.6: leaks memory");
    assert.equal(output.activity(), "✓ Download complete and checksum verified.", "npm warnings are not what it is doing");
    output.append("⠋ Configuring shell environment...");
    assert.equal(output.activity(), "Configuring shell environment...", "a spinner frame is not part of the words");
});

test("a carriage return split from its line feed does not erase the line", () => {
    const output = createInstallOutput();
    output.append("added 1 package\r");
    output.append("\nnext\n");
    assert.equal(output.text(), "added 1 package\nnext");
});

test("output is bounded to the newest text and says so", () => {
    const output = createInstallOutput(100);
    for (let index = 0; index < 50; index++) output.append(`line ${index}\n`);
    assert.ok(output.text().length <= 100);
    assert.match(output.text(), /line 49$/);
    assert.equal(output.truncated, true);
    assert.equal(createInstallOutput().activity(), undefined);
    const dots = createInstallOutput(100);
    for (let index = 0; index < 500; index++) dots.append(".");
    assert.ok(dots.text().length <= 100, "a line that never ends is bounded too");
});

// ---- failures ----------------------------------------------------------

test("failures are classified from the installers' own words", () => {
    const kind = (text: string, code: number | null = 1) => classifyInstallFailure(text, code, "Antigravity").kind;
    assert.equal(kind("Fatal: Could not connect to the release server to download the manifest. Please check your internet connection or firewall settings."), "network");
    assert.equal(kind("curl: (6) Could not resolve host: antigravity.google"), "network");
    assert.equal(kind("Could not reach nodejs.org to download Node.js. Check the internet connection, then try again."), "network");
    assert.equal(kind("Invoke-RestMethod : The remote name could not be resolved: 'nodejs.org'"), "network");
    assert.equal(kind("npm error code EACCES\nnpm error syscall mkdir"), "permission");
    assert.equal(kind("Write Error: Permission denied when attempting to create /home/u/.local/bin."), "permission");
    assert.equal(kind("tar: write error: No space left on device"), "disk-space");
    assert.equal(kind("Fatal: Unsupported architecture: i686. Antigravity CLI currently supports 64-bit Windows, macOS, and Linux."), "unsupported-platform");
    assert.equal(kind("Polyth cannot install Node.js on this system (Linux armv7l) by itself."), "unsupported-platform");
    assert.equal(kind("Security Halt: The downloaded payload checksum does not match the manifest."), "checksum");
    assert.equal(kind("The Node.js download was damaged (checksum mismatch). Try again."), "checksum");
    assert.equal(kind("sh: 1: curl: not found\nsh: 1: bash: not found"), "prerequisite");
    assert.equal(kind("'curl' is not recognized as an internal or external command,"), "prerequisite");
    assert.equal(kind("Fatal: Either curl or wget is required but neither is installed."), "prerequisite");
    assert.deepEqual(classifyInstallFailure("sh: 1: curl: not found", 127), { kind: "prerequisite", message: "The installer needs curl, which this machine does not have.", tool: "curl" });
    const unknown = classifyInstallFailure("starting\nsomething odd happened\nnpm warn deprecated x\n", 2);
    assert.deepEqual(unknown, { kind: "unknown", message: "starting\nsomething odd happened" }, "the installer's own last words explain it");
    assert.equal(classifyInstallFailure("", 3).message, "The installer stopped with exit code 3.");
});

test("sources name where an installer downloads from", () => {
    assert.deepEqual(installSources(vendorScriptInstallCommand({ posix: "https://antigravity.google/cli/install.sh" })!), ["antigravity.google"]);
    assert.deepEqual(installSources(npmCliInstallCommand("@openai/codex")), ["nodejs.org", "registry.npmjs.org"]);
    assert.ok(installSources(npmCliInstallCommand("@openai/codex", "win32")).includes("registry.npmjs.org"));
    assert.deepEqual(installSources("powershell -NoProfile -Command \"irm 'https://claude.ai/install.ps1' | iex\""), ["claude.ai"]);
});

test("a local install inherits the server environment with the setup PATH, one PATH key on Windows", () => {
    const posixEnv = installEnvironment({ PATH: "/usr/bin", HOME: "/home/u" }, { PATH: "/usr/bin:/home/u/.local/bin" }, "linux");
    assert.equal(posixEnv.PATH, "/usr/bin:/home/u/.local/bin");
    assert.equal(posixEnv.HOME, "/home/u");
    assert.equal(posixEnv.npm_config_fund, "false");
    const windowsEnv = installEnvironment({ Path: "C:\\Windows", USERPROFILE: "C:\\Users\\u" }, { PATH: "C:\\Windows;C:\\Users\\u\\.local\\bin" }, "win32");
    assert.deepEqual(Object.keys(windowsEnv).filter((key) => key.toUpperCase() === "PATH"), ["PATH"]);
    assert.equal(installEnvironment({ POLYTH_SAFE_TOKEN: "x", HOME: "/h" }, {}, "linux").POLYTH_SAFE_TOKEN, undefined, "vault references never reach an installer");
});

// ---- jobs --------------------------------------------------------------

type Fake = InstallProcess & { emit(text: string): void; exit(code: number | null): void; killed: boolean };
const fakeProcess = (): Fake => {
    const outputs: Array<(text: string) => void> = [];
    const exits: Array<(code: number | null) => void> = [];
    const fake: Fake = {
        killed: false,
        onOutput: (listener) => { outputs.push(listener); },
        onExit: (listener) => { exits.push(listener); },
        async kill() { fake.killed = true; fake.exit(null); },
        emit: (text) => { for (const listener of outputs) listener(text); },
        exit: (code) => { for (const listener of exits.splice(0)) listener(code); },
    };
    return fake;
};

const preview = (harnessId: string) => ({
    harnessId, harnessName: harnessId === "agy" ? "Antigravity" : "Codex", target: "local" as const,
    machine: { kind: "local" as const, os: "linux" as const }, command: `install ${harnessId}`, sources: [], browserOnMachine: true,
});

test("an install runs, verifies, and reports what Polyth now finds; a second start joins it", async () => {
    const jobs = createHarnessInstallJobs();
    const process = fakeProcess();
    const commands: string[] = [];
    const first = jobs.start({
        key: "local:agy", queueKey: "local", preview: preview("agy"),
        launch: async (command) => { commands.push(command); return process; },
        verify: async () => ({ installed: true, version: "1.4.7", state: "unknown" }),
    });
    assert.equal(first.phase, "queued");
    await until(() => jobs.get("local:agy")?.phase === "running", "running");
    const joined = jobs.start({ key: "local:agy", queueKey: "local", preview: preview("agy"), launch: async () => { throw new Error("must not launch twice"); }, verify: async () => ({ installed: false, state: "not-installed" }) });
    assert.equal(joined.id, first.id, "a second click joins the running install");
    process.emit("⠋ Downloading release package...\n");
    assert.equal(jobs.get("local:agy")?.activity, "Downloading release package...");
    process.exit(0);
    await until(() => jobs.get("local:agy")?.phase === "succeeded", "succeeded");
    const done = jobs.get("local:agy")!;
    assert.deepEqual(commands, ["install agy"], "exactly the previewed command runs");
    assert.deepEqual(done.result, { installed: true, version: "1.4.7", state: "unknown" });
    assert.equal(done.exitCode, 0);
    assert.ok(done.finishedAt! >= done.startedAt);
    assert.equal(jobs.list().length, 1);
});

test("installs on one machine run one after another; other machines do not wait", async () => {
    const jobs = createHarnessInstallJobs();
    const a = fakeProcess();
    const b = fakeProcess();
    const c = fakeProcess();
    const verify = async () => ({ installed: true, state: "ready" as const });
    jobs.start({ key: "local:codex", queueKey: "local", preview: preview("codex"), launch: async () => a, verify });
    jobs.start({ key: "local:pi", queueKey: "local", preview: preview("pi"), launch: async () => b, verify });
    jobs.start({ key: "ssh:c1:codex", queueKey: "ssh:c1", preview: preview("codex"), launch: async () => c, verify });
    await until(() => jobs.get("local:codex")?.phase === "running" && jobs.get("ssh:c1:codex")?.phase === "running", "first runs");
    await tick();
    assert.equal(jobs.get("local:pi")?.phase, "queued", "npm installers share the Node.js download");
    a.exit(0);
    await until(() => jobs.get("local:pi")?.phase === "running", "second runs after the first");
    b.exit(1);
    c.exit(0);
    await until(() => jobs.get("local:pi")?.phase === "failed" && jobs.get("ssh:c1:codex")?.phase === "succeeded", "all done");
});

test("cancel stops a running install or drops a queued one; neither counts as a failure", async () => {
    const jobs = createHarnessInstallJobs();
    const running = fakeProcess();
    let launchedSecond = false;
    jobs.start({ key: "local:a", queueKey: "local", preview: preview("a"), launch: async () => running, verify: async () => ({ installed: true, state: "ready" }) });
    jobs.start({ key: "local:b", queueKey: "local", preview: preview("b"), launch: async () => { launchedSecond = true; return fakeProcess(); }, verify: async () => ({ installed: true, state: "ready" }) });
    await until(() => jobs.get("local:a")?.phase === "running", "running");
    assert.equal((await jobs.cancel("local:b"))?.phase, "cancelled");
    await jobs.cancel("local:a");
    assert.equal(running.killed, true);
    await until(() => jobs.get("local:a")?.phase === "cancelled", "cancelled");
    await tick();
    assert.equal(launchedSecond, false, "a cancelled queued install never launches");
    assert.equal(await jobs.cancel("local:none"), undefined);
});

test("a Stop that lands after a successful exit still reports the install", async () => {
    const jobs = createHarnessInstallJobs();
    const child = fakeProcess();
    child.kill = async () => { child.killed = true; };
    jobs.start({ key: "local:a", queueKey: "local", preview: preview("a"), launch: async () => child, verify: async () => ({ installed: true, state: "unknown" }) });
    await until(() => jobs.get("local:a")?.phase === "running", "running");
    const stopping = jobs.cancel("local:a");
    child.exit(0);
    await stopping;
    await until(() => jobs.get("local:a")?.phase === "succeeded", "verified despite the late Stop");
});

test("a failed exit, a timeout, a launch error and a missing CLI after install are explained", async () => {
    const jobs = createHarnessInstallJobs({ timeoutMs: 50 });
    const failing = fakeProcess();
    jobs.start({ key: "local:a", queueKey: "q1", preview: preview("a"), launch: async () => failing, verify: async () => ({ installed: true, state: "ready" }) });
    await until(() => jobs.get("local:a")?.phase === "running", "running");
    failing.emit("curl: (6) Could not resolve host: example.com\n");
    failing.exit(6);
    await until(() => jobs.get("local:a")?.phase === "failed", "failed");
    assert.equal(jobs.get("local:a")?.failure?.kind, "network");

    const hanging = fakeProcess();
    jobs.start({ key: "local:b", queueKey: "q2", preview: preview("b"), launch: async () => hanging, verify: async () => ({ installed: true, state: "ready" }) });
    await until(() => jobs.get("local:b")?.phase === "failed", "timed out");
    assert.equal(jobs.get("local:b")?.failure?.kind, "timeout");
    assert.equal(hanging.killed, true);

    jobs.start({ key: "local:c", queueKey: "q3", preview: preview("c"), launch: async () => { throw new Error("spawn /bin/sh ENOENT"); }, verify: async () => ({ installed: true, state: "ready" }) });
    await until(() => jobs.get("local:c")?.phase === "failed", "launch failed");
    assert.match(jobs.get("local:c")!.output, /ENOENT/);

    const clean = fakeProcess();
    jobs.start({ key: "local:d", queueKey: "q4", preview: preview("d"), launch: async () => clean, verify: async () => ({ installed: false, state: "not-installed" }) });
    await until(() => jobs.get("local:d")?.phase === "running", "running");
    clean.exit(0);
    await until(() => jobs.get("local:d")?.phase === "failed", "not found");
    assert.equal(jobs.get("local:d")?.failure?.kind, "not-found-after-install");

    // `curl … | bash`: curl fails, bash runs an empty script and exits 0.
    const piped = fakeProcess();
    jobs.start({ key: "local:e", queueKey: "q5", preview: preview("e"), launch: async () => piped, verify: async () => ({ installed: false, state: "not-installed" }) });
    await until(() => jobs.get("local:e")?.phase === "running", "running");
    piped.emit("curl: (6) Could not resolve host: antigravity.google\n");
    piped.exit(0);
    await until(() => jobs.get("local:e")?.phase === "failed", "piped failure");
    assert.equal(jobs.get("local:e")?.failure?.kind, "network", "the installer's words beat a clean pipeline exit");
});

test("package teardown interrupts every install; finished ones expire", async () => {
    let now = 1_000;
    const jobs = createHarnessInstallJobs({ now: () => now, retainMs: 100 });
    const running = fakeProcess();
    jobs.start({ key: "local:a", queueKey: "local", preview: preview("a"), launch: async () => running, verify: async () => ({ installed: true, state: "ready" }) });
    jobs.start({ key: "local:b", queueKey: "local", preview: preview("b"), launch: async () => fakeProcess(), verify: async () => ({ installed: true, state: "ready" }) });
    await until(() => jobs.get("local:a")?.phase === "running", "running");
    await jobs.interruptAll();
    await until(() => jobs.get("local:a")?.phase === "failed", "interrupted");
    assert.equal(jobs.get("local:a")?.failure?.kind, "interrupted");
    assert.equal(jobs.get("local:b")?.failure?.kind, "interrupted");
    assert.equal(running.killed, true);
    now += 1_000;
    assert.equal(jobs.list().length, 0);
});

// ---- real processes ------------------------------------------------------

test("the local launcher runs the system shell with stdin closed and reports the exit", { skip: !posix }, async () => {
    const launch = localInstallLauncher({ env: async () => ({}) });
    const child = await launch("printf 'step\\rdone\\n'; echo oops >&2; read answer; echo \"answer:[$answer]\"; exit 3");
    let text = "";
    child.onOutput((chunk) => { text += chunk; });
    const code = await new Promise<number | null>((resolve) => child.onExit(resolve));
    assert.equal(code, 3);
    const output = createInstallOutput();
    output.append(text);
    // stdout and stderr are separate pipes, so only each line's text is fixed.
    assert.match(output.text(), /^done$/m, "the redrawn line keeps its final state");
    assert.doesNotMatch(output.text(), /step/);
    assert.match(output.text(), /^oops$/m, "stderr is part of the output");
    assert.match(output.text(), /^answer:\[\]$/m, "nothing can wait for an answer");
});

test("cancelling a local install ends its whole process tree", { skip: !posix }, async () => {
    const launch = localInstallLauncher({ env: async () => ({}) });
    const child = await launch("sleep 30 & echo $!; wait");
    let text = "";
    child.onOutput((chunk) => { text += chunk; });
    await until(() => /\d+/.test(text), "grandchild pid");
    const grandchild = Number(/\d+/.exec(text)![0]);
    const exited = new Promise<number | null>((resolve) => child.onExit(resolve));
    const started = Date.now();
    await child.kill();
    await exited;
    assert.ok(Date.now() - started < 3_000, "SIGTERM reaches the group");
    await until(() => { try { process.kill(grandchild, 0); return false; } catch { return true; } }, "grandchild gone");
});

const systemdUser = process.platform === "linux"
    && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 2_000 }).status === 0
    && spawnSync("sh", ["-c", "command -v systemd-run"], { stdio: "ignore" }).status === 0;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a contained install ends even a descendant that left the process group, and leaves no record", { skip: !systemdUser }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "polyth-install-containment-"));
    try {
        const launch = localInstallLauncher({ env: async () => ({}), containment: createInstallContainment(dir) });
        const child = await launch("setsid sleep 37 & echo $!; wait");
        let text = "";
        child.onOutput((chunk) => { text += chunk; });
        await until(() => /\d+/.test(text), "escaped pid");
        const escaped = Number(/\d+/.exec(text)![0]);
        assert.ok(readdirSync(dir).some((name) => name.endsWith(".authority")), "the install has a durable record while it runs");
        const exited = new Promise((resolve) => child.onExit(resolve));
        await child.kill();
        await exited;
        await until(() => !alive(escaped), "the setsid descendant is gone", 8_000);
        await until(() => readdirSync(dir).length === 0, "record removed after release", 8_000);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("recovery releases an installer an earlier Polyth process left running", { skip: !systemdUser }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "polyth-install-recovery-"));
    try {
        // A launch whose owner never released it (as after a crash).
        const orphaned = await createInstallContainment(dir).create();
        assert.ok(orphaned);
        const launch = orphaned.boundary.launch("/bin/sh", ["-c", "sleep 41"]);
        const child = spawnSync("sh", ["-c", `${launch.command} ${launch.args.map((arg) => `'${arg}'`).join(" ")} >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
        const pid = Number(child.stdout.trim());
        await until(() => alive(pid), "started");
        await createInstallContainment(dir).recover();
        await until(() => !alive(pid), "released by recovery", 8_000);
        assert.deepEqual(readdirSync(dir), []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the remote launcher runs on the host's harness PATH with stdin closed", async () => {
    const started: string[] = [];
    const remote: Pick<RemoteHost, "start"> = {
        async start(command) {
            started.push(command);
            return { onOutput: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: async () => {} };
        },
    };
    await remoteInstallLauncher(remote, REMOTE_SETUP_PATH)("curl -fsSL https://example.com/install.sh | bash");
    const inner = `${REMOTE_SETUP_PATH}; ( curl -fsSL https://example.com/install.sh | bash ) </dev/null 2>&1`;
    assert.deepEqual(started, [`exec /bin/sh -c '${inner}'`], "never the SSH user's login shell");
    const parsed = spawnSync("/bin/sh", ["-c", `printf '%s' ${started[0]!.slice("exec /bin/sh -c ".length)}`], { encoding: "utf8" }).stdout;
    assert.equal(parsed, inner, "the quoting round-trips through a POSIX shell");
});

// ---- route -------------------------------------------------------------

const codex: HarnessDescriptor = {
    id: "codex", name: "Codex", integration: "App Server", priority: 50, setupUrl: "https://example.com/codex",
    installCommand: "printf 'installing codex\\n'",
    remoteHost: { binary: "codex", installCommand: "echo remote", sessions: true },
};
const guideOnly: HarnessDescriptor = { id: "guide", name: "Guide", integration: "x", priority: 60, setupUrl: "https://example.com" };
const ownerSpace = { spaceId: "space-a", spaceSlug: "space-a", userId: "user-a", role: "owner", deployment: "local-trusted", storageDir: "/tmp/polyth-space-a" } as SpaceContext;
const localProject: Project = { id: "p-local", path: "/work/app", name: "app", createdAt: 0 };
const sshProject = { id: "p-ssh", path: "/srv/app", name: "app", createdAt: 0, remote: { kind: "ssh", connectionId: "c1" } } as Project;

function routeHost(log: { invalidated: string[]; started: string[]; probed: number }, sshAllowed = true) {
    const services = createServerServiceRegistry();
    const descriptors = [codex, guideOnly];
    services.provide(serverServiceKey<HarnessRegistry>("harnesses"), {
        get: (id: string) => {
            const descriptor = descriptors.find((row) => row.id === id);
            return descriptor ? { descriptor } : undefined;
        },
        providers: () => descriptors.map((descriptor) => ({ descriptor })),
        invalidate(filter: { harnessId?: string }) { log.invalidated.push(filter.harnessId ?? "*"); },
        async snapshots(_context: unknown, options: { harnessId?: string; force?: boolean }) {
            log.probed += 1;
            assert.equal(options.force, true, "the check after an install is a fresh probe");
            return [{ identity: { id: options.harnessId, name: "Codex", integration: "x", version: "codex-cli 0.160.0" }, availability: { installed: true, state: "unknown" } } as unknown as HarnessSnapshot];
        },
    } as unknown as HarnessRegistry);
    services.provide(serverServiceKey<{ host(id: string): RemoteHost; usable(id: string, principal: { kind: string; userId?: string }): boolean }>("ssh"), {
        // The project's binding may use it; the person asking is checked too.
        usable: (_id, principal) => principal.kind === "person" ? sshAllowed : true,
        host: () => ({
            label: "dev@build-box",
            processCommand: () => ({ command: "ssh", args: [] }),
            async start(command: string) {
                log.started.push(command);
                const exits: Array<(code: number | null) => void> = [];
                setTimeout(() => { for (const exit of exits) exit(0); }, 5);
                return { onOutput: () => ({ dispose() {} }), onExit: (listener: (code: number | null) => void) => { exits.push(listener); return { dispose() {} }; }, kill: async () => {} };
            },
        } as unknown as RemoteHost),
    });
    const projects = [localProject, sshProject];
    const projectService = { async list() { return projects; }, async get(id: string) { return projects.find((row) => row.id === id); } };
    return {
        services,
        projects: projectService,
        spaceStorage: () => ({ path: (value: string) => `/tmp/${value}` }),
        forSpace: () => ({ projects: projectService }),
    } as unknown as ServerPackageHost;
}

function caller(routes: ReturnType<typeof harnessRoutes>) {
    return async (input: { method: "GET" | "POST" | "DELETE"; path: string; body?: Record<string, unknown>; principal?: string; space?: Record<string, unknown>; loopback?: boolean }) => {
        let payload: unknown;
        const url = new URL(`http://localhost${input.path}`);
        const handled = await routes({
            path: url.pathname, method: input.method, url,
            space: { ...ownerSpace, ...input.space },
            principal: { kind: input.principal ?? "local-user" },
            ingress: { kind: "public-http", listenerId: "l", loopback: input.loopback ?? true, secure: false },
            async body() { return input.body ?? {}; },
            json(_status: number, body: unknown) { payload = body; },
        } as unknown as RouteRequest);
        assert.equal(handled, true);
        return payload;
    };
}

test("the route previews, starts, lists and cancels a local install with the server-chosen command", { skip: !posix }, async () => {
    const log = { invalidated: [] as string[], started: [] as string[], probed: 0 };
    const jobs = createHarnessInstallJobs();
    const call = caller(harnessRoutes(routeHost(log), jobs));
    const read = await call({ method: "GET", path: "/api/harnesses/codex/install" }) as { preview: HarnessInstallDto; job: null };
    assert.equal(read.job, null);
    assert.deepEqual({ ...read.preview, machine: read.preview.machine.kind }, {
        harnessId: "codex", harnessName: "Codex", target: "local", machine: "local", command: codex.installCommand,
        sources: [], browserOnMachine: true, setupUrl: "https://example.com/codex",
    });
    const started = await call({ method: "POST", path: "/api/harnesses/codex/install", body: { projectId: "p-local", command: "rm -rf /" } }) as HarnessInstallDto;
    assert.equal(started.command, codex.installCommand, "a command in the body is ignored");
    await until(() => jobs.get("local:codex")?.phase === "succeeded", "installed");
    const done = (await call({ method: "GET", path: "/api/harnesses/codex/install" }) as { job: HarnessInstallDto }).job;
    assert.equal(done.output, "installing codex");
    assert.deepEqual(done.result, { installed: true, version: "codex-cli 0.160.0", state: "unknown" });
    assert.deepEqual(log.invalidated, ["codex"]);
    assert.equal(log.probed, 1);
    const listed = await call({ method: "GET", path: "/api/harnesses/installs?projectId=p-local" }) as HarnessInstallDto[];
    assert.deepEqual(listed.map((job) => job.harnessId), ["codex"]);
    assert.equal((await call({ method: "GET", path: "/api/harnesses/installs" }) as unknown[]).length, 1, "no project open still means this machine");
    assert.deepEqual(await call({ method: "GET", path: "/api/harnesses/installs?projectId=p-ssh" }), [],
        "a project whose chats run Codex on its SSH host shows that host's install, not this machine's");
    assert.equal((await call({ method: "DELETE", path: "/api/harnesses/codex/install" }) as HarnessInstallDto).phase, "succeeded", "cancelling a finished install changes nothing");
});

test("a remote project's install runs on its SSH host and is listed only there", async () => {
    const log = { invalidated: [] as string[], started: [] as string[], probed: 0 };
    const jobs = createHarnessInstallJobs();
    const call = caller(harnessRoutes(routeHost(log), jobs));
    const read = await call({ method: "GET", path: "/api/harnesses/codex/install?projectId=p-ssh" }) as { preview: HarnessInstallDto };
    assert.deepEqual(read.preview.machine, { kind: "remote", label: "dev@build-box" });
    assert.equal(read.preview.command, "echo remote");
    assert.equal(read.preview.browserOnMachine, false);
    await call({ method: "POST", path: "/api/harnesses/codex/install", body: { projectId: "p-ssh" } });
    await until(() => jobs.get("ssh:c1:codex")?.phase === "succeeded", "remote installed");
    assert.deepEqual(log.started, [`exec /bin/sh -c '${REMOTE_SETUP_PATH}; ( echo remote ) </dev/null 2>&1'`]);
    assert.deepEqual(await call({ method: "GET", path: "/api/harnesses/installs?projectId=p-local" }), [], "another machine's install is not listed");
    assert.equal((await call({ method: "GET", path: "/api/harnesses/installs?projectId=p-ssh" }) as unknown[]).length, 1);
});

test("installs need harness management, a known project and an automatic installer", async () => {
    const log = { invalidated: [] as string[], started: [] as string[], probed: 0 };
    const call = caller(harnessRoutes(routeHost(log), createHarnessInstallJobs()));
    const member = { instanceOwner: false, harnessPersonal: true, userId: "user-a" };
    await assert.rejects(call({ method: "POST", path: "/api/harnesses/codex/install", body: {}, principal: "ui-session", space: member }), { code: "forbidden" });
    await assert.rejects(call({ method: "GET", path: "/api/harnesses/codex/install", principal: "ui-session", space: member }), { code: "forbidden" });
    assert.deepEqual(await call({ method: "GET", path: "/api/harnesses/installs", principal: "ui-session", space: member }), [], "a person who cannot install sees none");
    await assert.rejects(call({ method: "POST", path: "/api/harnesses/codex/install", body: {}, space: { deployment: "multi-tenant-sandboxed" } }), { code: "forbidden" });
    await assert.rejects(call({ method: "GET", path: "/api/harnesses/guide/install" }), { code: "unsupported" });
    await assert.rejects(call({ method: "GET", path: "/api/harnesses/missing/install" }), { code: "not-found" });
    await assert.rejects(call({ method: "POST", path: "/api/harnesses/codex/install", body: { projectId: "other-space" } }), { code: "not-found" });
});

test("a host install needs the person to be allowed to use that SSH connection", async () => {
    const log = { invalidated: [] as string[], started: [] as string[], probed: 0 };
    const jobs = createHarnessInstallJobs();
    const allowed = caller(harnessRoutes(routeHost(log, true), jobs));
    await allowed({ method: "POST", path: "/api/harnesses/codex/install", body: { projectId: "p-ssh" } });
    await until(() => jobs.get("ssh:c1:codex")?.phase === "succeeded", "installed by an allowed person");
    const denied = caller(harnessRoutes(routeHost(log, false), jobs));
    await assert.rejects(denied({ method: "GET", path: "/api/harnesses/codex/install?projectId=p-ssh" }), { code: "not-found" });
    await assert.rejects(denied({ method: "POST", path: "/api/harnesses/codex/install", body: { projectId: "p-ssh" } }), { code: "not-found" });
    await assert.rejects(denied({ method: "DELETE", path: "/api/harnesses/codex/install?projectId=p-ssh" }), { code: "not-found" });
    assert.deepEqual(await denied({ method: "GET", path: "/api/harnesses/installs?projectId=p-ssh" }), [], "nor read its output");
    assert.equal(log.started.length, 1);
});
