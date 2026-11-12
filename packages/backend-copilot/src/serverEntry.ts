import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HarnessRegistry, RuntimeEvent } from "@polyth/contracts";
import { createAcpProvider } from "@polyth/backend-acp";
import type { RegisteredAcpProfile } from "@polyth/backend-acp/profile";
import { createHarnessAccountFamily, harnessCommandLine, type HarnessAccountStatus, type ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { npmCliInstallCommand } from "@polyth/harness-runtime/installers";
import { createFolderSkillManager, nativeSkillFolders } from "@polyth/harness-runtime/native-skills";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { latestPromptUsage, listNativeSessions, readLatestPrompt, readNativeDialogue, resolveCopilotHome } from "./nativeLog.ts";
import { writeCopilotLaunchMcp } from "./launchMcp.ts";
import { copilotAgentNotice } from "./notices.ts";
import { preinstalledCopilotDirectories } from "./preinstalled.ts";
import { COPILOT_TOKEN_ENV, environmentSignIn, readCopilotSignIn } from "./signIn.ts";
import { createCopilotSmallModelRunner } from "./smallModel.ts";
const exec = promisify(execFile);

/** GitHub publishes the CLI on npm for Linux, macOS and Windows (x64 and
 *  arm64, glibc and musl); the package's loader starts the platform binary. */
export const NPM_PACKAGE = "@github/copilot";
/**
 * Copilot's own agent-spawning tools. Delegation belongs to Polyth, and the
 * CLI has a real switch for it: `--excluded-tools` removes the tools from
 * every session of an ACP server (verified against 1.0.109, where the model
 * no longer receives them).
 */
export const COPILOT_NATIVE_AGENT_TOOLS = ["task", "read_agent", "list_agents", "write_agent", "run_dynamic_workflow", "dynamic_workflows_manage"] as const;
/**
 * `--no-auto-update`: Polyth offers the update in Settings and replaces the
 * binary only when no chat runs it; the CLI must not swap itself underneath.
 */
export const COPILOT_ACP_ARGS = ["--acp", "--stdio", "--no-auto-update", `--excluded-tools=${COPILOT_NATIVE_AGENT_TOOLS.join(",")}`];

const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
const run = (command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number) =>
    exec(windowsShim(command) ? `"${command}"` : command, args, { timeout, maxBuffer: 64 * 1024, env, shell: windowsShim(command) });

/** `copilot --version` prints `GitHub Copilot CLI 1.0.109.` and an update hint. */
export const parseCopilotVersion = (output: string): string | undefined =>
    /GitHub Copilot CLI\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)/i.exec(output)?.[1];

/** Last resolved executable, for the synchronous sign-in command. */
let knownCopilotCommand: string | undefined;
/** Executables already proven to be GitHub Copilot CLI, by path. */
const verified = new Map<string, string>();
const VERSION_TTL_MS = 60_000;
let versionReadAt = 0;

/** Resolve `copilot` and prove it is GitHub's CLI: other tools install a
 *  `copilot` command too (the AWS Copilot CLI among them). */
export const resolveCopilotBinary = async (): Promise<{ command: string; version: string; env: NodeJS.ProcessEnv }> => {
    const configured = process.env.POLYTH_COPILOT_BIN?.trim();
    let report = await discoverHarnessExecutable(configured || "copilot");
    // A copy on PATH or in a usual install folder is the person's own choice
    // and wins; otherwise use what GitHub's Windows installer or the GitHub
    // Copilot app left outside PATH (see preinstalled.ts).
    if (!report.hit && !configured) {
        const additionalDirectories = await preinstalledCopilotDirectories();
        if (additionalDirectories.length) report = await discoverHarnessExecutable("copilot", { additionalDirectories, loginShellProbe: false });
    }
    if (!report.hit) throw Object.assign(new Error("GitHub Copilot CLI was not found"), { code: "not-installed" });
    const command = report.hit.executablePath;
    const env = await harnessExecutableChildEnv(command);
    const known = verified.get(command);
    if (known && Date.now() - versionReadAt < VERSION_TTL_MS) {
        knownCopilotCommand = report.hit.launcherPath ?? command;
        return { command, version: known, env };
    }
    const version = parseCopilotVersion(await run(command, ["--version"], { ...env, COPILOT_AUTO_UPDATE: "false" }, 10_000)
        .then(({ stdout, stderr }) => `${stdout}\n${stderr}`));
    if (!version) throw Object.assign(new Error(`${command} is not GitHub Copilot CLI`), { code: "not-installed" });
    verified.set(command, version);
    versionReadAt = Date.now();
    knownCopilotCommand = report.hit.launcherPath ?? command;
    return { command, version, env };
};

