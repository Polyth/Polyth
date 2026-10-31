import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessRegistry } from "@polyth/contracts";
import { createAcpProvider } from "@polyth/backend-acp";
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

/** `grok models` is a local catalog report; it never runs a model turn. */
const grokAccountStatus = async (account?: ResolvedHarnessAccount): Promise<HarnessAccountStatus> => {
    const { command, env } = await resolveGrokBinary();
    const { stdout, stderr, ok } = await exec(command, ["models"], {
        timeout: 20_000,
        maxBuffer: 64 * 1024,
        env: { ...env, ...accountEnv(account) },
        shell: windowsShim(command),
    }).then(({ stdout, stderr }) => ({ stdout, stderr, ok: true }), (error: { stdout?: string; stderr?: string }) =>
        ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "", ok: false }));
    if (/not authenticated|please (?:sign|log) ?in/i.test(`${stdout}\n${stderr}`)) return { loggedIn: false };
    return ok && stdout.trim() ? { loggedIn: true } : { loggedIn: "unknown" };
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
        ...(account ? { env: { ...process.env, ...accountEnv(account) } } : {}),
        async probe(context) {
            if (context.remote)
                return { harnessId, installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const { command, env: baseEnv } = await resolveGrokBinary();
                const env = { ...baseEnv, ...accountEnv(account) };
                profile.command = command;
                profile.env = env;
                const version = await exec(command, ["version"], { timeout: 5000, maxBuffer: 4096, env, shell: windowsShim(command) })
                    .then(({ stdout, stderr }) => (stdout || stderr).trim())
                    .catch(() => undefined);
                return {
                    harnessId,
                    installed: true,
                    authenticated: "unknown",
                    healthy: true,
                    ...(version ? { version } : {}),
                    message: "Native sign-in is verified when the ACP agent initializes",
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
        createProvider: (account) => createAcpProvider(host, createGrokProfile(account)),
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
