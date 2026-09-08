import { createHash } from "node:crypto";
import type { HarnessContext, HarnessRegistry } from "@polyth/contracts";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { ACP_STATIC_FEATURES, connectAcp, createAcpRuntime, type AcpProfile } from "./index.ts";
import { discoverAcpModels } from "./discovery.ts";
import { createAcpProvisioner } from "./provisioner.ts";
export function registerAcpProfile(host: ServerPackageHost, profile: AcpProfile) {
    const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
    let registration: ReturnType<HarnessRegistry["register"]> | undefined;
    /**
     * Open a throwaway native session purely to read what the agent
     * advertises. ACP publishes its model catalog per session, so there is no
     * cheaper place to ask.
     */
    const discoveryProbe = (context: HarnessContext) => ({
        async open() {
            const connection = await connectAcp(profile, context);
            try {
                const result = await connection.rpc.request("session/new", { cwd: context.cwd, mcpServers: [] });
                return { result, close: () => connection.rpc.close() };
            } catch (error) {
                await connection.rpc.close();
                throw error;
            }
        },
    });
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
                    const key = createHash("sha256").update(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? "catalog"])).digest("hex");
                    const file = host.spaceStorage(context.space).path(`runtime/${profile.descriptor.id}/${key}.json`);
                    const connection = await connectAcp(profile, context, file);
                    return createAcpRuntime(
                        context,
                        connection.rpc,
                        profile.descriptor.id,
                        connection.agentCapabilities,
                        profile.descriptor.name,
                    );
                },
            });
        },
        onDisable() { registration?.dispose(); },
    };
}
