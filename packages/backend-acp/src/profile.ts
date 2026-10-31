import { createHash } from "node:crypto";
import type { HarnessContext, HarnessProbe, HarnessProvider, HarnessRegistry, HarnessVersionStore, ModelDescriptor, SessionSourceProvider } from "@polyth/contracts";
import { acknowledgeCapabilityApplication, releaseHarnessProcessExecution, type RpcPeer } from "@polyth/harness-runtime";
import { probeRemoteHarness, remoteHarnessLaunch, resolveRemoteHarnessHost } from "@polyth/harness-runtime/remote-host";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { ACP_STATIC_FEATURES, connectAcp, createAcpRuntime, type AcpClientMethodTranslator, type AcpProfile } from "./index.ts";
import { discoverAcpModels, invalidateAcpDiscovery } from "./discovery.ts";
import { acpOverlays, createAcpProvisioner } from "./provisioner.ts";
import { configureAcpCapabilityDelivery } from "./capabilityDelivery.ts";

type AcpClientRequestResult =
    | { handled: false }
    | { handled: true; result: unknown };
export type RegisteredAcpProfile = AcpProfile & {
    clientRequest?(
        method: string,
        params: unknown,
    ): AcpClientRequestResult | Promise<AcpClientRequestResult>;
    /** Session-lived client extension translator factory. */
    createClientTranslator?: () => AcpClientMethodTranslator;
    /** Optional native-transcript source for the Snapshot import picker. */
    source?: SessionSourceProvider;
    /** Whether thought chunks prove prompt admission before the first visible chunk. */
    admitOnThought?: boolean;
    /** Side-by-side CLI installs to prune after an update. */
    versionStore?: HarnessVersionStore;
};

const isUnsupportedClientRequest = (error: unknown) =>
    error instanceof Error && error.message === "unsupported request";

export function configureAcpClientRequestHandling(
    rpc: RpcPeer,
    handler: RegisteredAcpProfile["clientRequest"],
) {
    if (!handler) return;
    const onRequest = rpc.onRequest.bind(rpc);
    rpc.onRequest = (fallback) => onRequest(async (method, params) => {
        try {
            return await fallback(method, params);
        } catch (error) {
            if (!isUnsupportedClientRequest(error)) throw error;
            const handled = await handler(method, params);
            if (handled.handled) return handled.result;
            throw error;
        }
    });
}

/** One ACP harness provider. Each account of a multi-account profile gets
 *  its own profile object and therefore its own caches and runtime state. */
