// UX-PERSONAS: one capability model. This is a navigation-metadata registry —
// it owns labels, keywords, tier/rank resolution, and open commands only. It
// is NOT a component host: the workspace and right-surface registries keep
// rendering and lifecycle ownership, and a descriptor confers no filesystem,
// process, credential, project, or session authority.
//
// Header, right rail, compact navigation, command search, shortcuts, and
// Settings all consume the same resolved list, so they can never disagree
// about whether a capability exists. Presets change only tier and rank;
// `available()` is independent of preset selection.
import { useSyncExternalStore } from "react";
import {
  getPresentation, getPresetState, resolvePlacements, subscribePresetState,
  type CapabilityTier, type ResolvedPlacement, type WorkspacePresetId, type PlacementOverride,
} from "./workspacePresets.ts";

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
 *  Goals & progress. Everything else lives in More tools or Technical
 *  options — placed, never filtered out. Old searchable names (Git,
 *  Multi-Run, Fusion, plugin, …) stay as keywords so existing users are
 *  not stranded. */
export const BUILTIN_CAPABILITY_META: CapabilityMeta[] = [
  { id: "session", label: "Chat", plainDescription: "Talk with Polyth about your project.", keywords: ["session", "conversation", "chat"], standardTier: "primary", standardRank: 0 },
  { id: "files", label: "Project files", plainDescription: "Browse and edit the files in your project.", keywords: ["files", "editor", "tree", "quick open"], standardTier: "primary", standardRank: 1 },
  { id: "preview", label: "Preview", plainDescription: "See the running result while you work.", keywords: ["live preview", "browser", "app"], standardTier: "primary", standardRank: 2 },
  { id: "goals", label: "Goals & progress", plainDescription: "Track goals and how the work is going.", keywords: ["goals", "progress", "status"], standardTier: "primary", standardRank: 3 },
  { id: "multirun", label: "Compare responses", technicalLabel: "Multi-Run", plainDescription: "Ask several ways at once and compare the answers.", keywords: ["multi-run", "multirun", "compare models"], standardTier: "more", standardRank: 10 },
  { id: "workflow", label: "Workflows", technicalLabel: "DAG orchestration", plainDescription: "Coordinate agent roles in dependency-based pipelines.", keywords: ["workflow", "dag", "orchestration", "multi-agent"], standardTier: "more", standardRank: 11 },
  { id: "fusion", label: "Combine drafts", technicalLabel: "Fusion", plainDescription: "Merge the best parts of several drafts.", keywords: ["fusion", "fuse models", "merge"], standardTier: "more", standardRank: 12 },
  { id: "walkthrough", label: "Guided walkthrough", plainDescription: "A step-by-step guided review of the work.", keywords: ["walkthrough", "guide", "tour"], standardTier: "more", standardRank: 13 },
  { id: "schedule", label: "Schedule", technicalLabel: "Scheduled prompts", plainDescription: "Run prompts on a schedule.", keywords: ["schedule", "scheduled prompts", "cron"], standardTier: "more", standardRank: 14 },
  { id: "usage", label: "Usage & cost", plainDescription: "See what the work is using and costing.", keywords: ["usage", "cost", "tokens", "quota"], standardTier: "more", standardRank: 15 },
  { id: "github", label: "GitHub", plainDescription: "Browse issues and pull requests for this project.", keywords: ["github", "issues", "pull requests", "pr"], standardTier: "more", standardRank: 16 },
  { id: "knowledge", label: "Knowledge", plainDescription: "Notes and references Polyth can use.", keywords: ["knowledge", "notes", "docs"], standardTier: "more", standardRank: 17 },
  { id: "context", label: "Context", plainDescription: "What Polyth is currently looking at.", keywords: ["context", "pinned", "session status"], standardTier: "more", standardRank: 18 },
  { id: "voice", label: "Voice input", technicalLabel: "Dictation", plainDescription: "Talk instead of typing.", keywords: ["voice", "dictation", "microphone", "speech"], standardTier: "more", standardRank: 19 },
  { id: "git", label: "Source control", technicalLabel: "Git", plainDescription: "Review and manage changes to the code.", keywords: ["git", "worktrees", "branch", "diff", "changes"], standardTier: "technical", standardRank: 30 },
  { id: "terminal", label: "Terminal", plainDescription: "Run commands in the project workspace.", keywords: ["terminal", "shell", "console"], standardTier: "technical", standardRank: 31 },
  { id: "models-agents", label: "Models & agents", plainDescription: "Choose which model and agent Polyth uses.", keywords: ["model", "agent", "profile", "provider"], standardTier: "technical", standardRank: 32 },
  { id: "events", label: "Event log", plainDescription: "The raw record of everything in a session.", keywords: ["events", "log", "debug"], standardTier: "technical", standardRank: 33 },
  { id: "diagnostics", label: "Extension diagnostics", technicalLabel: "Plugins", plainDescription: "Inspect installed extensions and their logs.", keywords: ["plugin", "extension", "install", "logs"], standardTier: "technical", standardRank: 34 },
];

