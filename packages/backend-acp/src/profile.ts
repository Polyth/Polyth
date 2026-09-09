import { createHash } from "node:crypto";
import type { HarnessContext, HarnessRegistry, ModelDescriptor } from "@polyth/contracts";
import { acknowledgeCapabilityApplication, releaseProcessExecution } from "@polyth/harness-runtime";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { ACP_STATIC_FEATURES, connectAcp, createAcpRuntime, type AcpProfile } from "./index.ts";
import { discoverAcpModels } from "./discovery.ts";
import { acpOverlays, createAcpProvisioner } from "./provisioner.ts";
import { configureAcpCapabilityDelivery } from "./capabilityDelivery.ts";
export function registerAcpProfile(host: ServerPackageHost, profile: AcpProfile) {
    const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
    let registration: ReturnType<HarnessRegistry["register"]> | undefined;
    const catalogs = new Map<string, ModelDescriptor[]>();
    const contextKey = (context: HarnessContext) => JSON.stringify([context.spaceId, context.projectId, context.cwd]);
    /** ACP exposes its model catalog only while opening a native session. */
    const discoveryProbe = (context: HarnessContext) => ({
        async open(signal?: AbortSignal) {
            const connection = await connectAcp(profile, context, undefined, signal);
            const abort = () => { void connection.rpc.close().catch(() => {}); };
            signal?.addEventListener("abort", abort, { once: true });
            try {
                const result = await connection.rpc.request("session/new", { cwd: context.cwd, mcpServers: [] });
                return {
                    result,
                    setConfigOption: (configId: string, value: string) => connection.rpc.request("session/set_config_option", {
                        sessionId: (result as { sessionId: string }).sessionId,
                        configId,
                        value,
                    }),
                    close: async () => {
                        signal?.removeEventListener("abort", abort);
                        await connection.rpc.close();
                    },
                };
            } catch (error) {
                signal?.removeEventListener("abort", abort);
                await connection.rpc.close();
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
                probe: profile.probe,
                // Stage HTTP entries, then require the actual initialize
                // advertisement before sending any native session request.
                provisioner: createAcpProvisioner(profile.descriptor.id, true),
                async discover(context) {
                    if (context.remote || process.platform !== "linux") {
                        throw Object.assign(new Error("Local Linux runtimes are supported"), { code: "unsupported" });
                    }
                    const availability = await profile.probe(context);
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
                    catalogs.set(contextKey(context), discovery.models);
                    return {
                        state: "ready" as const,
                        catalog: { models: discovery.models, agents: [] },
                    };
                },
                async createRuntime(context) {
                    if (!context.space || context.remote || process.platform !== "linux")
                        throw Object.assign(new Error("Local Linux Space context required"), { code: "unsupported" });
                    const connection = await connectAcp(profile, context, stateFile(context));
                    try {
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
                            { models: catalogs.get(contextKey(context)) },
                        );
                    } catch (error) {
                        await connection.rpc.close().catch(() => {});
                        throw error;
                    }
                },
                async releaseExecution(context, binding, operationId) {
                    if (!context.space || context.remote || process.platform !== "linux")
                        return { kind: "rejected", code: "unsupported", message: "Local Linux Space context required" };
                    return releaseProcessExecution(stateFile(context), binding, operationId);
                },
            });
        },
        onDisable() { registration?.dispose(); catalogs.clear(); },
    };
}
