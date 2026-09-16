// Workbench runtime store: the ONE source of truth for where surfaces live.
// Holds the active profile and its layout for the active project, persists
// every change through workbench/prefs.ts, and exposes the command vocabulary
// (open/close/move/swap/presentation/collapse/resize/reset) that the shell,
// the compatibility adapters in store.ts, and the public web-sdk host all
// dispatch into. Never imports the app store: store.ts subscribes here and
// mirrors the focal surface into its legacy railPlugin/paneMode fields.
import { useSyncExternalStore } from "react";
import type {
  OpenSurfaceOptions,
  WorkbenchPresentation,
  WorkbenchProfileSummary,
  WorkbenchRegion,
  WorkbenchRegionSnapshot,
  WorkbenchSnapshot,
} from "@polyth/web-sdk";
import { isWorkspaceSurface, listSurfaces, type RailSurface } from "../surfaces.ts";
import {
  ANY_REGION,
  CHAT_SURFACE_ID,
  WORKBENCH_REGIONS,
  activateSurface,
  closeSurface,
  closeTransient,
  exitFullscreen,
  focalSurface,
  isCompanionShaped,
  layoutFromTemplate,
  makePrimary,
  moveSurface,
  openSurface,
  placementOf,
  reorderSurface,
  resetSurfacePosition,
  resizeRegion,
  resizeSurface,
  setActive,
  setCollapsed,
  setPresentation,
  swapSurfaces,
  type SurfaceConstraints,
  type SurfaceSize,
  type WorkbenchLayout,
} from "./layout.ts";
import {
  CONVERSATION_PROFILE_ID,
  getWorkbenchProfile,
  listWorkbenchProfileSummaries,
  profileSummary,
  subscribeWorkbenchProfiles,
} from "./profiles.ts";
import {
  emptyWorkbenchPrefs,
  profileRecord,
  readWorkbenchPrefs,
  reloadWorkbenchPrefs,
  writeWorkbenchPrefs,
  type WorkbenchPrefs,
  type WorkbenchProfileRecord,
} from "./prefs.ts";
import {
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  projectPresentationEventProjectId,
} from "../projectPresentationSync.ts";

interface WorkbenchRuntime {
  projectId: string | null;
  prefs: WorkbenchPrefs;
  /** Phone-only transient focus: which region fills the viewport. */
  phoneFocus: WorkbenchRegion | null;
}

