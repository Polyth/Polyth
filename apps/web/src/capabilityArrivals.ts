// Capabilities appear in a project's rails only where they belong.
// Capabilities register globally (a package is installed or enabled once for
// every project), so placement is decided per project:
// - a project that was never arranged (new, or its layout was reset) receives
//   its complete default arrangement (`defaultCapabilityPlacements`) — the
//   packages' `defaultRails` for the project's kind (a Personal project is
//   the `personal` kind), within the rail limits;
// - afterwards each capability that arrives takes the same per-project
//   decision (`defaultRailFor`), and anything without a rail for this project
//   waits under Technical until the user adds it.
//
// Decisions are persisted in the synced per-project capability layout. They
// are only made once the project's shared layout has been synced from the
// server, its directions and the package catalog are known, and the initial
// package activation has finished — otherwise a stale or partial view would
// be recorded as the project's choice.
import type { ProjectComposition } from "@polyth/contracts/project-composition";
import { listCapabilities, subscribeCapabilities, type CapabilityDescriptor } from "./capabilities.ts";
import { recordCapabilityArrivals, type CapabilityArrival, type PlacementOverride } from "./capabilityLayout.ts";
import {
  projectPackageAffinity,
  projectRailPlanContext,
  subscribeProjectRelevance,
} from "./packages/projectRelevance.ts";
import {
  defaultCapabilityPlacements,
  defaultRailFor,
  type PackageAffinityResolver,
  type ProjectCapabilitySeedInput,
  type RailPlanOptions,
} from "./projectCompositionPlan.ts";
import {
  isProjectPresentationSynced,
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  subscribeProjectPresentationSynced,
} from "./projectPresentationSync.ts";
import { isRailLauncherId, railDestinationIds } from "./railPlacement.ts";
import { getState, subscribeStore } from "./store.ts";

export interface CapabilityArrivalDeps {
  packagesSynced: () => boolean;
  subscribePackages: (listener: () => void) => () => void;
}

/** Pure: the default-plan inputs for the capabilities that can be launchers. */
export function capabilitySeedInputs(
  capabilities: readonly CapabilityDescriptor[],
  destinations: ReadonlySet<string>,
): ProjectCapabilitySeedInput[] {
  return capabilities.filter((capability) => isRailLauncherId(capability.id)).map((capability) => ({
    id: capability.id,
    ownerPackageId: capability.ownerPackageId,
    projectAffinity: capability.projectAffinity,
    defaultRails: capability.defaultRails,
    standardTier: capability.standardTier,
    standardRank: capability.standardRank,
    rail: capability.rail,
    ...(capability.kind ? { kind: capability.kind } : {}),
    rightRailDestination: destinations.has(capability.id),
  }));
}

/** Pure: the arrivals record for one project. A capability declaring
 * `defaultRails` always gets an explicit placement; one without keeps its
 * standard tier unless the project's directions send it to More. */
export function capabilityArrivalsFor(
  composition: ProjectComposition | undefined,
  capabilities: readonly CapabilityDescriptor[],
  packageAffinity: PackageAffinityResolver = projectPackageAffinity,
  options: RailPlanOptions = {},
): CapabilityArrival[] {
  return capabilities.map((capability): CapabilityArrival => {
    const legacy = capability.legacyStandardTier !== undefined
      ? { legacyTier: capability.legacyStandardTier, standardTier: capability.standardTier, standardRank: capability.standardRank }
      : {};
    if (!isRailLauncherId(capability.id)) return { id: capability.id, placement: null, ...legacy };
    const rail = defaultRailFor(composition, capability, packageAffinity, options);
    const tier = rail === "top" ? "primary" : rail === "right" ? "more" : "technical";
    const placement: PlacementOverride = { tier, rank: capability.standardRank };
    return {
      id: capability.id,
      placement: capability.defaultRails !== undefined || tier !== capability.standardTier ? placement : null,
      ...legacy,
    };
  });
}

export function installCapabilityArrivalReconciler(deps: CapabilityArrivalDeps): () => void {
  let queued = false;
  let projectId = getState().activeProjectId;

  const reconcile = (): void => {
    queued = false;
    const current = getState().activeProjectId;
    if (current === null || !deps.packagesSynced() || !isProjectPresentationSynced(current)) return;
    const context = projectRailPlanContext(current);
    if (context === null) return;
    const capabilities = listCapabilities();
    const options = { personal: context.personal };
    recordCapabilityArrivals(
      current,
      capabilityArrivalsFor(context.composition, capabilities, projectPackageAffinity, options),
      () => defaultCapabilityPlacements(
        context.composition,
        capabilitySeedInputs(capabilities, railDestinationIds()),
        projectPackageAffinity,
        options,
      ),
    );
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    queueMicrotask(reconcile);
  };

  const stops = [
    subscribeCapabilities(schedule),
    subscribeProjectRelevance(schedule),
    subscribeProjectPresentationSynced(schedule),
    deps.subscribePackages(schedule),
    subscribeStore(() => {
      const next = getState().activeProjectId;
      if (next === projectId) return;
      projectId = next;
      schedule();
    }),
  ];
  if (typeof window !== "undefined") {
    window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, schedule);
    stops.push(() => window.removeEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, schedule));
  }
  schedule();
  return () => { for (const stop of stops) stop(); };
}
