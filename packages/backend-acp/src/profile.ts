import { createHash } from "node:crypto";
import type { HarnessRegistry } from "@polyth/contracts";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { ACP_STATIC_FEATURES, connectAcp, createAcpRuntime, type AcpProfile } from "./index.ts";
import { createAcpProvisioner } from "./provisioner.ts";
export function registerAcpProfile(host: ServerPackageHost, profile: AcpProfile) {
    const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
    let registration: ReturnType<HarnessRegistry["register"]> | undefined;
    return {
        remoteAccess: localOnlyRemoteAccess([`backend-${profile.descriptor.id}`]),
        onEnable() {
            registration = registry.register({
                descriptor: profile.descriptor,
                staticFeatures: ACP_STATIC_FEATURES,
                probe: profile.probe,
                provisioner: createAcpProvisioner(profile.descriptor.id),
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
                    );
                },
            });
        },
        onDisable() { registration?.dispose(); },
    };
}