let runtime: WorkbenchRuntime = {
  projectId: null,
  prefs: withProfile(emptyWorkbenchPrefs(), CONVERSATION_PROFILE_ID),
  phoneFocus: null,
};
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeWorkbench(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useWorkbench<T>(selector: (state: WorkbenchRuntime) => T): T {
  return useSyncExternalStore(subscribeWorkbench, () => selector(runtime), () => selector(runtime));
}

/** Ensure a profile has a layout record (from its template when missing). */
function withProfile(prefs: WorkbenchPrefs, profileId: string): WorkbenchPrefs {
  if (prefs.profiles[profileId]) return prefs;
  const definition = getWorkbenchProfile(profileId);
  return {
    ...prefs,
    profiles: { ...prefs.profiles, [profileId]: profileRecord(prefs, profileId, definition?.defaultLayout ?? null) },
  };
}

function activeRecord(): WorkbenchProfileRecord {
  return runtime.prefs.profiles[runtime.prefs.activeProfile]!;
}

export function getActiveProfileId(): string {
  return runtime.prefs.activeProfile;
}

export function getActiveProfileSummary(): WorkbenchProfileSummary {
  const definition = getWorkbenchProfile(runtime.prefs.activeProfile) ?? getWorkbenchProfile(CONVERSATION_PROFILE_ID)!;
  return profileSummary(definition);
}

export function getWorkbenchLayout(): WorkbenchLayout {
  return activeRecord().layout;
}

export function getWorkbenchProjectId(): string | null {
  return runtime.projectId;
}

export function isLayoutCustomized(): boolean {
  return activeRecord().customized;
}

export function getPhoneFocus(): WorkbenchRegion | null {
  return runtime.phoneFocus;
}

export function setPhoneFocus(region: WorkbenchRegion | null): void {
  if (runtime.phoneFocus === region) return;
  runtime = { ...runtime, phoneFocus: region };
  notify();
}

export function workbenchSnapshot(): WorkbenchSnapshot {
  const layout = getWorkbenchLayout();
  const regions = {} as Record<WorkbenchRegion, WorkbenchRegionSnapshot>;
  for (const region of WORKBENCH_REGIONS) {
    regions[region] = {
      surfaces: [...layout.regions[region].surfaces],
      active: layout.regions[region].active,
      collapsed: layout.collapsed[region],
    };
  }
  return {
    activeProfile: runtime.prefs.activeProfile,
    profiles: listWorkbenchProfileSummaries(),
    regions,
    floating: [...layout.floating],
    fullscreen: layout.fullscreen?.surfaceId ?? null,
  };
}

// ---- persistence ---------------------------------------------------------------------

function commit(prefs: WorkbenchPrefs, options: { customized?: boolean } = {}): void {
  let next = prefs;
  if (options.customized === true) {
    const record = next.profiles[next.activeProfile];
    if (record && !record.customized) {
      next = { ...next, profiles: { ...next.profiles, [next.activeProfile]: { ...record, customized: true } } };
    }
  }
  if (next === runtime.prefs) return;
  runtime = { ...runtime, prefs: next };
  if (runtime.projectId !== null) writeWorkbenchPrefs(runtime.projectId, next);
  notify();
}

function updateLayout(
  reducer: (layout: WorkbenchLayout) => WorkbenchLayout,
  options: { customized?: boolean } = {},
): boolean {
  const record = activeRecord();
  const layout = reducer(record.layout);
  if (layout === record.layout) return false;
  commit({
    ...runtime.prefs,
    profiles: { ...runtime.prefs.profiles, [runtime.prefs.activeProfile]: { ...record, layout } },
  }, options);
  return true;
}

/** Switch the active project: load (migrating) its record and drop transient
 *  windows. A project's layout never leaks into another project's record. */
export function setWorkbenchProject(projectId: string | null): void {
  if (projectId === runtime.projectId) return;
  const prefs = projectId === null ? emptyWorkbenchPrefs() : readWorkbenchPrefs(projectId);
  const activeProfile = resolveProfile(prefs.activeProfile);
  runtime = {
    projectId,
    prefs: withProfile({ ...prefs, activeProfile }, activeProfile),
    phoneFocus: null,
  };
  notify();
}

/** A profile the picker may activate: registered and currently available. */
function resolveProfile(profileId: string): string {
  const definition = getWorkbenchProfile(profileId);
  if (!definition) return CONVERSATION_PROFILE_ID;
  return profileSummary(definition).available ? profileId : CONVERSATION_PROFILE_ID;
}

// ---- profiles --------------------------------------------------------------------------

/** Activate a registered, available profile. Layouts of other profiles are
 *  kept untouched; open resources are not affected (tabs are scoped to the
 *  project/session, not to the profile). */
export function activateWorkbenchProfile(profileId: string): boolean {
  const definition = getWorkbenchProfile(profileId);
  if (!definition || !profileSummary(definition).available) return false;
  if (runtime.prefs.activeProfile === profileId) return true;
  const prefs = withProfile({ ...runtime.prefs, activeProfile: profileId }, profileId);
  runtime = { ...runtime, prefs, phoneFocus: null };
  if (runtime.projectId !== null) writeWorkbenchPrefs(runtime.projectId, prefs);
  notify();
  return true;
}

/** When the package owning the active profile unloads, fall back to
 *  conversation without deleting the profile's persisted layout. */
export function reconcileActiveProfile(): void {
  const resolved = resolveProfile(runtime.prefs.activeProfile);
  if (resolved === runtime.prefs.activeProfile) return;
  activateWorkbenchProfile(resolved);
}

subscribeWorkbenchProfiles(() => {
  reconcileActiveProfile();
  notify();
});

if (typeof window !== "undefined") {
  window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, (event) => {
    const projectId = projectPresentationEventProjectId(event);
    if (projectId === null || projectId !== runtime.projectId) return;
    const prefs = reloadWorkbenchPrefs(projectId);
    const activeProfile = resolveProfile(prefs.activeProfile);
    runtime = {
      ...runtime,
      prefs: withProfile({ ...prefs, activeProfile }, activeProfile),
      phoneFocus: null,
    };
    notify();
  });
}

/** Reset one profile (default: the active one) to its package-defined layout.
 *  Other profiles are untouched. */
export function resetWorkbenchProfile(profileId: string = runtime.prefs.activeProfile): void {
  const definition = getWorkbenchProfile(profileId);
  if (!definition) return;
  commit({
    ...runtime.prefs,
    profiles: {
      ...runtime.prefs.profiles,
      [profileId]: { layout: layoutFromTemplate(definition.defaultLayout), customized: false },
    },
  });
}

// ---- constraints ------------------------------------------------------------------------

function surfaceOf(surfaceId: string): RailSurface | undefined {
  return listSurfaces().find((surface) => surface.id === surfaceId);
}

export function constraintsFor(surfaceId: string): SurfaceConstraints {
  if (surfaceId === CHAT_SURFACE_ID) return { allowedRegions: WORKBENCH_REGIONS, preferredRegion: "primary" };
  const surface = surfaceOf(surfaceId);
  const placement = surface?.placement;
  return {
    allowedRegions: placement?.allowedRegions && placement.allowedRegions.length > 0
      ? placement.allowedRegions
      : WORKBENCH_REGIONS,
    preferredRegion: placement?.preferredRegion
      ?? (surface?.presentation?.dock === "bottom" ? "bottom" : ANY_REGION.preferredRegion),
  };
}

