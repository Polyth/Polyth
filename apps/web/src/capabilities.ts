// One capability model. This is a navigation-metadata registry —
// it owns labels, keywords, tier/rank resolution, and open commands only. It
// is NOT a component host: the workspace and right-surface registries keep
// rendering and lifecycle ownership, and a descriptor confers no filesystem,
// process, credential, project, or session authority.
//
// Header, right rail, compact navigation, command search, shortcuts, and
// Settings all consume the same resolved list, so they can never disagree
// about whether a capability exists. Per-project placement changes only tier
// and rank; `available()` remains a runtime property.
import { useSyncExternalStore } from "react";
import {
  getCapabilityPlacements, resolvePlacements, subscribeCapabilityLayout,
  type CapabilityTier, type ResolvedPlacement, type PlacementOverride,
} from "./capabilityLayout.ts";
import { tr } from "./i18n/index.ts";

export interface CapabilityDescriptor {
  id: string;
  label: string;
  plainDescription: string;
  technicalLabel?: string;
  keywords: string[];
  standardTier: CapabilityTier;
  standardRank: number;
  open: () => void;
  available: () => boolean;
  unavailableReason?: () => string | null;
}

// ---- built-in navigation metadata (pure, testable without a DOM) -------------

export interface CapabilityMeta {
  id: string;
  label: string;
  plainDescription: string;
  technicalLabel?: string;
  keywords: string[];
  standardTier: CapabilityTier;
  standardRank: number;
}

/** The standard arrangement: primary = Chat; Project files; Preview;
 *  Goals & progress. Frequently used tools live in More, while advanced
 *  configuration stays under Technical options — placed, never filtered out.
 *  Old searchable names (Git, Multi-Run, Fusion, plugin, …) stay as keywords
 *  so existing users are not stranded. */
export const BUILTIN_CAPABILITY_META: CapabilityMeta[] = [
  { id: "session", label: tr("capabilities.chat"), plainDescription: tr("capabilities.talkWithPolythAboutYourProject"), keywords: ["session", "conversation", "chat"], standardTier: "primary", standardRank: 0 },
  { id: "context", label: tr("capabilities.context"), plainDescription: tr("capabilities.whatPolythIsCurrentlyLookingAt"), keywords: ["context", "pinned", "session status"], standardTier: "more", standardRank: 18 },
  { id: "events", label: tr("capabilities.eventLog"), plainDescription: tr("capabilities.theRawRecordOfEverythingInA"), keywords: ["events", "log", "debug"], standardTier: "technical", standardRank: 33 },
];

// ---- plain-language disclosure groups -----------------------------------------

export const TECHNICAL_GROUP_LABEL = tr("capabilities.technicalOptions");

const GROUP_OF: Record<string, string> = {
  files: tr("capabilities.workWithTheProject"),
  browser: tr("capabilities.workWithTheProject"),
  goals: tr("capabilities.workWithTheProject"),
  knowledge: tr("capabilities.workWithTheProject"),
  context: tr("capabilities.workWithTheProject"),
  voice: tr("capabilities.workWithTheProject"),
  usage: tr("capabilities.planAndReview"),
  schedule: tr("capabilities.planAndReview"),
  walkthrough: tr("capabilities.planAndReview"),
  github: tr("capabilities.planAndReview"),
  multirun: tr("capabilities.compareAndRefine"),
  workflow: tr("capabilities.compareAndRefine"),
  fusion: tr("capabilities.compareAndRefine"),
  git: TECHNICAL_GROUP_LABEL,
  terminal: TECHNICAL_GROUP_LABEL,
  "models-agents": TECHNICAL_GROUP_LABEL,
  events: TECHNICAL_GROUP_LABEL,
  diagnostics: TECHNICAL_GROUP_LABEL,
};

/** Dynamically registered extensions default to the generic More tools group
 *  (and the `more` tier) and are searchable immediately. */
export function capabilityGroup(id: string): string {
  return GROUP_OF[id] ?? tr("capabilitymenu.moreTools");
}

export const GROUP_ORDER = [
  tr("capabilities.workWithTheProject"),
  tr("capabilities.planAndReview"),
  tr("capabilities.compareAndRefine"),
  tr("capabilitymenu.moreTools"),
  TECHNICAL_GROUP_LABEL,
];

// ---- registry -------------------------------------------------------------------

const registry = new Map<string, CapabilityDescriptor>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of [...listeners]) l();
}

/** Register (or replace by id — disposal is by identity, matching the surface
 *  registry contract). Returns an unregister function. */
export function registerCapability(descriptor: CapabilityDescriptor): () => void {
  registry.set(descriptor.id, descriptor);
  bump();
  return () => {
    if (registry.get(descriptor.id) === descriptor) {
      registry.delete(descriptor.id);
      bump();
    }
  };
}

export function listCapabilities(): CapabilityDescriptor[] {
  return [...registry.values()];
}

export function getCapability(id: string): CapabilityDescriptor | null {
  return registry.get(id) ?? null;
}

export function subscribeCapabilities(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useCapabilityVersion(): number {
  return useSyncExternalStore(subscribeCapabilities, () => version);
}

// ---- resolution ------------------------------------------------------------------

export interface ResolvedCapability {
  descriptor: CapabilityDescriptor;
  tier: CapabilityTier;
  rank: number;
}

/** Pure: resolve descriptors against explicit per-project overrides. */
export function resolveCapabilities(
  descriptors: readonly CapabilityDescriptor[],
  overrides: Record<string, PlacementOverride> = {},
): ResolvedCapability[] {
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  const placements: ResolvedPlacement[] = resolvePlacements(
    descriptors.map((d) => ({ id: d.id, standardTier: d.standardTier, standardRank: d.standardRank })),
    overrides,
  );
  return placements.map((p) => ({ descriptor: byId.get(p.id)!, tier: p.tier, rank: p.rank }));
}

/** The single resolved list every navigation surface consumes. */
export function currentResolvedCapabilities(): ResolvedCapability[] {
  return resolveCapabilities(listCapabilities(), getCapabilityPlacements());
}

/** React hook: re-render on registry or active-project placement changes. */
export function useResolvedCapabilities(): ResolvedCapability[] {
  useCapabilityVersion();
  useSyncExternalStore(subscribeCapabilityLayout, getCapabilityPlacements);
  return currentResolvedCapabilities();
}

// ---- extension seam -----------------------------------------------------------

export interface PolythCapabilitiesApi {
  registerCapability: typeof registerCapability;
  listCapabilities: typeof listCapabilities;
}

declare global {
  interface Window {
    __polythCapabilities?: PolythCapabilitiesApi;
  }
}

/** Managed extensions register navigation capabilities dynamically (like
 *  window.__polythSurfaces for panels). A registered capability appears in
 *  More tools and command search immediately, defaulting to the `more` tier. */
export function exposeCapabilities(): void {
  if (typeof window !== "undefined") {
    window.__polythCapabilities = { registerCapability, listCapabilities };
  }
}
