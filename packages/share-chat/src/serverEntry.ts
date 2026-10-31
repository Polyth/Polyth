import type {
  AgentCapabilityContributionRegistry,
  Disposable,
} from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { sharedChatSkill } from "./agentSkill.ts";
import { createSharedChatAgentTool, SHARE_CHAT_PACKAGE_ID } from "./agentTool.ts";
import { SharedChatReader } from "./runtime.ts";

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const reader = new SharedChatReader();
  let registrations: Disposable[] | undefined;

  return {
    // No routes: paired devices stay default-deny, declared explicitly.
    remoteAccess: localOnlyRemoteAccess([SHARE_CHAT_PACKAGE_ID]),
    onEnable() {
      if (registrations) return;
      reader.start();
      const registered: Disposable[] = [];
      try {
        const capabilities = host.services.require(
          serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
        );
        registered.push(capabilities.register(SHARE_CHAT_PACKAGE_ID, sharedChatSkill));
        registered.push(capabilities.register(SHARE_CHAT_PACKAGE_ID, createSharedChatAgentTool(reader)));
        registrations = registered;
      } catch (cause) {
        for (const registration of registered.toReversed()) registration.dispose();
        reader.stop();
        throw cause;
      }
    },
    async onDisable() {
      reader.stop();
      for (const registration of registrations?.toReversed() ?? []) await registration.dispose();
      registrations = undefined;
    },
  };
}
