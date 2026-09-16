import type { AgentCapabilityDescriptor } from "@polyth/contracts";
import { capabilityRevision, desiredBundleRevision } from "./capabilities.ts";

export interface PromptPrefixContributorDiagnostic {
  id: string;
  kind: AgentCapabilityDescriptor["kind"];
  owner: string;
  scope: AgentCapabilityDescriptor["scope"];
  revision: string;
}

/**
 * Content-free identity for the deterministic Polyth-owned capability prefix.
 *
 * This deliberately does NOT claim to fingerprint opaque vendor-internal
 * system prompts. It fingerprints the same harness-filtered desired capability
 * bundle Polyth provisions. The provisioning service supplies the fully
 * assembled desired state, whose descriptors already carry semantic revisions,
 * so instruction/tool/schema changes rotate this identity even when a package
 * forgot to bump a declared revision.
 */
export interface PromptPrefixDiagnostics {
  version: 1;
  coverage: "polyth-capability-prefix";
  harnessId?: string;
  identity: string;
  bundleRevision: string;
  contributorCount: number;
  contributors: PromptPrefixContributorDiagnostic[];
}

const targetsHarness = (descriptor: AgentCapabilityDescriptor, harnessId: string): boolean => {
  const target = (descriptor as AgentCapabilityDescriptor & { targetHarnessId?: unknown }).targetHarnessId;
  return target === undefined || target === harnessId;
};

export function promptPrefixDiagnostics(
  descriptors: readonly AgentCapabilityDescriptor[],
  harnessId?: string,
): PromptPrefixDiagnostics {
  const ordered = descriptors
    .filter((descriptor) => !harnessId || targetsHarness(descriptor, harnessId))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const bundleRevision = desiredBundleRevision(ordered);
  const contributors = ordered.map((descriptor): PromptPrefixContributorDiagnostic => ({
    id: descriptor.id,
    kind: descriptor.kind,
    owner: descriptor.owner,
    scope: descriptor.scope,
    revision: descriptor.revision,
  }));
  return {
    version: 1,
    coverage: "polyth-capability-prefix",
    ...(harnessId ? { harnessId } : {}),
    identity: capabilityRevision("prompt-prefix:v1", harnessId ?? "all", bundleRevision),
    bundleRevision,
    contributorCount: contributors.length,
    contributors,
  };
}
