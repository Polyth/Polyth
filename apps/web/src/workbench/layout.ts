// Workbench layout model — pure and DOM-free (node --test covers it directly).
// One layout describes where every open surface lives: docked in one of four
// semantic regions (start/primary/end/bottom — never left/right), floating
// above the workbench, or fullscreen over it. The reducer owns the invariant
// that a surface appears at most once, that each region's active tab is one of
// its surfaces, and that leaving fullscreen returns a surface to the EXACT
// placement it came from. Geometry (measured widths, dock admission) stays in
// the hosts; this module only records preferred sizes.
import {
  WORKBENCH_REGIONS,
  type WorkbenchLayoutTemplate,
  type WorkbenchPresentation,
  type WorkbenchRegion,
} from "@polyth/web-sdk";

export type { WorkbenchPresentation, WorkbenchRegion };
export { WORKBENCH_REGIONS };

export interface RegionState {
  surfaces: string[];
  active: string | null;
}

export interface DockedPlacement { presentation: "docked"; region: WorkbenchRegion }
export interface FloatingPlacement { presentation: "floating" }
export interface FullscreenPlacement {
  presentation: "fullscreen";
  /** Where the surface returns when fullscreen ends. */
  previous: DockedPlacement | FloatingPlacement;
}
export type SurfacePlacement = DockedPlacement | FloatingPlacement | FullscreenPlacement;

export interface SurfaceSize {
  /** Docked inline size beside Chat / floating window width (px). */
  inline?: number;
  /** Floating window height (px). */
  block?: number;
  /** Bottom-dock strip height (px) — kept apart from the floating height. */
  dockBlock?: number;
}

export interface WorkbenchLayout {
  regions: Record<WorkbenchRegion, RegionState>;
  /** Floating windows back-to-front (the last entry is on top). */
  floating: string[];
  fullscreen: { surfaceId: string; previous: DockedPlacement | FloatingPlacement } | null;
  /** Preferred region sizes (px): inline for start/end, block for bottom. */
  sizes: Record<WorkbenchRegion, number | null>;
  collapsed: Record<WorkbenchRegion, boolean>;
  surfaceSizes: Record<string, SurfaceSize>;
  /** The region a surface was last docked in — where Dock/Reset returns it. */
  homes: Partial<Record<string, WorkbenchRegion>>;
}

/** Per-surface constraints the caller resolves from the surface registry. */
export interface SurfaceConstraints {
  allowedRegions: readonly WorkbenchRegion[];
  preferredRegion: WorkbenchRegion;
}

export const ANY_REGION: SurfaceConstraints = { allowedRegions: WORKBENCH_REGIONS, preferredRegion: "end" };

/** The built-in Chat surface id. It can be placed anywhere and collapsed,
 *  but never closed. */
export const CHAT_SURFACE_ID = "session";

const emptyRegion = (): RegionState => ({ surfaces: [], active: null });

export function emptyLayout(): WorkbenchLayout {
  return {
    regions: { start: emptyRegion(), primary: emptyRegion(), end: emptyRegion(), bottom: emptyRegion() },
    floating: [],
    fullscreen: null,
    sizes: { start: null, primary: null, end: null, bottom: null },
    collapsed: { start: false, primary: false, end: false, bottom: false },
    surfaceSizes: {},
    homes: {},
  };
}

export function isWorkbenchRegion(value: unknown): value is WorkbenchRegion {
  return typeof value === "string" && (WORKBENCH_REGIONS as readonly string[]).includes(value);
}

export function layoutFromTemplate(template: WorkbenchLayoutTemplate): WorkbenchLayout {
  let layout = emptyLayout();
  for (const entry of template.surfaces) {
    if (entry.presentation === "floating") {
      layout = { ...layout, floating: [...layout.floating.filter((id) => id !== entry.surface), entry.surface] };
      continue;
    }
    if (!isWorkbenchRegion(entry.region) || placementOf(layout, entry.surface) !== null) continue;
    const region = layout.regions[entry.region];
    layout = {
      ...layout,
      regions: {
        ...layout.regions,
        [entry.region]: {
          surfaces: [...region.surfaces, entry.surface],
          active: entry.active || region.active === null ? entry.surface : region.active,
        },
      },
      homes: { ...layout.homes, [entry.surface]: entry.region },
    };
  }
  for (const region of WORKBENCH_REGIONS) {
    const size = template.sizes?.[region];
    if (typeof size === "number" && Number.isFinite(size) && size > 0) layout.sizes[region] = Math.round(size);
    if (template.collapsed?.includes(region)) layout.collapsed[region] = true;
  }
  return layout;
}

