import type { AgentRuntime, HarnessContext, HarnessProvider } from "@polyth/contracts";
import { inspectOpenCodeEngine, resolveOpenCodeBinary } from "./runtimeStorage.ts";
/** The composition root supplies its managed pool (config/restart interlocks).
 * Vendor discovery and native history stay in this package. */
export function createOpenCodeHarness(runtime: (context: HarnessContext) => Promise<AgentRuntime>): HarnessProvider {
    return {
        descriptor: { id: "opencode", name: "OpenCode", integration: "HTTP / SSE", priority: 0, setupUrl: "https://opencode.ai/docs/", installCommand: "npm install -g opencode-ai" },
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
            const providers = [...new Map(models.map((model) => [model.providerID, {
                id: model.providerID,
                name: model.providerName ?? model.providerID,
                connected: models.some((candidate) => candidate.providerID === model.providerID && candidate.connected === true),
            }])).values()];
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
