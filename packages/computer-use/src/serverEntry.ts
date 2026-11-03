import type {
  AgentCapabilityContributionRegistry,
  Disposable,
  ToolExecutionContext,
} from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { computerUseSkill } from "./agentSkill.ts";
import { COMPUTER_USE_PACKAGE_ID, createComputerAgentTool } from "./agentTool.ts";
import { detectDriver } from "./drivers/index.ts";
import { ComputerUseError } from "./errors.ts";
import { ComputerUseRuntime } from "./runtime.ts";
import type { ComputerDriver } from "./types.ts";

/** The person who set up a single-person installation. */
const BOOTSTRAP_OWNER_ID = "usr_owner";

/** Only the instance owner's own turns may drive the desktop: it is the
 * owner's machine. Other Space members, system work with no person and
 * scheduled work without an actor are refused. */
export const ownerOnly = (host: Pick<ServerPackageHost, "personSpaceContext">) => (context: ToolExecutionContext): void => {
  const actor = context.actorUserId;
  const refuse = () => {
    throw new ComputerUseError("forbidden", "Only the owner of this Polyth installation can let agents control this computer");
  };
  if (!actor || actor.startsWith("system:") || !context.spaceId) refuse();
  const person = host.personSpaceContext?.(actor!, context.spaceId!) as { instanceOwner?: boolean } | undefined;
  if (person) {
    if (person.instanceOwner !== true) refuse();
    return;
  }
  // No canonical context: a single-person install, whose only person is
  // the bootstrap owner.
  if (actor !== BOOTSTRAP_OWNER_ID) refuse();
};

export interface ComputerUsePackageOptions {
  driver?: ComputerDriver | null;
}

export function createComputerUsePackage(host: ServerPackageHost, options: ComputerUsePackageOptions = {}): ServerPackage {
  // Hosted, multi-tenant deployments have no owner desktop to drive.
  const driver = host.deployment === "multi-tenant-sandboxed"
    ? undefined
    : options.driver === undefined ? detectDriver() : options.driver ?? undefined;
  const runtime = driver ? new ComputerUseRuntime({ driver, authorize: ownerOnly(host) }) : undefined;
  let registrations: Disposable[] | undefined;

  return {
    // No routes: paired devices stay default-deny, declared explicitly.
    remoteAccess: localOnlyRemoteAccess([COMPUTER_USE_PACKAGE_ID]),
    onEnable() {
      // Without a desktop (a headless server) the tool would only ever fail,
      // so nothing is offered to agents.
      if (registrations || !runtime) return;
      runtime.start();
      const registered: Disposable[] = [];
      try {
        const capabilities = host.services.require(
          serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
        );
        registered.push(capabilities.register(COMPUTER_USE_PACKAGE_ID, computerUseSkill));
        registered.push(capabilities.register(COMPUTER_USE_PACKAGE_ID, createComputerAgentTool(runtime)));
        registrations = registered;
      } catch (cause) {
        for (const registration of registered.toReversed()) registration.dispose();
        runtime.stop();
        throw cause;
      }
    },
    async onDisable() {
      runtime?.stop();
      for (const registration of registrations?.toReversed() ?? []) await registration.dispose();
      registrations = undefined;
    },
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  return createComputerUsePackage(host);
}
