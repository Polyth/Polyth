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
