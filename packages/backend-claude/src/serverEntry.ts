import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessProvider, HarnessRegistry } from "@polyth/contracts";
import { createProcessAuthority } from "@polyth/harness-runtime";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createClaudeRuntime } from "./index.ts";
const exec = promisify(execFile);
// Optional SDK is loaded only by this package, never a server boot prerequisite.
const loadSdk = () => import("@anthropic-ai/claude-agent-sdk");
export default function registerPackage(host: ServerPackageHost) {
    const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
    const provider: HarnessProvider = {
        descriptor: { id: "claude", name: "Claude Code", integration: "Agent SDK", priority: 20, setupUrl: "https://code.claude.com/docs/en/setup", installCommand: "curl -fsSL https://claude.ai/install.sh | bash", signInCommand: "claude auth login" },
        async probe(context) {
            if (context.remote || process.platform !== "linux")
                return { harnessId: "claude", installed: false, healthy: false, authenticated: "unknown", message: "Local Linux runtimes are supported" };
            try {
                await loadSdk();
            }
            catch {
                return { harnessId: "claude", installed: false, healthy: false, authenticated: "unknown", message: "Optional Claude Agent SDK dependency is unavailable" };
            }
            try {
                const command = process.env.POLYTH_CLAUDE_BIN ?? "claude";
                const version = (await exec(command, ["--version"], { timeout: 5000, maxBuffer: 4096 })).stdout.trim();
                const authenticated = await exec(command, ["auth", "status", "--json"], { timeout: 5000, maxBuffer: 8192 }).then(({ stdout }) => JSON.parse(stdout).loggedIn === true).catch(() => false);
                return { harnessId: "claude", installed: true, healthy: true, authenticated, version };
            }
            catch {
                return { harnessId: "claude", installed: false, healthy: false, authenticated: "unknown" };
            }
        },
        async createRuntime(context) {
            if (!context.space || context.remote || process.platform !== "linux")
                throw Object.assign(new Error("Local Linux Space context required"), { code: "unsupported" });
            const key = createHash("sha256").update(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? "catalog"])).digest("hex");
            const authority = await createProcessAuthority(host.spaceStorage(context.space).path(`runtime/claude/${key}.json`));
            try {
                return await createClaudeRuntime(context, await loadSdk(), authority);
            }
            catch (error) {
                await authority.close();
                throw error;
            }
        },
    };
    let registration: ReturnType<HarnessRegistry["register"]> | undefined;
    return { remoteAccess: localOnlyRemoteAccess(["backend-claude"]), onEnable() { registration = registry.register(provider); }, onDisable() { registration?.dispose(); } };
}
