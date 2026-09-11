import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessContext, HarnessProvider, HarnessRegistry } from "@polyth/contracts";
import {
    createStdioRpc,
    discoverHarnessExecutable,
    harnessExecutableChildEnv,
    releaseProcessExecution,
} from "@polyth/harness-runtime";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createCodexRuntime, CODEX_CAPABILITIES, type Thread } from "./index.ts";
import { createCodexProvisioner } from "./provisioner.ts";
const exec = promisify(execFile);

const resolveCodexBinary = async () => {
    const requested = process.env.POLYTH_CODEX_BIN?.trim() || "codex";
    const report = await discoverHarnessExecutable(requested);
    if (!report.hit) {
        throw Object.assign(new Error(`Codex CLI was not found (${report.searched.slice(0, 8).join(", ") || "no searchable locations"})`), { code: "not-installed" });
    }
    return report.hit.executablePath;
};

export async function connectCodex(context: HarnessContext, stateFile?: string) {
    const command = await resolveCodexBinary();
    const env = await harnessExecutableChildEnv(command);
    const rpc = await createStdioRpc({ command, args: ["app-server"], cwd: context.cwd, stateFile, stableAuthority: true, env });
    try {
        await rpc.request("initialize", { clientInfo: { name: "polyth", title: "Polyth", version: "0.1.0" } });
        rpc.notify("initialized", {});
        return rpc;
    }
    catch (error) {
        await rpc.close();
        throw error;
    }
}
export default function registerPackage(host: ServerPackageHost) {
    const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
    const stateFile = (context: HarnessContext) => {
        const key = createHash("sha256").update(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? "catalog"])).digest("hex");
        return host.spaceStorage(context.space!).path(`runtime/codex/${key}.json`);
    };
    const provider: HarnessProvider = {
        descriptor: { id: "codex", name: "Codex", integration: "App Server", priority: 10, setupUrl: "https://developers.openai.com/codex/cli/", installCommand: "npm install -g @openai/codex", signInCommand: "codex login" },
        staticFeatures: CODEX_CAPABILITIES,
        async probe(context) {
            if (context.remote)
                return { harnessId: "codex", installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const command = await resolveCodexBinary();
                const env = await harnessExecutableChildEnv(command);
                const version = (await exec(command, ["--version"], { timeout: 5000, maxBuffer: 4096, env })).stdout.trim();
                // Authentication and catalog inspection happen only when detail
                // discovery is requested; the cheap probe must not create a thread.
                return { harnessId: "codex", installed: true, authenticated: "unknown", healthy: true, state: "unknown", version };
            }
            catch {
                return { harnessId: "codex", installed: false, authenticated: "unknown", healthy: false };
            }
        },
        async discover(context) {
            const runtime = await createCodexRuntime(context, await connectCodex(context));
            try {
                const [models, agents, capabilities] = await Promise.all([
                    runtime.models(), runtime.agents(), runtime.capabilities(),
                ]);
                return { state: "ready", authenticated: true, capabilities, catalog: { models, agents } };
            }
            finally {
                await runtime.dispose();
            }
        },
        async createRuntime(context) {
            if (!context.space || context.remote)
                throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
            return createCodexRuntime(context, await connectCodex(context, stateFile(context)));
        },
        async releaseExecution(context, binding, operationId) {
            if (!context.space || context.remote)
                return { kind: "rejected", code: "unsupported", message: "Local Space context required" };
            if (process.platform !== "linux") {
                return {
                    kind: "rejected",
                    code: "unsupported",
                    message: "Crash-safe cross-harness switching currently requires Linux; this Codex runtime can still be used normally",
                };
            }
            return releaseProcessExecution(stateFile(context), binding, operationId);
        },
        provisioner: createCodexProvisioner(),
        source: {
            async list(context) {
                const rpc = await connectCodex(context);
                try {
                    const result = await rpc.request<{
                        data: Thread[];
                    }>("thread/list", { cwd: context.cwd, sourceKinds: ["cli"], limit: 100 });
                    return result.data.filter((thread) => thread.cwd === context.cwd).map((thread) => ({ ref: thread.id, title: thread.name ?? thread.preview ?? "Codex session", updatedAt: (thread.updatedAt ?? 0) * 1000 }));
                }
                finally {
                    await rpc.close();
                }
            },
            async *read(context, ref) {
                const rpc = await connectCodex(context);
                try {
                    const { thread } = await rpc.request<{
                        thread: Thread;
                    }>("thread/read", { threadId: ref, includeTurns: true });
                    if (thread.cwd !== context.cwd || thread.source !== "cli")
                        throw Object.assign(new Error("source not found"), { code: "not-found" });
                    if (thread.historyMode === "paginated" || thread.turns?.some((turn) => turn.itemsView && turn.itemsView !== "full"))
                        throw Object.assign(new Error("Native history is incomplete"), { code: "unsupported" });
                    for (const turn of thread.turns ?? [])
                        for (const item of turn.items ?? []) {
                            if (item.type === "agentMessage" && item.text)
                                yield { role: "assistant", text: item.text };
                            if (item.type === "userMessage") {
                                const text = (item.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
                                if (text)
                                    yield { role: "user", text };
                            }
                        }
                }
                finally {
                    await rpc.close();
                }
            },
        },
    };
    let registration: ReturnType<HarnessRegistry["register"]> | undefined;
    return { remoteAccess: localOnlyRemoteAccess(["backend-codex"]), onEnable() { registration = registry.register(provider); }, onDisable() { registration?.dispose(); } };
}
