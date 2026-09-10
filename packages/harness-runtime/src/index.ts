export {
    createProcessAuthority,
    releaseProcessExecution,
    type ProcessAuthorityOptions,
    type ProcessAuthorityProof,
    type ProcessContainment,
    type ProcessContainmentController,
} from "./authority.ts";
export { createStdioRpc, type RpcPeer } from "./rpc.ts";
export {
  acknowledgeCapabilityApplication,
  captureCapabilityLaunch,
  capabilityRevision,
  createCapabilityContributionRegistry,
  createLaunchOverlayStore,
  desiredBundleRevision,
  mcpNativeNameCollision,
  overlayKey,
  planHarnessCapabilities,
  provisioningTarget,
  provisioningTargetKey,
  releaseCapabilityLaunch,
  semanticCapabilityRevision,
  setCapabilityLaunchSink,
  setCapabilityReceiptSink,
} from "./capabilities.ts";
export type { LaunchOverlayRecord, LaunchOverlayStore } from "./capabilities.ts";
export {
  composeTurnPrompt,
  deltaCost,
  deltaTokenUsage,
  isPlaceholderTitle,
  titleFromPrompt,
} from "./features.ts";
export { contextWindowTelemetry, normalizeTokenUsage } from "./telemetry.ts";
// The canonical model/attachment control rules live on the contract surface so
// the browser can apply the same ones without importing this node-side
// package. Adapters keep one import site by re-exporting them here.
export {
  attachmentModality,
  effectiveAttachmentSupport,
  findModelDescriptor,
  harnessModels,
  resolveModelSelection,
  resolveVariantPreference,
  type ModelSelection,
} from "@polyth/contracts";
export {
  composeProjectedPrompt,
  planAttachmentDelivery,
  projectAttachmentText,
  materializeAttachmentText,
  TEXT_PROJECTION_MAX_BYTES,
  unsupportedAttachmentMessage,
  type AttachmentDeliveryInput,
  type AttachmentDeliveryPlan,
  type TextProjection,
  type TextProjectionInput,
} from "./delivery.ts";
import type {
    AgentRuntime,
    HarnessAvailabilityState,
    HarnessContext,
    HarnessProbe,
    HarnessProvider,
    HarnessRegistry,
    HarnessSelection,
    HarnessSnapshot,
    RuntimeSessionBinding,
    SessionProjection,
} from "@polyth/contracts";
export const harnessError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export function harnessProviderById(registry: HarnessRegistry, id: string): HarnessProvider {
  const provider = registry.get(id);
  if (!provider) {
    throw harnessError("runtime-unavailable", `Harness ${id} is not registered`);
  }
  return provider;
}
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
        pending?: {
            detail: boolean;
            generation: number;
            promise: Promise<HarnessSnapshot>;
        };
        /** Last successful detail/discovery verification for current metadata. */
        detailedAt?: number;
        /** Snapshot revision whose auth/state was positively verified. Catalog
         * freshness alone is never execution-readiness proof. */
        readinessRevision?: string;
        /** Invalidations and forced refreshes fence older asynchronous writes. */
        generation: number;
    }>();
    let revision = 0;
    const SNAPSHOT_TTL_MS = 15_000;
    const DETAIL_TTL_MS = 5 * 60_000;
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
        get(id: string) {
            return providers.get(id);
        },
        probe: (context: HarnessContext) => Promise.all(list().map((provider) => probeOne(provider, context))),
        async snapshots(context: HarnessContext, options: { harnessId?: string; force?: boolean; detail?: boolean } = {}) {
            const preferences = await policy(context);
            const selected = options.harnessId
                ? list().filter((provider) => provider.descriptor.id === options.harnessId)
                : list();
            return Promise.all(selected.map(async (provider) => {
                const key = snapshotKey(context, provider.descriptor.id);
                const entry = snapshots.get(key) ?? { generation: 0 };
                snapshots.set(key, entry);
                const generation = options.force ? ++entry.generation : entry.generation;
                // A forced probe can reflect an auth/config/runtime change.
                // Keep the old catalog only as presentation fallback while
                // making the next detail caller revalidate it.
                if (options.force) {
                    entry.detailedAt = undefined;
                    provider.invalidateDiscovery?.(context);
                }
                const now = Date.now();
                const summaryFresh = entry.current
                    && now - entry.current.context.fetchedAt < SNAPSHOT_TTL_MS;
                const detailFresh = entry.current
                    && (provider.discover === undefined
                        || (entry.detailedAt !== undefined && now - entry.detailedAt < DETAIL_TTL_MS));
                const needsDetail = Boolean(options.detail && provider.discover
                    && (options.force || !detailFresh));
                if (!options.force && entry.pending && (!needsDetail || entry.pending.detail))
                    return entry.pending.promise;
                if (!options.force && summaryFresh && (!options.detail || detailFresh))
                    return entry.current!;

                const refresh = async (
                    detail: boolean,
                    generation: number,
                    knownProbe?: HarnessProbe,
                ): Promise<HarnessSnapshot> => {
                    const currentAtStart = entry.current;
                    const lastGoodAtStart = entry.lastGood;
                    const checkedAt = Date.now();
                    const probe = knownProbe ?? await probeOne(provider, context);
                    let discovery;
                    let discoveryError: unknown;
                    if (detail && provider.discover) {
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
                    const lastGood = lastGoodAtStart;
                    const degraded = discoveryError !== undefined || state === "offline" || state === "degraded";
                    // A cheap probe refresh must not erase metadata previously
                    // obtained by an explicit detail discovery. During an outage,
                    // use only the last successful snapshot as the fallback.
                    const retained = !detail
                        ? currentAtStart ?? lastGood
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
                    if (entry.generation === generation && snapshots.get(key) === entry) {
                        entry.current = snapshot;
                        if (detail && provider.discover && discoveryError === undefined)
                            entry.detailedAt = checkedAt;
                        entry.readinessRevision = state !== "unknown"
                            && availability.authenticated !== "unknown"
                            ? snapshot.context.revision
                            : undefined;
                        if (!degraded && (state === "ready" || state === "unknown" || state === "partially-configured"))
                            entry.lastGood = snapshot;
                    }
                    return snapshot;
                };
                const previous = !options.force && needsDetail && entry.pending && !entry.pending.detail
                    ? entry.pending
                    : undefined;
                const pending = {} as NonNullable<typeof entry.pending>;
                const work = previous
                    ? previous.promise.then((summary) => refresh(
                        true,
                        generation,
                        summary.availability as HarnessProbe,
                    ))
                    : refresh(needsDetail, generation);
                pending.detail = needsDetail;
                pending.generation = generation;
                pending.promise = work.finally(() => {
                    if (entry.pending === pending)
                        entry.pending = undefined;
                });
                entry.pending = pending;
                return pending.promise;
            }));
        },
        invalidate(match: Partial<Pick<HarnessContext, "spaceId" | "projectId" | "cwd" | "remote">> & { harnessId?: string } = {}) {
            for (const [key, entry] of snapshots) {
                const [spaceId, projectId, cwd, remote, harnessId] = JSON.parse(key) as [string, string, string, boolean, string];
                if (match.spaceId !== undefined && match.spaceId !== spaceId)
                    continue;
                if (match.projectId !== undefined && match.projectId !== projectId)
                    continue;
                if (match.cwd !== undefined && match.cwd !== cwd)
                    continue;
                if (match.remote !== undefined && match.remote !== remote)
                    continue;
                if (match.harnessId !== undefined && match.harnessId !== harnessId)
                    continue;
                entry.generation += 1;
                entry.current = undefined;
                entry.lastGood = undefined;
                entry.detailedAt = undefined;
                entry.readinessRevision = undefined;
                entry.pending = undefined;
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
                const cache = snapshots.get(snapshotKey(context, provider.descriptor.id));
                const current = cache?.current;
                if (current && Date.now() - current.context.fetchedAt < SNAPSHOT_TTL_MS) {
                    const cachedProbe = current.availability as HarnessProbe;
                    if (!runnable(cachedProbe))
                        continue;
                    // Detail discovery already proved readiness for this exact
                    // context. Re-running probe/discover here was the main warm
                    // harness-switch tax and could start OpenCode just to select
                    // a runtime that was already known-good.
                    const readinessVerified = provider.discover === undefined
                        || cache?.readinessRevision === current.context.revision;
                    if (readinessVerified)
                        return provider;
                }
                let probe = await probeOne(provider, context);
                if (!runnable(probe))
                    continue;
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
                        if (cache?.current) {
                            const checkedAt = Date.now();
                            const refined = {
                                ...cache.current,
                                availability: { ...cache.current.availability, ...probe, checkedAt },
                                context: {
                                    ...cache.current.context,
                                    revision: `${checkedAt}-${++revision}`,
                                    fetchedAt: checkedAt,
                                },
                            };
                            cache.current = refined;
                            cache.readinessRevision = probe.state !== "unknown"
                                && probe.authenticated !== "unknown"
                                ? refined.context.revision
                                : undefined;
                            // This path verified execution readiness only. It did
                            // not materialize catalog/capabilities/configuration,
                            // so a later detail=1 request must still discover them.
                        }
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
    lifetime: "session" | "workspace";
    pending: Promise<AgentRuntime>;
    runtime?: AgentRuntime;
    releasing?: Promise<void>;
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
    /** Runs before a new runtime is constructed. Provisioning uses this hook. */
    beforeCreate?: (provider: HarnessProvider, context: HarnessContext) => Promise<void>;
    /** Physical owner may retain a shared runtime with other bindings/executions. */
    releaseRuntime?: (runtime: AgentRuntime, dispose: () => Promise<void>) => Promise<void>;
}) {
    const cached = new Map<string, HarnessCacheEntry>();
    const failedRetirements = new Map<string, HarnessCacheEntry[]>();
    const runtimeLocations = new WeakMap<AgentRuntime, string>();
    const disposals = new WeakMap<AgentRuntime, Promise<void>>();
    const disposeOnce = (runtime: AgentRuntime): Promise<void> => {
        let pending = disposals.get(runtime);
        if (!pending) {
            // Start synchronously so a shared owner's occupancy check and fence
            // cannot admit a new binding between those two steps.
            pending = (async () => runtime.dispose())();
            disposals.set(runtime, pending);
        }
        return pending;
    };
    const available = async (entry: HarnessCacheEntry): Promise<AgentRuntime> => {
        const runtime = await entry.pending;
        if (entry.releasing) {
            await entry.releasing;
            throw harnessError("runtime-unavailable", "Session runtime was released; retry with the current workspace");
        }
        return runtime;
    };
    const get = async (context: HarnessContext, provider: HarnessProvider) => {
        const sessionId = context.sessionId ?? "";
        const releasing = [...cached.values()].find(entry => entry.sessionId === sessionId && entry.releasing);
        if (releasing) {
            await releasing.releasing;
            throw harnessError("runtime-unavailable", "Session runtime release is pending; retry with the current workspace");
        }
        const key = harnessCacheKey(context.spaceId, context.projectId, context.cwd, sessionId, provider.descriptor.id);
        let entry = cached.get(key);
        if (!entry) {
            const created: HarnessCacheEntry = {
                sessionId,
                lifetime: provider.runtimeLifetime ?? "session",
                pending: Promise.resolve(undefined as unknown as AgentRuntime),
            };
            created.pending = (async () => {
                await options.beforeCreate?.(provider, context);
                const runtime = await provider.createRuntime(context);
                if (disposals.has(runtime)) {
                    throw harnessError("runtime-unavailable", "Provider returned a released runtime");
                }
                const location = JSON.stringify([
                    context.spaceId,
                    context.projectId,
                    context.cwd,
                    provider.descriptor.id,
                ]);
                const priorLocation = runtimeLocations.get(runtime);
                if (priorLocation !== undefined && priorLocation !== location) {
                    throw harnessError(
                        "runtime-unavailable",
                        `Harness ${provider.descriptor.id} reused one runtime facade across workspace locations`,
                    );
                }
                runtimeLocations.set(runtime, location);
                Object.defineProperty(runtime, "harnessId", { value: provider.descriptor.id, configurable: true });
                if (cached.get(key) === created) created.runtime = runtime;
                return runtime;
            })();
            entry = created;
            cached.set(key, entry);
            created.pending.catch(() => { if (cached.get(key) === created) cached.delete(key); });
        }
        return available(entry);
    };
    return {
        /** Read cached/discovered metadata for all harnesses in one project context. */
        async harnessSnapshots(
            projectId: string,
            cwd?: string,
            snapshotOptions: { harnessId?: string; force?: boolean; detail?: boolean } = {},
        ) {
            const context = await options.context(projectId, cwd);
            return options.registry.snapshots(context, snapshotOptions);
        },
        async forProject(projectId: string, cwd?: string, targetHarnessId?: string) {
            const context = await options.context(projectId, cwd);
            return get(context, await options.registry.resolve(context, targetHarnessId
                ? { mode: "pinned", harnessId: targetHarnessId }
                : { mode: "auto" }));
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
                if (existing) return available(existing);
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
        async releaseSessionExecution(
            projection: SessionProjection,
            binding: RuntimeSessionBinding,
            operationId: string,
        ) {
            const harnessId = projection.resolvedHarnessId
                ?? (projection.backendSessionId ? options.legacyHarnessId : undefined);
            if (!harnessId)
                return undefined;
            const provider = options.registry.get(harnessId);
            if (!provider?.releaseExecution)
                return undefined;
            const context = {
                ...await options.context(projection.projectId, binding.location.directory, projection.id),
                model: projection.model,
            };
            return provider.releaseExecution(context, binding, operationId);
        },
        async resolve(projection: SessionProjection, cwd: string, selection: HarnessSelection) {
            const context = { ...await options.context(projection.projectId, cwd, projection.id), model: projection.model };
            return (await options.registry.resolve(context, selection, projection.resolvedHarnessId)).descriptor.id;
        },
        async releaseSession(sessionId: string) {
            const entries = [...cached].filter(([, entry]) => entry.sessionId === sessionId);
            const results = await Promise.allSettled(entries.map(([key, entry]) => {
                entry.releasing ??= (async () => {
                    const runtime = entry.runtime ?? await entry.pending;
                    // Cached canonical sessions are leases even for providers
                    // without an additional physical occupancy controller.
                    let others: HarnessCacheEntry[];
                    do {
                        others = [...cached.values()].filter(other => other.sessionId !== sessionId && !other.releasing);
                        await Promise.all(others.map(other => other.pending.catch(() => undefined)));
                        // A lookup may have arrived while construction settled.
                        // Include it before deciding this is the last lease.
                    } while ([...cached.values()].some(other => other.sessionId !== sessionId
                        && !other.releasing && !others.includes(other)));
                    if (!others.some(other => other.runtime === runtime)) {
                        if (options.releaseRuntime) await options.releaseRuntime(runtime, () => disposeOnce(runtime));
                        else await disposeOnce(runtime);
                    }
                    if (cached.get(key) === entry) cached.delete(key);
                })();
                // Failed disposal deliberately keeps the source cache fenced.
                return entry.releasing;
            }));
            const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
            if (errors.length) throw new AggregateError(errors, "session runtime release failed");
        },
        forgetSession(sessionId: string) {
            for (const [key, entry] of cached) {
                if (entry.sessionId === sessionId && !entry.releasing) cached.delete(key);
            }
        },
        async retireSession(sessionId: string) {
            const retiring = [...(failedRetirements.get(sessionId) ?? [])];
            failedRetirements.delete(sessionId);
            for (const [key, entry] of cached) {
                if (entry.sessionId !== sessionId) continue;
                cached.delete(key);
                retiring.push(entry);
            }
            if (retiring.length === 0) return;
            const settled = await Promise.allSettled(retiring.map((entry) => entry.pending));
            // Never await unrelated factories: a hung provider for one session
            // must not prevent another session from releasing its own lease.
            const remaining = new Set([...cached.values()].flatMap((entry) =>
                entry.runtime ? [entry.runtime] : []));
            const disposed = new Set<AgentRuntime>();
            const errors: unknown[] = [];
            const retry: HarnessCacheEntry[] = [];
            for (let index = 0; index < settled.length; index += 1) {
                const result = settled[index]!;
                // A rejected factory produced no runtime to leak.
                if (result.status === "rejected") continue;
                const runtime = result.value;
                if (retiring[index]!.lifetime === "workspace" || remaining.has(runtime) || disposed.has(runtime)) continue;
                disposed.add(runtime);
                try { await runtime.dispose(); } catch (error) {
                    retry.push(retiring[index]!);
                    errors.push(error);
                }
            }
            if (retry.length > 0) failedRetirements.set(sessionId, retry);
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, "harness session retirement failed");
        },
        forgetRuntime(runtime: AgentRuntime) {
            for (const [key, entry] of cached) {
                if (entry.runtime === runtime) cached.delete(key);
            }
        },
        async dispose() {
            const seen = new Set<AgentRuntime>();
            const entries = [
                ...cached.values(),
                ...[...failedRetirements.values()].flat(),
            ];
            const jobs = entries.map(async (entry) => {
                const runtime = entry.runtime ?? await entry.pending;
                if (seen.has(runtime)) return;
                seen.add(runtime);
                await disposeOnce(runtime);
            });
            cached.clear();
            failedRetirements.clear();
            const results = await Promise.allSettled(jobs);
            const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, "harness runtime disposal failed");
        },
    };
}
