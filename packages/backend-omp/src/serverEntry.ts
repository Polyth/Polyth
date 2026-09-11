import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerAcpProfile, type AcpProfile } from "@polyth/backend-acp";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import type { ServerPackageHost } from "@polyth/plugins";
const exec = promisify(execFile);

const resolveOmpBinary = async () => {
    const report = await discoverHarnessExecutable(process.env.POLYTH_OMP_BIN?.trim() || "omp");
    if (!report.hit) throw Object.assign(new Error("OMP CLI was not found"), { code: "not-installed" });
    const env = await harnessExecutableChildEnv(report.hit.executablePath);
    process.env.PATH = env.PATH;
    return { command: report.hit.executablePath, env };
};
const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

export default function registerPackage(host: ServerPackageHost) {
    const profile: AcpProfile = {
        descriptor: {
            id: "omp",
            name: "OMP",
            integration: "ACP v1",
            autoSelect: false,
            priority: 60,
            setupUrl: "https://github.com/can1357/oh-my-pi",
            installCommand: "curl -fsSL https://omp.sh/install | sh",
        },
        command: process.env.POLYTH_OMP_BIN?.trim() || "omp",
        args: ["acp"],
        async probe(context) {
            if (context.remote)
                return { harnessId: "omp", installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const { command, env } = await resolveOmpBinary();
                profile.command = command;
                const version = await exec(command, ["--version"], { timeout: 5000, maxBuffer: 4096, env, shell: windowsShim(command) })
                    .then(({ stdout, stderr }) => (stdout || stderr).trim())
                    .catch(() => undefined);
                return {
                    harnessId: "omp",
                    installed: true,
                    authenticated: "unknown",
                    healthy: true,
                    ...(version ? { version } : {}),
                    message: "Provider authentication is verified by the native ACP session",
                };
            }
            catch {
                return { harnessId: "omp", installed: false, authenticated: "unknown", healthy: false };
            }
        },
    };
    return registerAcpProfile(host, profile);
}
