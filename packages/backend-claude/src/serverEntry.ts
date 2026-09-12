import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessProvider, HarnessRegistry } from "@polyth/contracts";
import { releaseProcessExecution } from "@polyth/harness-runtime";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { createHarnessProcessAuthority } from "@polyth/harness-runtime/process-authority";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { claudeAuthFingerprint, createClaudeRuntime, discoverClaudeModels, invalidateClaudeModelCache, CLAUDE_CAPABILITIES } from "./index.ts";
import { createClaudeProvisioner } from "./provisioner.ts";
const exec = promisify(execFile);
const configuredClaudeBinary = process.env.POLYTH_CLAUDE_BIN?.trim();
const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
// Optional SDK is loaded only by this package, never a server boot prerequisite.
const loadSdk = () => import("@anthropic-ai/claude-agent-sdk");

type ClaudeSessionInfoLike = {
    customTitle?: string | null;
    summary?: string | null;
};

/**
 * Agent-SDK sessions can report the first user prompt through `summary` even
 * when no semantic title was ever generated. `customTitle`, in contrast, is an
 * explicit native title. Keep the session object intact for resume detection,
 * but hide an untrusted summary from the runtime title-ingestion path.
 */
export function titleSafeClaudeSessionInfo<T extends ClaudeSessionInfoLike | null | undefined>(info: T): T {
    if (!info || info.customTitle) return info;
    return { ...info, summary: "" } as T;
}

const titleSafeClaudeSdk = async () => {
    const sdk = await loadSdk();
    return {
        query: sdk.query,
        async getSessionInfo(...args: Parameters<typeof sdk.getSessionInfo>) {
            return titleSafeClaudeSessionInfo(await sdk.getSessionInfo(...args));
        },
    };
};

const resolveClaudeBinary = async () => {
    const requested = configuredClaudeBinary || "claude";
    const report = await discoverHarnessExecutable(requested);
    if (!report.hit) {
        throw Object.assign(new Error(`Claude Code CLI was not found (${report.searched.slice(0, 8).join(", ") || "no searchable locations"})`), { code: "not-installed" });
    }
    const command = report.hit.executablePath;
    const env = await harnessExecutableChildEnv(command);
    // The SDK reads this existing Polyth override when it constructs its query.
    // Persist the exact discovered path for execution, but keep the user's
    // original override separately so a later refresh may rediscover a moved
    // default installation instead of treating our own cached path as intent.
    process.env.POLYTH_CLAUDE_BIN = command;
    process.env.PATH = env.PATH;
    return command;
};

export default function registerPackage(host: ServerPackageHost) {
    const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
    let lastAuthenticated: boolean | undefined;
    const stateFile = (context: Parameters<HarnessProvider["createRuntime"]>[0]) => {
        const key = createHash("sha256").update(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? "catalog"])).digest("hex");
        return host.spaceStorage(context.space!).path(`runtime/claude/${key}.json`);
    };
    const provider: HarnessProvider = {
        descriptor: { id: "claude", name: "Claude Code", integration: "Agent SDK", priority: 20, setupUrl: "https://code.claude.com/docs/en/setup", installCommand: "curl -fsSL https://claude.ai/install.sh | bash", signInCommand: "claude auth login" },
        // SDK-hosted sessions do not guarantee a semantic native title. The
        // canonical layer should therefore publish its fallback immediately;
        // an explicit customTitle event may still refine it later.
        staticFeatures: { ...CLAUDE_CAPABILITIES, title: "emulated" },
        async probe(context) {
            if (context.remote)
                return { harnessId: "claude", installed: false, healthy: false, authenticated: "unknown", message: "Local execution only" };
            try {
                await loadSdk();
            }
            catch {
                return { harnessId: "claude", installed: false, healthy: false, authenticated: "unknown", message: "Optional Claude Agent SDK dependency is unavailable" };
            }
            try {
                const command = await resolveClaudeBinary();
                const env = await harnessExecutableChildEnv(command);
                const shell = windowsShim(command);
                const version = (await exec(command, ["--version"], { timeout: 5000, maxBuffer: 4096, env, shell })).stdout.trim();
                const authenticated = await exec(command, ["auth", "status", "--json"], { timeout: 5000, maxBuffer: 8192, env, shell }).then(({ stdout }) => JSON.parse(stdout).loggedIn === true).catch(() => false);
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
            if (context.remote) {
                throw Object.assign(new Error("Local execution only"), { code: "unsupported" });
            }
            const command = await resolveClaudeBinary();
            const sdk = await loadSdk();
            const models = await discoverClaudeModels({
                query: sdk.query as Parameters<typeof discoverClaudeModels>[0]["query"],
                cwd: context.cwd,
                executable: command,
                authFingerprint: claudeAuthFingerprint(),
            });
            return {
                state: "ready" as const,
                authenticated: true,
                capabilities: { ...CLAUDE_CAPABILITIES, title: "emulated" as const },
                catalog: { models, agents: [] },
            };
        },
        async createRuntime(context) {
            if (!context.space || context.remote)
                throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
            await resolveClaudeBinary();
            const authority = await createHarnessProcessAuthority(stateFile(context));
            try {
                const runtime = await createClaudeRuntime(context, await titleSafeClaudeSdk(), authority);
                const capabilities = runtime.capabilities.bind(runtime);
                runtime.capabilities = async () => ({ ...await capabilities(), title: "emulated" as const });
                return runtime;
            }
            catch (error) {
                await authority.close();
                throw error;
            }
        },
        async releaseExecution(context, binding, operationId) {
            if (!context.space || context.remote)
                return { kind: "rejected", code: "unsupported", message: "Local Space context required" };
            if (process.platform !== "linux") {
                return {
                    kind: "rejected",
                    code: "unsupported",
                    message: "Crash-safe cross-harness switching currently requires Linux; this Claude runtime can still be used normally",
                };
            }
            return releaseProcessExecution(stateFile(context), binding, operationId);
        },
        provisioner: createClaudeProvisioner({
            storageRoot(context) {
                if (!context.space || context.space.spaceId !== context.spaceId) return undefined;
                return host.spaceStorage(context.space).packageDir(host.pluginId);
            },
        }),
    };
    let registration: ReturnType<HarnessRegistry["register"]> | undefined;
    return { remoteAccess: localOnlyRemoteAccess(["backend-claude"]), onEnable() { registration = registry.register(provider); }, onDisable() { registration?.dispose(); } };
}
