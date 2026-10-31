import { useSyncExternalStore } from "react";
import { getState, subscribeStore } from "./store.ts";
import {
  markProjectPresentationChanged,
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  projectPresentationEventHasKey,
  projectPresentationEventProjectId,
} from "./projectPresentationSync.ts";
import { presentationScopeId } from "./projectInterfaceScope.ts";

export type CapabilityTier = "primary" | "more" | "technical";

export interface PlacementOverride {
  tier: CapabilityTier;
  rank: number;
}

export interface CapabilityPlacementInput {
  id: string;
  standardTier: CapabilityTier;
  standardRank: number;
}

export interface ResolvedPlacement {
  id: string;
  tier: CapabilityTier;
  rank: number;
}

interface CapabilityLayoutRecord {
  version: 1;
  placements: Record<string, PlacementOverride>;
  /** Capabilities this project has already received. Anything not listed is a
   * new arrival (a package installed or enabled since) and is placed once by
   * direction; it is never re-placed after the user moves it. Absent on
   * records written before arrivals were tracked. */
  seen?: Record<string, true>;
  /** Version of the default arrangement this project was seeded with, kept
   * only while the person has not rearranged it. A record without it and
   * without placements has never been arranged (a new project, or one whose
   * layout was reset) and receives the default plan. */
  defaults?: number;
  /** The person's own order of each tier rail, mixing capability launchers,
   * placed widgets (`widget:<instanceId>`) and panel buttons. Only sequences
   * items; membership stays with tiers and widget placements. Absent until
   * the first rearrangement: the rail's current visual order applies. */
  railOrder?: RailOrders;
  /** The header's view tabs (Chat, Canvas, workbench profiles): the person's
   * order and the tabs they hid. Canvas and optional profiles keep their own
   * per-project offers; `hidden` covers the always-offered ones. Absent until
   * the first change. */
  viewTabs?: ViewTabLayout;
}

export interface ViewTabLayout {
  order?: string[];
  hidden?: string[];
}
export const MAX_VIEW_TABS = 64;

/** The two tier rails whose mixed order is kept here (the header rail's
 * order is its widget placement order). */
export type TierRailZone = "top" | "right";
export type RailOrders = Partial<Record<TierRailZone, string[]>>;
export const MAX_RAIL_ORDER = 256;

/** Bump to re-seed every project that still has no explicit placements. */
export const DEFAULT_CAPABILITY_LAYOUT_VERSION = 1;

export interface CapabilityArrival {
  id: string;
  /** Where the capability starts in this project, or null to keep its
   * standard tier without recording a placement. */
  placement: PlacementOverride | null;
  /** Previous default tier and the capability's current standard tier/rank:
   * an already-seen, never-placed capability keeps showing on `legacyTier`. */
  legacyTier?: CapabilityTier;
  standardTier?: CapabilityTier;
  standardRank?: number;
}

export const CAPABILITY_LAYOUT_KEY = "polyth.capabilityLayout.v1";
/** Resolves to the shared record while every project shares one interface. */
export const capabilityLayoutStorageKey = (projectId: string): string =>
  `${CAPABILITY_LAYOUT_KEY}.${presentationScopeId(projectId)}`;
export const MAX_PLACEMENT_OVERRIDES = 128;
export const MAX_SEEN_CAPABILITIES = 512;

const EMPTY_LAYOUT: CapabilityLayoutRecord = { version: 1, placements: {} };
const TIER_ORDER: Record<CapabilityTier, number> = { primary: 0, more: 1, technical: 2 };

const isTier = (value: unknown): value is CapabilityTier =>
  value === "primary" || value === "more" || value === "technical";

function parseRailOrder(value: unknown): { railOrder?: RailOrders } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const railOrder: RailOrders = {};
  for (const zone of ["top", "right"] as const) {
    const ids = (value as Record<string, unknown>)[zone];
    if (!Array.isArray(ids)) continue;
    railOrder[zone] = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))]
      .slice(0, MAX_RAIL_ORDER);
  }
  return Object.keys(railOrder).length > 0 ? { railOrder } : {};
}

function parseIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))]
    .slice(0, MAX_VIEW_TABS);
}

function parseViewTabs(value: unknown): { viewTabs?: ViewTabLayout } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const order = parseIds((value as Record<string, unknown>).order);
  const hidden = parseIds((value as Record<string, unknown>).hidden);
  const viewTabs: ViewTabLayout = { ...(order ? { order } : {}), ...(hidden ? { hidden } : {}) };
  return Object.keys(viewTabs).length > 0 ? { viewTabs } : {};
}

export function parseCapabilityLayout(raw: string | null): CapabilityLayoutRecord {
  try {
    const data = JSON.parse(raw ?? "") as Partial<CapabilityLayoutRecord>;
    if (!data || data.version !== 1 || !data.placements || typeof data.placements !== "object") {
      return { ...EMPTY_LAYOUT, placements: {} };
    }
    const placements: Record<string, PlacementOverride> = {};
    for (const [id, value] of Object.entries(data.placements)) {
      if (Object.keys(placements).length >= MAX_PLACEMENT_OVERRIDES) break;
      const placement = value as Partial<PlacementOverride> | undefined;
      if (
        placement
        && isTier(placement.tier)
        && typeof placement.rank === "number"
        && Number.isFinite(placement.rank)
      ) {
        placements[id] = { tier: placement.tier, rank: placement.rank };
      }
    }
    const defaults = {
      ...(typeof data.defaults === "number" && Number.isInteger(data.defaults) && data.defaults > 0
        ? { defaults: data.defaults }
        : {}),
      ...parseRailOrder(data.railOrder),
      ...parseViewTabs(data.viewTabs),
    };
    if (!data.seen || typeof data.seen !== "object" || Array.isArray(data.seen)) return { version: 1, placements, ...defaults };
    const seen: Record<string, true> = {};
    for (const [id, value] of Object.entries(data.seen).slice(0, MAX_SEEN_CAPABILITIES)) {
      if (value === true && id) seen[id] = true;
    }
    return { version: 1, placements, seen, ...defaults };
  } catch {
    return { ...EMPTY_LAYOUT, placements: {} };
  }
}

export function resolvePlacements(
  capabilities: readonly CapabilityPlacementInput[],
  overrides: Record<string, PlacementOverride> = {},
): ResolvedPlacement[] {
  const resolved = capabilities.map((capability): ResolvedPlacement => {
    const override = overrides[capability.id];
    return override
      ? { id: capability.id, tier: override.tier, rank: override.rank }
      : {
          id: capability.id,
          tier: capability.standardTier,
          rank: capability.standardRank,
        };
  });
  resolved.sort((a, b) =>
    TIER_ORDER[a.tier] - TIER_ORDER[b.tier]
    || a.rank - b.rank
    || a.id.localeCompare(b.id));
  return resolved;
}

export function moveCapabilityBefore(
  ordered: readonly string[], draggedId: string, targetId: string,
): string[] {
  if (draggedId === targetId || !ordered.includes(targetId)) return [...ordered];
  const next = ordered.filter((id) => id !== draggedId);
  next.splice(next.indexOf(targetId), 0, draggedId);
  return next;
}

function read(projectId: string | null): CapabilityLayoutRecord {
  if (projectId === null) return { ...EMPTY_LAYOUT, placements: {} };
  try {
    return parseCapabilityLayout(localStorage.getItem(capabilityLayoutStorageKey(projectId)));
  } catch {
    return { ...EMPTY_LAYOUT, placements: {} };
  }
}

function write(projectId: string | null, layout: CapabilityLayoutRecord): void {
  if (projectId === null) return;
  try {
    localStorage.setItem(capabilityLayoutStorageKey(projectId), JSON.stringify(layout));
    markProjectPresentationChanged(projectId, "capabilityLayout");
  } catch {
    // Browser storage may be unavailable; keep the current in-memory layout.
  }
}

let activeProjectId = getState().activeProjectId;
let state = read(activeProjectId);
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

