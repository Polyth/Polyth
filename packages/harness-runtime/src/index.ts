export {
  AGENT_BETA_ENV,
  AGENT_BETA_READ_ONLY_MESSAGE,
  agentBetaBlocksPermission,
  agentBetaEnabled,
  isFilesystemMutationPermission,
} from "./agentBeta.ts";
export {
    createProcessAuthority,
    isWorkspaceUnavailableError,
    workspaceUnavailableError,
    releaseProcessExecution,
    hasDurableProcessRelease,
    type ProcessAuthorityOptions,
    type ProcessAuthorityProof,
    type ProcessContainment,
    type ProcessContainmentController,
} from "./authority.ts";
export { releaseHarnessProcessExecution } from "./processAuthority.ts";
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
export type {
  CapabilityLaunchCapture,
  LaunchOverlayRecord,
  LaunchOverlayStore,
} from "./capabilities.ts";
export {
  composeTurnPrompt,
  deltaCost,
  deltaTokenUsage,
  isPlaceholderTitle,
  titleFromPrompt,
} from "./features.ts";
export { contextWindowTelemetry, normalizeTokenUsage } from "./telemetry.ts";
export {
  createSmallModelCliRunner,
  type SmallModelCliInvocation,
  type SmallModelCliOptions,
  type SmallModelCliRunner,
} from "./smallModelCli.ts";
// The canonical model/attachment control rules live on the contract surface so
// the browser can apply the same ones without importing this node-side
// package. Adapters keep one import site by re-exporting them here.
export {
  attachmentModality,
  effectiveAttachmentDelivery,
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
  projectAttachmentPdf,
  materializeAttachmentText,
  PDF_PROJECTION_MAX_BYTES,
  TEXT_PROJECTION_MAX_BYTES,
  unsupportedAttachmentMessage,
  type AttachmentDeliveryInput,
  type AttachmentDeliveryPlan,
  type PdfProjectionInput,
  type TextProjection,
  type TextProjectionInput,
} from "./delivery.ts";
import type {
    AgentDescriptor,
    AgentRuntime,
    HarnessCapabilitySupport,
    HarnessAvailabilityState,
    HarnessContext,
    HarnessDescriptor,
    HarnessProbe,
    HarnessProvider,
    HarnessRegistry,
    HarnessRosterItem,
    HarnessSelection,
    HarnessSnapshot,
    RuntimeCapabilities,
    RuntimeSessionBinding,
    SessionProjection,
} from "@polyth/contracts";
export const harnessError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const polythOwnedDelegationCapabilities = (capabilities: RuntimeCapabilities): RuntimeCapabilities =>
    ({ ...capabilities, subagents: false });

const polythOwnedDelegationAgents = (agents: readonly AgentDescriptor[] | undefined): AgentDescriptor[] | undefined =>
    agents?.filter((agent) => agent.mode !== "subagent");

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
    title?: string;
    color?: string;
    /** New conversations on this harness are private sessions. */
    privateSessions?: boolean;
}>;
/** Whether new conversations on `descriptor` start private under these
 * preferences: only a harness that declares support can honour it. */
export const privateSessionsOn = (descriptor: Pick<HarnessDescriptor, "privateSessions">, preference: HarnessPreferences[string] | undefined): boolean =>
    descriptor.privateSessions === true && preference?.privateSessions === true;
/** Why a private session cannot run on this harness. */
export const privateSessionUnsupported = (name: string): Error =>
    harnessError("unsupported", `${name} can't run a private session: it keeps every conversation in its own history. Choose a harness with private sessions.`);
/** The snapshot's view of the preference; absent for a harness without support. */
const privateSessionsPolicy = (descriptor: Pick<HarnessDescriptor, "privateSessions">, preference: HarnessPreferences[string] | undefined): { privateSessions?: boolean } =>
    descriptor.privateSessions === true ? { privateSessions: preference?.privateSessions === true } : {};
