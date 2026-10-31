import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { HarnessProvider, HarnessRegistry, HarnessVersionStore, SmallModelCompletionRequest } from "@polyth/contracts";
import { releaseHarnessProcessExecution } from "@polyth/harness-runtime";
import { discoverHarnessExecutable, harnessExecutableChildEnv, windowsCmdShimTarget } from "@polyth/harness-runtime/executable-discovery";
import { createHarnessProcessAuthority } from "@polyth/harness-runtime/process-authority";
import { execRemoteHarness, probeRemoteHarness, remoteHarnessLaunch, resolveRemoteHarnessHost, type RemoteProcessHost } from "@polyth/harness-runtime/remote-host";
import { createHarnessAccountFamily, harnessCommandLine, type HarnessAccountStatus, type ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { vendorScriptInstallCommand } from "@polyth/harness-runtime/installers";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { claudeAuthFingerprint, createClaudeRuntime, discoverClaudeModels, invalidateClaudeModelCache, CLAUDE_CAPABILITIES } from "./index.ts";
import { gateClaudeAgentTools, hasPolythAgentToolsMcp } from "./mcpReadiness.ts";
import { createClaudeNativePlugins } from "./nativePlugins.ts";
import { claudeConfigDir, createClaudePreferences, nativeSkillsUnsupported } from "./preferences.ts";
import { createClaudeProvisioner } from "./provisioner.ts";
import { createClaudeSmallModelRunner } from "./smallModel.ts";
import { claudeProjectsDir, listClaudeSessions, readClaudeSession } from "./history.ts";
const exec = promisify(execFile);
const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
/** Local report commands. A shim left on `cmd.exe` gets its path quoted: the
 *  shell joins the argv unquoted, so `C:\Users\Jane Doe\…` would split. */
const execCli = (command: string, args: string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => {
    const shell = windowsShim(command);
    return exec(shell ? `"${command}"` : command, args, { ...options, shell, windowsHide: true });
};
// Optional SDK is loaded only by this package, never a server boot prerequisite.
const loadSdk = () => import("@anthropic-ai/claude-agent-sdk");

type ClaudeSessionInfoLike = {
    customTitle?: string | null;
    summary?: string | null;
    firstPrompt?: string | null;
};

/**
 * Agent-SDK sessions can report the first user prompt through `summary` even
 * when no semantic title was ever generated. `customTitle`, in contrast, is an
 * explicit native title. When the SDK also gives us `firstPrompt`, a different
 * summary is the SDK's semantic title; only prompt-derived summaries are
 * hidden from the runtime title-ingestion path.
 */
export function titleSafeClaudeSessionInfo<T extends ClaudeSessionInfoLike | null | undefined>(info: T): T {
    if (!info || info.customTitle) return info;
    const summary = info.summary?.trim().replace(/\s+/g, " ").toLowerCase();
    const prompt = info.firstPrompt?.trim().replace(/\s+/g, " ").toLowerCase();
    const firstLine = info.firstPrompt?.split(/\r?\n/).find((line) => line.trim())?.trim().replace(/\s+/g, " ").toLowerCase();
    if (summary && prompt && summary !== prompt && summary !== firstLine) return info;
    return { ...info, summary: "" } as T;
}

type ClaudeSpawnOptions = Parameters<NonNullable<NonNullable<Parameters<Awaited<ReturnType<typeof loadSdk>>["query"]>[0]["options"]>["spawnClaudeCodeProcess"]>>[0];

/** Bare name of the CLI on a remote host's harness PATH. */
export const CLAUDE_REMOTE_BINARY = "claude";
/** Anthropic's native installers (code.claude.com/docs/en/setup). */
const CLAUDE_INSTALLER = { posix: "https://claude.ai/install.sh", windowsPowerShell: "https://claude.ai/install.ps1" };
/** The native installer and `claude update` put each release at
 *  `…/claude/versions/<version>` (the executable itself) and point the
 *  launcher at it; the updater keeps older ones for rollback. */
export const CLAUDE_VERSION_STORE: HarnessVersionStore = {
    directory(executablePath) {
        const versions = dirname(executablePath);
        return basename(versions) === "versions" && basename(dirname(versions)) === "claude" ? versions : undefined;
    },
    entry: /^[0-9]+\.[0-9]+\.[0-9]+$/,
};
/** SDK protocol markers only; local credentials and config never travel. */
const REMOTE_CLAUDE_ENV = /^(?:CLAUDE_CODE_ENTRYPOINT|CLAUDE_AGENT_SDK_[A-Z0-9_]+)$/;
const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** The SDK's spawn request, re-aimed at the remote host over SSH. */
export const remoteClaudeSpawnOptions = (remote: RemoteProcessHost, options: ClaudeSpawnOptions, cwd: string): ClaudeSpawnOptions => {
    const env = Object.fromEntries(Object.entries(options.env)
        .filter((entry): entry is [string, string] => REMOTE_CLAUDE_ENV.test(entry[0]) && typeof entry[1] === "string"));
    const launch = remoteHarnessLaunch(remote, [options.command, ...options.args], { cwd: options.cwd ?? cwd, env });
    return { ...options, command: launch.command, args: launch.args, cwd: launch.cwd, env: launch.env };
};

/** Whether the host's own Claude Code keeps a transcript for `id`. */
const remoteClaudeSessionExists = async (remote: RemoteProcessHost, id: string): Promise<boolean> => {
    if (!NATIVE_SESSION_ID.test(id)) return false;
    const result = await execRemoteHarness(remote, [
        "sh", "-c",
        'for f in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl; do [ -f "$f" ] && exit 0; done; exit 1',
        "sh", id,
    ], 15_000);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw Object.assign(new Error(`Could not reach ${remote.label}`), { code: "runtime-unavailable" });
};

export const titleSafeClaudeSdk = (
    sdk: Awaited<ReturnType<typeof loadSdk>>,
    command: string,
    env: NodeJS.ProcessEnv,
    /** Runs the CLI on this host instead; its transcripts live there too. */
    remote?: { host: RemoteProcessHost; cwd: string },
) => {
    return {
        query(...args: Parameters<typeof sdk.query>) {
            const params = args[0];
            const options = params.options ?? {};
            const owned = options.spawnClaudeCodeProcess;
            const query = sdk.query({
                ...params,
                options: {
                    ...options,
                    // A bare name is a native binary to the SDK, resolved on
                    // the host's PATH by the remote shell.
                    pathToClaudeCodeExecutable: remote ? CLAUDE_REMOTE_BINARY : command,
                    env: { ...env, ...options.env },
                    ...(remote ? {
                        spawnClaudeCodeProcess(spawnOptions: ClaudeSpawnOptions) {
                            const target = remoteClaudeSpawnOptions(remote.host, spawnOptions, remote.cwd);
                            if (owned) return owned(target);
                            const child = spawn(target.command, target.args, { cwd: target.cwd, env: target.env, signal: target.signal, stdio: ["pipe", "pipe", "pipe"] });
                            child.stderr.resume();
                            return child;
                        },
                    } : {}),
                },
            });
            return gateClaudeAgentTools(
                query,
                hasPolythAgentToolsMcp(options.mcpServers),
            );
        },
        async getSessionInfo(...args: Parameters<typeof sdk.getSessionInfo>) {
            // Remote transcripts are not readable here; existence is enough
            // to resume, and titles stay Polyth's emulated ones.
            if (remote) {
                return await remoteClaudeSessionExists(remote.host, args[0])
                    ? { sessionId: args[0] } as unknown as Awaited<ReturnType<typeof sdk.getSessionInfo>>
                    : undefined;
            }
            return titleSafeClaudeSessionInfo(await sdk.getSessionInfo(...args));
        },
    };
};

const loadTitleSafeClaudeSdk = async (command: string, env: NodeJS.ProcessEnv, remote?: { host: RemoteProcessHost; cwd: string }) =>
    titleSafeClaudeSdk(await loadSdk(), command, env, remote);

/** Last resolved executable; lets the synchronous descriptor offer a sign-in
 *  command that works from a profile-less terminal shell. */
let knownClaudeCommand: string | undefined;

const resolveClaudeBinary = async () => {
    const requested = process.env.POLYTH_CLAUDE_BIN?.trim() || "claude";
    const report = await discoverHarnessExecutable(requested);
    if (!report.hit) {
        throw Object.assign(new Error(`Claude Code CLI was not found (${report.searched.slice(0, 8).join(", ") || "no searchable locations"})`), { code: "not-installed" });
    }
    const launcher = report.hit.executablePath;
    knownClaudeCommand = report.hit.launcherPath ?? launcher;
    // npm installs Claude Code on Windows as a `claude.cmd` shim around a
    // native `claude.exe`. A `.cmd` only starts through `cmd.exe`, which
    // re-parses every SDK argument and splits a path with spaces, so run the
    // program the shim runs. An older npm release shims `cli.js` instead: the
    // SDK runs that through `node` (it cannot spawn a `.cmd`), while the short
    // CLI reports keep the shim.
    const target = windowsShim(launcher) ? await windowsCmdShimTarget(launcher, { scripts: true }) : undefined;
    const command = target && !/\.m?js$/i.test(target) ? target : launcher;
    return { command, sdkCommand: target ?? launcher, env: await harnessExecutableChildEnv(launcher) };
};

/** First line of why the CLI could not be found or started, bounded. */
const probeFailureMessage = (error: unknown): string | undefined => {
    const failure = error as { code?: unknown; message?: unknown; stderr?: unknown };
    if (failure?.code === "not-installed" && typeof failure.message === "string") return failure.message.slice(0, 300);
    const stderr = typeof failure?.stderr === "string" ? failure.stderr.trim().split(/\r?\n/)[0] : "";
    const detail = stderr || (typeof failure?.message === "string" ? failure.message.split(/\r?\n/)[0]! : "");
    return detail ? `Claude Code CLI did not start: ${detail}`.slice(0, 300) : undefined;
};

const accountEnv = (account?: ResolvedHarnessAccount): Record<string, string> =>
    account ? { CLAUDE_CONFIG_DIR: account.dir } : {};

/** `claude auth status` is a local report; it never runs a model turn. */
const claudeAccountStatus = async (account?: ResolvedHarnessAccount): Promise<HarnessAccountStatus> => {
    const { command, env } = await resolveClaudeBinary();
    const { stdout } = await execCli(command, ["auth", "status", "--json"], {
        timeout: 5000,
        maxBuffer: 8192,
        env: { ...env, ...accountEnv(account) },
    }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
    const report = JSON.parse(stdout) as { loggedIn?: unknown; email?: unknown; subscriptionType?: unknown };
    return {
        loggedIn: report.loggedIn === true,
        ...(typeof report.email === "string" && report.email ? { email: report.email } : {}),
        ...(typeof report.subscriptionType === "string" && report.subscriptionType ? { plan: report.subscriptionType } : {}),
    };
};

/** One Claude Code harness. The default serves the user's own `~/.claude`;
 *  every extra account is a separate harness bound to its own
 *  `CLAUDE_CONFIG_DIR`, which holds that account's credentials and native
 *  transcripts. */
export function createClaudeProvider(host: ServerPackageHost, account?: ResolvedHarnessAccount): HarnessProvider {
    const harnessId = account ? account.harnessId : "claude";
    const projectsDir = account ? join(account.dir, "projects") : claudeProjectsDir();
    const resolveBinary = async () => {
        const resolved = await resolveClaudeBinary();
        return { command: resolved.command, sdkCommand: resolved.sdkCommand, env: { ...resolved.env, ...accountEnv(account) } };
    };
    const fingerprint = () => claudeAuthFingerprint({ ...process.env, ...accountEnv(account) });
    let lastAuthenticated: boolean | undefined;
    // Late-bound: preferences discover plugin skills, plugins report whether
    // their skills are inherited.
    let preferences: ReturnType<typeof createClaudePreferences> | undefined;
    const plugins = createClaudeNativePlugins({
        harnessId,
        resolveBinary,
        inheritsSkills: async (context) => !nativeSkillsUnsupported(context) && (await preferences!.launch(context)).inheritSkills,
    });
    preferences = createClaudePreferences({
        harnessId,
        configDir: () => claudeConfigDir(account?.dir),
        plugins,
        files: {
            dir(context) {
                if (context.remote || !context.space || context.space.spaceId !== context.spaceId) return undefined;
                return join(host.spaceStorage(context.space).packageDir(host.pluginId), "harnesses", harnessId);
            },
        },
    });
    const settings = preferences;
    const stateFile = (context: Parameters<HarnessProvider["createRuntime"]>[0]) => {
        const key = createHash("sha256").update(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? "catalog"])).digest("hex");
        return host.spaceStorage(context.space!).path(`runtime/${harnessId}/${key}.json`);
    };
    // Extra accounts are local `CLAUDE_CONFIG_DIR`s; only the default harness
    // runs on a remote host, there on the host's own sign-in.
    const remoteHost = async (context: Parameters<HarnessProvider["probe"]>[0]): Promise<RemoteProcessHost | undefined> => {
        if (!context.remote) return undefined;
        if (account) throw Object.assign(new Error("Extra Claude Code accounts run on this machine only"), { code: "unsupported" });
        return resolveRemoteHarnessHost(host, context);
    };
    /** Model-cache identity of a remote host's own sign-in. */
    const remoteFingerprint = (remote: RemoteProcessHost) => `remote:${remote.label}`;
    return {
        // Private sessions run with the SDK's `persistSession: false`.
        descriptor: { id: harnessId, name: "Claude Code", integration: "Agent SDK", priority: 0, setupUrl: "https://code.claude.com/docs/en/setup", installCommand: vendorScriptInstallCommand(CLAUDE_INSTALLER, process.platform), signInCommand: "claude auth login", updateCommand: ["claude", "update"], releaseSource: { kind: "npm", package: "@anthropic-ai/claude-code" }, remoteHost: { binary: CLAUDE_REMOTE_BINARY, installCommand: vendorScriptInstallCommand(CLAUDE_INSTALLER), signInCommand: "claude auth login", ...(account ? {} : { sessions: true }) }, privateSessions: true },
        // SDK-hosted sessions do not guarantee a semantic native title. The
        // canonical layer should therefore publish its fallback immediately;
        // an explicit customTitle event may still refine it later.
        staticFeatures: { ...CLAUDE_CAPABILITIES, title: "emulated" },
        versionStore: CLAUDE_VERSION_STORE,
        async probe(context) {
            if (context.remote) {
                if (account) return { harnessId, installed: false, healthy: false, authenticated: "unknown", message: "Extra Claude Code accounts run on this machine only" };
                try {
                    await loadSdk();
                }
                catch {
                    return { harnessId, installed: false, healthy: false, authenticated: "unknown", message: "Optional Claude Agent SDK dependency is unavailable" };
                }
                const remote = await remoteHost(context);
                if (remote) return probeRemoteHarness(remote, harnessId, CLAUDE_REMOTE_BINARY);
            }
            try {
                await loadSdk();
            }
            catch {
                return { harnessId, installed: false, healthy: false, authenticated: "unknown", message: "Optional Claude Agent SDK dependency is unavailable" };
            }
            try {
                const { command, env } = await resolveBinary();
                const version = (await execCli(command, ["--version"], { timeout: 5000, maxBuffer: 4096, env })).stdout.trim();
                const authenticated = await execCli(command, ["auth", "status", "--json"], { timeout: 5000, maxBuffer: 8192, env }).then(({ stdout }) => JSON.parse(stdout).loggedIn === true).catch(() => false);
                // A sign-in/out flips what the account can list, so the cached
                // cold catalog must not survive it.
                if (lastAuthenticated !== undefined && lastAuthenticated !== authenticated) {
                    invalidateClaudeModelCache({ executable: command, authFingerprint: fingerprint() });
                }
                lastAuthenticated = authenticated;
                return { harnessId, installed: true, healthy: true, authenticated, version };
            }
            catch (error) {
                // The reason reaches Providers & Models; without it a CLI
                // that exists but fails to start looks simply absent.
                const message = probeFailureMessage(error);
                return { harnessId, installed: false, healthy: false, authenticated: "unknown", ...(message ? { message } : {}) };
            }
        },
        // Model discovery does not need a conversation: the Agent SDK reports
        // the catalog from its `initialize` control response.
        async discover(context) {
            const remote = await remoteHost(context);
            if (remote) {
                // The SDK's `initialize` lists models even when signed out;
                // the host's sign-in shows when a turn runs.
                const sdk = await loadTitleSafeClaudeSdk(CLAUDE_REMOTE_BINARY, process.env, { host: remote, cwd: context.cwd });
                const models = await discoverClaudeModels({
                    query: sdk.query as Parameters<typeof discoverClaudeModels>[0]["query"],
                    cwd: context.cwd,
                    executable: CLAUDE_REMOTE_BINARY,
                    authFingerprint: remoteFingerprint(remote),
                });
                return {
                    state: "ready" as const,
                    capabilities: { ...CLAUDE_CAPABILITIES, title: "emulated" as const },
                    catalog: { models, agents: [] },
                    controls: await settings.controls(context),
                };
            }
            const { command, sdkCommand, env } = await resolveBinary();
            // The SDK answers `initialize` with a model list even for a login
            // that is signed out, so that list alone is no sign-in evidence.
            // With only native credentials (no key in the environment), the
            // CLI's own local report decides.
            if (fingerprint().startsWith("native")) {
                const signedIn = await execCli(command, ["auth", "status", "--json"], { timeout: 5000, maxBuffer: 8192, env })
                    .then(({ stdout }) => JSON.parse(stdout).loggedIn === true, () => false);
                if (!signedIn) {
                    return {
                        state: "auth-required" as const,
                        authenticated: false as const,
                        controls: await settings.controls(context),
                        message: account ? `Sign in to the Claude Code account “${account.name}” to list its models` : "Sign in to Claude Code to list its models",
                    };
                }
            }
            const sdk = await loadTitleSafeClaudeSdk(sdkCommand, env);
            const models = await discoverClaudeModels({
                query: sdk.query as Parameters<typeof discoverClaudeModels>[0]["query"],
                cwd: context.cwd,
                executable: command,
                authFingerprint: fingerprint(),
            });
            return {
                state: "ready" as const,
                authenticated: true,
                capabilities: { ...CLAUDE_CAPABILITIES, title: "emulated" as const },
                catalog: { models, agents: [] },
                controls: await settings.controls(context),
            };
        },
        applyControl: (context, controlId, value) => settings.applyControl(context, controlId, value),
        async createRuntime(context) {
            if (!context.space)
                throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
            const remote = await remoteHost(context);
            if (remote) {
                const authority = await createHarnessProcessAuthority(stateFile(context));
                try {
                    const sdk = await loadTitleSafeClaudeSdk(CLAUDE_REMOTE_BINARY, process.env, { host: remote, cwd: context.cwd });
                    const runtime = await createClaudeRuntime(context, sdk, authority, { harnessId, authFingerprint: remoteFingerprint(remote), launchPreferences: () => settings.launch(context) });
                    const capabilities = runtime.capabilities.bind(runtime);
                    runtime.capabilities = async () => ({ ...await capabilities(), title: "emulated" as const });
                    // Utility print-mode turns are a local CLI run; a remote
                    // leg has none.
                    return runtime;
                }
                catch (error) {
                    await authority.close();
                    throw error;
                }
            }
            const { command, sdkCommand, env } = await resolveBinary();
            const authority = await createHarnessProcessAuthority(stateFile(context));
            try {
                const runtime = await createClaudeRuntime(context, await loadTitleSafeClaudeSdk(sdkCommand, env), authority, { harnessId, authFingerprint: fingerprint(), launchPreferences: () => settings.launch(context) });
                const capabilities = runtime.capabilities.bind(runtime);
                runtime.capabilities = async () => ({ ...await capabilities(), title: "emulated" as const });
                // Stateless utility inference (commit messages, auditors) must not
                // open an SDK session or run a tool-capable turn.
                const smallModel = createClaudeSmallModelRunner({
                    command,
                    cwd: context.cwd,
                    env,
                });
                runtime.completeSmallModel = (request: SmallModelCompletionRequest) => smallModel.complete(request);
                return runtime;
            }
            catch (error) {
                await authority.close();
                throw error;
            }
        },
        async releaseExecution(context, binding, operationId) {
            if (!context.space)
                return { kind: "rejected", code: "unsupported", message: "Local Space context required" };
            // Release proof covers this machine's process boundary only.
            if (context.remote)
                return { kind: "rejected", code: "unsupported", message: "Crash-safe cross-harness switching is not available on remote hosts; this Claude runtime can still be used normally" };
            return releaseHarnessProcessExecution(stateFile(context), binding, operationId);
        },
        provisioner: createClaudeProvisioner({
            harnessId,
            storageRoot(context) {
                if (!context.space || context.space.spaceId !== context.spaceId) return undefined;
                return host.spaceStorage(context.space).packageDir(host.pluginId);
            },
        }),
        plugins,
        skills: settings.skills,
        source: {
            async list(context) {
                if (context.remote) return [];
                return listClaudeSessions(context.cwd, projectsDir);
            },
            read: (context, ref) => {
                if (context.remote) throw Object.assign(new Error("Local execution only"), { code: "unsupported" });
                return readClaudeSession(context, ref, projectsDir);
            },
        },
    };
}

export default function registerPackage(host: ServerPackageHost) {
    const accounts = createHarnessAccountFamily({
        family: "claude",
        label: "Claude Code",
        packageId: "backend-claude",
        storageDir: host.storageDir,
        deployment: host.deployment,
        registry: () => host.services.require(serverServiceKey<HarnessRegistry>("harnesses")),
        createProvider: (account) => createClaudeProvider(host, account),
        status: claudeAccountStatus,
        signInCommand: (account) => harnessCommandLine([knownClaudeCommand ?? "claude", "auth", "login"], accountEnv(account)),
        limitsFamily: "claude",
    });
    return {
        remoteAccess: localOnlyRemoteAccess(["backend-claude"]),
        routes: accounts.routes,
        onEnable: accounts.onEnable,
        async onDisable() {
            await accounts.onDisable();
            invalidateClaudeModelCache();
        },
    };
}