/** `COPILOT_HOME` holds one login's account list, settings, plugins, skills
 *  and native sessions. */
const accountEnv = (account?: ResolvedHarnessAccount): Record<string, string> =>
    account ? { COPILOT_HOME: account.dir } : {};

/**
 * Child environment for a Copilot CLI run. An added account must sign in as
 * itself: a token in the environment wins over every stored login, so the
 * server's own `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` would
 * silently replace that account. The default harness keeps the inherited
 * environment untouched.
 */
export const accountChildEnv = (base: NodeJS.ProcessEnv, account?: ResolvedHarnessAccount): NodeJS.ProcessEnv => {
    if (!account) return base;
    const env = { ...base };
    for (const name of COPILOT_TOKEN_ENV) delete env[name];
    env.COPILOT_HOME = account.dir;
    return env;
};

const MAX_SETTLE_ATTEMPTS = 8;
const SETTLE_RETRY_MS = 150;
const MAX_TRACKED_SESSIONS = 256;
/** A signed-in answer is kept longer than one that a sign-in is about to change. */
const SIGNED_IN_TTL_MS = 30_000;
const SIGNED_OUT_TTL_MS = 5_000;

export function createCopilotProfile(account?: ResolvedHarnessAccount): RegisteredAcpProfile {
    const harnessId = account ? account.harnessId : "copilot";
    const home = () => account ? account.dir : resolveCopilotHome(profile.env ?? process.env);
    /** Responses already published, per native session; a resumed session's
     *  earlier prompt is never reported twice in one server lifetime. */
    const published = new Map<string, Set<string>>();
    const profile: RegisteredAcpProfile = {
        descriptor: {
            id: harnessId,
            name: "GitHub Copilot",
            integration: "ACP v1",
            autoSelect: false,
            priority: 55,
            setupUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
            installCommand: npmCliInstallCommand(NPM_PACKAGE, process.platform),
            // The CLI's own updater, whichever way it was installed (npm,
            // Homebrew, WinGet or GitHub's script).
            updateCommand: ["copilot", "update"],
            releaseSource: { kind: "npm", package: NPM_PACKAGE },
            remoteHost: { binary: "copilot", installCommand: npmCliInstallCommand(NPM_PACKAGE), signInCommand: "copilot login --device-code" },
        },
        command: process.env.POLYTH_COPILOT_BIN?.trim() || "copilot",
        args: COPILOT_ACP_ARGS,
        ...(account ? { env: accountChildEnv(process.env, account) } : {}),
        agentNotice: copilotAgentNotice,
        // Copilot refuses stdio MCP servers on `session/new`; they are given
        // to the process it starts instead (see launchMcp.ts).
        launchStdioMcp: writeCopilotLaunchMcp,
        // An MCP tool call has kind `other` and its qualified name
        // (`<server>-<tool>`) as the title; built-in tools keep their kind.
        toolNameFromTitle: true,
        utilityCompletion: ({ command, env }) => createCopilotSmallModelRunner({ command, ...(env ? { env } : {}), excludedTools: COPILOT_NATIVE_AGENT_TOOLS }),
        reportsUsage: true,
        async settleTurn({ backendSessionId, turnId }) {
            for (let attempt = 1; attempt <= MAX_SETTLE_ATTEMPTS; attempt++) {
                const events = await readLatestPrompt(home(), backendSessionId);
                const usage = events ? latestPromptUsage(events) : undefined;
                if (usage && (usage.complete || attempt === MAX_SETTLE_ATTEMPTS)) {
                    let seen = published.get(backendSessionId);
                    if (!seen) {
                        seen = new Set();
                        published.set(backendSessionId, seen);
                        if (published.size > MAX_TRACKED_SESSIONS) published.delete(published.keys().next().value!);
                    }
                    const recorded: RuntimeEvent[] = [];
                    for (const row of usage.rows) {
                        if (seen.has(row.id)) continue;
                        seen.add(row.id);
                        recorded.push({
                            type: "usage/recorded",
                            model: { providerID: harnessId, modelID: row.model },
                            tokens: row.tokens,
                            turnId,
                            harnessId,
                            agentKind: "main",
                            quality: "exact",
                        });
                    }
                    return recorded;
                }
                await new Promise((resolve) => setTimeout(resolve, SETTLE_RETRY_MS).unref?.());
            }
            return [];
        },
        async probe(context) {
            if (context.remote)
                return { harnessId, installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const { command, version, env: baseEnv } = await resolveCopilotBinary();
                const env = accountChildEnv(baseEnv, account);
                profile.command = command;
                profile.env = env;
                // Starting the agent for every probe would cost seconds; the
                // launch environment is free to read, and everything else is
                // answered by the session the catalog read opens anyway.
                const signIn = environmentSignIn(env);
                return {
                    harnessId,
                    installed: true,
                    authenticated: signIn ? true : "unknown",
                    healthy: true,
                    version,
                    ...(signIn ? {} : { message: "GitHub sign-in is verified when the agent opens a session" }),
                };
            }
            catch {
                return { harnessId, installed: false, authenticated: "unknown", healthy: false };
            }
        },
        source: {
            async list(context) {
                if (context.remote) return [];
                return listNativeSessions(home(), context.cwd);
            },
            read(context, ref) {
                if (context.remote) throw Object.assign(new Error("Local execution only"), { code: "unsupported" });
                return readNativeDialogue(home(), context.cwd, ref);
            },
        },
    };
    return profile;
}