export function surfaceAllowsRegion(surfaceId: string, region: WorkbenchRegion): boolean {
  return constraintsFor(surfaceId).allowedRegions.includes(region);
}

// ---- commands -----------------------------------------------------------------------------

/** Open (or focus) a surface. In the conversation profile's classic shape the
 *  workbench keeps the legacy "one package window" semantics: the new window
 *  replaces the current one and inherits its presentation (a pinned window
 *  stays pinned, a floating one stays floating). Any richer layout — several
 *  docked surfaces, a surface in start — is treated as a customized workbench
 *  and simply adds the surface. */
export function workbenchOpenSurface(surfaceId: string, options: OpenSurfaceOptions = {}): boolean {
  if (surfaceId === CHAT_SURFACE_ID) {
    return updateLayout((layout) => openSurface(layout, surfaceId, { ...options, presentation: options.presentation ?? "docked", region: options.region ?? "primary" }, constraintsFor(surfaceId)));
  }
  const constraints = constraintsFor(surfaceId);
  return updateLayout((layout) => {
    if (placementOf(layout, surfaceId) !== null) {
      return openSurface(layout, surfaceId, options, constraints);
    }
    const companion = runtime.prefs.activeProfile === CONVERSATION_PROFILE_ID && isCompanionShaped(layout);
    if (!companion) {
      return openSurface(layout, surfaceId, { ...options, presentation: options.presentation ?? "docked" }, constraints);
    }
    const focal = focalSurface(layout);
    const focalPlacement = focal !== null ? placementOf(layout, focal) : null;
    const focalSurfaceDef = focal !== null ? surfaceOf(focal) : undefined;
    const workspaceWindow = surfaceOf(surfaceId) === undefined || isWorkspaceSurface(surfaceOf(surfaceId)!);
    let next = focal !== null && focal !== CHAT_SURFACE_ID ? closeSurface(layout, focal) : layout;
    let presentation: WorkbenchPresentation = options.presentation ?? "floating";
    let region: WorkbenchRegion | undefined = options.region;
    if (options.presentation === undefined) {
      if (!workspaceWindow) {
        presentation = "docked";
        region ??= "end";
      } else if (focalPlacement !== null && focalSurfaceDef !== undefined && isWorkspaceSurface(focalSurfaceDef)) {
        // Sticky window mode: inherit the previous package window's presentation.
        presentation = focalPlacement.presentation === "fullscreen"
          ? focalPlacement.previous.presentation
          : focalPlacement.presentation;
        if (focalPlacement.presentation === "fullscreen") {
          next = openSurface(next, surfaceId, { presentation, ...(region ? { region } : {}) }, constraints);
          return setPresentation(next, surfaceId, "fullscreen", constraints);
        }
      }
    }
    return openSurface(next, surfaceId, { presentation, ...(region ? { region } : {}), activate: options.activate }, constraints);
  });
}

export function workbenchCloseSurface(surfaceId: string): boolean {
  if (surfaceId === CHAT_SURFACE_ID) return false;
  return updateLayout((layout) => closeSurface(layout, surfaceId));
}

export function workbenchActivateSurface(surfaceId: string): boolean {
  return updateLayout((layout) => activateSurface(layout, surfaceId));
}

export function workbenchMoveSurface(surfaceId: string, region: WorkbenchRegion): boolean {
  if (!surfaceAllowsRegion(surfaceId, region)) return false;
  return updateLayout((layout) => moveSurface(layout, surfaceId, region, constraintsFor(surfaceId)), { customized: true });
}

export function workbenchMakePrimary(surfaceId: string): boolean {
  if (!surfaceAllowsRegion(surfaceId, "primary")) return false;
  return updateLayout((layout) => makePrimary(layout, surfaceId, constraintsFor(surfaceId)), { customized: true });
}

export function workbenchSwapSurfaces(a: string, b: string): boolean {
  const layout = getWorkbenchLayout();
  const pa = placementOf(layout, a);
  const pb = placementOf(layout, b);
  if (pa?.presentation === "docked" && !surfaceAllowsRegion(b, pa.region)) return false;
  if (pb?.presentation === "docked" && !surfaceAllowsRegion(a, pb.region)) return false;
  return updateLayout((current) => swapSurfaces(current, a, b), { customized: true });
}

export function workbenchSetPresentation(surfaceId: string, presentation: WorkbenchPresentation): boolean {
  return updateLayout((layout) => setPresentation(layout, surfaceId, presentation, constraintsFor(surfaceId)));
}