subscribeStore(() => {
  const nextProjectId = getState().activeProjectId;
  if (nextProjectId === activeProjectId) return;
  activeProjectId = nextProjectId;
  state = read(activeProjectId);
  emit();
});

if (typeof window !== "undefined") {
  window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, (event) => {
    const hydratedProjectId = projectPresentationEventProjectId(event);
    if (hydratedProjectId === null || hydratedProjectId !== activeProjectId || !projectPresentationEventHasKey(event, "capabilityLayout")) return;
    state = read(activeProjectId);
    emit();
  });
}

export function getCapabilityPlacements(): Record<string, PlacementOverride> {
  return state.placements;
}

export function subscribeCapabilityLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function boundedPlacements(placements: Record<string, PlacementOverride>): Record<string, PlacementOverride> {
  const next: Record<string, PlacementOverride> = {};
  for (const [id, placement] of Object.entries(placements)) {
    if (Object.keys(next).length >= MAX_PLACEMENT_OVERRIDES) break;
    if (!isTier(placement.tier) || !Number.isFinite(placement.rank)) continue;
    next[id] = { tier: placement.tier, rank: placement.rank };
  }
  return next;
}

/** Has this project never been arranged (new, or its layout was reset)? */
export function needsDefaultCapabilityLayout(projectId: string): boolean {
  return projectId === activeProjectId
    && state.defaults === undefined
    && Object.keys(state.placements).length === 0;
}

/** Seed a project's navigation with its default arrangement. A project the
 * person has rearranged is never touched. Without `replace` an already
 * arranged project is kept too; project creation passes `replace` because the
 * chosen directions are authoritative over a default arrangement made while
 * the project was being set up. */
export function seedCapabilityLayoutForProject(
  projectId: string,
  placements: Record<string, PlacementOverride>,
  options: { replace?: boolean } = {},
): boolean {
  if (projectId !== activeProjectId) return false;
  const untouchedDefaults = state.defaults !== undefined;
  if (!needsDefaultCapabilityLayout(projectId) && !(options.replace && untouchedDefaults)) return false;
  const next = boundedPlacements(placements);
  if (Object.keys(next).length === 0) return false;

  state = { ...state, version: 1, placements: next, defaults: DEFAULT_CAPABILITY_LAYOUT_VERSION };
  write(projectId, state);
  emit();
  return true;
}

/** A person's own arrangement: it no longer counts as the default one. */
function rearranged(
  placements: Record<string, PlacementOverride>,
  railOrder: RailOrders | undefined = state.railOrder,
): CapabilityLayoutRecord {
  return {
    version: 1,
    placements,
    ...(state.seen ? { seen: state.seen } : {}),
    ...(railOrder ? { railOrder } : {}),
    ...(state.viewTabs ? { viewTabs: state.viewTabs } : {}),
  };
}

export function setPlacementOverride(id: string, placement: PlacementOverride | null): void {
  const placements = { ...state.placements };
  if (placement === null) {
    delete placements[id];
  } else if (id in placements || Object.keys(placements).length < MAX_PLACEMENT_OVERRIDES) {
    placements[id] = placement;
  } else {
    return;
  }
  state = rearranged(placements);
  write(activeProjectId, state);
  emit();
}

/** Persist one complete visual order. Items may come from another tier, which
 * makes dropping between the top and right rails a move rather than a copy.
 * `rail` also stores that rail's whole mixed order (launchers, widgets and
 * panels exactly as dropped); its ids leave the other rail's order. */
export function setCapabilityTierOrder(
  tier: CapabilityTier,
  ids: readonly string[],
  rail?: { zone: TierRailZone; order: readonly string[] },
): void {
  const placements = { ...state.placements };
  for (const [rank, id] of [...new Set(ids)].entries()) {
    if (!(id in placements) && Object.keys(placements).length >= MAX_PLACEMENT_OVERRIDES) break;
    placements[id] = { tier, rank };
  }
  let railOrder = state.railOrder;
  if (rail) {
    const order = [...new Set(rail.order)].slice(0, MAX_RAIL_ORDER);
    const moved = new Set(order);
    const other: TierRailZone = rail.zone === "top" ? "right" : "top";
    railOrder = {
      ...railOrder,
      [rail.zone]: order,
      ...(railOrder?.[other] ? { [other]: railOrder[other]!.filter((id) => !moved.has(id)) } : {}),
    };
  }
  state = rearranged(placements, railOrder);
  write(activeProjectId, state);
  emit();
}