// ---- queries ----------------------------------------------------------------------

export function regionOf(layout: WorkbenchLayout, surfaceId: string): WorkbenchRegion | null {
  for (const region of WORKBENCH_REGIONS) {
    if (layout.regions[region].surfaces.includes(surfaceId)) return region;
  }
  return null;
}

export function placementOf(layout: WorkbenchLayout, surfaceId: string): SurfacePlacement | null {
  if (layout.fullscreen?.surfaceId === surfaceId) {
    return { presentation: "fullscreen", previous: layout.fullscreen.previous };
  }
  if (layout.floating.includes(surfaceId)) return { presentation: "floating" };
  const region = regionOf(layout, surfaceId);
  return region === null ? null : { presentation: "docked", region };
}

/** Every placed surface id, docked regions first (start→bottom), then floating, then fullscreen. */
export function placedSurfaces(layout: WorkbenchLayout): string[] {
  const out: string[] = [];
  for (const region of WORKBENCH_REGIONS) out.push(...layout.regions[region].surfaces);
  out.push(...layout.floating);
  if (layout.fullscreen) out.push(layout.fullscreen.surfaceId);
  return out;
}

/** The surface the user is looking at outside the primary region: the
 *  fullscreen layer, else the top floating window, else the active docked
 *  surface of end/bottom/start (in that order). Mirrors the legacy single
 *  package-window notion for compatibility consumers. */
export function focalSurface(layout: WorkbenchLayout): string | null {
  if (layout.fullscreen) return layout.fullscreen.surfaceId;
  if (layout.floating.length > 0) return layout.floating[layout.floating.length - 1]!;
  for (const region of ["end", "bottom", "start"] as const) {
    const active = layout.regions[region].active;
    if (active !== null && !layout.collapsed[region]) return active;
  }
  return null;
}

/** True when the layout is the classic Conversation shape the companion host
 *  renders: Chat alone in primary, nothing in start, and at most one other
 *  surface anywhere (docked end/bottom, floating, or fullscreen). */
export function isCompanionShaped(layout: WorkbenchLayout): boolean {
  const primary = layout.regions.primary.surfaces;
  if (primary.length !== 1 || primary[0] !== CHAT_SURFACE_ID) return false;
  if (layout.regions.start.surfaces.length > 0) return false;
  const others = layout.regions.end.surfaces.length + layout.regions.bottom.surfaces.length
    + layout.floating.length + (layout.fullscreen ? 1 : 0);
  return others <= 1;
}

// ---- helpers ------------------------------------------------------------------------

function withRegion(layout: WorkbenchLayout, region: WorkbenchRegion, next: RegionState): WorkbenchLayout {
  return { ...layout, regions: { ...layout.regions, [region]: next } };
}

/** Remove a surface from wherever it is (no-op when absent). */
export function detachSurface(layout: WorkbenchLayout, surfaceId: string): WorkbenchLayout {
  let next = layout;
  if (next.fullscreen?.surfaceId === surfaceId) next = { ...next, fullscreen: null };
  if (next.floating.includes(surfaceId)) next = { ...next, floating: next.floating.filter((id) => id !== surfaceId) };
  for (const region of WORKBENCH_REGIONS) {
    const state = next.regions[region];
    const index = state.surfaces.indexOf(surfaceId);
    if (index < 0) continue;
    const surfaces = state.surfaces.filter((id) => id !== surfaceId);
    let active = state.active;
    if (active === surfaceId) {
      // Prefer the right neighbour, then the left, mirroring editor tabs.
      active = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
    }
    next = withRegion(next, region, { surfaces, active });
  }
  return next;
}

