import { matchesProjectAffinity, type ProjectComposition } from "@polyth/contracts/project-composition";
import type { WorkbenchProfileDefinition } from "@polyth/web-sdk";

/** Pure, deterministic initial-profile planner. It consumes package-provided
 * affinity metadata only; no profile ids are hardcoded here. */
export function selectInitialWorkbenchProfile(
  composition: ProjectComposition,
  profiles: readonly WorkbenchProfileDefinition[],
): string | null {
  if (composition.directions.length === 0) return null;
  const selected = new Set(composition.directions);
  return profiles
    .filter((profile) => profile.id !== "conversation")
    .filter((profile) => profile.projectAffinity?.recommended === true)
    .filter((profile) => matchesProjectAffinity(composition, profile.projectAffinity))
    .map((profile) => ({
      profile,
      overlap: profile.projectAffinity?.directions?.filter((direction) => selected.has(direction)).length ?? 0,
    }))
    .sort((left, right) => right.overlap - left.overlap
      || left.profile.order - right.profile.order
      || left.profile.id.localeCompare(right.profile.id))[0]?.profile.id ?? null;
}