/** Record the capabilities currently available in `projectId`. A project
 * that was never arranged receives `seed()` — its complete default
 * arrangement — first. Otherwise the first record only establishes the
 * baseline: whatever a project already shows stays as it is. Afterwards a
 * capability that arrives (its package was installed, enabled or became
 * relevant) takes the arrival's placement, decided by the same per-project
 * plan. Explicit placements win. */
export function recordCapabilityArrivals(
  projectId: string,
  capabilities: readonly CapabilityArrival[],
  seed?: () => Record<string, PlacementOverride>,
): boolean {
  if (projectId !== activeProjectId) return false;
  const seeded = seed !== undefined && needsDefaultCapabilityLayout(projectId);
  const previous = seeded ? undefined : state.seen;
  const fresh = capabilities.filter((capability) => previous?.[capability.id] !== true);
  const placements = seeded ? boundedPlacements(seed()) : { ...state.placements };
  // Migration: a capability whose default tier changed (`legacyStandardTier`)
  // that this project already saw without an explicit placement was showing on
  // its old default, so pin that tier instead of letting it silently move.
  let migrated = false;
  if (previous !== undefined) {
    for (const capability of capabilities) {
      const { legacyTier, standardTier } = capability;
      if (previous[capability.id] !== true || capability.id in placements) continue;
      if (!legacyTier || legacyTier === standardTier) continue;
      if (Object.keys(placements).length >= MAX_PLACEMENT_OVERRIDES) break;
      placements[capability.id] = { tier: legacyTier, rank: capability.standardRank ?? 0 };
      migrated = true;
    }
  }
  if (fresh.length === 0 && !migrated) return false;
  const seen: Record<string, true> = { ...previous };
  for (const capability of fresh) {
    if (Object.keys(seen).length >= MAX_SEEN_CAPABILITIES) break;
    seen[capability.id] = true;
    if (seeded || previous === undefined || capability.placement === null) continue;
    if (capability.id in placements) continue;
    if (Object.keys(placements).length >= MAX_PLACEMENT_OVERRIDES) continue;
    placements[capability.id] = { ...capability.placement };
  }
  state = {
    version: 1,
    placements,
    seen,
    ...(seeded ? { defaults: DEFAULT_CAPABILITY_LAYOUT_VERSION } : state.defaults !== undefined ? { defaults: state.defaults } : {}),
    ...(state.railOrder ? { railOrder: state.railOrder } : {}),
    ...(state.viewTabs ? { viewTabs: state.viewTabs } : {}),
  };
  write(projectId, state);
  emit();
  return true;
}

const NO_RAIL_ORDER: RailOrders = {};
export function getRailOrders(): RailOrders {
  return state.railOrder ?? NO_RAIL_ORDER;
}

export function useRailOrders(): RailOrders {
  return useSyncExternalStore(subscribeCapabilityLayout, getRailOrders);
}

export function useCapabilityPlacements(): Record<string, PlacementOverride> {
  return useSyncExternalStore(subscribeCapabilityLayout, getCapabilityPlacements);
}

const NO_VIEW_TABS: ViewTabLayout = {};
export function getViewTabLayout(): ViewTabLayout {
  return state.viewTabs ?? NO_VIEW_TABS;
}

export function useViewTabLayout(): ViewTabLayout {
  return useSyncExternalStore(subscribeCapabilityLayout, getViewTabLayout);
}

/** Persist the header view tabs' order and hidden set. Not a rail
 * rearrangement: the project keeps its default-arrangement marker. */
export function setViewTabLayout(next: ViewTabLayout): void {
  const viewTabs = { ...parseViewTabs(next).viewTabs };
  state = { ...state, viewTabs };
  write(activeProjectId, state);
  emit();
}
