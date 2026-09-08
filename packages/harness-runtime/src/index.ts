export { createProcessAuthority } from "./authority.ts";
export { createStdioRpc, type RpcPeer } from "./rpc.ts";
import type {
    AgentRuntime,
    HarnessAvailabilityState,
    HarnessContext,
    HarnessProbe,
    HarnessProvider,
    HarnessRegistry,
    HarnessSelection,
    HarnessSnapshot,
    SessionProjection,
} from "@polyth/contracts";
export const harnessError = (code: string, message: string): Error => Object.assign(new Error(message), { code });
export type HarnessPreferences = Record<string, {
    enabled?: boolean;
    priority?: number;
}>;
export function harnessAvailability(probe: HarnessProbe): HarnessAvailabilityState {
    if (probe.state)
        return probe.state;
    if (!probe.installed)
        return /support|incompatible|not available here/i.test(probe.message ?? "") ? "incompatible" : "not-installed";
    if (!probe.healthy)
        return "offline";
    if (probe.authenticated === false)
        return "auth-required";
    return probe.authenticated === "unknown" ? "unknown" : "ready";
}
const runnable = (probe: HarnessProbe): boolean => {
    const state = harnessAvailability(probe);
    return probe.installed && probe.healthy && probe.authenticated !== false
        && state !== "setup-required" && state !== "partially-configured"
        && state !== "incompatible" && state !== "offline" && state !== "not-installed";
};
export function createHarnessRegistry() {
    let policy: (context: HarnessContext) => Promise<HarnessPreferences> = async () => ({});
    const providers = new Map<string, HarnessProvider>();
    const snapshots = new Map<string, {
        current?: HarnessSnapshot;
        lastGood?: HarnessSnapshot;
        pending?: Promise<HarnessSnapshot>;
    }>();
    let revision = 0;
    const SNAPSHOT_TTL_MS = 15_000;
    const snapshotKey = (context: HarnessContext, harnessId: string) => JSON.stringify([
        context.spaceId,
        context.projectId,
        context.cwd,
        context.remote ?? false,
        harnessId,
    ]);
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
            return { dispose() { if (providers.get(id) === provider) {
                    providers.delete(id);
                    for (const key of snapshots.keys())
                        if (JSON.parse(key).at(-1) === id)
                            snapshots.delete(key);
                } } };
        },
        providers: list,
        probe: (context: HarnessContext) => Promise.all(list().map((provider) => probeOne(provider, context))),
        async snapshots(context: HarnessContext, options: { harnessId?: string; force?: boolean; detail?: boolean } = {}) {
            const preferences = await policy(context);
            const selected = options.harnessId
                ? list().filter((provider) => provider.descriptor.id === options.harnessId)
                : list();
            return Promise.all(selected.map(async (provider) => {
                const key = snapshotKey(context, provider.descriptor.id);
                const entry = snapshots.get(key) ?? {};
                snapshots.set(key, entry);
                const fresh = entry.current
                    && Date.now() - entry.current.context.fetchedAt < SNAPSHOT_TTL_MS
                    && (!options.detail || entry.current.catalog !== undefined || provider.discover === undefined);
                if (!options.force && fresh)
                    return entry.current!;
                if (!options.force && entry.pending)
                    return entry.pending;
                const pending = (async (): Promise<HarnessSnapshot> => {
                    const checkedAt = Date.now();
                    const probe = await probeOne(provider, context);
                    let discovery;
                    let discoveryError: unknown;
                    if (options.detail && provider.discover) {
                        try {
                            discovery = await provider.discover(context);
                        }
                        catch (error) {
                            discoveryError = error;
                        }
                    }
                    const discoveryMessage = discoveryError instanceof Error ? discoveryError.message : String(discoveryError ?? "");
                    const state = discoveryError && /auth|login|sign[ -]?in|credential/i.test(discoveryMessage)
                        ? "auth-required" as const
                        : discoveryError && probe.healthy
                            ? "degraded" as const
                            : discovery?.state ?? harnessAvailability(probe);
                    const availability = {
                        ...probe,
                        ...(discovery?.authenticated !== undefined ? { authenticated: discovery.authenticated } : {}),
                        state,
                        checkedAt,
                    };
                    const lastGood = entry.lastGood;
                    const degraded = discoveryError !== undefined || state === "offline" || state === "degraded";
                    // A cheap probe refresh must not erase metadata previously
                    // obtained by an explicit detail discovery. During an outage,
                    // use only the last successful snapshot as the fallback.
                    const retained = !options.detail
                        ? entry.current ?? lastGood
                        : degraded ? lastGood : undefined;
                    const discoveredCatalog = discovery?.catalog ? {
                        ...discovery.catalog,
                        ...(discovery.catalog.models ? { models: discovery.catalog.models.map((model) => ({ ...model, harnessId: provider.descriptor.id })) } : {}),
                        ...(discovery.catalog.agents ? { agents: discovery.catalog.agents.map((agent) => ({ ...agent, harnessId: provider.descriptor.id })) } : {}),
                        ...(discovery.catalog.roles ? { roles: discovery.catalog.roles.map((role) => ({ ...role, harnessId: provider.descriptor.id })) } : {}),
                    } : undefined;
                    const snapshot: HarnessSnapshot = {
                        identity: {
                            id: provider.descriptor.id,
                            name: provider.descriptor.name,
                            integration: provider.descriptor.integration,
                            ...(probe.version ? { version: probe.version } : {}),
                        },
                        availability,
                        policy: {
                            enabled: preferences[provider.descriptor.id]?.enabled ?? true,
                            priority: preferences[provider.descriptor.id]?.priority ?? provider.descriptor.priority,
                            autoSelect: provider.descriptor.autoSelect !== false,
                        },
                        ...(provider.descriptor.installCommand || provider.descriptor.signInCommand || provider.descriptor.setupUrl
                            ? { setup: {
                                ...(provider.descriptor.installCommand ? { installCommand: provider.descriptor.installCommand } : {}),
                                ...(provider.descriptor.signInCommand ? { signInCommand: provider.descriptor.signInCommand } : {}),
                                ...(provider.descriptor.setupUrl ? { setupUrl: provider.descriptor.setupUrl } : {}),
                            } }
                            : {}),
                        ...(discovery?.capabilities ?? retained?.capabilities
                            ? { capabilities: discovery?.capabilities ?? retained?.capabilities }
                            : {}),
                        ...(discoveredCatalog ?? retained?.catalog
                            ? { catalog: discoveredCatalog ?? retained?.catalog }
                            : {}),
                        ...(discovery?.controls || discovery?.restartRequired !== undefined || discovery?.pendingChanges !== undefined
                            ? { configuration: {
                                controls: discovery.controls ?? [],
                                ...(discovery.restartRequired !== undefined ? { restartRequired: discovery.restartRequired } : {}),
                                ...(discovery.pendingChanges !== undefined ? { pendingChanges: discovery.pendingChanges } : {}),
                            } }
                            : retained?.configuration ? { configuration: retained.configuration } : {}),
                        context: {
                            spaceId: context.spaceId,
                            projectId: context.projectId,
                            cwd: context.cwd,
                            ...(context.remote !== undefined ? { remote: context.remote } : {}),
                            revision: `${checkedAt}-${++revision}`,
                            fetchedAt: checkedAt,
                        },
                        ...(degraded && lastGood ? { stale: true } : {}),
                        ...(discoveryError ? { message: discoveryMessage }
                            : discovery?.message ? { message: discovery.message }
                                : probe.message ? { message: probe.message } : {}),
                        ...(discovery?.native !== undefined
                            ? { native: discovery.native }
                            : retained?.native !== undefined ? { native: retained.native } : {}),
                    };
                    entry.current = snapshot;
                    if (!degraded && (state === "ready" || state === "unknown" || state === "partially-configured"))
                        entry.lastGood = snapshot;
                    return snapshot;
                })();
                entry.pending = pending;
                return pending.finally(() => {
                    if (entry.pending === pending)
                        entry.pending = undefined;
                });
            }));
        },
        invalidate(match: Partial<Pick<HarnessContext, "spaceId" | "projectId" | "cwd">> & { harnessId?: string } = {}) {
            for (const [key, entry] of snapshots) {
                const [spaceId, projectId, cwd, , harnessId] = JSON.parse(key) as [string, string, string, boolean, string];
                if (match.spaceId !== undefined && match.spaceId !== spaceId)
                    continue;
                if (match.projectId !== undefined && match.projectId !== projectId)
                    continue;
                if (match.cwd !== undefined && match.cwd !== cwd)
                    continue;
                if (match.harnessId !== undefined && match.harnessId !== harnessId)
                    continue;
                entry.current = undefined;
            }
        },
        async resolve(context: HarnessContext, selection: HarnessSelection, stickyId?: string) {
            const id = selection.mode === "pinned" ? selection.harnessId : stickyId;
            const preferences = await policy(context);
            const ordered = list().filter((p) => preferences[p.descriptor.id]?.enabled !== false).sort((a, b) => (preferences[a.descriptor.id]?.priority ?? a.descriptor.priority) - (preferences[b.descriptor.id]?.priority ?? b.descriptor.priority) || a.descriptor.id.localeCompare(b.descriptor.id));
            const candidates = selection.mode === "pinned"
                ? ordered.filter((p) => p.descriptor.id === id)
                : [...ordered.filter((p) => p.descriptor.id === id), ...ordered.filter((p) => p.descriptor.id !== id)].filter((p) => p.descriptor.autoSelect !== false);
            for (const provider of candidates) {
                let probe = await probeOne(provider, context);
                if (!runnable(probe))
                    continue;
                // Cheap probes deliberately avoid starting native runtimes.
                // At the actual execution boundary, refine unknown readiness
                // so Auto cannot select a harness that discovery identifies as
                // unauthenticated or setup-incomplete.
                if (provider.discover && (probe.state === "unknown" || probe.authenticated === "unknown")) {
                    try {
                        const discovery = await provider.discover(context);
                        probe = {
                            ...probe,
                            ...(discovery.authenticated !== undefined ? { authenticated: discovery.authenticated } : {}),
                            ...(discovery.state !== undefined ? { state: discovery.state } : {}),
                            ...(discovery.message ? { message: discovery.message } : {}),
                        };
                    }
                    catch {
                        continue;
                    }
                }
                if (runnable(probe))
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