// ---- plain-language disclosure groups -----------------------------------------

export const TECHNICAL_GROUP_LABEL = "Technical options";

const GROUP_OF: Record<string, string> = {
  files: "Work with the project",
  preview: "Work with the project",
  goals: "Work with the project",
  knowledge: "Work with the project",
  context: "Work with the project",
  voice: "Work with the project",
  usage: "Plan and review",
  schedule: "Plan and review",
  walkthrough: "Plan and review",
  github: "Plan and review",
  multirun: "Compare and refine",
  workflow: "Compare and refine",
  fusion: "Compare and refine",
  git: TECHNICAL_GROUP_LABEL,
  terminal: TECHNICAL_GROUP_LABEL,
  "models-agents": TECHNICAL_GROUP_LABEL,
  events: TECHNICAL_GROUP_LABEL,
  diagnostics: TECHNICAL_GROUP_LABEL,
};

/** Dynamically registered extensions default to the generic More tools group
 *  (and the `more` tier) and are searchable immediately. */
export function capabilityGroup(id: string): string {
  return GROUP_OF[id] ?? "More tools";
}

export const GROUP_ORDER = [
  "Work with the project",
  "Plan and review",
  "Compare and refine",
  "More tools",
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

/** Pure: resolve descriptors against a preset + explicit overrides. */
export function resolveCapabilities(
  descriptors: readonly CapabilityDescriptor[],
  presetId: WorkspacePresetId | null,
  overrides: Record<string, PlacementOverride> = {},
): ResolvedCapability[] {
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  const placements: ResolvedPlacement[] = resolvePlacements(
    descriptors.map((d) => ({ id: d.id, standardTier: d.standardTier, standardRank: d.standardRank })),
    presetId,
    overrides,
  );
  return placements.map((p) => ({ descriptor: byId.get(p.id)!, tier: p.tier, rank: p.rank }));
}

/** The single resolved list every navigation surface consumes: current
 *  registry contents against the current preset and explicit overrides. */
export function currentResolvedCapabilities(): ResolvedCapability[] {
  return resolveCapabilities(listCapabilities(), getPresetState().presetId, getPresentation().placements);
}

/** React hook: re-render on registry changes or preset/override changes. */
export function useResolvedCapabilities(): ResolvedCapability[] {
  useCapabilityVersion();
  useSyncExternalStore(subscribePresetState, getPresetState);
  useSyncExternalStore(subscribePresetState, getPresentation);
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
 *  More tools and command search immediately, defaulting to the `more` tier —
 *  registration never touches preset state. */
export function exposeCapabilities(): void {
  if (typeof window !== "undefined") {
    window.__polythCapabilities = { registerCapability, listCapabilities };
  }
}
