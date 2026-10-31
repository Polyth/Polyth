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
import { useSyncExternalStore, type ComponentType } from "react";
import {
  getCapabilityPlacements, resolvePlacements, subscribeCapabilityLayout,
  type CapabilityTier, type ResolvedPlacement, type PlacementOverride,
} from "./capabilityLayout.ts";
import { tr } from "./i18n/index.ts";
import { assertOwnerCanReplace } from "./packages/ownership.ts";
import type { DefaultRails, ProjectAffinity } from "@polyth/contracts/project-composition";
import { isProjectContributionRelevant, subscribeProjectRelevance } from "./packages/projectRelevance.ts";

export interface CapabilityDescriptor {
  id: string;
  /** Host-bound owner package. Missing means a host/core contribution. */
  ownerPackageId?: string;
  projectAffinity?: ProjectAffinity;
  /** Starting rail per project kind for a freshly arranged project
   * (`projectCompositionPlan.ts`); unlisted kinds start under More. */
  defaultRails?: DefaultRails;
  label: string;
  plainDescription: string;
  technicalLabel?: string;
  keywords: string[];
  standardTier: CapabilityTier;
  /** Previous default tier; see `CapabilityDefinition.legacyStandardTier`. */
  legacyStandardTier?: CapabilityTier;
  standardRank: number;
  /** False keeps an internal destination searchable without a rail launcher. */
  rail?: boolean;
  /** False when the owning package registers its own placeable widget, so the
   * host does not generate a second `capability:<id>` launcher. Defaults true. */
  launcherWidget?: boolean;
  /** `command`: a press acts (no destination, never active, any rail, one
   * launcher per capability rather than per package). */
  kind?: "destination" | "command";
  /** Own rail mark; `railIcons.ts` prefers it over the package mark. */
  icon?: ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;
  open: () => void;
  available: () => boolean;
  unavailableReason?: () => string | null;
}

export const isCommandCapability = (descriptor: Pick<CapabilityDescriptor, "kind"> | null | undefined): boolean =>
  descriptor?.kind === "command";

// ---- built-in navigation metadata (pure, testable without a DOM) -------------

export interface CapabilityMeta {
  id: string;
  label: string;
  plainDescription: string;
  technicalLabel?: string;
  keywords: string[];
  standardTier: CapabilityTier;
  standardRank: number;
  launcherWidget?: boolean;
  defaultRails?: DefaultRails;
}

/** The standard arrangement: primary = Chat; Project files; Preview;
 *  Goals & progress. Frequently used tools live in More, while advanced
 *  configuration stays under Technical options — placed, never filtered out.
 *  Old searchable names (Git, Multi-Run, Fusion, plugin, …) stay as keywords
 *  so existing users are not stranded. */
export const BUILTIN_CAPABILITY_META: CapabilityMeta[] = [
  { id: "session", label: tr("capabilities.chat"), plainDescription: tr("capabilities.talkWithPolythAboutYourProject"), keywords: ["session", "conversation", "chat"], standardTier: "primary", standardRank: 0 },
  { id: "context", label: tr("capabilities.context"), plainDescription: tr("capabilities.whatPolythIsCurrentlyLookingAt"), keywords: ["context", "pinned", "session status"], standardTier: "more", standardRank: 18, defaultRails: {} },
  // The header bell is its own placeable widget, so no generated launcher.
  { id: "notification-centre", label: tr("notificationcentre.notifications"), plainDescription: tr("notificationcentre.openTheNotificationCentreAndSeeUnread"), keywords: ["notifications", "alerts", "inbox", "bell"], standardTier: "more", standardRank: 19, launcherWidget: false, defaultRails: {} },
  { id: "workspace-edit", label: tr("header.editWorkspace"), plainDescription: tr("header.editWorkspaceDescription"), keywords: ["edit", "customize", "workspace layout", "panel placement"], standardTier: "technical", standardRank: 32 },
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
  "workspace-edit": TECHNICAL_GROUP_LABEL,
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

subscribeProjectRelevance(bump);

/** Register (or same-owner replace by id). Cross-owner collisions throw.
 *  Disposal is by identity. */
export function registerCapability(descriptor: CapabilityDescriptor): () => void {
  const existing = registry.get(descriptor.id);
  if (existing) {
    assertOwnerCanReplace({
      registry: "capability",
      id: descriptor.id,
      existingOwner: existing.ownerPackageId,
      nextOwner: descriptor.ownerPackageId,
    });
  }
  registry.set(descriptor.id, descriptor);
  bump();
  return () => {
    if (registry.get(descriptor.id) === descriptor) {
      registry.delete(descriptor.id);
      bump();
    }
  };
}

/** Re-render navigation when a registered capability's `available()` result
 *  changes. The registry only bumps on register/dispose; closures that read
 *  live state need this so Header/rail pick up the new answer. */
export function notifyCapabilities(): void {
  bump();
}

export function listCapabilities(): CapabilityDescriptor[] {
  return [...registry.values()].filter((descriptor) =>
    isProjectContributionRelevant(descriptor.ownerPackageId, descriptor.projectAffinity));
}

/** Every registered descriptor, ignoring the active project's relevance.
 *  Only for editors that decide relevance themselves (project composition);
 *  navigation surfaces use `listCapabilities()`. */
export function listRegisteredCapabilities(): CapabilityDescriptor[] {
  return [...registry.values()];
}

/** Packages that own at least one rail launcher (`rail !== false`) — the
 *  packages whose visibility a project can meaningfully choose. */
export function railLauncherPackageIds(
  descriptors: readonly Pick<CapabilityDescriptor, "ownerPackageId" | "rail">[],
): Set<string> {
  const owners = new Set<string>();
  for (const descriptor of descriptors) {
    if (descriptor.ownerPackageId && descriptor.rail !== false) owners.add(descriptor.ownerPackageId);
  }
  return owners;
}

export function getCapability(id: string): CapabilityDescriptor | null {
  const descriptor = registry.get(id);
  return descriptor && isProjectContributionRelevant(descriptor.ownerPackageId, descriptor.projectAffinity)
    ? descriptor : null;
}

/** A registered capability's own launcher mark, regardless of relevance. */
export function capabilityIcon(id: string): CapabilityDescriptor["icon"] {
  return registry.get(id)?.icon;
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
