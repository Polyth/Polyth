import { dirname } from "node:path";
import {
  createCapabilityProvisioningController as createCoreCapabilityProvisioningController,
} from "./capabilityProvisioningCore.ts";
import { isAgentPackageRelevant } from "./projectCompositionAgentGate.ts";

export {
  reconcilePinnedHarness,
  type CapabilityProvisioningController,
  type InstructionProvisionState,
} from "./capabilityProvisioningCore.ts";

/** Composition decorator around the canonical provisioning implementation.
 * Global package lifecycle/sandbox admission remains authoritative; project
 * relevance only narrows the already-admitted contribution set. */
export function createCapabilityProvisioningController(
  opts: Parameters<typeof createCoreCapabilityProvisioningController>[0],
): ReturnType<typeof createCoreCapabilityProvisioningController> {
  const packageAllowed = opts.contributionAllowed;
  const dataDir = dirname(opts.file);
  return createCoreCapabilityProvisioningController({
    ...opts,
    contributionAllowed: (owner, context) => {
      if (packageAllowed?.(owner, context) === false) return false;
      return isAgentPackageRelevant(dataDir, owner, context);
    },
  });
}
