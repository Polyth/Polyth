import type { Disposable } from "@polyth/contracts";
import { serverServiceKey, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import registerHarnessPackage from "./serverEntry.ts";
import { polythPeerSkill, registerPeerObservationTool } from "./peerObservationTool.ts";
import { polythSessionsSkill, registerPolythSessionControl } from "./sessionControlTool.ts";

export default async function registerPackage(host: ServerPackageHost): Promise<ServerPackage> {
  const base = await registerHarnessPackage(host);
  let sessionControl: Disposable | undefined;
  let peerObservations: Disposable | undefined;
  let sessionsSkill: Disposable | undefined;
  let peerSkill: Disposable | undefined;

  return {
    ...base,
    async onEnable() {
      await base.onEnable?.();
      if (!sessionControl) sessionControl = registerPolythSessionControl(host);
      if (!peerObservations) peerObservations = registerPeerObservationTool(host);
      if (!sessionsSkill) {
        const caps = host.services.require(serverServiceKey<import("@polyth/contracts").AgentCapabilityContributionRegistry>("harness.capabilities"));
        sessionsSkill = caps.register("harness-runtime", polythSessionsSkill);
      }
      if (!peerSkill) {
        const caps = host.services.require(serverServiceKey<import("@polyth/contracts").AgentCapabilityContributionRegistry>("harness.capabilities"));
        peerSkill = caps.register("harness-runtime", polythPeerSkill);
      }
    },
    async onDisable() {
      await peerSkill?.dispose();
      peerSkill = undefined;
      await sessionsSkill?.dispose();
      sessionsSkill = undefined;
      await peerObservations?.dispose();
      peerObservations = undefined;
      await sessionControl?.dispose();
      sessionControl = undefined;
      await base.onDisable?.();
    },
  };
}
