import { useSyncExternalStore } from "react";
import { getState, subscribeStore } from "./store.ts";

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
}

export const CAPABILITY_LAYOUT_KEY = "polyth.capabilityLayout.v1";
export const capabilityLayoutStorageKey = (projectId: string): string =>
  `${CAPABILITY_LAYOUT_KEY}.${projectId}`;
export const MAX_PLACEMENT_OVERRIDES = 128;

const EMPTY_LAYOUT: CapabilityLayoutRecord = { version: 1, placements: {} };
const TIER_ORDER: Record<CapabilityTier, number> = { primary: 0, more: 1, technical: 2 };

const isTier = (value: unknown): value is CapabilityTier =>
  value === "primary" || value === "more" || value === "technical";

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
    return { version: 1, placements };
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

export function getCapabilityPlacements(): Record<string, PlacementOverride> {
  return state.placements;
}

export function subscribeCapabilityLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
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
  state = { version: 1, placements };
  write(activeProjectId, state);
  emit();
}

/** Persist one complete visual order. Items may come from another tier, which
 * makes dropping between the top and right rails a move rather than a copy. */
export function setCapabilityTierOrder(tier: CapabilityTier, ids: readonly string[]): void {
  const placements = { ...state.placements };
  for (const [rank, id] of [...new Set(ids)].entries()) {
    if (!(id in placements) && Object.keys(placements).length >= MAX_PLACEMENT_OVERRIDES) break;
    placements[id] = { tier, rank };
  }
  state = { version: 1, placements };
  write(activeProjectId, state);
  emit();
}

export function useCapabilityPlacements(): Record<string, PlacementOverride> {
  return useSyncExternalStore(subscribeCapabilityLayout, getCapabilityPlacements);
}
