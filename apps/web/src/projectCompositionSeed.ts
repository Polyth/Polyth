import type { ProjectComposition } from "@polyth/contracts/project-composition";
import { matchesProjectAffinity } from "@polyth/contracts/project-composition";
import type { WorkbenchProfileDefinition } from "@polyth/web-sdk";
import { whenPackagesSettled } from "./packages/registry.ts";
import { listProjectContextRecommendedWidgetIds } from "./packages/projectContext.ts";
import { getWorkbenchProjectId, activateWorkbenchProfile } from "./workbench/store.ts";
import { CONVERSATION_PROFILE_ID, listWorkbenchProfiles } from "./workbench/profiles.ts";
import { setWidgetVisible, updateWidgetLayoutForProject } from "./widgets/widgetLayout.ts";

export function selectInitialWorkbenchProfile(
  composition: ProjectComposition,
  profiles: readonly WorkbenchProfileDefinition[],
): string | null {
  if (composition.directions.length === 0) return null;
  const selected = new Set(composition.directions);
  return profiles
    .filter((profile) => profile.id !== CONVERSATION_PROFILE_ID)
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

/** Seed only a freshly-created project. Never call this on ordinary project
 * reads/switches or Settings edits: those preserve user customization. */
export async function seedInitialProjectWorkspace(
  projectId: string,
  composition: ProjectComposition,
): Promise<void> {
  await whenPackagesSettled();

  const recommended = listProjectContextRecommendedWidgetIds(projectId);
  if (recommended.length > 0) {
    updateWidgetLayoutForProject(projectId, (layout) => {
      let next = layout;
      for (const id of recommended) {
        if (!next.widgets[id]) continue;
        next = setWidgetVisible(next, id, true);
      }
      return next;
    }, { immediate: true });
  }

  const profileId = selectInitialWorkbenchProfile(composition, listWorkbenchProfiles());
  if (profileId && getWorkbenchProjectId() === projectId) activateWorkbenchProfile(profileId);
}
