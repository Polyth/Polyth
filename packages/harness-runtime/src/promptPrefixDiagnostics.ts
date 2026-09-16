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
 * system prompts. It fingerprints the exact desired capability bundle Polyth
 * resolves before harness projection. The canonical registry has already
 * normalized every descriptor revision from its semantic fields, so a changed
 * instruction/tool/schema rotates this identity even when a package forgot to
 * bump its declared revision.
 */
export interface PromptPrefixDiagnostics {
  version: 1;
  coverage: "polyth-capability-prefix";
  identity: string;
  bundleRevision: string;
  contributorCount: number;
  contributors: PromptPrefixContributorDiagnostic[];
}

export function promptPrefixDiagnostics(
  descriptors: readonly AgentCapabilityDescriptor[],
): PromptPrefixDiagnostics {
  const ordered = [...descriptors].sort((left, right) => left.id.localeCompare(right.id));
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
    identity: capabilityRevision("prompt-prefix:v1", bundleRevision),
    bundleRevision,
    contributorCount: contributors.length,
    contributors,
  };
}
