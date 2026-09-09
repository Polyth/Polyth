import { createHash } from "node:crypto";
import type { HarnessContext, HarnessRegistry } from "@polyth/contracts";
import { releaseProcessExecution } from "@polyth/harness-runtime";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { ACP_STATIC_FEATURES, connectAcp, createAcpRuntime, type AcpProfile } from "./index.ts";
import { discoverAcpModels } from "./discovery.ts";
import { createAcpProvisioner } from "./provisioner.ts";
export function registerAcpProfile(host: ServerPackageHost, profile: AcpProfile) {
    const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
    let registration: ReturnType<HarnessRegistry["register"]> | undefined;
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
                provisioner: createAcpProvisioner(profile.descriptor.id),
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
                    return {
                        state: "ready" as const,
                        catalog: { models: discovery.models, agents: [] },
                    };
                },
                async createRuntime(context) {
                    if (!context.space || context.remote || process.platform !== "linux")
                        throw Object.assign(new Error("Local Linux Space context required"), { code: "unsupported" });
                    const connection = await connectAcp(profile, context, stateFile(context));
                    return createAcpRuntime(
                        context,
                        connection.rpc,
                        profile.descriptor.id,
                        connection.agentCapabilities,
                        profile.descriptor.name,
                    );
                },
                async releaseExecution(context, binding, operationId) {
                    if (!context.space || context.remote || process.platform !== "linux")
                        return { kind: "rejected", code: "unsupported", message: "Local Linux Space context required" };
                    return releaseProcessExecution(stateFile(context), binding, operationId);
                },
            });
        },
        onDisable() { registration?.dispose(); },
    };
}