function dockInto(
  layout: WorkbenchLayout,
  surfaceId: string,
  region: WorkbenchRegion,
  index: number | null,
  activate: boolean,
): WorkbenchLayout {
  const state = layout.regions[region];
  const surfaces = [...state.surfaces];
  const at = index === null ? surfaces.length : Math.max(0, Math.min(index, surfaces.length));
  surfaces.splice(at, 0, surfaceId);
  const active = activate || state.active === null ? surfaceId : state.active;
  return {
    ...withRegion(layout, region, { surfaces, active }),
    collapsed: activate ? { ...layout.collapsed, [region]: false } : layout.collapsed,
    homes: { ...layout.homes, [surfaceId]: region },
  };
}

export function allowedRegion(
  requested: WorkbenchRegion | undefined,
  constraints: SurfaceConstraints,
  home?: WorkbenchRegion,
): WorkbenchRegion | null {
  const allowed = constraints.allowedRegions.length > 0 ? constraints.allowedRegions : WORKBENCH_REGIONS;
  if (requested !== undefined) return allowed.includes(requested) ? requested : null;
  if (home !== undefined && allowed.includes(home)) return home;
  if (allowed.includes(constraints.preferredRegion)) return constraints.preferredRegion;
  return allowed[0] ?? null;
}

// ---- commands ----------------------------------------------------------------------

export interface OpenOptions {
  region?: WorkbenchRegion;
  presentation?: WorkbenchPresentation;
  activate?: boolean;
}

/** Open (or re-activate) a surface. An already-placed surface is activated
 *  in place unless a different presentation/region is explicitly requested. */
export function openSurface(
  layout: WorkbenchLayout,
  surfaceId: string,
  options: OpenOptions,
  constraints: SurfaceConstraints = ANY_REGION,
): WorkbenchLayout {
  const activate = options.activate !== false;
  const current = placementOf(layout, surfaceId);
  if (current !== null) {
    const wantsMove = options.region !== undefined
      && (current.presentation !== "docked" || current.region !== options.region);
    const wantsPresentation = options.presentation !== undefined && options.presentation !== current.presentation;
    if (wantsMove && options.presentation !== "floating" && options.presentation !== "fullscreen") {
      return moveSurface(layout, surfaceId, options.region!, constraints);
    }
    if (wantsPresentation) return setPresentation(layout, surfaceId, options.presentation!, constraints);
    return activate ? activateSurface(layout, surfaceId) : layout;
  }
  const presentation = options.presentation ?? "docked";
  if (presentation === "floating") {
    return { ...layout, floating: [...layout.floating, surfaceId] };
  }
  const region = allowedRegion(options.region, constraints, layout.homes[surfaceId]);
  if (region === null) return layout;
  const docked = dockInto(layout, surfaceId, region, null, activate);
  if (presentation === "fullscreen") {
    return enterFullscreen(docked, surfaceId);
  }
  return docked;
}

export function closeSurface(layout: WorkbenchLayout, surfaceId: string): WorkbenchLayout {
  return placementOf(layout, surfaceId) === null ? layout : detachSurface(layout, surfaceId);
}

/** Make a docked surface its region's active tab, or bring a floating window
 *  to the front. Also un-collapses the region so the surface is visible. */
export function activateSurface(layout: WorkbenchLayout, surfaceId: string): WorkbenchLayout {
  const placement = placementOf(layout, surfaceId);
  if (placement === null) return layout;
  if (placement.presentation === "floating") {
    if (layout.floating[layout.floating.length - 1] === surfaceId) return layout;
    return { ...layout, floating: [...layout.floating.filter((id) => id !== surfaceId), surfaceId] };
  }
  if (placement.presentation === "fullscreen") return layout;
  const state = layout.regions[placement.region];
  if (state.active === surfaceId && !layout.collapsed[placement.region]) return layout;
  return {
    ...withRegion(layout, placement.region, { ...state, active: surfaceId }),
    collapsed: { ...layout.collapsed, [placement.region]: false },
  };
}

export function setActive(layout: WorkbenchLayout, region: WorkbenchRegion, surfaceId: string): WorkbenchLayout {
  const state = layout.regions[region];
  if (!state.surfaces.includes(surfaceId) || state.active === surfaceId) return layout;
  return withRegion(layout, region, { ...state, active: surfaceId });
}

