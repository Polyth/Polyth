import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessContext, HarnessProvider, HarnessRegistry } from "@polyth/contracts";
import { createStdioRpc } from "@polyth/harness-runtime";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createCodexRuntime, type Thread } from "./index.ts";
const exec = promisify(execFile);
export async function connectCodex(context: HarnessContext, stateFile?: string) {
    const rpc = await createStdioRpc({ command: process.env.POLYTH_CODEX_BIN ?? "codex", args: ["app-server"], cwd: context.cwd, stateFile, stableAuthority: true });
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
    const provider: HarnessProvider = {
        descriptor: { id: "codex", name: "Codex", integration: "App Server", priority: 10, setupUrl: "https://developers.openai.com/codex/cli/", installCommand: "npm install -g @openai/codex", signInCommand: "codex login" },
        async probe(context) {
            if (context.remote || process.platform !== "linux")
                return { harnessId: "codex", installed: false, authenticated: "unknown", healthy: false, message: "This adapter currently supports local Linux runtimes" };
            let version: string;
            try {
                version = (await exec(process.env.POLYTH_CODEX_BIN ?? "codex", ["--version"], { timeout: 5000, maxBuffer: 4096 })).stdout.trim();
            }
            catch {
                return { harnessId: "codex", installed: false, authenticated: "unknown", healthy: false };
            }
            try {
                const rpc = await connectCodex(context);
                try {
                    const auth = await rpc.request<{
                        account: unknown;
                        requiresOpenaiAuth: boolean;
                    }>("account/read", { refreshToken: false });
                    return { harnessId: "codex", installed: true, authenticated: Boolean(auth.account) || !auth.requiresOpenaiAuth, healthy: true, version };
                }
                finally {
                    await rpc.close();
                }
            }
            catch {
                return { harnessId: "codex", installed: true, authenticated: "unknown", healthy: false, version, message: "Codex App Server probe failed" };
            }
        },
        async createRuntime(context) {
            if (!context.space || context.remote || process.platform !== "linux")
                throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
            const key = createHash("sha256").update(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? "catalog"])).digest("hex");
            const stateFile = host.spaceStorage(context.space).path(`runtime/codex/${key}.json`);
            return createCodexRuntime(context, await connectCodex(context, stateFile));
        },
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
