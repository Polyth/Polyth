import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessProvider, HarnessRegistry } from "@polyth/contracts";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
const exec = promisify(execFile);

const resolvePiBinary = async () => {
    const report = await discoverHarnessExecutable(process.env.POLYTH_PI_BIN?.trim() || "pi");
    if (!report.hit) throw Object.assign(new Error("Pi CLI was not found"), { code: "not-installed" });
    const env = await harnessExecutableChildEnv(report.hit.executablePath);
    return { command: report.hit.executablePath, env };
};

export default function registerPackage(host: ServerPackageHost) {
    const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
    const provider: HarnessProvider = {
        descriptor: {
            id: "pi",
            name: "Pi",
            integration: "RPC detected",
            autoSelect: false,
            priority: 70,
            setupUrl: "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
            installCommand: "npm install -g @mariozechner/pi-coding-agent",
        },
        async probe(context) {
            if (context.remote)
                return { harnessId: "pi", installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const { command, env } = await resolvePiBinary();
                const version = await exec(command, ["--version"], { timeout: 5000, maxBuffer: 4096, env })
                    .then(({ stdout, stderr }) => (stdout || stderr).trim())
                    .catch(() => undefined);
                return {
                    harnessId: "pi",
                    installed: true,
                    authenticated: "unknown",
                    healthy: false,
                    state: "incompatible",
                    ...(version ? { version } : {}),
                    message: "Pi was detected, but Polyth does not yet translate its native RPC protocol into AgentRuntime",
                };
            }
            catch {
                return { harnessId: "pi", installed: false, authenticated: "unknown", healthy: false };
            }
        },
        async createRuntime() {
            throw Object.assign(new Error("Pi native RPC adapter is not implemented yet"), { code: "unsupported" });
        },
    };
    let registration: ReturnType<HarnessRegistry["register"]> | undefined;
    return {
        remoteAccess: localOnlyRemoteAccess(["backend-pi"]),
        onEnable() { registration = registry.register(provider); },
        onDisable() { registration?.dispose(); },
    };
}
