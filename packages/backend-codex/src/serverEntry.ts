import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessContext, HarnessProvider, HarnessRegistry, SmallModelCompletionRequest } from "@polyth/contracts";
import { createStdioRpc, releaseHarnessProcessExecution } from "@polyth/harness-runtime";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { npmCliInstallCommand } from "@polyth/harness-runtime/installers";
import { probeRemoteHarness, remoteHarnessLaunch, resolveRemoteHarnessHost, type RemoteProcessHost } from "@polyth/harness-runtime/remote-host";
import { createHarnessAccountFamily, harnessCommandLine, type HarnessAccountStatus, type ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createCodexRuntime, CODEX_CAPABILITIES, type Thread } from "./index.ts";
import { createCodexNativePlugins } from "./nativePlugins.ts";
import { createCodexProvisioner } from "./provisioner.ts";
import { createCodexSmallModelRunner } from "./smallModel.ts";
import { withCodexTitleGeneration } from "./title.ts";
const exec = promisify(execFile);
const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

/** Last resolved executable, for the synchronous sign-in command. */
let knownCodexCommand: string | undefined;

const resolveCodexBinary = async () => {
    const requested = process.env.POLYTH_CODEX_BIN?.trim() || "codex";
    const report = await discoverHarnessExecutable(requested);
    if (!report.hit) {
        throw Object.assign(new Error(`Codex CLI was not found (${report.searched.slice(0, 8).join(", ") || "no searchable locations"})`), { code: "not-installed" });
    }
    knownCodexCommand = report.hit.launcherPath ?? report.hit.executablePath;
    return report.hit.executablePath;
};

/** `CODEX_HOME` holds one login's `auth.json`, config and native threads. */
const accountEnv = (account?: ResolvedHarnessAccount): Record<string, string> =>
    account ? { CODEX_HOME: account.dir } : {};

const codexEnv = async (command: string, account?: ResolvedHarnessAccount): Promise<NodeJS.ProcessEnv> =>
    ({ ...await harnessExecutableChildEnv(command), ...accountEnv(account) });

const CODEX_REMOTE_BINARY = "codex";

/** With `remote`, the App Server runs on that SSH host with its own login. */
export async function connectCodex(context: HarnessContext, stateFile?: string, account?: ResolvedHarnessAccount, remote?: RemoteProcessHost) {
    const launch = remote
        ? remoteHarnessLaunch(remote, [CODEX_REMOTE_BINARY, "app-server"], { cwd: context.cwd })
        : await (async () => {
            const command = await resolveCodexBinary();
            return { command, args: ["app-server"], cwd: context.cwd, env: await codexEnv(command, account) };
        })();
    const rpc = await createStdioRpc({ ...launch, stateFile, stableAuthority: true });
    try {
        await rpc.request("initialize", { clientInfo: { name: "polyth", title: "Polyth", version: "0.1.0" } });
        rpc.notify("initialized", {});
        return rpc;
    }
    catch (error) {
        await rpc.close();
        throw error;
    }
}

const createManagedCodexRuntime = async (context: HarnessContext, harnessId: string, stateFile?: string, account?: ResolvedHarnessAccount, remote?: RemoteProcessHost) => {
    const rpc = await connectCodex(context, stateFile, account, remote);
    try {
        const runtime = await createCodexRuntime(context, rpc, { harnessId });
        // An ephemeral thread refuses `thread/name/set`, so the hidden title
        // turn would be wasted; a private session keeps Polyth's own title.
        return context.privateSession ? runtime : withCodexTitleGeneration(context, rpc, runtime);
    }
    catch (error) {
        await rpc.close().catch(() => {});
        throw error;
    }
};

/** `codex login status` is a local report (exit 0 signed in, 1 not). */
const codexAccountStatus = async (
    account?: ResolvedHarnessAccount,
    resolved?: { command: string; env: NodeJS.ProcessEnv },
): Promise<HarnessAccountStatus> => {
    const command = resolved?.command ?? await resolveCodexBinary();
    const result = await exec(command, ["login", "status"], {
        timeout: 10_000,
        maxBuffer: 8192,
        env: resolved?.env ?? await codexEnv(command, account),
        shell: windowsShim(command),
    }).then(({ stdout, stderr }) => ({ ok: true, text: `${stdout}\n${stderr}` }), (error: { code?: unknown; stdout?: string; stderr?: string }) =>
        ({ ok: false, exit: error.code, text: `${error.stdout ?? ""}\n${error.stderr ?? ""}` }));
    if (result.ok && /logged in/i.test(result.text) && !/not logged in/i.test(result.text)) {
        const plan = /using ([^\n]+)/i.exec(result.text)?.[1]?.trim();
        return { loggedIn: true, ...(plan ? { plan } : {}) };
    }
    if (/not logged in/i.test(result.text)) return { loggedIn: false };
    return { loggedIn: "unknown" };
};

