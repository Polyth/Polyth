import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessRegistry } from "@polyth/contracts";
import { createAcpProvider } from "@polyth/backend-acp";
import { createFolderSkillManager, nativeSkillFolders } from "@polyth/harness-runtime/native-skills";
import type { RegisteredAcpProfile } from "@polyth/backend-acp/profile";
import { createHarnessAccountFamily, harnessCommandLine, type HarnessAccountStatus, type ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { vendorScriptInstallCommand } from "@polyth/harness-runtime/installers";

/** xAI's per-user installers: `~/.grok/bin` on macOS/Linux, and on Windows
 *  `%USERPROFILE%\.grok\bin\grok.exe`, added to the User PATH only. */
export const GROK_INSTALLER = { posix: "https://x.ai/cli/install.sh", windowsPowerShell: "https://x.ai/cli/install.ps1" } as const;
const GROK_INSTALL = vendorScriptInstallCommand(GROK_INSTALLER, process.platform);
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
const exec = promisify(execFile);

/** Last resolved executable, for the synchronous sign-in command. */
let knownGrokCommand: string | undefined;
const resolveGrokBinary = async () => {
    const report = await discoverHarnessExecutable(process.env.POLYTH_GROK_BIN?.trim() || "grok");
    if (!report.hit) throw Object.assign(new Error("Grok CLI was not found"), { code: "not-installed" });
    const env = await harnessExecutableChildEnv(report.hit.executablePath);
    knownGrokCommand = report.hit.launcherPath ?? report.hit.executablePath;
    return { command: report.hit.executablePath, env };
};
const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

/** `GROK_HOME` holds one login's credentials, config and native sessions. */
const accountEnv = (account?: ResolvedHarnessAccount): Record<string, string> =>
    account ? { GROK_HOME: account.dir } : {};

/**
 * Child environment for a Grok CLI run. An added account must sign in as
 * itself: `XAI_API_KEY` takes precedence over stored browser credentials, so a
 * server-wide key would silently replace that account's own login. The default
 * harness keeps the inherited environment untouched.
 */
const accountChildEnv = (base: NodeJS.ProcessEnv, account?: ResolvedHarnessAccount): NodeJS.ProcessEnv => {
    const env = { ...base };
    if (!account) return env;
    delete env.XAI_API_KEY;
    env.GROK_HOME = account.dir;
    return env;
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * `grok models` reports the sign-in state without running a model turn: the
 * signed-out banner, the API-key banner, or a signed-in first line (usually an
 * account label containing the email).
 */
export function parseGrokModelsStatus(output: { stdout: string; stderr: string; ok: boolean }): HarnessAccountStatus {
    const text = `${output.stdout}\n${output.stderr}`;
    if (/not authenticated|please (?:sign|log) ?in/i.test(text)) return { loggedIn: false };
    if (/using XAI_API_KEY/i.test(text)) return { loggedIn: true, plan: "API key" };
    if (!output.ok) return { loggedIn: "unknown" };
    const firstLine = output.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (!firstLine) return { loggedIn: "unknown" };
    const email = EMAIL.exec(firstLine)?.[0];
    return { loggedIn: true, ...(email ? { email } : {}) };
}

/** `grok models` never runs a model turn; a launch failure is never "signed out". */
const readGrokModelsStatus = async (command: string, env: NodeJS.ProcessEnv): Promise<HarnessAccountStatus> =>
    exec(windowsShim(command) ? `"${command}"` : command, ["models"], {
        timeout: 20_000,
        maxBuffer: 64 * 1024,
        env,
        shell: windowsShim(command),
    }).then(({ stdout, stderr }) => parseGrokModelsStatus({ stdout, stderr, ok: true }),
        (error: { stdout?: string; stderr?: string; killed?: boolean; timedOut?: boolean; code?: string }) => {
            if (error.killed || error.timedOut || error.code === "ETIMEDOUT") return { loggedIn: "unknown" as const };
            return parseGrokModelsStatus({ stdout: error.stdout ?? "", stderr: error.stderr ?? "", ok: false });
        });

const grokAccountStatus = async (account?: ResolvedHarnessAccount): Promise<HarnessAccountStatus> => {
    const { command, env } = await resolveGrokBinary();
    return readGrokModelsStatus(command, accountChildEnv(env, account));
};

export function createGrokProfile(account?: ResolvedHarnessAccount): RegisteredAcpProfile {
    const harnessId = account ? account.harnessId : "grok";
    const profile: RegisteredAcpProfile = {
        descriptor: {
            id: harnessId,
            name: "Grok Build",
            integration: "ACP v1",
            autoSelect: false,
            priority: 50,
            setupUrl: "https://docs.x.ai/build/cli/headless-scripting",
            ...(GROK_INSTALL ? { installCommand: GROK_INSTALL } : {}),
            updateCommand: ["grok", "update"],
            // The stable-channel file the installer reads; its whole body is the version.
            releaseSource: { kind: "page", url: "https://x.ai/cli/stable", pattern: "^\\s*([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.]+)?)\\s*$" },
            remoteHost: { binary: "grok", installCommand: vendorScriptInstallCommand(GROK_INSTALLER), signInCommand: "grok login --device-auth" },
        },
        command: process.env.POLYTH_GROK_BIN?.trim() || "grok",
        args: ["agent", "stdio"],
        ...(account ? { env: accountChildEnv(process.env, account) } : {}),
        async probe(context) {
            if (context.remote)
                return { harnessId, installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const { command, env: baseEnv } = await resolveGrokBinary();
                const env = accountChildEnv(baseEnv, account);
                profile.command = command;
                profile.env = env;
                // The sign-in state feeds the model-discovery cache key, so a
                // fresh login (or an expired one) is seen without waiting for
                // the 60 s/5 min discovery lifetimes.
                const [version, status] = await Promise.all([
                    exec(windowsShim(command) ? `"${command}"` : command, ["version"], { timeout: 5000, maxBuffer: 4096, env, shell: windowsShim(command) })
                        .then(({ stdout, stderr }) => (stdout || stderr).trim())
                        .catch(() => undefined),
                    readGrokModelsStatus(command, env),
                ]);
                return {
                    harnessId,
                    installed: true,
                    authenticated: status.loggedIn,
                    healthy: true,
                    ...(version ? { version } : {}),
                    ...(status.loggedIn === "unknown" ? { message: "Native sign-in is verified when the ACP agent initializes" } : {}),
                };
            }
            catch {
                return { harnessId, installed: false, authenticated: "unknown", healthy: false };
            }
        },
    };
    return profile;
}

export default function registerPackage(host: ServerPackageHost) {
    const accounts = createHarnessAccountFamily({
        family: "grok",
        label: "Grok Build",
        packageId: "backend-grok",
        storageDir: host.storageDir,
        deployment: host.deployment,
        registry: () => host.services.require(serverServiceKey<HarnessRegistry>("harnesses")),
        createProvider: (account) => {
            const provider = createAcpProvider(host, createGrokProfile(account));
            // Its help names these, the other agents' folders included.
            provider.skills = createFolderSkillManager({
                harnessId: provider.descriptor.id,
                harnessName: "Grok Build",
                folders: (context) => nativeSkillFolders(context, {
                    project: [join(".grok", "skills"), join(".claude", "skills"), join(".cursor", "skills")],
                    user: [
                        join(account?.dir ?? process.env.GROK_HOME?.trim() ?? join(homedir(), ".grok"), "skills"),
                        join(homedir(), ".claude", "skills"),
                        join(homedir(), ".cursor", "skills"),
                    ],
                }),
            });
            return provider;
        },
        status: grokAccountStatus,
        signInCommand: (account) => harnessCommandLine([knownGrokCommand ?? "grok", "login"], accountEnv(account)),
        // The CLI's own flow "for headless/remote environments".
        deviceSignInCommand: (account) => harnessCommandLine([knownGrokCommand ?? "grok", "login", "--device-auth"], accountEnv(account)),
    });
    return {
        remoteAccess: localOnlyRemoteAccess(["backend-grok"]),
        routes: accounts.routes,
        onEnable: accounts.onEnable,
        onDisable: accounts.onDisable,
    };
}
