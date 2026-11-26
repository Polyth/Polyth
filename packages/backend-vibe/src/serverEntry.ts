import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HarnessRegistry, RuntimeEvent } from "@polyth/contracts";
import { createAcpProvider } from "@polyth/backend-acp";
import type { AcpClientMethodTranslator } from "@polyth/backend-acp";
import type { RegisteredAcpProfile } from "@polyth/backend-acp/profile";
import { createHarnessAccountFamily, harnessCommandLine, type HarnessAccountStatus, type ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { vendorScriptInstallCommand } from "@polyth/harness-runtime/installers";
import { createFolderSkillManager, nativeSkillFolders } from "@polyth/harness-runtime/native-skills";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { classifyVibePromptFailure } from "./failures.ts";
import { MISTRAL_API_KEY_ENV, vibeChildEnv } from "./launchEnv.ts";
import { createVibeModelIdCodec } from "./models.ts";
import { listVibeSessions, readVibeDialogue, resolveVibeHome } from "./nativeSessions.ts";
import { readVibeSignIn } from "./signIn.ts";
import { vibeNativeToolName } from "./toolNames.ts";
import { createVibeTurnUsageTracker } from "./usage.ts";
const exec = promisify(execFile);

/** Mistral's installer: uv (installed first when missing) or Homebrew. */
export const VIBE_INSTALLER = { posix: "https://mistral.ai/vibe/install.sh", posixShell: "bash" } as const;
/** The PyPI package both installers put in place. */
export const PYPI_PACKAGE = "mistral-vibe";
/**
 * Windows has no Mistral installer script; the CLI installs there with uv
 * like everywhere else (Vibe runs on Python ≥ 3.12 and ships Windows
 * dependencies). Astral's PowerShell installer puts uv in
 * `%USERPROFILE%\.local\bin`, and `uv tool install` puts `vibe-acp` beside it.
 */
export const VIBE_WINDOWS_INSTALL = "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \""
    + "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; "
    + "$b = Join-Path $env:USERPROFILE '.local\\bin'; "
    + "if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { irm https://astral.sh/uv/install.ps1 | iex; $env:Path = $b + ';' + $env:Path }; "
    + "$LASTEXITCODE=1; uv tool install --python 3.13 " + PYPI_PACKAGE + "; exit $LASTEXITCODE\"";

export const vibeInstallCommand = (platform: NodeJS.Platform | "posix"): string | undefined =>
    platform === "win32" ? VIBE_WINDOWS_INSTALL : vendorScriptInstallCommand(VIBE_INSTALLER, platform);

/** The installer script upgrades whichever way it installed (uv or
 *  Homebrew); on Windows uv does. */
export const vibeUpdateCommand = (platform: NodeJS.Platform): readonly string[] =>
    platform === "win32"
        ? ["uv", "tool", "upgrade", PYPI_PACKAGE]
        : ["bash", "-c", `curl -fsSL ${VIBE_INSTALLER.posix} | bash`];

/** `vibe-acp --version` prints `vibe-acp 3.1.5`. */
export const parseVibeAcpVersion = (output: string): string | undefined =>
    /^\s*vibe-acp\s+v?(\d+\.\d+\.\d+(?:[-.+]?[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)\s*$/im.exec(output)?.[1];

const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
const run = (command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number) =>
    exec(windowsShim(command) ? `"${command}"` : command, args, { timeout, maxBuffer: 64 * 1024, env, shell: windowsShim(command) });

/** Last resolved executable, for the synchronous sign-in command. */
let knownVibeAcpCommand: string | undefined;
/** Executables already proven to be Mistral Vibe's ACP agent, by path. */
const verified = new Map<string, string>();
const VERSION_TTL_MS = 60_000;
let versionReadAt = 0;

/** Resolve `vibe-acp` and prove it is Mistral Vibe's. */
export const resolveVibeAcpBinary = async (): Promise<{ command: string; version: string; env: NodeJS.ProcessEnv }> => {
    const report = await discoverHarnessExecutable(process.env.POLYTH_VIBE_BIN?.trim() || "vibe-acp");
    if (!report.hit) throw Object.assign(new Error("Mistral Vibe (vibe-acp) was not found"), { code: "not-installed" });
    const command = report.hit.executablePath;
    const env = await harnessExecutableChildEnv(command);
    const known = verified.get(command);
    if (known && Date.now() - versionReadAt < VERSION_TTL_MS) {
        knownVibeAcpCommand = report.hit.launcherPath ?? command;
        return { command, version: known, env };
    }
    const version = parseVibeAcpVersion(await run(command, ["--version"], env, 15_000)
        .then(({ stdout, stderr }) => `${stdout}\n${stderr}`));
    if (!version) throw Object.assign(new Error(`${command} is not Mistral Vibe`), { code: "not-installed" });
    verified.set(command, version);
    versionReadAt = Date.now();
    knownVibeAcpCommand = report.hit.launcherPath ?? command;
    return { command, version, env };
};

/** `vibe`, installed beside `vibe-acp` by every installer. */
export const vibeCliBeside = (acpCommand: string): string => {
    // Either separator: a Windows path is also handled on a POSIX server.
    const beside = acpCommand.replace(/(^|[\\/])vibe-acp(\.[A-Za-z0-9]+)?$/i, "$1vibe$2");
    return beside === acpCommand ? "vibe" : beside;
};

/**
 * Vibe's retry notice (`_session/retrying {category, detail}`) arrives while
 * a provider error is being retried, sometimes for minutes with nothing else
 * on the wire. It proves the prompt's turn ran and keeps the prompt watchdog
 * from treating the silence as a dead agent.
 */
export const createVibeClientTranslator = (): AcpClientMethodTranslator => ({
    translateClientMethod(method) {
        return method === "_session/retrying" ? { handled: true, events: [] } : { handled: false };
    },
});

const SIGNED_IN_TTL_MS = 30_000;
const SIGNED_OUT_TTL_MS = 5_000;

export function createVibeProfile(account?: ResolvedHarnessAccount): RegisteredAcpProfile {
    const harnessId = account ? account.harnessId : "vibe";
    const home = () => account ? account.dir : resolveVibeHome(profile.env ?? process.env);
    const usage = createVibeTurnUsageTracker();
    const profile: RegisteredAcpProfile = {
        descriptor: {
            id: harnessId,
            name: "Mistral Vibe",
            integration: "ACP v1",
            autoSelect: false,
            priority: 55,
            setupUrl: "https://github.com/mistralai/mistral-vibe#installation",
            ...(vibeInstallCommand(process.platform) ? { installCommand: vibeInstallCommand(process.platform)! } : {}),
            updateCommand: vibeUpdateCommand(process.platform),
            releaseSource: { kind: "page", url: `https://pypi.org/pypi/${PYPI_PACKAGE}/json`, pattern: "\"version\"\\s*:\\s*\"([0-9]+\\.[0-9]+\\.[0-9]+(?:[-.+]?[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?)\"" },
        },
        command: process.env.POLYTH_VIBE_BIN?.trim() || "vibe-acp",
        args: [],
        env: vibeChildEnv(process.env, account),
        // Polyth's agent tools reach Vibe as the stdio bridge on session/new.
        // Vibe also accepts streamable-HTTP servers but does not advertise
        // `mcpCapabilities.http` (3.1.5), and the shared adapter never sends
        // a transport the agent did not advertise.
        classifyPromptFailure: classifyVibePromptFailure,
        // One model, several ids: the built-in alias before the account's
        // catalog loads, the catalog id after. Aliases keep either selection.
        modelIdCodec: createVibeModelIdCodec(() => home()),
        nativeToolName: vibeNativeToolName,
        // Vibe's `session_info_update` title is first the raw first prompt
        // (Polyth's context blocks included), then one its title request
        // produced on the person's Mistral quota. Polyth names the chat.
        nativeTitles: false,
        createClientTranslator: createVibeClientTranslator,
        observeSessionUpdate: ({ backendSessionId, update }) => usage.observe(backendSessionId, update),
        // Vibe echoes a prompt as `user_message_chunk` once its turn starts,
        // before the first model request; a slow first token proves nothing.
        async probeAdmission({ backendSessionId, sentAt }) {
            const echoed = usage.echoedAt(backendSessionId);
            return echoed !== undefined && echoed >= sentAt;
        },
        reportsUsage: true,
        async settleTurn({ backendSessionId, turnId, promptResult, modelId }) {
            const tokens = usage.settle(backendSessionId, promptResult);
            if (!tokens || !modelId) return [];
            const event: RuntimeEvent = {
                type: "usage/recorded",
                model: { providerID: harnessId, modelID: modelId },
                tokens,
                turnId,
                harnessId,
                agentKind: "main",
                quality: "exact",
                // A turn's requests summed (tool rounds included).
                aggregate: true,
            };
            return [event];
        },
        async probe(context) {
            if (context.remote)
                return { harnessId, installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const { command, version, env: baseEnv } = await resolveVibeAcpBinary();
                profile.command = command;
                profile.env = vibeChildEnv(baseEnv, account);
                // Starting the agent for every probe would cost seconds; the
                // key is checked when the catalog read opens a session.
                const keyed = !account && Boolean(baseEnv[MISTRAL_API_KEY_ENV]?.trim());
                return {
                    harnessId,
                    installed: true,
                    authenticated: keyed ? true : "unknown",
                    healthy: true,
                    version,
                    ...(keyed
                        ? { message: "Uses MISTRAL_API_KEY from the Polyth server environment; the key is verified on the first turn" }
                        : { message: "The Mistral API key is checked when the agent opens a session" }),
                };
            }
            catch {
                return { harnessId, installed: false, authenticated: "unknown", healthy: false };
            }
        },
        source: {
            async list(context) {
                if (context.remote) return [];
                return listVibeSessions(home(), context.cwd);
            },
            read(context, ref) {
                if (context.remote) throw Object.assign(new Error("Local execution only"), { code: "unsupported" });
                return readVibeDialogue(profile, home(), context.cwd, ref);
            },
        },
    };
    return profile;
}

/** One sign-in read per login at a time, remembered briefly: the Accounts
 *  list asks for every row whenever it is shown. */
const signIns = new Map<string, { until: number; status: Promise<HarnessAccountStatus> }>();
const vibeAccountStatus = async (account?: ResolvedHarnessAccount): Promise<HarnessAccountStatus> => {
    const key = account?.harnessId ?? "vibe";
    const cached = signIns.get(key);
    if (cached && Date.now() < cached.until) return cached.status;
    const status = (async () => {
        const { command, env } = await resolveVibeAcpBinary();
        const profile = createVibeProfile(account);
        return readVibeSignIn({ ...profile, command, env: vibeChildEnv(env, account) });
    })();
    const entry = { until: Number.POSITIVE_INFINITY, status };
    signIns.set(key, entry);
    status.then((value) => {
        entry.until = Date.now() + (value.loggedIn === true ? SIGNED_IN_TTL_MS : SIGNED_OUT_TTL_MS);
    }, () => {
        if (signIns.get(key) === entry) signIns.delete(key);
    });
    return status;
};

export default function registerPackage(host: ServerPackageHost) {
    const accounts = createHarnessAccountFamily({
        family: "vibe",
        label: "Mistral Vibe",
        relay: { policy: "prohibited" },
        packageId: "backend-vibe",
        storageDir: host.storageDir,
        deployment: host.deployment,
        registry: () => host.services.require(serverServiceKey<HarnessRegistry>("harnesses")),
        createProvider: (account) => {
            const provider = createAcpProvider(host, createVibeProfile(account));
            // Vibe's skill search path: project `.vibe/skills` and
            // `.agents/skills`, then `$VIBE_HOME/skills` and `~/.agents/skills`.
            provider.skills = createFolderSkillManager({
                harnessId: provider.descriptor.id,
                harnessName: "Mistral Vibe",
                folders: (context) => nativeSkillFolders(context, {
                    project: [join(".vibe", "skills"), join(".agents", "skills")],
                    user: [
                        join(account?.dir ?? resolveVibeHome(), "skills"),
                        join(homedir(), ".agents", "skills"),
                    ],
                }),
            });
            return provider;
        },
        status: vibeAccountStatus,
        // `vibe --setup` asks for an API key (or signs in through Mistral AI
        // Studio in the browser) and keeps it in this login's VIBE_HOME.
        signInCommand: (account) => harnessCommandLine(
            [vibeCliBeside(knownVibeAcpCommand ?? "vibe-acp"), "--setup"],
            account ? { VIBE_HOME: account.dir } : {},
        ),
        // Usage reads each added login's own `VIBE_HOME/.env` for its Limits.
        limitsFamily: "vibe",
    });
    return {
        remoteAccess: localOnlyRemoteAccess(["backend-vibe"]),
        routes: accounts.routes,
        onEnable: accounts.onEnable,
        onDisable: accounts.onDisable,
    };
}
