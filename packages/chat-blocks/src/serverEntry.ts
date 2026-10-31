import type { AgentCapabilityContributionRegistry, Disposable } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  SERVER_BEHAVIOR_SECTIONS,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { CHAT_BLOCKS_PACKAGE_ID, chatBlocksRuleSection, chatBlocksSkill } from "./rule.ts";

// The package has no routes: blocks are plain assistant text in canonical
// history and render in the browser (data files are read through the Files
// API). The server teaches every harness the format while the package is
// enabled — a short behavior section plus an on-demand reference skill — and
// withdraws both when it is disabled.
export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let registration: Disposable | undefined;
  let skill: Disposable | undefined;

  const refresh = async (): Promise<void> => {
    await host.services.get(SERVER_BEHAVIOR_SECTIONS)?.changed();
  };

  return {
    remoteAccess: localOnlyRemoteAccess([CHAT_BLOCKS_PACKAGE_ID]),
    async onEnable() {
      const capabilities = host.services.get(
        serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
      );
      if (capabilities && !skill) skill = capabilities.register(CHAT_BLOCKS_PACKAGE_ID, chatBlocksSkill);
      const sections = host.services.get(SERVER_BEHAVIOR_SECTIONS);
      if (!sections || registration) return;
      registration = sections.register(CHAT_BLOCKS_PACKAGE_ID, chatBlocksRuleSection);
      await refresh();
    },
    async onDisable() {
      await skill?.dispose();
      skill = undefined;
      if (!registration) return;
      registration.dispose();
      registration = undefined;
      await refresh();
    },
  };
}