/** One sign-in read per login at a time, remembered briefly: the Accounts
 *  list asks for every row whenever it is shown. */
const signIns = new Map<string, { until: number; status: Promise<HarnessAccountStatus> }>();
const copilotAccountStatus = async (account?: ResolvedHarnessAccount): Promise<HarnessAccountStatus> => {
    const key = account?.harnessId ?? "copilot";
    const cached = signIns.get(key);
    if (cached && Date.now() < cached.until) return cached.status;
    const status = (async () => {
        const { command, env } = await resolveCopilotBinary();
        const profile = createCopilotProfile(account);
        return readCopilotSignIn({ ...profile, command, env: accountChildEnv(env, account) });
    })();
    const entry = { until: Number.POSITIVE_INFINITY, status };
    signIns.set(key, entry);
    status.then((value) => {
        entry.until = Date.now() + (value.loggedIn === true ? SIGNED_IN_TTL_MS : SIGNED_OUT_TTL_MS);
    }, () => {
        // A failed read (CLI missing) is not remembered.
        if (signIns.get(key) === entry) signIns.delete(key);
    });
    return status;
};

export default function registerPackage(host: ServerPackageHost) {
    const accounts = createHarnessAccountFamily({
        family: "copilot",
        label: "GitHub Copilot",
        packageId: "backend-copilot",
        storageDir: host.storageDir,
        deployment: host.deployment,
        registry: () => host.services.require(serverServiceKey<HarnessRegistry>("harnesses")),
        createProvider: (account) => {
            const provider = createAcpProvider(host, createCopilotProfile(account));
            // The sources `copilot skill --help` names.
            provider.skills = createFolderSkillManager({
                harnessId: provider.descriptor.id,
                harnessName: "GitHub Copilot",
                folders: (context) => nativeSkillFolders(context, {
                    project: [join(".github", "skills"), join(".agents", "skills"), join(".claude", "skills")],
                    user: [
                        join(account?.dir ?? resolveCopilotHome(), "skills"),
                        join(homedir(), ".agents", "skills"),
                    ],
                }),
            });
            return provider;
        },
        status: copilotAccountStatus,
        signInCommand: (account) => harnessCommandLine([knownCopilotCommand ?? "copilot", "login"], accountEnv(account)),
        // The browser flow ends on a loopback callback of this machine.
        deviceSignInCommand: (account) => harnessCommandLine([knownCopilotCommand ?? "copilot", "login", "--device-code"], accountEnv(account)),
    });
    return {
        remoteAccess: localOnlyRemoteAccess(["backend-copilot"]),
        routes: accounts.routes,
        onEnable: accounts.onEnable,
        onDisable: accounts.onDisable,
    };
}
