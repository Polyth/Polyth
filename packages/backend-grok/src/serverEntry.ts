import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerAcpProfile } from "@polyth/backend-acp";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import type { ServerPackageHost } from "@polyth/plugins";
const exec = promisify(execFile);

const resolveGrokBinary = async () => {
    const report = await discoverHarnessExecutable(process.env.POLYTH_GROK_BIN?.trim() || "grok");
    if (!report.hit) throw Object.assign(new Error("Grok CLI was not found"), { code: "not-installed" });
    const env = await harnessExecutableChildEnv(report.hit.executablePath);
    process.env.PATH = env.PATH;
    return { command: report.hit.executablePath, env };
};

export default function registerPackage(host: ServerPackageHost) {
    return registerAcpProfile(host, {
        descriptor: {
            id: "grok",
            name: "Grok Build",
            integration: "ACP v1",
            autoSelect: false,
            priority: 50,
            setupUrl: "https://docs.x.ai/build/cli/headless-scripting",
            installCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
        },
        command: "grok",
        args: ["agent", "stdio"],
        async probe(context) {
            if (context.remote)
                return { harnessId: "grok", installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const { command, env } = await resolveGrokBinary();
                const version = await exec(command, ["version"], { timeout: 5000, maxBuffer: 4096, env })
                    .then(({ stdout, stderr }) => (stdout || stderr).trim())
                    .catch(() => undefined);
                return {
                    harnessId: "grok",
                    installed: true,
                    authenticated: "unknown",
                    healthy: true,
                    ...(version ? { version } : {}),
                    message: "Native sign-in is verified when the ACP agent initializes",
                };
            }
            catch {
                return { harnessId: "grok", installed: false, authenticated: "unknown", healthy: false };
            }
        },
    });
}