/** Dock a surface into `region` (from anywhere). Fullscreen/floating end. */
export function moveSurface(
  layout: WorkbenchLayout,
  surfaceId: string,
  region: WorkbenchRegion,
  constraints: SurfaceConstraints = ANY_REGION,
): WorkbenchLayout {
  if (allowedRegion(region, constraints) === null) return layout;
  const current = placementOf(layout, surfaceId);
  if (current?.presentation === "docked" && current.region === region) return activateSurface(layout, surfaceId);
  return dockInto(detachSurface(layout, surfaceId), surfaceId, region, null, true);
}

/** Reorder a docked surface inside its region (tab drag). */
export function reorderSurface(layout: WorkbenchLayout, surfaceId: string, index: number): WorkbenchLayout {
  const region = regionOf(layout, surfaceId);
  if (region === null) return layout;
  const state = layout.regions[region];
  const from = state.surfaces.indexOf(surfaceId);
  const to = Math.max(0, Math.min(index, state.surfaces.length - 1));
  if (from === to) return layout;
  const surfaces = [...state.surfaces];
  surfaces.splice(from, 1);
  surfaces.splice(to, 0, surfaceId);
  return withRegion(layout, region, { ...state, surfaces });
}

/** Exchange two surfaces' placements. Docked↔docked swaps region, index, and
 *  active flags; docked↔floating hands the docked slot to the floating one.
 *  Anything involving fullscreen is a no-op — leave fullscreen first. */
export function swapSurfaces(layout: WorkbenchLayout, a: string, b: string): WorkbenchLayout {
  if (a === b) return layout;
  const pa = placementOf(layout, a);
  const pb = placementOf(layout, b);
  if (pa === null || pb === null || pa.presentation === "fullscreen" || pb.presentation === "fullscreen") return layout;
  const slotOf = (id: string, placement: SurfacePlacement) => {
    if (placement.presentation !== "docked") return null;
    const state = layout.regions[placement.region];
    return { region: placement.region, index: state.surfaces.indexOf(id), active: state.active === id };
  };
  const slotA = slotOf(a, pa);
  const slotB = slotOf(b, pb);
  let next = detachSurface(detachSurface(layout, a), b);
  const place = (id: string, slot: ReturnType<typeof slotOf>) => {
    if (slot === null) {
      next = { ...next, floating: [...next.floating, id] };
      return;
    }
    next = dockInto(next, id, slot.region, slot.index, slot.active);
  };
  // Re-dock in ascending index order so both indices land where they were.
  const pairs: Array<[string, ReturnType<typeof slotOf>]> = [[a, slotB], [b, slotA]];
  pairs.sort((x, y) => (x[1]?.index ?? Number.MAX_SAFE_INTEGER) - (y[1]?.index ?? Number.MAX_SAFE_INTEGER));
  for (const [id, slot] of pairs) place(id, slot);
  return next;
}

/** Put `surfaceId` in the primary region, exchanging it with the current
 *  primary surface when both are docked (the classic "Make primary"). */
export function makePrimary(layout: WorkbenchLayout, surfaceId: string, constraints: SurfaceConstraints = ANY_REGION): WorkbenchLayout {
  const current = placementOf(layout, surfaceId);
  if (current?.presentation === "docked" && current.region === "primary") return activateSurface(layout, surfaceId);
  const primaryActive = layout.regions.primary.active;
  if (current?.presentation === "docked" && primaryActive !== null) {
    return swapSurfaces(layout, surfaceId, primaryActive);
  }
  return moveSurface(layout, surfaceId, "primary", constraints);
}

function enterFullscreen(layout: WorkbenchLayout, surfaceId: string): WorkbenchLayout {
  const current = placementOf(layout, surfaceId);
  if (current === null || current.presentation === "fullscreen") return layout;
  // Only one fullscreen layer: an existing one returns home first.
  const base = layout.fullscreen ? exitFullscreen(layout) : layout;
  const previous: DockedPlacement | FloatingPlacement = placementOf(base, surfaceId) as DockedPlacement | FloatingPlacement;
  // Keep the docked tab registered (hidden) so its region order survives; the
  // renderer shows the fullscreen layer and makes siblings inert.
  return { ...base, fullscreen: { surfaceId, previous } };
}

