import type { ProjectComposition } from "@polyth/contracts/project-composition";
import { whenPackagesSettled } from "./packages/registry.ts";
import { listProjectContextRecommendedWidgetIds } from "./packages/projectContext.ts";
import { projectPackageAffinity } from "./packages/projectRelevance.ts";
import { listCapabilities } from "./capabilities.ts";
import { capabilitySeedInputs } from "./capabilityArrivals.ts";
import { seedCapabilityLayoutForProject } from "./capabilityLayout.ts";
import { railDestinationIds } from "./railPlacement.ts";
import { getWorkbenchProjectId, activateWorkbenchProfile } from "./workbench/store.ts";
import { listWorkbenchProfiles } from "./workbench/profiles.ts";
import { setWidgetVisible, updateWidgetLayoutForProject } from "./widgets/widgetLayout.ts";
import {
  defaultCapabilityPlacements,
  selectInitialWorkbenchProfile,
} from "./projectCompositionPlan.ts";

export { selectInitialWorkbenchProfile } from "./projectCompositionPlan.ts";

/** Seed only a freshly-created project. Never call this on ordinary project
 * reads/switches or Settings edits: those preserve user customization. */
export async function seedInitialProjectWorkspace(
  projectId: string,
  composition: ProjectComposition,
): Promise<void> {
  await whenPackagesSettled();

  const capabilityPlacements = defaultCapabilityPlacements(
    composition,
    capabilitySeedInputs(listCapabilities(), railDestinationIds()),
    projectPackageAffinity,
  );
  seedCapabilityLayoutForProject(projectId, capabilityPlacements, { replace: true });

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

  const profileId = selectInitialWorkbenchProfile(
    composition,
    listWorkbenchProfiles(),
    projectPackageAffinity,
  );
  if (profileId && getWorkbenchProjectId() === projectId) activateWorkbenchProfile(profileId);
}