export function createCodexProvider(host: ServerPackageHost, account?: ResolvedHarnessAccount): HarnessProvider {
    const harnessId = account ? account.harnessId : "codex";
    const stateFile = (context: HarnessContext) => {
        const key = createHash("sha256").update(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? "catalog"])).digest("hex");
        return host.spaceStorage(context.space!).path(`runtime/${harnessId}/${key}.json`);
    };
    // Extra accounts are local `CODEX_HOME` directories; only the default
    // harness runs on a remote host, there on the host's own login.
    const remoteHost = async (context: HarnessContext): Promise<RemoteProcessHost | undefined> => {
        if (!context.remote) return undefined;
        if (account) throw Object.assign(new Error("Extra Codex accounts run on this machine only"), { code: "unsupported" });
        return resolveRemoteHarnessHost(host, context);
    };
    return {
        descriptor: { id: harnessId, name: "Codex", integration: "App Server", priority: 50, setupUrl: "https://developers.openai.com/codex/cli/", installCommand: npmCliInstallCommand("@openai/codex", process.platform), signInCommand: "codex login", deviceSignInCommand: "codex login --device-auth", updateCommand: ["codex", "update"], releaseSource: { kind: "npm", package: "@openai/codex" }, remoteHost: { binary: CODEX_REMOTE_BINARY, installCommand: npmCliInstallCommand("@openai/codex"), signInCommand: "codex login --device-auth", ...(account ? {} : { sessions: true }) }, privateSessions: true },
        // Polyth now reproduces the Codex client's semantic metadata turn, so
        // canonical sessions can wait briefly for the native thread name event.
        staticFeatures: { ...CODEX_CAPABILITIES, title: "native" },
        async probe(context) {
            if (context.remote) {
                if (account) return { harnessId, installed: false, authenticated: "unknown", healthy: false, message: "Extra Codex accounts run on this machine only" };
                const remote = await remoteHost(context);
                if (remote) return probeRemoteHarness(remote, harnessId, CODEX_REMOTE_BINARY);
            }
            try {
                const command = await resolveCodexBinary();
                const env = await codexEnv(command, account);
                const version = (await exec(command, ["--version"], { timeout: 5000, maxBuffer: 4096, env, shell: windowsShim(command) })).stdout.trim();
                // The cheap probe never starts the App Server. Sign-in is the
                // CLI's own local report (a file read, ~0.1 s) — the same
                // evidence detail discovery trusts. With an API key in the
                // environment the App Server decides, so that stays unknown.
                if (!process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY) {
                    const status = await codexAccountStatus(account, { command, env }).catch(() => ({ loggedIn: "unknown" as const }));
                    if (status.loggedIn === true)
                        return { harnessId, installed: true, authenticated: true, healthy: true, state: "ready", version };
                    if (status.loggedIn === false) {
                        return {
                            harnessId, installed: true, authenticated: false, healthy: true, state: "auth-required", version,
                            message: account ? `The Codex account “${account.name}” is not signed in` : "Codex is not signed in",
                        };
                    }
                }
                return { harnessId, installed: true, authenticated: "unknown", healthy: true, state: "unknown", version };
            }
            catch {
                return { harnessId, installed: false, authenticated: "unknown", healthy: false };
            }
        },
        async discover(context) {
            // The App Server lists a catalog even for a signed-out login, so
            // that list is no sign-in evidence. Without an API key in the
            // environment the CLI's own local report decides.
            const remote = await remoteHost(context);
            // A remote host's sign-in is its own; the App Server reports it.
            if (!remote && !process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY
                && (await codexAccountStatus(account).catch(() => ({ loggedIn: "unknown" as const }))).loggedIn === false) {
                return {
                    state: "auth-required" as const,
                    authenticated: false as const,
                    message: account ? `Sign in to the Codex account “${account.name}” to list its models` : "Sign in to Codex to list its models",
                };
            }
            const runtime = await createManagedCodexRuntime(context, harnessId, undefined, account, remote);
            try {
                const [models, agents, capabilities] = await Promise.all([
                    runtime.models(), runtime.agents(), runtime.capabilities(),
                ]);
                return { state: "ready", authenticated: true, capabilities, catalog: { models, agents } };
            }
            finally {
                await runtime.dispose();
            }
        },
        async createRuntime(context) {
            if (!context.space)
                throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
            const remote = await remoteHost(context);
            const runtime = await createManagedCodexRuntime(context, harnessId, stateFile(context), account, remote);
            // `codex exec` utility turns are a local CLI run; a remote leg has none.
            if (remote) return runtime;
            // Stateless utility inference (commit messages, auditors) runs one
            // ephemeral `codex exec` instead of a tool-capable native thread.
            const command = await resolveCodexBinary();
            const smallModel = createCodexSmallModelRunner({
                command,
                cwd: context.cwd,
                env: await codexEnv(command, account),
            });
            runtime.completeSmallModel = (request: SmallModelCompletionRequest) => smallModel.complete(request);
            return runtime;
        },
        async releaseExecution(context, binding, operationId) {
            if (!context.space)
                return { kind: "rejected", code: "unsupported", message: "Local Space context required" };
            // Release proof covers this machine's process boundary only.
            if (context.remote)
                return { kind: "rejected", code: "unsupported", message: "Crash-safe cross-harness switching is not available on remote hosts; this Codex runtime can still be used normally" };
            return releaseHarnessProcessExecution(stateFile(context), binding, operationId);
        },
        provisioner: createCodexProvisioner(harnessId),
        plugins: createCodexNativePlugins({ harnessId, connect: (context) => connectCodex(context, undefined, account) }),
        source: {
            async list(context) {
                const rpc = await connectCodex(context, undefined, account, await remoteHost(context));
                try {
                    // Polyth runs Codex through its App Server, so native threads
                    // carry `source: "vscode"` (originator "polyth"), not `"cli"`.
                    // Filter by the project cwd instead of a CLI-only source kind,
                    // and never offer spawned/subagent or ephemeral threads.
                    const result = await rpc.request<{
                        data: Thread[];
                    }>("thread/list", { cwd: context.cwd, limit: 100 });
                    return result.data
                        .filter((thread) => thread.cwd === context.cwd && !thread.ephemeral && !thread.parentThreadId)
                        .map((thread) => ({ ref: thread.id, title: thread.name ?? thread.preview ?? "Codex session", updatedAt: (thread.updatedAt ?? 0) * 1000 }));
                }
                finally {
                    await rpc.close();
                }
            },
            async *read(context, ref) {
                const rpc = await connectCodex(context, undefined, account, await remoteHost(context));
                try {
                    const { thread } = await rpc.request<{
                        thread: Thread;
                    }>("thread/read", { threadId: ref, includeTurns: true });
                    if (thread.cwd !== context.cwd || thread.parentThreadId || thread.ephemeral)
                        throw Object.assign(new Error("source not found"), { code: "not-found" });
                    // `historyMode: "paginated"` alone is not proof of truncation on
                    // current Codex builds: the read above returns full turns. Only a
                    // turn that explicitly advertises partial `itemsView` is unsafe.
                    if (thread.turns?.some((turn) => turn.itemsView && turn.itemsView !== "full"))
                        throw Object.assign(new Error("Native history is incomplete"), { code: "unsupported" });
                    for (const turn of thread.turns ?? [])
                        for (const item of turn.items ?? []) {
                            if (item.type === "agentMessage" && item.text)
                                yield { role: "assistant", text: item.text };
                            if (item.type === "userMessage") {
                                const text = (item.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
                                if (text)
                                    yield { role: "user", text };
                            }
                        }
                }
                finally {
                    await rpc.close();
                }
            },
        },
    };
}

export default function registerPackage(host: ServerPackageHost) {
    const accounts = createHarnessAccountFamily({
        family: "codex",
        label: "Codex",
        packageId: "backend-codex",
        storageDir: host.storageDir,
        deployment: host.deployment,
        registry: () => host.services.require(serverServiceKey<HarnessRegistry>("harnesses")),
        createProvider: (account) => createCodexProvider(host, account),
        status: codexAccountStatus,
        signInCommand: (account) => harnessCommandLine([knownCodexCommand ?? "codex", "login"], accountEnv(account)),
        // `codex login` waits for a callback on this machine's localhost:1455;
        // a browser elsewhere can only finish the device-code flow.
        deviceSignInCommand: (account) => harnessCommandLine([knownCodexCommand ?? "codex", "login", "--device-auth"], accountEnv(account)),
        limitsFamily: "codex",
    });
    return {
        remoteAccess: localOnlyRemoteAccess(["backend-codex"]),
        routes: accounts.routes,
        onEnable: accounts.onEnable,
        onDisable: accounts.onDisable,
    };
}
