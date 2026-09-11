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
    process.env.PATH = env.PATH;
    return { command: report.hit.executablePath, env };
};
const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

export default function registerPackage(host: ServerPackageHost) {
    const profile: AcpProfile = {
        descriptor: { "id": "fx", "name": "fx", "integration": "ACP v1", "autoSelect": false, "priority": 40, "setupUrl": "https://fx.sh/docs/using-fx/acp", "signInCommand": "fx login" },
        command: process.env.POLYTH_FX_BIN?.trim() || "fx", args: ["acp"],
        async probe(context) {
            if (context.remote)
                return { harnessId: "fx", installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const { command, env } = await resolveFxBinary();
                profile.command = command;
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
