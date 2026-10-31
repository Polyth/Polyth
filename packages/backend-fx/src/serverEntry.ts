import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerAcpProfile, type AcpProfile } from "@polyth/backend-acp";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/backend-acp/executable-discovery";
import type { ServerPackageHost } from "@polyth/plugins";
const exec = promisify(execFile);

const resolveFxBinary = async () => {
    const report = await discoverHarnessExecutable(process.env.POLYTH_FX_BIN?.trim() || "fx");
    if (!report.hit) throw Object.assign(new Error("fx CLI was not found"), { code: "not-installed" });
    const env = await harnessExecutableChildEnv(report.hit.executablePath);
    return { command: report.hit.executablePath, env };
};
const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

/** fx's official installer (fx.sh/docs/getting-started/installation): per
 *  user into `~/.local/bin/fx`, no sudo, and no question without a TTY. */
export const FX_INSTALL_COMMAND = "curl -fsSL https://fx.sh/setup.sh | bash";
/** "fx runs on macOS and Linux": Windows has no installer, so Settings shows
 *  the setup guide there. */
export const fxInstallCommand = (platform: NodeJS.Platform = process.platform): string | undefined =>
    platform === "win32" ? undefined : FX_INSTALL_COMMAND;
/** The file the installer reads for the newest release; its body is `v0.0.14`. */
export const FX_RELEASE_SOURCE = { kind: "page", url: "https://releases.fx.sh/latest.txt", pattern: "^\\s*v?([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\\s*$" } as const;
const FX_INSTALL = fxInstallCommand();

export default function registerPackage(host: ServerPackageHost) {
    const profile: AcpProfile = {
        descriptor: {
            "id": "fx", "name": "fx", "integration": "ACP v1", "autoSelect": false, "priority": 40, "setupUrl": "https://fx.sh/docs/using-fx/acp", "signInCommand": "fx login",
            ...(FX_INSTALL ? { "installCommand": FX_INSTALL } : {}),
            "updateCommand": ["fx", "upgrade"],
            "releaseSource": FX_RELEASE_SOURCE,
            "remoteHost": { "binary": "fx", "installCommand": FX_INSTALL_COMMAND, "signInCommand": "fx login" },
        },
        command: process.env.POLYTH_FX_BIN?.trim() || "fx", args: ["acp"],
        async probe(context) {
            if (context.remote)
                return { harnessId: "fx", installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const { command, env } = await resolveFxBinary();
                profile.command = command;
                profile.env = env;
                const version = (await exec(command, ["--version"], { timeout: 5000, maxBuffer: 4096, env, shell: windowsShim(command) })).stdout.trim();
                // Installation alone is not proof of authentication. The profile is
                // offered for explicit selection but excluded from automatic routing
                // until a native auth/status contract is verified.
                return { harnessId: "fx", installed: true, authenticated: "unknown", healthy: true, version, message: "Native sign-in status is not available" };
            }
            catch {
                return { harnessId: "fx", installed: false, authenticated: "unknown", healthy: false };
            }
        },
    };
    return registerAcpProfile(host, profile);
}
