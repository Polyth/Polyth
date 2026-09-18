import {
  matchesProjectAffinity,
  type ProjectAffinity,
  type ProjectComposition,
} from "@polyth/contracts/project-composition";
import type { WorkbenchProfileDefinition } from "@polyth/web-sdk";

export type PackageAffinityResolver = (ownerPackageId: string) => ProjectAffinity | undefined;

export interface ProjectCapabilitySeedInput {
  id: string;
  ownerPackageId?: string;
  projectAffinity?: ProjectAffinity;
  standardTier: "primary" | "more" | "technical";
  standardRank: number;
}

export interface ProjectCapabilityPlacement {
  tier: "primary" | "more" | "technical";
  rank: number;
}

/**
 * A typed project starts focused without making anything unavailable: package
 * capabilities that are not recommended for the chosen directions move out of
 * the always-visible rails into Technical. Host/core navigation is untouched,
 * explicit project inclusion wins, and General projects keep the global
 * arrangement exactly as-is.
 */
export function initialCapabilityPlacementOverrides(
  composition: ProjectComposition,
  capabilities: readonly ProjectCapabilitySeedInput[],
  packageAffinity: PackageAffinityResolver = () => undefined,
): Record<string, ProjectCapabilityPlacement> {
  if (composition.directions.length === 0) return {};

  const placements: Record<string, ProjectCapabilityPlacement> = {};
  for (const capability of capabilities) {
    if (capability.standardTier === "technical") continue;

    const owner = capability.ownerPackageId;
    if (!owner || owner === "host" || owner === "polyth") continue;
    if (composition.packageOverrides[owner] === "include") continue;

    const ownerAffinity = packageAffinity(owner);
    const contributionAffinity = capability.projectAffinity;
    if (ownerAffinity === undefined && contributionAffinity === undefined) continue;

    const recommended = contributionAffinity?.recommended ?? ownerAffinity?.recommended;
    const matches = matchesProjectAffinity(composition, ownerAffinity)
      && matchesProjectAffinity(composition, contributionAffinity);
    if (recommended === true && matches) continue;

    placements[capability.id] = { tier: "technical", rank: capability.standardRank };
  }
  return placements;
}

/** Pure, deterministic initial-profile planner. Explicit profile affinity wins;
 * otherwise a profile may inherit its owning package's discovery affinity.
 * No profile or package ids are hardcoded here. */
export function selectInitialWorkbenchProfile(
  composition: ProjectComposition,
  profiles: readonly WorkbenchProfileDefinition[],
  packageAffinity: PackageAffinityResolver = () => undefined,
): string | null {
  if (composition.directions.length === 0) return null;
  const selected = new Set(composition.directions);
  return profiles
    .filter((profile) => profile.id !== "conversation")
    .map((profile) => ({
      profile,
      affinity: profile.projectAffinity
        ?? (profile.ownerPackageId ? packageAffinity(profile.ownerPackageId) : undefined),
    }))
    .filter(({ affinity }) => affinity?.recommended === true)
    .filter(({ affinity }) => matchesProjectAffinity(composition, affinity))
    .map(({ profile, affinity }) => ({
      profile,
      overlap: affinity?.directions?.filter((direction) => selected.has(direction)).length ?? 0,
    }))
    .sort((left, right) => right.overlap - left.overlap
      || left.profile.order - right.profile.order
      || left.profile.id.localeCompare(right.profile.id))[0]?.profile.id ?? null;
}

export interface ProjectSetupRecovery {
  canExit: boolean;
  canRetry: boolean;
  exitKind: "open-anyway" | "close" | null;
}

/** Recovery after a source mutation/finalization failure.
 *
 * - A known project with composition not yet durable must stay in Retry so the
 *   flow cannot silently abandon a half-configured project and create another.
 * - Once composition is durable, opening anyway is safe if workspace seeding
 *   fails.
 * - If the source reported success but the shell cannot resolve a project id,
 *   there is no safe retry target; Close is the only non-dead-end action and a
 *   later registry refresh can reveal the already-created project. */
export function projectSetupRecovery(
  compositionPersisted: boolean,
  projectKnown: boolean,
): ProjectSetupRecovery {
  if (compositionPersisted) return { canExit: true, canRetry: projectKnown, exitKind: "open-anyway" };
  if (!projectKnown) return { canExit: true, canRetry: false, exitKind: "close" };
  return { canExit: false, canRetry: true, exitKind: null };
}
