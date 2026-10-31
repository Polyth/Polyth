import type { ProjectComposition } from "@polyth/contracts/project-composition";

export interface MissingProjectPackageOverride {
  id: string;
  preference: "include" | "exclude";
}

/** Preserve user intent for uninstalled contributions while making stale
 * project-local choices visible and removable in Project Settings. */
export function missingProjectPackageOverrides(
  composition: ProjectComposition,
  installedPackageIds: Iterable<string>,
): MissingProjectPackageOverride[] {
  const installed = new Set(installedPackageIds);
  return Object.entries(composition.packageOverrides)
    .filter(([id]) => !installed.has(id))
    .map(([id, preference]) => ({ id, preference }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