/** Leave fullscreen, restoring the exact previous placement. */
export function exitFullscreen(layout: WorkbenchLayout): WorkbenchLayout {
  if (layout.fullscreen === null) return layout;
  const { surfaceId, previous } = layout.fullscreen;
  const cleared = { ...layout, fullscreen: null };
  if (previous.presentation === "floating") {
    if (cleared.floating.includes(surfaceId)) return cleared;
    return { ...cleared, floating: [...cleared.floating, surfaceId] };
  }
  if (regionOf(cleared, surfaceId) === previous.region) return activateSurface(cleared, surfaceId);
  return dockInto(detachSurface(cleared, surfaceId), surfaceId, previous.region, null, true);
}

export function setPresentation(
  layout: WorkbenchLayout,
  surfaceId: string,
  presentation: WorkbenchPresentation,
  constraints: SurfaceConstraints = ANY_REGION,
): WorkbenchLayout {
  const current = placementOf(layout, surfaceId);
  if (current === null) return layout;
  if (current.presentation === presentation) return layout;
  if (presentation === "fullscreen") return enterFullscreen(layout, surfaceId);
  if (current.presentation === "fullscreen") {
    const restored = exitFullscreen(layout);
    const after = placementOf(restored, surfaceId);
    return after?.presentation === presentation ? restored : setPresentation(restored, surfaceId, presentation, constraints);
  }
  if (presentation === "floating") {
    return { ...detachSurface(layout, surfaceId), floating: [...layout.floating, surfaceId] };
  }
  const region = allowedRegion(undefined, constraints, layout.homes[surfaceId]);
  if (region === null) return layout;
  return dockInto(detachSurface(layout, surfaceId), surfaceId, region, null, true);
}

export function setCollapsed(layout: WorkbenchLayout, region: WorkbenchRegion, collapsed: boolean): WorkbenchLayout {
  if (layout.collapsed[region] === collapsed) return layout;
  return { ...layout, collapsed: { ...layout.collapsed, [region]: collapsed } };
}

const SIZE_MIN = 80;
const SIZE_MAX = 8192;

const saneSize = (value: number): boolean => Number.isFinite(value) && value >= SIZE_MIN && value <= SIZE_MAX;

export function resizeRegion(layout: WorkbenchLayout, region: WorkbenchRegion, size: number | null): WorkbenchLayout {
  const next = size === null ? null : saneSize(size) ? Math.round(size) : layout.sizes[region];
  if (layout.sizes[region] === next) return layout;
  return { ...layout, sizes: { ...layout.sizes, [region]: next } };
}

export function resizeSurface(layout: WorkbenchLayout, surfaceId: string, patch: SurfaceSize): WorkbenchLayout {
  const current = layout.surfaceSizes[surfaceId] ?? {};
  const next: SurfaceSize = { ...current };
  let changed = false;
  for (const key of ["inline", "block", "dockBlock"] as const) {
    const value = patch[key];
    if (value === undefined || !saneSize(value)) continue;
    const rounded = Math.round(value);
    if (next[key] !== rounded) {
      next[key] = rounded;
      changed = true;
    }
  }
  if (!changed) return layout;
  return { ...layout, surfaceSizes: { ...layout.surfaceSizes, [surfaceId]: next } };
}

/** Restore-time rule: floating windows are transient and close; a fullscreen
 *  surface returns to its previous docked placement (or closes when it was
 *  floating). Docked surfaces — including collapsed regions — survive. */
export function withoutTransient(layout: WorkbenchLayout): WorkbenchLayout {
  let next = layout.fullscreen ? exitFullscreen(layout) : layout;
  if (next.floating.length > 0) next = { ...next, floating: [] };
  return next;
}

/** Session-boundary rule: floating windows close, fullscreen returns to its
 *  docked home or closes. Docked surfaces are the shared companions. */
export function closeTransient(layout: WorkbenchLayout, keep: (surfaceId: string) => boolean = () => false): WorkbenchLayout {
  let next = layout;
  if (next.fullscreen && !keep(next.fullscreen.surfaceId)) {
    next = next.fullscreen.previous.presentation === "floating"
      ? detachSurface(next, next.fullscreen.surfaceId)
      : exitFullscreen(next);
  }
  const floating = next.floating.filter(keep);
  if (floating.length !== next.floating.length) next = { ...next, floating };
  return next;
}

/** Reset geometry and placement of one surface to the template's intent while
 *  keeping everything else. Returns the layout unchanged when the template
 *  does not mention the surface. */
