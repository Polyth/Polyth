import type { AgentRuntime, HarnessContext, HarnessProvider, RuntimeCapabilities } from "@polyth/contracts";
import { CAPABILITIES } from "./index.ts";
import { inspectOpenCodeEngine, resolveOpenCodeBinary } from "./runtimeStorage.ts";
/** The composition root supplies its managed pool (config/restart interlocks).
 * Vendor discovery and native history stay in this package. */
export function createOpenCodeHarness(
    runtime: (context: HarnessContext) => Promise<AgentRuntime>,
    releaseExecution?: NonNullable<HarnessProvider["releaseExecution"]>,
): HarnessProvider {
    return {
        descriptor: { id: "opencode", name: "OpenCode", integration: "HTTP / SSE", priority: 0, setupUrl: "https://opencode.ai/docs/", installCommand: "npm install -g opencode-ai" },
        runtimeLifetime: "workspace",
        staticFeatures: CAPABILITIES,
        async probe(context) {
            if (context.remote)
                return { harnessId: "opencode", installed: true, authenticated: "unknown", healthy: true };
            try {
                const binary = await resolveOpenCodeBinary();
                const identity = await inspectOpenCodeEngine(binary.executablePath);
                // Detection is intentionally process-free. Provider/model setup
                // belongs to lazy detail discovery; opening chat must not boot a
                // runtime merely to populate a cosmetic settings count.
                return { harnessId: "opencode", installed: true, authenticated: "unknown", healthy: true, state: "unknown", version: identity.version };
            }
            catch {
                return { harnessId: "opencode", installed: false, authenticated: "unknown", healthy: false, message: "Install OpenCode to enable this harness" };
            }
        },
        async discover(context) {
            const engine = await runtime(context);
            const [models, agents, capabilities] = await Promise.all([
                engine.models(),
                engine.agents(),
                engine.capabilities(),
            ]);
            // Provider projection is on the interactive catalog path. Build it
            // in one pass instead of scanning the full model list for every
            // model (the previous map(... models.some(...)) was O(n²)).
            const providerMap = new Map<string, { id: string; name: string; connected: boolean }>();
            for (const model of models) {
                const current = providerMap.get(model.providerID);
                if (current) {
                    if (model.connected === true) current.connected = true;
                    // Preserve the old projection's ability to surface a
                    // provider display name even when only a later model row
                    // carries it.
                    if (current.name === current.id && model.providerName) current.name = model.providerName;
                    continue;
                }
                providerMap.set(model.providerID, {
                    id: model.providerID,
                    name: model.providerName ?? model.providerID,
                    connected: model.connected === true,
                });
            }
            const providers = [...providerMap.values()];
            const hasUsableModel = models.some((model) => model.connected !== false);
            return {
                state: hasUsableModel ? "ready" : "setup-required",
                authenticated: hasUsableModel ? true : "unknown",
                ...(!hasUsableModel ? { message: "Configure an OpenCode provider before starting a conversation" } : {}),
                capabilities,
                catalog: { providers, models, agents, roles: agents },
            };
        },
        createRuntime: runtime,
        ...(releaseExecution ? { releaseExecution } : {}),
        source: {
            async list(context) {
                const engine = await runtime(context);
                return (await engine.sessions()).map((s) => ({ ref: s.id, title: s.title, updatedAt: s.updatedAt }));
            },
            async *read(context, ref) {
                const engine = await runtime(context);
                if (!(await engine.sessions()).some((s) => s.id === ref))
                    throw Object.assign(new Error("native session not found"), { code: "not-found" });
                for (const message of await engine.history(ref))
                    yield { role: message.role, text: message.text };
            },
        },
    };
}
