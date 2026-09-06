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
                try {
                    const models = await (await runtime(context)).models();
                    return { harnessId: "opencode", installed: true, authenticated: models.some((model) => model.connected), healthy: true, version: identity.version };
                }
                catch {
                    return { harnessId: "opencode", installed: true, authenticated: "unknown", healthy: false, version: identity.version, message: "The native OpenCode endpoint is unavailable" };
                }
            }
            catch {
                return { harnessId: "opencode", installed: false, authenticated: "unknown", healthy: false, message: "Install OpenCode to enable this harness" };
            }
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
