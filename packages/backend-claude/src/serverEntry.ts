import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessProvider, HarnessRegistry } from "@polyth/contracts";
import { createProcessAuthority, releaseProcessExecution } from "@polyth/harness-runtime";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { claudeAuthFingerprint, createClaudeRuntime, discoverClaudeModels, invalidateClaudeModelCache, CLAUDE_CAPABILITIES } from "./index.ts";
import { createClaudeProvisioner } from "./provisioner.ts";
const exec = promisify(execFile);
// Optional SDK is loaded only by this package, never a server boot prerequisite.
const loadSdk = () => import("@anthropic-ai/claude-agent-sdk");
export default function registerPackage(host: ServerPackageHost) {
    const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
    let lastAuthenticated: boolean | undefined;
    const stateFile = (context: Parameters<HarnessProvider["createRuntime"]>[0]) => {
        const key = createHash("sha256").update(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? "catalog"])).digest("hex");
        return host.spaceStorage(context.space!).path(`runtime/claude/${key}.json`);
    };
    const provider: HarnessProvider = {
        descriptor: { id: "claude", name: "Claude Code", integration: "Agent SDK", priority: 20, setupUrl: "https://code.claude.com/docs/en/setup", installCommand: "curl -fsSL https://claude.ai/install.sh | bash", signInCommand: "claude auth login" },
        staticFeatures: CLAUDE_CAPABILITIES,
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
                // A sign-in/out flips what the account can list, so the cached
                // cold catalog must not survive it.
                if (lastAuthenticated !== undefined && lastAuthenticated !== authenticated) {
                    invalidateClaudeModelCache({ executable: command, authFingerprint: claudeAuthFingerprint() });
                }
                lastAuthenticated = authenticated;
                return { harnessId: "claude", installed: true, healthy: true, authenticated, version };
            }
            catch {
                return { harnessId: "claude", installed: false, healthy: false, authenticated: "unknown" };
            }
        },
        // Model discovery does not need a conversation: the Agent SDK reports
        // the catalog from its `initialize` control response.
        async discover(context) {
            if (context.remote || process.platform !== "linux") {
                throw Object.assign(new Error("Local Linux runtimes are supported"), { code: "unsupported" });
            }
            const sdk = await loadSdk();
            const models = await discoverClaudeModels({
                query: sdk.query as Parameters<typeof discoverClaudeModels>[0]["query"],
                cwd: context.cwd,
                executable: process.env.POLYTH_CLAUDE_BIN ?? "claude",
                authFingerprint: claudeAuthFingerprint(),
            });
            return {
                state: "ready" as const,
                authenticated: true,
                capabilities: CLAUDE_CAPABILITIES,
                catalog: { models, agents: [] },
            };
        },
        async createRuntime(context) {
            if (!context.space || context.remote || process.platform !== "linux")
                throw Object.assign(new Error("Local Linux Space context required"), { code: "unsupported" });
            const authority = await createProcessAuthority(stateFile(context));
            try {
                return await createClaudeRuntime(context, await loadSdk(), authority);
            }
            catch (error) {
                await authority.close();
                throw error;
            }
        },
        async releaseExecution(context, binding, operationId) {
            if (!context.space || context.remote || process.platform !== "linux")
                return { kind: "rejected", code: "unsupported", message: "Local Linux Space context required" };
            return releaseProcessExecution(stateFile(context), binding, operationId);
        },
        provisioner: createClaudeProvisioner(),
    };
    let registration: ReturnType<HarnessRegistry["register"]> | undefined;
    return { remoteAccess: localOnlyRemoteAccess(["backend-claude"]), onEnable() { registration = registry.register(provider); }, onDisable() { registration?.dispose(); } };
}