export function resetSurfacePosition(
  layout: WorkbenchLayout,
  surfaceId: string,
  template: WorkbenchLayoutTemplate,
): WorkbenchLayout {
  const entry = template.surfaces.find((candidate) => candidate.surface === surfaceId);
  if (!entry) return layout;
  const detached = detachSurface(layout, surfaceId);
  const sizes = { ...detached.surfaceSizes };
  delete sizes[surfaceId];
  const base = { ...detached, surfaceSizes: sizes };
  if (entry.presentation === "floating") return { ...base, floating: [...base.floating, surfaceId] };
  return dockInto(base, surfaceId, entry.region, null, true);
}

// ---- persistence shape --------------------------------------------------------------

const MAX_SURFACES = 64;

/** Parse a persisted layout: unknown fields ignored, malformed parts dropped,
 *  duplicates removed, sizes sanity-checked. Never throws. */
export function parseLayout(raw: unknown): WorkbenchLayout {
  const layout = emptyLayout();
  if (typeof raw !== "object" || raw === null) return layout;
  const data = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const take = (id: unknown): string | null => {
    if (typeof id !== "string" || id === "" || seen.has(id) || seen.size >= MAX_SURFACES) return null;
    seen.add(id);
    return id;
  };
  const regions = typeof data.regions === "object" && data.regions !== null
    ? data.regions as Record<string, unknown>
    : {};
  for (const region of WORKBENCH_REGIONS) {
    const state = regions[region];
    if (typeof state !== "object" || state === null) continue;
    const { surfaces, active } = state as { surfaces?: unknown; active?: unknown };
    const ids = Array.isArray(surfaces) ? surfaces.map(take).filter((id): id is string => id !== null) : [];
    layout.regions[region] = {
      surfaces: ids,
      active: typeof active === "string" && ids.includes(active) ? active : ids[0] ?? null,
    };
  }
  if (Array.isArray(data.floating)) {
    layout.floating = data.floating.map(take).filter((id): id is string => id !== null);
  }
  const fullscreen = data.fullscreen as { surfaceId?: unknown; previous?: unknown } | null | undefined;
  if (fullscreen && typeof fullscreen === "object" && typeof fullscreen.surfaceId === "string") {
    const previous = fullscreen.previous as { presentation?: unknown; region?: unknown } | undefined;
    const prev: DockedPlacement | FloatingPlacement = previous?.presentation === "floating"
      ? { presentation: "floating" }
      : { presentation: "docked", region: isWorkbenchRegion(previous?.region) ? previous!.region : "end" };
    const id = fullscreen.surfaceId;
    if (seen.has(id) || take(id) !== null) layout.fullscreen = { surfaceId: id, previous: prev };
  }
  const sizes = typeof data.sizes === "object" && data.sizes !== null ? data.sizes as Record<string, unknown> : {};
  const collapsed = typeof data.collapsed === "object" && data.collapsed !== null ? data.collapsed as Record<string, unknown> : {};
  for (const region of WORKBENCH_REGIONS) {
    const size = sizes[region];
    if (typeof size === "number" && saneSize(size)) layout.sizes[region] = Math.round(size);
    if (collapsed[region] === true) layout.collapsed[region] = true;
  }
  const surfaceSizes = typeof data.surfaceSizes === "object" && data.surfaceSizes !== null
    ? data.surfaceSizes as Record<string, unknown>
    : {};
  for (const [id, value] of Object.entries(surfaceSizes).slice(0, MAX_SURFACES)) {
    if (!id || typeof value !== "object" || value === null) continue;
    const size: SurfaceSize = {};
    for (const key of ["inline", "block", "dockBlock"] as const) {
      const n = (value as Record<string, unknown>)[key];
      if (typeof n === "number" && saneSize(n)) size[key] = Math.round(n);
    }
    if (Object.keys(size).length > 0) layout.surfaceSizes[id] = size;
  }
  const homes = typeof data.homes === "object" && data.homes !== null ? data.homes as Record<string, unknown> : {};
  for (const [id, region] of Object.entries(homes).slice(0, MAX_SURFACES)) {
    if (id && isWorkbenchRegion(region)) layout.homes[id] = region;
  }
  return layout;
}