export function createAcpProvider(host: ServerPackageHost, profile: RegisteredAcpProfile): HarnessProvider {
    const catalogs = new Map<string, { models?: ModelDescriptor[] }>();
    // A remote project runs the agent's CLI on its SSH host over the same
    // stdio protocol. Extra accounts are local login directories, so only the
    // family harness, on the host's own sign-in, can run there.
    const remoteBinary = profile.descriptor.remoteHost?.binary;
    const remoteCapable = Boolean(remoteBinary)
        && (!profile.descriptor.accounts || profile.descriptor.accounts.family === profile.descriptor.id);
    const descriptor = remoteCapable
        ? { ...profile.descriptor, remoteHost: { ...profile.descriptor.remoteHost!, sessions: true } }
        : profile.descriptor;
    const remoteLaunch = async (context: HarnessContext) => {
        if (!context.remote) return undefined;
        if (!remoteCapable) {
            throw Object.assign(new Error(`${profile.descriptor.name} runs on this machine only`), { code: "unsupported" });
        }
        const remote = await resolveRemoteHarnessHost(host, context);
        if (!remote) return undefined;
        return remoteHarnessLaunch(remote, [remoteBinary!, ...(profile.remoteArgs ?? profile.args)], { cwd: context.cwd });
    };
    const probeRemote = async (context: HarnessContext): Promise<HarnessProbe> => {
        if (!remoteCapable) {
            return { harnessId: profile.descriptor.id, installed: false, authenticated: "unknown", healthy: false, message: "Runs on this machine only" };
        }
        const remote = await resolveRemoteHarnessHost(host, context);
        return remote
            ? probeRemoteHarness(remote, profile.descriptor.id, remoteBinary)
            : profile.probe(context);
    };
    const contextKey = (context: HarnessContext) => JSON.stringify([context.spaceId, context.projectId, context.cwd, context.remote ?? false]);
    const probes = new Map<string, { promise: Promise<HarnessProbe>; settledAt?: number }>();
    const trimContextCaches = () => {
        while (catalogs.size > 64) {
            const oldest = catalogs.keys().next().value as string | undefined;
            if (!oldest) break;
            catalogs.delete(oldest);
            probes.delete(oldest);
        }
        while (probes.size > 64) {
            const oldest = probes.keys().next().value as string | undefined;
            if (!oldest) break;
            probes.delete(oldest);
        }
    };
    const probeProfile = (context: HarnessContext): Promise<HarnessProbe> => {
        const key = contextKey(context);
        const existing = probes.get(key);
        if (existing && (existing.settledAt === undefined || Date.now() - existing.settledAt < 2_000)) {
            return existing.promise;
        }
        let promise: Promise<HarnessProbe>;
        promise = (context.remote ? probeRemote(context) : profile.probe(context)).then((value) => {
            const current = probes.get(key);
            if (current?.promise === promise) current.settledAt = Date.now();
            return value;
        }, (error) => {
            if (probes.get(key)?.promise === promise) probes.delete(key);
            throw error;
        });
        probes.set(key, { promise });
        trimContextCaches();
        return promise;
    };
    /** Read catalog metadata without creating a canonical Polyth session. */
    const discoveryProbe = (context: HarnessContext) => ({
        async open(signal?: AbortSignal) {
            const connection = await connectAcp(profile, context, undefined, signal, await remoteLaunch(context));
            const abort = () => { void connection.rpc.close().catch(() => {}); };
            signal?.addEventListener("abort", abort, { once: true });
            const close = async () => {
                signal?.removeEventListener("abort", abort);
                await connection.rpc.close();
            };
            try {
                // Profiles may expose a connection-level catalog. Older ACP
                // runtimes still fall back to metadata from a throwaway session.
                const models = await profile.discoverModels?.(connection, context);
                if (models) return { result: {}, models, close };
                const result = await connection.rpc.request("session/new", { cwd: context.cwd, mcpServers: [] });
                return {
                    result,
                    setConfigOption: profile.probeModelControls === false ? undefined : (configId: string, value: string) => connection.rpc.request("session/set_config_option", {
                        sessionId: (result as { sessionId: string }).sessionId,
                        configId,
                        value,
                    }),
                    close,
                };
            } catch (error) {
                await close();
                throw error;
            }
        },
    });
    const stateFile = (context: HarnessContext) => {
        const key = createHash("sha256").update(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? "catalog"])).digest("hex");
        return host.spaceStorage(context.space!).path(`runtime/${profile.descriptor.id}/${key}.json`);
    };
    return {
        descriptor,
        staticFeatures: profile.reportsUsage ? { ...ACP_STATIC_FEATURES, usage: true } : ACP_STATIC_FEATURES,
        probe: probeProfile,
        ...(profile.source ? { source: profile.source } : {}),
        ...(profile.versionStore ? { versionStore: profile.versionStore } : {}),
        invalidateDiscovery(context) {
            invalidateAcpDiscovery({ harnessId: profile.descriptor.id, cacheIdentity: contextKey(context) });
            catalogs.delete(contextKey(context));
            probes.delete(contextKey(context));
        },
        // Stage HTTP entries, then require the actual initialize
        // advertisement before sending any native session request.
        provisioner: createAcpProvisioner(profile.descriptor.id, true, profile.absoluteMcpCommands ? { absoluteMcpCommands: true } : {}),
        async discover(context) {
            const key = contextKey(context);
            const catalogEntry = catalogs.get(key) ?? {};
            catalogs.set(key, catalogEntry);
            trimContextCaches();
            const availability = await probeProfile(context);
            if (!availability.installed) {
                return { state: "not-installed" as const, message: availability.message ?? "The agent is not installed" };
            }
            const gate = profile.supportsModelDiscovery?.(availability) ?? { ok: true as const };
            if (!gate.ok) {
                return { state: "partially-configured" as const, message: gate.reason };
            }
            const discovery = await discoverAcpModels({
                harnessId: profile.descriptor.id,
                version: availability.version ?? "unknown",
                authFingerprint: String(availability.authenticated ?? "unknown"),
                cacheIdentity: contextKey(context),
                probe: discoveryProbe(context),
                ...(profile.modelIdCodec ? { modelIdCodec: profile.modelIdCodec } : {}),
            });
            if (discovery.state !== "ready") {
                return {
                    state: discovery.state,
                    ...(discovery.state === "auth-required" ? { authenticated: false as const } : {}),
                    message: discovery.state === "auth-required"
                        ? `${profile.descriptor.name} needs a native sign-in before it can list models`
                        : discovery.reason,
                };
            }
            if (catalogs.get(key) === catalogEntry) catalogEntry.models = discovery.models;
            return {
                state: "ready" as const,
                catalog: { models: discovery.models, agents: [] },
            };
        },
        async createRuntime(context) {
            if (!context.space)
                throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
            // Persisted native routes deliberately bypass automatic
            // re-selection. Re-probe here anyway: package probes own
            // executable resolution/PATH widening for desktop launches.
            const availability = await probeProfile(context);
            if (!availability.installed || !availability.healthy) {
                throw Object.assign(new Error(availability.message ?? `${profile.descriptor.name} is unavailable`), { code: "runtime-unavailable" });
            }
            const launch = await remoteLaunch(context);
            const connection = await connectAcp(profile, context, stateFile(context), undefined, launch);
            try {
                configureAcpClientRequestHandling(connection.rpc, profile.clientRequest);
                configureAcpCapabilityDelivery(connection.rpc, context, profile.descriptor.id, connection.agentCapabilities, {
                    peek: (ctx, id) => acpOverlays.peek(ctx, id),
                    acknowledge: acknowledgeCapabilityApplication,
                });
                const clientTranslator = profile.createClientTranslator?.();
                const runtime = createAcpRuntime(
                    context,
                    connection.rpc,
                    profile.descriptor.id,
                    connection.agentCapabilities,
                    profile.descriptor.name,
                    {
                        models: catalogs.get(contextKey(context))?.models,
                        ...(clientTranslator ? { clientTranslator } : {}),
                        ...(profile.admitOnThought ? { admitOnThought: true } : {}),
                        ...(profile.modelIdCodec ? { modelIdCodec: profile.modelIdCodec } : {}),
                        ...(profile.classifyPromptFailure ? { classifyPromptFailure: profile.classifyPromptFailure } : {}),
                        ...(profile.toolNameFromTitle ? { toolNameFromTitle: true } : {}),
                        // The agent's durable record lives on this machine;
                        // a remote leg has none to read.
                        ...(profile.settleTurn && !launch ? { settleTurn: profile.settleTurn, reportsUsage: profile.reportsUsage === true } : {}),
                        ...(profile.probeAdmission && !launch ? { probeAdmission: profile.probeAdmission } : {}),
                        ...(profile.mcpServerFailure ? { mcpServerFailure: profile.mcpServerFailure } : {}),
                    },
                );
                // Stateless utility inference (commit messages, auditors)
                // uses the agent's own print mode when it has one.
                // Print mode is a local CLI run; a remote leg has none.
                const utility = launch ? undefined : profile.utilityCompletion?.({
                    command: profile.command,
                    cwd: context.cwd,
                    ...(profile.env ? { env: profile.env } : {}),
                });
                if (utility) {
                    runtime.completeSmallModel = (request) => utility.complete(request);
                }
                return runtime;
            } catch (error) {
                await connection.rpc.close().catch(() => {});
                throw error;
            }
        },
        async releaseExecution(context, binding, operationId) {
            if (!context.space)
                return { kind: "rejected", code: "unsupported", message: "Local Space context required" };
            // Release proof covers this machine's process boundary only; the
            // remote end of an SSH leg is not proven gone by it.
            if (context.remote)
                return { kind: "rejected", code: "unsupported", message: `Crash-safe cross-harness switching is not available on remote hosts; ${profile.descriptor.name} can still be used normally` };
            return releaseHarnessProcessExecution(stateFile(context), binding, operationId);
        },
    };
}

export function registerAcpProfile(host: ServerPackageHost, profile: RegisteredAcpProfile) {
    let registration: ReturnType<HarnessRegistry["register"]> | undefined;
    return {
        remoteAccess: localOnlyRemoteAccess([`backend-${profile.descriptor.id}`]),
        onEnable() {
            if (registration) return;
            // A fresh provider per enable drops every catalog and probe cache.
            registration = host.services.require(serverServiceKey<HarnessRegistry>("harnesses")).register(createAcpProvider(host, profile));
        },
        async onDisable() {
            await registration?.dispose();
            registration = undefined;
        },
    };
}
