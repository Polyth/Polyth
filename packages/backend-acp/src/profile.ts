import { createHash } from "node:crypto";
import type { HarnessContext, HarnessProbe, HarnessRegistry, ModelDescriptor } from "@polyth/contracts";
import { acknowledgeCapabilityApplication, releaseProcessExecution, type RpcPeer } from "@polyth/harness-runtime";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { ACP_STATIC_FEATURES, connectAcp, createAcpRuntime, type AcpProfile } from "./index.ts";
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
};

export function configureAcpClientRequestHandling(
    rpc: RpcPeer,
    handler: RegisteredAcpProfile["clientRequest"],
) {
    if (!handler) return;
    const onRequest = rpc.onRequest.bind(rpc);
    rpc.onRequest = (fallback) => onRequest(async (method, params) => {
        const handled = await handler(method, params);
        return handled.handled ? handled.result : fallback(method, params);
    });
}

export function registerAcpProfile(host: ServerPackageHost, profile: RegisteredAcpProfile) {
    const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
    let registration: ReturnType<HarnessRegistry["register"]> | undefined;
    const catalogs = new Map<string, { models?: ModelDescriptor[] }>();
    const contextKey = (context: HarnessContext) => JSON.stringify([context.spaceId, context.projectId, context.cwd]);
    const probes = new Map<string, { promise: Promise<HarnessProbe>; settledAt?: number }>();
    const probeProfile = (context: HarnessContext): Promise<HarnessProbe> => {
        const key = contextKey(context);
        const existing = probes.get(key);
        if (existing && (existing.settledAt === undefined || Date.now() - existing.settledAt < 2_000)) {
            return existing.promise;
        }
        let promise: Promise<HarnessProbe>;
        promise = profile.probe(context).then((value) => {
            const current = probes.get(key);
            if (current?.promise === promise) current.settledAt = Date.now();
            return value;
        }, (error) => {
            if (probes.get(key)?.promise === promise) probes.delete(key);
            throw error;
        });
        probes.set(key, { promise });
        return promise;
    };
    /** Read catalog metadata without creating a canonical Polyth session. */
    const discoveryProbe = (context: HarnessContext) => ({
        async open(signal?: AbortSignal) {
            const connection = await connectAcp(profile, context, undefined, signal);
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
        remoteAccess: localOnlyRemoteAccess([`backend-${profile.descriptor.id}`]),
        onEnable() {
            registration = registry.register({
                descriptor: profile.descriptor,
                staticFeatures: ACP_STATIC_FEATURES,
                probe: probeProfile,
                invalidateDiscovery(context) {
                    invalidateAcpDiscovery({ harnessId: profile.descriptor.id, cacheIdentity: contextKey(context) });
                    catalogs.delete(contextKey(context));
                    probes.delete(contextKey(context));
                },
                // Stage HTTP entries, then require the actual initialize
                // advertisement before sending any native session request.
                provisioner: createAcpProvisioner(profile.descriptor.id, true),
                async discover(context) {
                    if (context.remote) {
                        throw Object.assign(new Error("Local execution only"), { code: "unsupported" });
                    }
                    const key = contextKey(context);
                    const catalogEntry = catalogs.get(key) ?? {};
                    catalogs.set(key, catalogEntry);
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
                    if (!context.space || context.remote)
                        throw Object.assign(new Error("Local Space context required"), { code: "unsupported" });
                    // Persisted native routes deliberately bypass automatic
                    // re-selection. Re-probe here anyway: package probes own
                    // executable resolution/PATH widening for desktop launches.
                    const availability = await probeProfile(context);
                    if (!availability.installed || !availability.healthy) {
                        throw Object.assign(new Error(availability.message ?? `${profile.descriptor.name} is unavailable`), { code: "runtime-unavailable" });
                    }
                    const connection = await connectAcp(profile, context, stateFile(context));
                    try {
                        configureAcpClientRequestHandling(connection.rpc, profile.clientRequest);
                        configureAcpCapabilityDelivery(connection.rpc, context, profile.descriptor.id, connection.agentCapabilities, {
                            peek: (ctx, id) => acpOverlays.peek(ctx, id),
                            acknowledge: acknowledgeCapabilityApplication,
                        });
                        return createAcpRuntime(
                            context,
                            connection.rpc,
                            profile.descriptor.id,
                            connection.agentCapabilities,
                            profile.descriptor.name,
                            { models: catalogs.get(contextKey(context))?.models },
                        );
                    } catch (error) {
                        await connection.rpc.close().catch(() => {});
                        throw error;
                    }
                },
                async releaseExecution(context, binding, operationId) {
                    if (!context.space || context.remote)
                        return { kind: "rejected", code: "unsupported", message: "Local Space context required" };
                    if (process.platform !== "linux") {
                        return {
                            kind: "rejected",
                            code: "unsupported",
                            message: `Crash-safe cross-harness switching currently requires Linux; ${profile.descriptor.name} can still be used normally`,
                        };
                    }
                    return releaseProcessExecution(stateFile(context), binding, operationId);
                },
            });
        },
        onDisable() { registration?.dispose(); catalogs.clear(); probes.clear(); },
    };
}
