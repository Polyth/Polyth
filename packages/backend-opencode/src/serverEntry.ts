import type { AgentRuntime, HarnessContext, HarnessRegistry } from "@polyth/contracts";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createOpenCodeHarness } from "./harness.ts";
export default function registerPackage(host: ServerPackageHost) {
    const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
    const pool = host.services.require(serverServiceKey<(context: HarnessContext) => Promise<AgentRuntime>>("opencode.runtime"));
    const registration = registry.register(createOpenCodeHarness(pool));
    return { remoteAccess: localOnlyRemoteAccess(["backend-opencode"]), onDisable: () => registration.dispose() };
}