export function workbenchSetActive(region: WorkbenchRegion, surfaceId: string): boolean {
  return updateLayout((layout) => setActive(layout, region, surfaceId));
}

export function workbenchSetCollapsed(region: WorkbenchRegion, collapsed: boolean): boolean {
  return updateLayout((layout) => setCollapsed(layout, region, collapsed), { customized: true });
}

export function workbenchToggleCollapsed(region: WorkbenchRegion): boolean {
  return workbenchSetCollapsed(region, !getWorkbenchLayout().collapsed[region]);
}

export function workbenchResizeRegion(region: WorkbenchRegion, size: number | null): boolean {
  return updateLayout((layout) => resizeRegion(layout, region, size), { customized: true });
}

export function workbenchResizeSurface(surfaceId: string, patch: SurfaceSize): boolean {
  return updateLayout((layout) => resizeSurface(layout, surfaceId, patch));
}

export function workbenchReorderSurface(surfaceId: string, index: number): boolean {
  return updateLayout((layout) => reorderSurface(layout, surfaceId, index), { customized: true });
}

export function workbenchExitFullscreen(): boolean {
  return updateLayout((layout) => exitFullscreen(layout));
}

/** Session/project boundary: floating windows close, fullscreen returns home. */
export function workbenchCloseTransient(keep: (surfaceId: string) => boolean = () => false): boolean {
  return updateLayout((layout) => closeTransient(layout, keep));
}

export function workbenchResetSurfacePosition(surfaceId: string): boolean {
  const template = getWorkbenchProfile(runtime.prefs.activeProfile)?.defaultLayout;
  if (!template) return false;
  return updateLayout((layout) => resetSurfacePosition(layout, surfaceId, template));
}

/** Compatibility memory: the last provider resource a surface showed. */
export function getWorkbenchLastResource(surfaceId: string): string | undefined {
  return runtime.prefs.lastResource[surfaceId];
}

export function setWorkbenchLastResource(surfaceId: string, resource: string): void {
  if (runtime.prefs.lastResource[surfaceId] === resource) return;
  commit({ ...runtime.prefs, lastResource: { ...runtime.prefs.lastResource, [surfaceId]: resource } });
}

// ---- legacy package-window transitions (companion host) -----------------------------

/** The surface the compatibility layer treats as "the package window". */
export function workbenchFocalSurface(): string | null {
  return focalSurface(getWorkbenchLayout());
}

export function workbenchToggleFullscreen(surfaceId: string | null = workbenchFocalSurface()): boolean {
  if (surfaceId === null) return false;
  const placement = placementOf(getWorkbenchLayout(), surfaceId);
  if (placement === null) return false;
  if (placement.presentation === "fullscreen") return workbenchExitFullscreen();
  return workbenchSetPresentation(surfaceId, "fullscreen");
}

/** Pin ⇄ float. While fullscreen, flips where the surface will return to. */
export function workbenchTogglePin(surfaceId: string | null = workbenchFocalSurface()): boolean {
  if (surfaceId === null) return false;
  const layout = getWorkbenchLayout();
  const placement = placementOf(layout, surfaceId);
  if (placement === null) return false;
  if (placement.presentation === "fullscreen") {
    const previous = placement.previous.presentation === "docked"
      ? { presentation: "floating" as const }
      : { presentation: "docked" as const, region: constraintsFor(surfaceId).preferredRegion };
    return updateLayout((current) => current.fullscreen?.surfaceId === surfaceId
      ? { ...current, fullscreen: { surfaceId, previous } }
      : current);
  }
  return workbenchSetPresentation(surfaceId, placement.presentation === "docked" ? "floating" : "docked");
}

/** Escape: a floating window closes, fullscreen returns home, docked stays. */
export function workbenchEscape(surfaceId: string | null = workbenchFocalSurface()): boolean {
  if (surfaceId === null) return false;
  const placement = placementOf(getWorkbenchLayout(), surfaceId);
  if (placement === null) return false;
  if (placement.presentation === "floating") return workbenchCloseSurface(surfaceId);
  if (placement.presentation === "fullscreen") return workbenchExitFullscreen();
  return false;
}

/** Outside interaction dismisses only a floating window. */
export function workbenchOutsideClose(surfaceId: string | null = workbenchFocalSurface()): boolean {
  if (surfaceId === null) return false;
  const placement = placementOf(getWorkbenchLayout(), surfaceId);
  return placement?.presentation === "floating" ? workbenchCloseSurface(surfaceId) : false;
}

/** Test seam: forget project state (prefs caches are reset separately). */
export function resetWorkbenchForTest(): void {
  runtime = {
    projectId: null,
    prefs: withProfile(emptyWorkbenchPrefs(), CONVERSATION_PROFILE_ID),
    phoneFocus: null,
  };
  notify();
}