/** A Space's title and color for one harness, laid over its descriptor. */
export function harnessAppearance(descriptor: Pick<HarnessDescriptor, "name">, preference: HarnessPreferences[string] | undefined): { name: string; defaultName?: string; color?: string } {
    const title = typeof preference?.title === "string" ? preference.title.trim() : "";
    const color = typeof preference?.color === "string" && /^#[0-9a-f]{6}$/i.test(preference.color) ? preference.color.toLowerCase() : undefined;
    return {
        name: title || descriptor.name,
        ...(title && title !== descriptor.name ? { defaultName: descriptor.name } : {}),
        ...(color ? { color } : {}),
    };
}
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
        && state !== "starting" && state !== "auth-required" && state !== "setup-required" && state !== "partially-configured"
        && state !== "incompatible" && state !== "offline" && state !== "not-installed";
};
/** Readiness a native check can establish for an installed, answering
 * harness. Only these outcomes may stand in for a cheap probe's "unknown". */
const VERIFIABLE_STATES: ReadonlySet<HarnessAvailabilityState> = new Set(["ready", "auth-required", "setup-required", "partially-configured"]);
/** The last native readiness check of one installed harness version. */
type ReadinessEvidence = {
    state: HarnessAvailabilityState;
    authenticated?: boolean | "unknown";
    message?: string;
    at: number;
    version?: string;
};
/** Account presentation fields; a descriptor may compute them on read. */
const accountIdentity = (descriptor: HarnessDescriptor): Pick<HarnessDescriptor, "accountLabel" | "accounts"> => ({
    ...(descriptor.accountLabel ? { accountLabel: descriptor.accountLabel } : {}),
    ...(descriptor.accounts ? { accounts: { family: descriptor.accounts.family, endpoint: descriptor.accounts.endpoint } } : {}),
});
export function createHarnessRegistry() {
    let policy: (context: HarnessContext) => Promise<HarnessPreferences> = async () => ({});
    const providers = new Map<string, HarnessProvider>();
    const unregistering = new Set<HarnessProvider>();
    const unregistrationListeners = new Set<(provider: HarnessProvider) => void | Promise<void>>();
    const unregistrationFlights = new WeakMap<HarnessProvider, Promise<void>>();
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
        /** What the last native check (detail discovery or the execution
         * boundary's refinement) established. A cheap probe that cannot see
         * sign-in reports "unknown"; within the detail trust window and for
         * the same installed version this answers for it in listings. */
        verified?: ReadinessEvidence;
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
    const list = () => [...providers.values()]
        .filter((provider) => !unregistering.has(provider))
        .sort((a, b) => a.descriptor.priority - b.descriptor.priority || a.descriptor.id.localeCompare(b.descriptor.id));
    const probeOne = async (provider: HarnessProvider, context: HarnessContext) => {
        try {
            return await provider.probe(context);
        }
        catch {
            return { harnessId: provider.descriptor.id, installed: false, authenticated: "unknown" as const, healthy: false, message: "Harness probe failed" };
        }
    };
    const capabilitySupportOne = async (provider: HarnessProvider, context: HarnessContext): Promise<HarnessCapabilitySupport | undefined> => {
        try {
            // Provisioner support is the canonical, process-free projection
            // used by snapshots; it must not start a runtime or discover native
            // state (see the public contract).
            return provider.provisioner ? await provider.provisioner.support(context) : undefined;
        }
        catch {
            // Capability support is advisory metadata. A broken optional
            // projection must not hide the harness availability snapshot.
            return undefined;
        }
    };
    return {
        configurePolicy(read: typeof policy) { policy = read; },
        register(provider: HarnessProvider) {
            const id = provider.descriptor.id;
            if (!/^[a-z][a-z0-9-]*$/.test(id) || providers.has(id))
                throw harnessError("conflict", "invalid or duplicate harness id");
            providers.set(id, provider);
            return { dispose() {
                if (providers.get(id) !== provider) return;
                const existing = unregistrationFlights.get(provider);
                if (existing) return existing;
                unregistering.add(provider);
                const flight = Promise.resolve().then(async () => {
                    try {
                        // Fence the provider before asking lifecycle owners. If an
                        // owner rejects because live runtime leases still exist,
                        // the provider becomes visible again with its snapshots.
                        for (const listener of [...unregistrationListeners])
                            await listener(provider);
                        if (providers.get(id) !== provider) return;
                        providers.delete(id);
                        for (const key of snapshots.keys())
                            if (JSON.parse(key).at(-1) === id)
                                snapshots.delete(key);
                    } finally {
                        unregistering.delete(provider);
                        unregistrationFlights.delete(provider);
                    }
                });
                unregistrationFlights.set(provider, flight);
                return flight;
            } };
        },
        onUnregister(listener: (provider: HarnessProvider) => void | Promise<void>) {
            unregistrationListeners.add(listener);
            return { dispose() { unregistrationListeners.delete(listener); } };
        },
        providers: list,
        get(id: string) {
            const provider = providers.get(id);
            return provider && !unregistering.has(provider) ? provider : undefined;
        },
        probe: (context: HarnessContext) => Promise.all(list().map((provider) => probeOne(provider, context))),
        async roster(context: HarnessContext): Promise<HarnessRosterItem[]> {
            const preferences = await policy(context);
            return list().map((provider) => ({
                identity: {
                    id: provider.descriptor.id,
                    integration: provider.descriptor.integration,
                    ...accountIdentity(provider.descriptor),
                    ...harnessAppearance(provider.descriptor, preferences[provider.descriptor.id]),
                },
                policy: {
                    enabled: preferences[provider.descriptor.id]?.enabled ?? true,
                    priority: preferences[provider.descriptor.id]?.priority ?? provider.descriptor.priority,
                    autoSelect: provider.descriptor.autoSelect !== false,
                },
            }));
        },
        async snapshots(context: HarnessContext, options: { harnessId?: string; force?: boolean; detail?: boolean; verify?: boolean } = {}) {
            const preferences = await policy(context);
            const selected = options.harnessId
                ? list().filter((provider) => provider.descriptor.id === options.harnessId)
                : list();
            const rows = await Promise.all(selected.map(async (provider): Promise<HarnessSnapshot> => {
                const key = snapshotKey(context, provider.descriptor.id);
                const entry = snapshots.get(key) ?? { generation: 0 };
                snapshots.set(key, entry);
                const generation = options.force ? ++entry.generation : entry.generation;
                // A forced probe can reflect an auth/config/runtime change.
                // Keep the old catalog only as presentation fallback while
                // making the next detail caller revalidate it.
                if (options.force) {
                    entry.detailedAt = undefined;
                    entry.verified = undefined;
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
                // A verifying caller (Settings checking readiness) waits for
                // the native answer instead of a last-known catalog.
                const catalogPresentation = !options.force && !options.verify && needsDetail
                    ? (entry.current?.catalog?.models?.length
                        ? entry.current
                        : entry.lastGood?.catalog?.models?.length
                            ? entry.lastGood
                            : undefined)
                    : undefined;

                const refresh = async (
                    detail: boolean,
                    generation: number,
                    knownProbe?: HarnessProbe,
                ): Promise<HarnessSnapshot> => {
                    const currentAtStart = entry.current;
                    const lastGoodAtStart = entry.lastGood;
                    const checkedAt = Date.now();
                    const probe = knownProbe ?? await probeOne(provider, context);
                    const capabilitySupport = await capabilitySupportOne(provider, context);
                    let inspectedConfiguration;
                    try {
                        inspectedConfiguration = await provider.inspectConfiguration?.(context);
                    }
                    catch {
                        inspectedConfiguration = undefined;
                    }
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
                    const probedState = harnessAvailability(probe);
                    // A cheap probe that cannot see sign-in answers "unknown".
                    // The last native check of this exact install answers for
                    // it within the detail trust window, so a listing does not
                    // fall back to "unknown" seconds after a check proved the
                    // harness ready (or signed out). A different version, a
                    // forced recheck or an unhealthy probe drops the evidence.
                    const evidence = entry.verified;
                    const carried = !detail && probedState === "unknown"
                        && probe.installed && probe.healthy && probe.authenticated !== false
                        && evidence !== undefined && checkedAt - evidence.at < DETAIL_TTL_MS
                        && evidence.version === probe.version
                        ? evidence
                        : undefined;
                    const state = discoveryError && /auth|login|sign[ -]?in|credential/i.test(discoveryMessage)
                        ? "auth-required" as const
                        : discoveryError && probe.healthy
                            ? "degraded" as const
                            : discovery?.state ?? carried?.state ?? probedState;
                    // The cheap probe's own message describes its "unknown"
                    // answer; carried evidence brings the checked message.
                    const { message: probeMessage, ...probeFields } = probe;
                    const message = discoveryError
                        ? discoveryMessage
                        : discovery?.message ?? (carried ? carried.message : probeMessage);
                    const availability = {
                        ...probeFields,
                        ...(discovery?.authenticated !== undefined
                            ? { authenticated: discovery.authenticated }
                            : carried?.authenticated !== undefined ? { authenticated: carried.authenticated } : {}),
                        ...(state === "auth-required" ? { authenticated: false as const } : {}),
                        ...(message ? { message } : {}),
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
                            ...accountIdentity(provider.descriptor),
                            ...(provider.plugins ? { nativePlugins: true as const } : {}),
                            ...(provider.skills ? { nativeSkills: true as const } : {}),
                        },
                        availability,
                        policy: {
                            enabled: preferences[provider.descriptor.id]?.enabled ?? true,
                            priority: preferences[provider.descriptor.id]?.priority ?? provider.descriptor.priority,
                            autoSelect: provider.descriptor.autoSelect !== false,
                            ...privateSessionsPolicy(provider.descriptor, preferences[provider.descriptor.id]),
                        },
                        ...(() => {
                            // A remote project's row describes its SSH host when
                            // its chats run there; set it up there, not here.
                            const descriptor = provider.descriptor;
                            const remote = context.remote === true && descriptor.remoteHost?.sessions === true;
                            const installCommand = remote ? descriptor.remoteHost?.installCommand : descriptor.installCommand;
                            const signInCommand = remote ? descriptor.remoteHost?.signInCommand : descriptor.signInCommand;
                            return installCommand || signInCommand || descriptor.setupUrl || descriptor.updateCommand?.length
                                ? { setup: {
                                    ...(installCommand ? { installCommand } : {}),
                                    ...(signInCommand ? { signInCommand } : {}),
                                    ...(descriptor.updateCommand?.length ? { updateCommand: descriptor.updateCommand.join(" ") } : {}),
                                    ...(descriptor.setupUrl ? { setupUrl: descriptor.setupUrl } : {}),
                                } }
                                : {};
                        })(),
                        ...(discovery?.capabilities ?? retained?.capabilities ?? provider.staticFeatures
                            ? { capabilities: polythOwnedDelegationCapabilities(
                                (discovery?.capabilities ?? retained?.capabilities ?? provider.staticFeatures)!,
                              ) }
                            : {}),
                        ...(capabilitySupport ?? retained?.capabilitySupport
                            ? { capabilitySupport: capabilitySupport ?? retained?.capabilitySupport }
                            : {}),
                        ...(discoveredCatalog ?? retained?.catalog
                            ? { catalog: {
                                ...(discoveredCatalog ?? retained?.catalog)!,
                                ...((discoveredCatalog ?? retained?.catalog)!.agents
                                  ? { agents: polythOwnedDelegationAgents((discoveredCatalog ?? retained?.catalog)!.agents)! }
                                  : {}),
                              } }
                            : {}),
                        ...(() => {
                            const discoveredConfiguration = discovery?.controls
                                || discovery?.restartRequired !== undefined
                                || discovery?.pendingChanges !== undefined
                                ? {
                                    controls: discovery.controls ?? [],
                                    ...(discovery.restartRequired !== undefined ? { restartRequired: discovery.restartRequired } : {}),
                                    ...(discovery.pendingChanges !== undefined ? { pendingChanges: discovery.pendingChanges } : {}),
                                }
                                : undefined;
                            const inspected = inspectedConfiguration
                                && (inspectedConfiguration.restartRequired !== undefined || inspectedConfiguration.pendingChanges !== undefined)
                                ? { controls: retained?.configuration?.controls ?? [], ...inspectedConfiguration }
                                : undefined;
                            const configuration = discoveredConfiguration
                                ? { ...inspected, ...discoveredConfiguration }
                                : inspected ?? retained?.configuration;
                            return configuration ? { configuration } : {};
                        })(),
                        context: {
                            spaceId: context.spaceId,
                            projectId: context.projectId,
                            cwd: context.cwd,
                            ...(context.remote !== undefined ? { remote: context.remote } : {}),
                            revision: `${checkedAt}-${++revision}`,
                            fetchedAt: checkedAt,
                        },
                        ...(degraded && lastGood ? { stale: true } : {}),
                        ...(message ? { message } : {}),
                        ...(discovery?.native !== undefined
                            ? { native: discovery.native }
                            : retained?.native !== undefined ? { native: retained.native } : {}),
                    };
                    if (entry.generation === generation && snapshots.get(key) === entry) {
                        entry.current = snapshot;
                        if (detail && provider.discover && discoveryError === undefined)
                            entry.detailedAt = checkedAt;
                        // Carried evidence is presentation: the execution
                        // boundary still refines an "unknown" probe natively.
                        entry.readinessRevision = !carried && state !== "unknown"
                            && availability.authenticated !== "unknown"
                            ? snapshot.context.revision
                            : undefined;
                        // The latest native answer always wins: a failed or
                        // inconclusive check revokes earlier evidence.
                        if (detail && provider.discover) {
                            entry.verified = discoveryError === undefined && VERIFIABLE_STATES.has(state)
                                ? {
                                    state,
                                    ...(availability.authenticated !== undefined ? { authenticated: availability.authenticated } : {}),
                                    // Only what the native check said; the probe's
                                    // note describes its own "unknown" answer.
                                    ...(discovery?.message ? { message: discovery.message } : {}),
                                    at: checkedAt,
                                    ...(probe.version !== undefined ? { version: probe.version } : {}),
                                }
                                : undefined;
                        }
                        if (!degraded && (state === "ready" || state === "unknown" || state === "partially-configured"))
                            entry.lastGood = snapshot;
                    }
                    return snapshot;
                };
                const scheduleRefresh = (): NonNullable<typeof entry.pending> => {
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
                    return pending;
                };
                if (catalogPresentation) {
                    const upgradingSummary = entry.pending && needsDetail && !entry.pending.detail;
                    if (!upgradingSummary) {
                        if (!entry.pending?.detail)
                            scheduleRefresh();
                        return { ...catalogPresentation, stale: true };
                    }
                }
                if (!options.force && entry.pending && (!needsDetail || entry.pending.detail))
                    return entry.pending.promise;
                if (!options.force && summaryFresh && (!options.detail || detailFresh))
                    return entry.current!;

                return scheduleRefresh().promise;
            }));
            // Title, color and the private-sessions preference need no probe: a
            // cached snapshot takes the current ones.
            return rows.map((row) => {
                const descriptor = providers.get(row.identity.id)?.descriptor;
                if (!descriptor) return row;
                const { defaultName: _defaultName, color: _color, ...identity } = row.identity;
                const { privateSessions: _privateSessions, ...policy } = row.policy;
                return {
                    ...row,
                    identity: { ...identity, ...harnessAppearance(descriptor, preferences[descriptor.id]) },
                    policy: { ...policy, ...privateSessionsPolicy(descriptor, preferences[descriptor.id]) },
                };
            });
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
                entry.verified = undefined;
                entry.pending = undefined;
            }
        },
        async privateSessions(context: HarnessContext, harnessId: string) {
            const provider = providers.get(harnessId);
            if (!provider || unregistering.has(provider)) return false;
            return privateSessionsOn(provider.descriptor, (await policy(context))[harnessId]);
        },
        async resolve(context: HarnessContext, selection: HarnessSelection, stickyId?: string) {
            const id = selection.mode === "pinned" ? selection.harnessId : stickyId;
            const preferences = await policy(context);
            const ordered = list().filter((p) => preferences[p.descriptor.id]?.enabled !== false).sort((a, b) => (preferences[a.descriptor.id]?.priority ?? a.descriptor.priority) - (preferences[b.descriptor.id]?.priority ?? b.descriptor.priority) || a.descriptor.id.localeCompare(b.descriptor.id));
            // A private session never reaches a harness that would save it.
            if (context.privateSession && selection.mode === "pinned") {
                const pinned = ordered.find((p) => p.descriptor.id === id);
                if (pinned && pinned.descriptor.privateSessions !== true) throw privateSessionUnsupported(pinned.descriptor.name);
            }
            const candidates = (selection.mode === "pinned"
                ? ordered.filter((p) => p.descriptor.id === id)
                : [...ordered.filter((p) => p.descriptor.id === id), ...ordered.filter((p) => p.descriptor.id !== id)].filter((p) => p.descriptor.autoSelect !== false))
                .filter((p) => !context.privateSession || p.descriptor.privateSessions === true);
            // Why the last candidate was passed over; a pinned selection reports it
            // instead of an anonymous "unavailable".
            let why = "";
            for (const provider of candidates) {
                const cache = snapshots.get(snapshotKey(context, provider.descriptor.id));
                const current = cache?.current;
                if (current && Date.now() - current.context.fetchedAt < SNAPSHOT_TTL_MS) {
                    const cachedProbe = current.availability as HarnessProbe;
                    if (!runnable(cachedProbe)) {
                        why = cachedProbe.message ?? `cached ${harnessAvailability(cachedProbe)}`;
                        continue;
                    }
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
                if (providers.get(provider.descriptor.id) !== provider || unregistering.has(provider))
                    continue;
                if (!runnable(probe)) {
                    why = probe.message ?? harnessAvailability(probe);
                    continue;
                }
                // At the actual execution boundary, refine unknown readiness
                // so Auto cannot select a harness that discovery identifies as
                // unauthenticated or setup-incomplete.
                if (provider.discover && (probe.state === "unknown" || probe.authenticated === "unknown")) {
                    try {
                        const discovery = await provider.discover(context);
                        if (providers.get(provider.descriptor.id) !== provider || unregistering.has(provider))
                            continue;
                        probe = {
                            ...probe,
                            ...(discovery.authenticated !== undefined ? { authenticated: discovery.authenticated } : {}),
                            ...(discovery.state !== undefined ? { state: discovery.state } : {}),
                            ...(discovery.message ? { message: discovery.message } : {}),
                        };
                        const refinedState = harnessAvailability(probe);
                        if (cache) {
                            cache.verified = VERIFIABLE_STATES.has(refinedState)
                                ? {
                                    state: refinedState,
                                    ...(probe.authenticated !== undefined ? { authenticated: probe.authenticated } : {}),
                                    ...(discovery.message ? { message: discovery.message } : {}),
                                    at: Date.now(),
                                    ...(probe.version !== undefined ? { version: probe.version } : {}),
                                }
                                : undefined;
                        }
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
                    catch (error) {
                        if (cache) cache.verified = undefined;
                        why = error instanceof Error ? error.message : String(error);
                        continue;
                    }
                }
                if (runnable(probe))
                    return provider;
            }
            throw harnessError("runtime-unavailable", selection.mode === "pinned" ? `Selected harness ${selection.harnessId} is unavailable${why ? ` (${why.slice(0, 200)})` : ""}`
                : context.privateSession ? "No harness that can run a private session is ready. Open Harnesses in Settings to set one up."
                    : "No compatible harness is ready. Open Harnesses in Settings to set one up.");
        },
    };
}
/** The registry chooses factories; AgentRuntime remains the execution seam.
 * Persisted routes are exact lookups, never Auto fallback while old authority
 * may be alive. Only a new, not-yet-admitted session may try another factory. */
export interface RuntimeAcquisitionInfo {
    warmRuntimeHit?: boolean;
    runtimeSpawnMs?: number;
}

type HarnessCacheEntry = {
    sessionId: string;
    spaceId: string;
    cwd: string;
    harnessId: string;
    lifetime: "session" | "workspace";
    pending: Promise<AgentRuntime>;
    runtime?: AgentRuntime;
    acquisitionInfo?: RuntimeAcquisitionInfo;
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
    /** Physical owners can refine factory reuse with per-acquisition evidence. */
    acquisitionInfo?: (provider: HarnessProvider, context: HarnessContext, runtime: AgentRuntime) => RuntimeAcquisitionInfo | undefined;
    /** Physical owner may retain a shared runtime with other bindings/executions. */
    releaseRuntime?: (runtime: AgentRuntime, dispose: () => Promise<void>) => Promise<void>;
    /** Package shutdown may unregister providers before the shared pool drains. */
    allowProviderUnregistration?: () => boolean;
}) {
    const cached = new Map<string, HarnessCacheEntry>();
    const failedRetirements = new Map<string, HarnessCacheEntry[]>();
    const retiringEntries = new Set<HarnessCacheEntry>();
    const runtimeLocations = new WeakMap<AgentRuntime, string>();
    const delegationEnforced = new WeakSet<AgentRuntime>();
    const disposals = new WeakMap<AgentRuntime, Promise<void>>();
    const unregisterSubscription = options.registry.onUnregister?.((provider) => {
        if (options.allowProviderUnregistration?.()) return;
        const harnessId = provider.descriptor.id;
        const liveEntries = [...cached.values(), ...retiringEntries]
            .filter((entry) => entry.harnessId === harnessId).length;
        const failedEntries = [...failedRetirements.values()].flat()
            .filter((entry) => entry.harnessId === harnessId).length;
        if (liveEntries || failedEntries) {
            throw harnessError(
                "conflict",
                `Cannot disable ${harnessId} while ${liveEntries + failedEntries} runtime lease${liveEntries + failedEntries === 1 ? "" : "s"} still reference it`,
            );
        }
    });
    const enforceDelegation = (runtime: AgentRuntime): AgentRuntime => {
        if (delegationEnforced.has(runtime)) return runtime;
        delegationEnforced.add(runtime);
        const capabilities = typeof runtime.capabilities === "function"
            ? runtime.capabilities.bind(runtime)
            : undefined;
        if (capabilities) {
            runtime.capabilities = async () => polythOwnedDelegationCapabilities(await capabilities());
        }
        const agents = typeof runtime.agents === "function"
            ? runtime.agents.bind(runtime)
            : undefined;
        if (agents) {
            runtime.agents = async () => polythOwnedDelegationAgents(await agents()) ?? [];
        }
        return runtime;
    };
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
        // Resolution can await native probes. Its result must still name the
        // registered provider when the runtime lease is acquired.
        if (options.registry.get(provider.descriptor.id) !== provider)
            throw harnessError("runtime-unavailable", `Harness ${provider.descriptor.id} is no longer registered`);
        const sessionId = context.sessionId ?? "";
        if (failedRetirements.has(sessionId) || [...retiringEntries].some((entry) => entry.sessionId === sessionId))
            throw harnessError("runtime-unavailable", "The previous session runtime has not been released");
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
                spaceId: context.spaceId,
                cwd: context.cwd,
                harnessId: provider.descriptor.id,
                lifetime: provider.runtimeLifetime ?? "session",
                pending: Promise.resolve(undefined as unknown as AgentRuntime),
            };
            created.pending = (async () => {
                await options.beforeCreate?.(provider, context);
                if (options.registry.get(provider.descriptor.id) !== provider)
                    throw harnessError("runtime-unavailable", `Harness ${provider.descriptor.id} is no longer registered`);
                const runtime = enforceDelegation(await provider.createRuntime(context));
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
                if (context.privateSession) Object.defineProperty(runtime, "privateSession", { value: true, configurable: true });
                if (cached.get(key) === created) {
                    created.runtime = runtime;
                    // Telemetry is observational; a failed observer cannot
                    // strand a successfully constructed execution authority.
                    try { created.acquisitionInfo = options.acquisitionInfo?.(provider, context, runtime); } catch { /* diagnostic only */ }
                    created.acquisitionInfo ??= created.lifetime === "session" ? { warmRuntimeHit: false } : undefined;
                }
                return runtime;
            })();
            entry = created;
            cached.set(key, entry);
            created.pending.catch(() => { if (cached.get(key) === created) cached.delete(key); });
        }
        return available(entry);
    };
    return {
        /** Canonical leases protect native creation before event wiring binds
         * the session to the physical owner. Utility/catalog leases do not. */
        hasSessionLease(runtime: AgentRuntime): boolean {
            for (const entry of cached.values()) if (entry.sessionId && entry.runtime === runtime) return true;
            for (const entry of retiringEntries) if (entry.sessionId && entry.runtime === runtime) return true;
            for (const entries of failedRetirements.values()) {
                if (entries.some(entry => entry.sessionId && entry.runtime === runtime)) return true;
            }
            return false;
        },
        /** Canonical sessions holding a live (not releasing) lease on `harnessId` in one Space. */
        liveSessionIds(spaceId: string, harnessId: string): string[] {
            return [...new Set([...cached.values()]
                .filter((entry) => entry.sessionId && !entry.releasing && entry.spaceId === spaceId && entry.harnessId === harnessId)
                .map((entry) => entry.sessionId))];
        },
        /** Metadata for the first acquisition of this exact canonical lease. */
        acquisitionInfo(runtime: AgentRuntime, sessionId: string): RuntimeAcquisitionInfo | undefined {
            const location = runtimeLocations.get(runtime);
            if (!location) return undefined;
            const [spaceId, projectId, cwd, harnessId] = JSON.parse(location) as [string, string, string, string];
            const entry = cached.get(harnessCacheKey(spaceId, projectId, cwd, sessionId, harnessId));
            if (entry?.runtime !== runtime) return undefined;
            return entry?.acquisitionInfo ? { ...entry.acquisitionInfo } : undefined;
        },
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
            const context: HarnessContext = {
                ...await options.context(projection.projectId, cwd, projection.id),
                model: projection.model,
                ...(projection.privateSession ? { privateSession: true as const } : {}),
            };
            /** A private session stays private on every harness it runs on. A
             *  conversation that has no native leg yet becomes private when its
             *  harness's private sessions are on. */
            const sessionContext = async (provider: HarnessProvider): Promise<HarnessContext> => {
                if (context.privateSession) {
                    if (provider.descriptor.privateSessions !== true) throw privateSessionUnsupported(provider.descriptor.name);
                    return context;
                }
                if (projection.backendSessionId || provider.descriptor.privateSessions !== true) return context;
                return await options.registry.privateSessions?.(context, provider.descriptor.id)
                    ? { ...context, privateSession: true }
                    : context;
            };
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
                return get(await sessionContext(provider), provider);
            }
            const first = await options.registry.resolve(context, selection);
            try {
                return await get(await sessionContext(first), first);
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
                        return await get(await sessionContext(ready), ready);
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
            const context = {
                ...await options.context(projection.projectId, cwd, projection.id),
                model: projection.model,
                ...(projection.privateSession ? { privateSession: true as const } : {}),
            };
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
        /** Every live lease of this canonical session is session-lifetime. */
        isSessionScoped(sessionId: string): boolean {
            const entries = [...cached.values()].filter((entry) => entry.sessionId === sessionId && !entry.releasing);
            return entries.length > 0 && entries.every((entry) => entry.lifetime === "session");
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
            // Cache removal is not execution-release proof. Keep these leases
            // visible to package disable until disposal settles.
            for (const entry of retiring) retiringEntries.add(entry);
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
            for (const entry of retiring) retiringEntries.delete(entry);
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, "harness session retirement failed");
        },
        /** Release the project-scoped utility leases (titles, commit messages,
         * recaps, ...) acquired in one workspace directory. Canonical session
         * leases are owned by their session lifecycle and stay untouched; a
         * runtime still shared with any other lease is only uncached. Used when
         * the directory itself is about to be deleted. */
        async retireWorkspace(cwd: string) {
            const normalize = (path: string) => path.replace(/[\\/]+$/, "") || path;
            const target = normalize(cwd);
            const retiring: HarnessCacheEntry[] = [];
            for (const [key, entry] of cached) {
                if (entry.sessionId || normalize(entry.cwd) !== target) continue;
                cached.delete(key);
                retiring.push(entry);
            }
            if (retiring.length === 0) return;
            for (const entry of retiring) retiringEntries.add(entry);
            try {
                const settled = await Promise.allSettled(retiring.map((entry) => entry.pending));
                const remaining = new Set([...cached.values()].flatMap((entry) =>
                    entry.runtime ? [entry.runtime] : []));
                const disposed = new Set<AgentRuntime>();
                const errors: unknown[] = [];
                for (const result of settled) {
                    // A rejected factory produced no runtime to leak.
                    if (result.status === "rejected") continue;
                    const runtime = result.value;
                    if (remaining.has(runtime) || disposed.has(runtime)) continue;
                    disposed.add(runtime);
                    try {
                        if (options.releaseRuntime) await options.releaseRuntime(runtime, () => disposeOnce(runtime));
                        else await disposeOnce(runtime);
                    } catch (error) {
                        errors.push(error);
                    }
                }
                if (errors.length === 1) throw errors[0];
                if (errors.length > 1) throw new AggregateError(errors, "harness workspace retirement failed");
            } finally {
                for (const entry of retiring) retiringEntries.delete(entry);
            }
        },
        forgetRuntime(runtime: AgentRuntime) {
            for (const [key, entry] of cached) {
                if (entry.runtime === runtime) cached.delete(key);
            }
        },
        async dispose() {
            await unregisterSubscription?.dispose();
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
