import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessRegistry } from "@polyth/contracts";
import { createAcpProvider } from "@polyth/backend-acp";
import type { RegisteredAcpProfile } from "@polyth/backend-acp/profile";
import { createHarnessAccountFamily, harnessCommandLine, type HarnessAccountStatus, type ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { vendorScriptInstallCommand } from "@polyth/harness-runtime/installers";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
const exec = promisify(execFile);

/** The official per-user installers. On Windows the script uses an existing
 *  Bun (`~\.bun\bin\omp`) or else downloads the checksum-verified build to
 *  `%LOCALAPPDATA%\omp\omp.exe`, added to the User PATH only. */
export const OMP_INSTALLER = { posix: "https://omp.sh/install", posixShell: "sh", windowsPowerShell: "https://omp.sh/install.ps1" } as const;
const OMP_INSTALL = vendorScriptInstallCommand(OMP_INSTALLER, process.platform);

/** Last resolved executable, for the synchronous sign-in command. */
let knownOmpCommand: string | undefined;
const resolveOmpBinary = async () => {
    const report = await discoverHarnessExecutable(process.env.POLYTH_OMP_BIN?.trim() || "omp");
    if (!report.hit) throw Object.assign(new Error("OMP CLI was not found"), { code: "not-installed" });
    const env = await harnessExecutableChildEnv(report.hit.executablePath);
    knownOmpCommand = report.hit.launcherPath ?? report.hit.executablePath;
    return { command: report.hit.executablePath, env };
};
const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

/** OMP keeps one login's credentials (`agent.db`), settings and sessions in
 *  its agent directory, which `PI_CODING_AGENT_DIR` relocates. */
const accountEnv = (account?: ResolvedHarnessAccount): Record<string, string> =>
    account ? { PI_CODING_AGENT_DIR: account.dir } : {};

/** `omp models` lists the configured catalog locally; it runs no model turn. */
const ompAccountStatus = async (account?: ResolvedHarnessAccount): Promise<HarnessAccountStatus> => {
    const { command, env } = await resolveOmpBinary();
    const { text, ok } = await exec(command, ["models"], {
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        env: { ...env, ...accountEnv(account) },
        shell: windowsShim(command),
    }).then(({ stdout, stderr }) => ({ text: `${stdout}\n${stderr}`, ok: true }), (error: { stdout?: string; stderr?: string }) =>
        ({ text: `${error.stdout ?? ""}\n${error.stderr ?? ""}`, ok: false }));
    if (/no models available/i.test(text)) return { loggedIn: false };
    return ok && text.trim() ? { loggedIn: true } : { loggedIn: "unknown" };
};

export function createOmpProfile(account?: ResolvedHarnessAccount): RegisteredAcpProfile {
    const harnessId = account ? account.harnessId : "omp";
    const profile: RegisteredAcpProfile = {
        descriptor: {
            id: harnessId,
            name: "OMP",
            integration: "ACP v1",
            autoSelect: false,
            priority: 60,
            setupUrl: "https://github.com/can1357/oh-my-pi",
            ...(OMP_INSTALL ? { installCommand: OMP_INSTALL } : {}),
            updateCommand: ["omp", "update"],
            // The latest-stable build record the installer reads. It is per
            // target; the stable version is shared (linux x86_64/arm64 agree).
            releaseSource: { kind: "page", url: "https://build.stencil.so/api/products/omp/latest/linux-x86_64?channel=stable", pattern: "\"version\"\\s*:\\s*\"([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\"" },
            remoteHost: { binary: "omp", installCommand: vendorScriptInstallCommand(OMP_INSTALLER), signInCommand: "omp" },
        },
        command: process.env.POLYTH_OMP_BIN?.trim() || "omp",
        args: ["acp"],
        ...(account ? { env: { ...process.env, ...accountEnv(account) } } : {}),
        async probe(context) {
            if (context.remote)
                return { harnessId, installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const { command, env: baseEnv } = await resolveOmpBinary();
                const env = { ...baseEnv, ...accountEnv(account) };
                profile.command = command;
                profile.env = env;
                const version = await exec(command, ["--version"], { timeout: 5000, maxBuffer: 4096, env, shell: windowsShim(command) })
                    .then(({ stdout, stderr }) => (stdout || stderr).trim())
                    .catch(() => undefined);
                return {
                    harnessId,
                    installed: true,
                    authenticated: "unknown",
                    healthy: true,
                    ...(version ? { version } : {}),
                    message: "Provider authentication is verified by the native ACP session",
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
        family: "omp",
        label: "OMP",
        packageId: "backend-omp",
        storageDir: host.storageDir,
        deployment: host.deployment,
        registry: () => host.services.require(serverServiceKey<HarnessRegistry>("harnesses")),
        createProvider: (account) => createAcpProvider(host, createOmpProfile(account)),
        status: ompAccountStatus,
        // OMP signs in from its own interactive `/login` command.
        signInCommand: (account) => harnessCommandLine([knownOmpCommand ?? "omp"], accountEnv(account)),
    });
    return {
        remoteAccess: localOnlyRemoteAccess(["backend-omp"]),
        routes: accounts.routes,
        onEnable: accounts.onEnable,
        onDisable: accounts.onDisable,
    };
}
