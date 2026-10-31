import type { Disposable } from "@polyth/contracts";
import { serverServiceKey, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import registerHarnessPackage from "./serverEntry.ts";
import { registerDelegationMergeReminder, type DelegationMergeReminder } from "./delegationMerge.ts";
import { polythPeerSkill, registerPeerObservationTool } from "./peerObservationTool.ts";
import { polythDelegationPolicy, polythSessionsSkill, registerPolythSessionControl } from "./sessionControlTool.ts";
import { registerProjectMcpTool } from "./projectMcpTool.ts";

export default async function registerPackage(host: ServerPackageHost): Promise<ServerPackage> {
  const base = await registerHarnessPackage(host);
  let sessionControl: Disposable | undefined;
  let mergeReminder: DelegationMergeReminder | undefined;
  let peerObservations: Disposable | undefined;
  let sessionsSkill: Disposable | undefined;
  let delegationPolicy: Disposable | undefined;
  let peerSkill: Disposable | undefined;
  let projectMcp: Disposable | undefined;

  return {
    ...base,
    async onEnable() {
      await base.onEnable?.();
      // Resolves the isolation service lazily per turn, so it does not
      // depend on the Git package enabling before this one.
      if (!mergeReminder) mergeReminder = registerDelegationMergeReminder(host);
      if (!sessionControl) sessionControl = registerPolythSessionControl(host, { delegations: mergeReminder });
      if (!peerObservations) peerObservations = registerPeerObservationTool(host);
      if (!projectMcp) projectMcp = registerProjectMcpTool(host);
      if (!sessionsSkill) {
        const caps = host.services.require(serverServiceKey<import("@polyth/contracts").AgentCapabilityContributionRegistry>("harness.capabilities"));
        sessionsSkill = caps.register("harness-runtime", polythSessionsSkill);
      }
      if (!delegationPolicy) {
        const caps = host.services.require(serverServiceKey<import("@polyth/contracts").AgentCapabilityContributionRegistry>("harness.capabilities"));
        delegationPolicy = caps.register("harness-runtime", polythDelegationPolicy);
      }
      if (!peerSkill) {
        const caps = host.services.require(serverServiceKey<import("@polyth/contracts").AgentCapabilityContributionRegistry>("harness.capabilities"));
        peerSkill = caps.register("harness-runtime", polythPeerSkill);
      }
    },
    async onDisable() {
      await projectMcp?.dispose();
      projectMcp = undefined;
      await peerSkill?.dispose();
      peerSkill = undefined;
      await delegationPolicy?.dispose();
      delegationPolicy = undefined;
      await sessionsSkill?.dispose();
      sessionsSkill = undefined;
      await peerObservations?.dispose();
      peerObservations = undefined;
      await sessionControl?.dispose();
      sessionControl = undefined;
      await mergeReminder?.dispose();
      mergeReminder = undefined;
      await base.onDisable?.();
    },
  };
}
