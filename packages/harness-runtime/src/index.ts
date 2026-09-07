export { createProcessAuthority } from "./authority.ts";
export { createStdioRpc, type RpcPeer } from "./rpc.ts";
import type { AgentRuntime, HarnessContext, HarnessProvider, HarnessRegistry, HarnessSelection, SessionProjection } from "@polyth/contracts";

export const harnessError = (code: string, message: string): Error => Object.assign(new Error(message), { code });
export type HarnessPreferences = Record<string, {
    enabled?: boolean;
    priority?: number;
}>;
export function createHarnessRegistry() {
    let policy: (context: HarnessContext) => Promise<HarnessPreferences> = async () => ({});
    const providers = new Map<string, HarnessProvider>();
    const list = () => [...providers.values()].sort((a, b) => a.descriptor.priority - b.descriptor.priority || a.descriptor.id.localeCompare(b.descriptor.id));
    const probeOne = async (provider: HarnessProvider, context: HarnessContext) => {
        try {
            return await provider.probe(context);
        }
        catch {
            return { harnessId: provider.descriptor.id, installed: false, authenticated: "unknown" as const, healthy: false, message: "Harness probe failed" };
        }
    };
    return {
        configurePolicy(read: typeof policy) { policy = read; },
        register(provider: HarnessProvider) {
            const id = provider.descriptor.id;
            if (!/^[a-z][a-z0-9-]*$/.test(id) || providers.has(id))
                throw harnessError("conflict", "invalid or duplicate harness id");
            providers.set(id, provider);
            return { dispose() { if (providers.get(id) === provider)
                    providers.delete(id); } };
        },
        providers: list,
        probe: (context: HarnessContext) => Promise.all(list().map((provider) => probeOne(provider, context))),
        async resolve(context: HarnessContext, selection: HarnessSelection, stickyId?: string) {
            const id = selection.mode === "pinned" ? selection.harnessId : stickyId;
            const preferences = await policy(context);
            const ordered = list().filter((p) => preferences[p.descriptor.id]?.enabled !== false).sort((a, b) => (preferences[a.descriptor.id]?.priority ?? a.descriptor.priority) - (preferences[b.descriptor.id]?.priority ?? b.descriptor.priority) || a.descriptor.id.localeCompare(b.descriptor.id));
            const candidates = selection.mode === "pinned"
                ? ordered.filter((p) => p.descriptor.id === id)
                : [...ordered.filter((p) => p.descriptor.id === id), ...ordered.filter((p) => p.descriptor.id !== id)].filter((p) => p.descriptor.autoSelect !== false);
            for (const provider of candidates) {
                const probe = await probeOne(provider, context);
                if (probe.installed && probe.healthy && probe.authenticated !== false)
                    return provider;
            }
            throw harnessError("runtime-unavailable", selection.mode === "pinned" ? `Selected harness ${selection.harnessId} is unavailable` : "No compatible harness is ready. Open Harnesses in Settings to set one up.");
        },
    };
}
/** The registry chooses factories; AgentRuntime remains the execution seam.
 * Persisted routes are exact lookups, never Auto fallback while old authority
 * may be alive. Only a new, not-yet-admitted session may try another factory. */
type HarnessCacheEntry = {
    sessionId: string;
    pending: Promise<AgentRuntime>;
    runtime?: AgentRuntime;
};

const harnessCacheKey = (
    spaceId: string,
    projectId: string,
    cwd: string,
    sessionId: string,
    harnessId: string,
): string => JSON.stringify([spaceId, projectId, cwd, sessionId, harnessId]);

export function createHarnessPool(options: {
    registry: HarnessRegistry;
    context(projectId: string, cwd?: string, sessionId?: string): Promise<HarnessContext>;
    legacyHarnessId: string;
}) {
    const cached = new Map<string, HarnessCacheEntry>();
    const get = async (context: HarnessContext, provider: HarnessProvider) => {
        const sessionId = context.sessionId ?? "";
        const key = harnessCacheKey(context.spaceId, context.projectId, context.cwd, sessionId, provider.descriptor.id);
        let entry = cached.get(key);
        if (!entry) {
            const pending = provider.createRuntime(context).then((runtime) => {
                Object.defineProperty(runtime, "harnessId", { value: provider.descriptor.id, configurable: true });
                const current = cached.get(key);
                if (current?.pending === pending) current.runtime = runtime;
                return runtime;
            });
            entry = { sessionId, pending };
            cached.set(key, entry);
            pending.catch(() => { if (cached.get(key)?.pending === pending) cached.delete(key); });
        }
        return entry.pending;
    };
    return {
        async forProject(projectId: string, cwd?: string) {
            const context = await options.context(projectId, cwd);
            return get(context, await options.registry.resolve(context, { mode: "auto" }));
        },
        async forSession(projection: SessionProjection, cwd: string, targetHarnessId?: string) {
            const context = { ...await options.context(projection.projectId, cwd, projection.id), model: projection.model };
            const existingId = targetHarnessId ?? projection.resolvedHarnessId
                ?? (projection.backendSessionId ? options.legacyHarnessId : undefined);
            const selection = existingId ? { mode: "pinned" as const, harnessId: existingId } : projection.harness ?? { mode: "auto" as const };
            // Once a route has native state, probe failure must not select another
            // engine or prevent the provider from reconciling/releasing that state.
            if (existingId) {
                const existing = cached.get(harnessCacheKey(context.spaceId, context.projectId, context.cwd, context.sessionId ?? "", existingId));
                if (existing)
                    return existing.pending;
                const provider = options.registry.providers().find((p) => p.descriptor.id === existingId);
                if (!provider)
                    throw harnessError("runtime-unavailable", `Harness ${existingId} is not registered`);
                return get(context, provider);
            }
            const first = await options.registry.resolve(context, selection);
            try {
                return await get(context, first);
            }
            catch (error) {
                if (selection.mode === "pinned")
                    throw error;
                // Construction is before native creation/admission. A failed factory
                // must dispose its process; persisted native routes never use this path.
                for (const other of options.registry.providers()) {
                    if (other === first || other.descriptor.autoSelect === false)
                        continue;
                    try {
                        const ready = await options.registry.resolve(context, { mode: "pinned", harnessId: other.descriptor.id });
                        return await get(context, ready);
                    }
                    catch { /* isolate a broken optional factory */ }
                }
                throw error;
            }
        },
        async resolve(projection: SessionProjection, cwd: string, selection: HarnessSelection) {
            const context = { ...await options.context(projection.projectId, cwd, projection.id), model: projection.model };
            return (await options.registry.resolve(context, selection, projection.resolvedHarnessId)).descriptor.id;
        },
        forgetSession(sessionId: string) {
            for (const [key, entry] of cached) {
                if (entry.sessionId === sessionId) cached.delete(key);
            }
        },
        forgetRuntime(runtime: AgentRuntime) {
            for (const [key, entry] of cached) {
                if (entry.runtime === runtime) cached.delete(key);
            }
        },
        async dispose() {
            const seen = new Set<AgentRuntime>();
            const jobs = [...cached.values()].map(async (entry) => {
                const runtime = entry.runtime ?? await entry.pending;
                if (seen.has(runtime)) return;
                seen.add(runtime);
                await runtime.dispose();
            });
            cached.clear();
            const results = await Promise.allSettled(jobs);
            const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, "harness runtime disposal failed");
        },
    };
}
