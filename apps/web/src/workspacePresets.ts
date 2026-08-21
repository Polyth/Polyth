// UX-PERSONAS: optional workspace presets. One schema is the single source of
// truth for setup cards, confirmation summaries, starter order, capability
// placement, Settings labels, and command labels. A preset is a starting
// arrangement — never an identity, permission set, allow-list, or hidden model
// instruction. Selection, switching, clearing, and skipping are local
// presentation state only: no session API call, no SessionEvent appended.
import { useSyncExternalStore } from "react";

export type WorkspacePresetId =
  | "build-debug"
  | "plan-coordinate"
  | "design-explore";

export type CapabilityTier = "primary" | "more" | "technical";
export type ComposerDetail = "plain" | "technical";
export type PresetSetupState = "unseen" | "completed";

export interface PresetPlacement {
  capabilityId: string;
  tier: CapabilityTier;
  rank: number;
}

export interface WorkspacePreset {
  id: WorkspacePresetId;
  label: string;
  description: string;
  confirmationLabel: string;
  starterIds: string[];
  placements: PresetPlacement[];
  initialComposerDetail: ComposerDetail;
}

// ---- exact user-facing copy -------------------------------------------------

export const OPTIONAL_SETUP_COPY = {
  kicker: "Optional setup",
  heading: "What should Polyth put within easy reach?",
  // Names only effects the implementation supplies (no shortcut promise yet).
  description:
    "Choose a starting preset for starter actions, workspace order, and initial detail. It won’t hide tools or limit what you can do. Change or clear it anytime.",
  skip: "Skip for now",
  persistenceNote: "Saved on this device. Change it in Settings → Workspace preset.",
} as const;

/** The `No preset` card is generated from the standard arrangement — it is a
 *  null selection, not a fourth identity value. */
export const NO_PRESET_CARD = {
  label: "No preset",
  description: "Keep the standard workspace and your existing defaults.",
  confirmationLabel: "Continue without a preset",
} as const;

// ---- starter actions ---------------------------------------------------------

/** Stable language-independent starter ids → localized labels. Selecting a
 *  starter fills the composer draft exactly; it never submits a message. */
export const STARTER_LABELS: Record<string, string> = {
  "explore-project": "Explore this project",
  "explain-here": "Explain what’s here",
  "plan-next-step": "Plan a next step",
  "review-recent-work": "Review recent work",
  "help-get-started": "Help me get started",
  "explore-code": "Explore the code",
  "debug-issue": "Debug an issue",
  "review-recent-changes": "Review recent changes",
  "add-tests": "Add tests",
  "explain-project": "Explain this project",
  "catch-me-up": "Catch me up",
  "turn-into-plan": "Turn this into a plan",
  "summarize-progress": "Summarize progress",
  "identify-risks": "Identify risks",
  "suggest-next-action": "Suggest the next action",
  "explore-directions": "Explore a few directions",
  "draft-interface": "Draft an interface",
  "open-preview": "Open a preview",
  "revise-from-feedback": "Revise from feedback",
  "explain-visually": "Explain it visually",
};

export const STANDARD_STARTER_IDS = [
  "explore-project",
  "explain-here",
  "plan-next-step",
  "review-recent-work",
  "help-get-started",
];

// ---- preset definitions -------------------------------------------------------

export const WORKSPACE_PRESETS: WorkspacePreset[] = [
  {
    id: "build-debug",
    label: "Build & debug",
    description: "Keep code, project files, changes, and technical starters close.",
    confirmationLabel: "Use Build & debug preset",
    starterIds: ["explore-code", "debug-issue", "review-recent-changes", "add-tests", "explain-project"],
    placements: [
      { capabilityId: "session", tier: "primary", rank: 0 },
      { capabilityId: "files", tier: "primary", rank: 1 },
      { capabilityId: "git", tier: "primary", rank: 2 },
      { capabilityId: "terminal", tier: "primary", rank: 3 },
      { capabilityId: "preview", tier: "primary", rank: 4 },
      { capabilityId: "goals", tier: "more", rank: 10 },
    ],
    initialComposerDetail: "technical",
  },
  {
    id: "plan-coordinate",
    label: "Plan & coordinate",
    description: "Lead with goals, plans, progress, and clear next actions.",
    confirmationLabel: "Use Plan & coordinate preset",
    starterIds: ["catch-me-up", "turn-into-plan", "summarize-progress", "identify-risks", "suggest-next-action"],
    placements: [
      { capabilityId: "session", tier: "primary", rank: 0 },
      { capabilityId: "goals", tier: "primary", rank: 1 },
      { capabilityId: "usage", tier: "primary", rank: 2 },
      { capabilityId: "schedule", tier: "primary", rank: 3 },
      { capabilityId: "walkthrough", tier: "primary", rank: 4 },
      { capabilityId: "files", tier: "more", rank: 10 },
      { capabilityId: "preview", tier: "more", rank: 11 },
    ],
    initialComposerDetail: "plain",
  },
  {
    id: "design-explore",
    label: "Design & explore",
    description: "Make room for ideas, previews, voice, and iterative drafts.",
    confirmationLabel: "Use Design & explore preset",
    starterIds: ["explore-directions", "draft-interface", "open-preview", "revise-from-feedback", "explain-visually"],
    placements: [
      { capabilityId: "session", tier: "primary", rank: 0 },
      { capabilityId: "preview", tier: "primary", rank: 1 },
      { capabilityId: "files", tier: "primary", rank: 2 },
      { capabilityId: "voice", tier: "primary", rank: 3 },
      { capabilityId: "goals", tier: "more", rank: 10 },
    ],
    initialComposerDetail: "plain",
  },
];

export function presetById(id: string | null | undefined): WorkspacePreset | null {
  return WORKSPACE_PRESETS.find((p) => p.id === id) ?? null;
}

const PRESET_IDS = new Set<string>(WORKSPACE_PRESETS.map((p) => p.id));

export function isPresetId(v: unknown): v is WorkspacePresetId {
  return typeof v === "string" && PRESET_IDS.has(v);
}

// ---- persistence records -------------------------------------------------------

export const PRESET_STORE_KEY = "polyth.workspacePreset.v1";
export const PRESENTATION_STORE_KEY = "polyth.workspacePresentation.v1";
/** Explicit override maps are capped so hostile storage can't balloon parses. */
export const MAX_OVERRIDE_ENTRIES = 128;

export interface WorkspacePresetRecord {
  version: 1;
  setup: PresetSetupState;
  presetId: WorkspacePresetId | null;
  /** null = the preset (or standard baseline) may seed the initial value;
   *  once the user toggles it, the explicit choice wins over every preset. */
  composerDetail: ComposerDetail | null;
  moreToolsOpen: boolean;
}

export interface PlacementOverride {
  tier: CapabilityTier;
  rank: number;
}

/** Explicit user placement/starter overrides — stored separately from the
 *  preset record so `Clear preset` never deletes them. */
export interface WorkspacePresentationRecord {
  version: 1;
  placements: Record<string, PlacementOverride>;
  starterOrder: string[] | null;
}

const DEFAULT_RECORD: WorkspacePresetRecord = {
  version: 1,
  setup: "unseen",
  presetId: null,
  composerDetail: null,
  moreToolsOpen: false,
};

const DEFAULT_PRESENTATION: WorkspacePresentationRecord = {
  version: 1,
  placements: {},
  starterOrder: null,
};

const isTier = (v: unknown): v is CapabilityTier =>
  v === "primary" || v === "more" || v === "technical";
const isDetail = (v: unknown): v is ComposerDetail => v === "plain" || v === "technical";

/** Defensive parse: unknown preset/setup/detail values are rejected, unknown
 *  fields dropped, and nothing ever throws during app startup. Invalid data
 *  falls back to `setup:"unseen", presetId:null` — the shell stays usable. */
export function parsePresetRecord(raw: string | null): WorkspacePresetRecord {
  try {
    const data = JSON.parse(raw ?? "") as Record<string, unknown>;
    if (!data || typeof data !== "object" || data.version !== 1) return { ...DEFAULT_RECORD };
    const setup = data.setup === "completed" ? "completed" : data.setup === "unseen" ? "unseen" : null;
    if (setup === null) return { ...DEFAULT_RECORD };
    const presetId = isPresetId(data.presetId) ? data.presetId : data.presetId === null ? null : undefined;
    if (presetId === undefined) return { ...DEFAULT_RECORD };
    const composerDetail = isDetail(data.composerDetail) ? data.composerDetail : null;
    return {
      version: 1,
      setup,
      presetId,
      composerDetail,
      moreToolsOpen: data.moreToolsOpen === true,
    };
  } catch {
    return { ...DEFAULT_RECORD };
  }
}

export function parsePresentationRecord(raw: string | null): WorkspacePresentationRecord {
  try {
    const data = JSON.parse(raw ?? "") as Record<string, unknown>;
    if (!data || typeof data !== "object" || data.version !== 1) return structuredClone(DEFAULT_PRESENTATION);
    const placements: Record<string, PlacementOverride> = {};
    if (data.placements && typeof data.placements === "object") {
      for (const [id, v] of Object.entries(data.placements as Record<string, unknown>)) {
        if (Object.keys(placements).length >= MAX_OVERRIDE_ENTRIES) break;
        const o = v as { tier?: unknown; rank?: unknown };
        if (o && isTier(o.tier) && typeof o.rank === "number" && Number.isFinite(o.rank)) {
          placements[id] = { tier: o.tier, rank: o.rank };
        }
      }
    }
    const starterOrder = Array.isArray(data.starterOrder)
      ? data.starterOrder.filter((s): s is string => typeof s === "string").slice(0, MAX_OVERRIDE_ENTRIES)
      : null;
    return { version: 1, placements, starterOrder: starterOrder && starterOrder.length > 0 ? starterOrder : null };
  } catch {
    return structuredClone(DEFAULT_PRESENTATION);
  }
}

// ---- one-time legacy migration -------------------------------------------------

/** Legacy persona defaults, retained only as migration inputs. Polyth never
 *  addresses the user by these names again. */
const LEGACY_KEY = "polyth.prefs";
export const LEGACY_PERSONA_PLUGINS: Record<string, string[]> = {
  engineer: ["session", "files", "git", "preview", "terminal", "context", "usage", "events", "goals", "multirun", "fusion", "walkthrough", "schedule", "github", "dictation", "knowledge"],
  manager: ["session", "files", "context", "usage", "goals", "multirun", "fusion", "walkthrough", "knowledge"],
  creator: ["session", "preview", "files"],
  blank: ["session", "files", "context", "usage"],
};

const LEGACY_PRESET_OF: Record<string, WorkspacePresetId | null> = {
  engineer: "build-debug",
  manager: "plan-coordinate",
  creator: "design-explore",
  blank: null,
};

/** Legacy plugin id → capability id (identical except dictation → voice). */
export function legacyPluginToCapability(id: string): string {
  return id === "dictation" ? "voice" : id;
}

export interface LegacyMigrationResult {
  record: WorkspacePresetRecord;
  presentation: WorkspacePresentationRecord;
}

/** Pure one-time migration of `polyth.prefs`:
 *  engineer→build-debug, manager→plan-coordinate, creator→design-explore,
 *  blank→null (setup completed); absent/invalid→null (setup unseen).
 *  The legacy `plugins` array is classified, never replayed as an allow-list:
 *  membership identical to that persona's defaults is discarded (it was
 *  preset-owned filtering); user-added ids become explicit promoted placement
 *  overrides; user-removed default ids become explicit `More tools` placement
 *  overrides — never hidden or unavailable. */
export function migrateLegacyPrefs(raw: string | null): LegacyMigrationResult {
  let persona: string | null = null;
  let plugins: string[] = [];
  try {
    const data = JSON.parse(raw ?? "") as { persona?: unknown; plugins?: unknown };
    if (typeof data.persona === "string" && data.persona in LEGACY_PERSONA_PLUGINS) persona = data.persona;
    if (Array.isArray(data.plugins)) plugins = data.plugins.filter((p): p is string => typeof p === "string");
  } catch {
    persona = null;
  }
  if (persona === null) {
    return { record: { ...DEFAULT_RECORD }, presentation: structuredClone(DEFAULT_PRESENTATION) };
  }
  const defaults = LEGACY_PERSONA_PLUGINS[persona]!;
  // Empty plugin lists meant "persona defaults" in the legacy parse contract.
  const effective = plugins.length === 0 ? defaults.slice() : plugins;
  const placements: Record<string, PlacementOverride> = {};
  const added = effective.filter((p) => !defaults.includes(p));
  const removed = defaults.filter((p) => !effective.includes(p));
  added.forEach((p, i) => {
    placements[legacyPluginToCapability(p)] = { tier: "primary", rank: 90 + i };
  });
  removed.forEach((p, i) => {
    if (p === "session") return; // chat can never be displaced by migration
    placements[legacyPluginToCapability(p)] = { tier: "more", rank: 60 + i };
  });
  return {
    record: {
      version: 1,
      setup: "completed",
      presetId: LEGACY_PRESET_OF[persona] ?? null,
      composerDetail: null,
      moreToolsOpen: false,
    },
    presentation: { version: 1, placements, starterOrder: null },
  };
}

// ---- pure placement resolution ---------------------------------------------------

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

const TIER_ORDER: Record<CapabilityTier, number> = { primary: 0, more: 1, technical: 2 };

/** Preset resolution may change only tier and rank. Explicit user overrides
 *  win over preset suggestions; unknown override ids are ignored. Output is a
 *  stable sort: tier, then rank, then id. */
export function resolvePlacements(
  caps: readonly CapabilityPlacementInput[],
  presetId: WorkspacePresetId | null,
  overrides: Record<string, PlacementOverride> = {},
): ResolvedPlacement[] {
  const preset = presetById(presetId);
  const presetMap = new Map<string, PresetPlacement>();
  if (preset) for (const p of preset.placements) presetMap.set(p.capabilityId, p);
  const out = caps.map((c): ResolvedPlacement => {
    const fromPreset = presetMap.get(c.id);
    const base: ResolvedPlacement = fromPreset
      ? { id: c.id, tier: fromPreset.tier, rank: fromPreset.rank }
      : { id: c.id, tier: c.standardTier, rank: c.standardRank };
    const o = overrides[c.id];
    return o ? { id: c.id, tier: o.tier, rank: o.rank } : base;
  });
  out.sort((a, b) =>
    TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.rank - b.rank || a.id.localeCompare(b.id));
  return out;
}

/** Starter order for a preset (or the standard baseline), with the user's
 *  explicit starter override winning. Unknown ids are dropped. */
export function starterIdsFor(
  presetId: WorkspacePresetId | null,
  starterOverride: string[] | null = null,
): string[] {
  if (starterOverride && starterOverride.length > 0) {
    const known = starterOverride.filter((id) => id in STARTER_LABELS);
    if (known.length > 0) return known;
  }
  return presetById(presetId)?.starterIds ?? STANDARD_STARTER_IDS;
}

export function starterLabelsFor(
  presetId: WorkspacePresetId | null,
  starterOverride: string[] | null = null,
): string[] {
  return starterIdsFor(presetId, starterOverride).map((id) => STARTER_LABELS[id] ?? id);
}

// ---- generated confirmation summary ------------------------------------------------

export interface PresetSummaryInput {
  /** Candidate selection (null = No preset / standard baseline). */
  presetId: WorkspacePresetId | null;
  /** Current applied selection for difference computation. */
  currentPresetId: WorkspacePresetId | null;
  /** Capability metadata; unavailable entries are omitted from the summary. */
  caps: readonly (CapabilityPlacementInput & { label: string; available: boolean })[];
  overrides?: Record<string, PlacementOverride>;
  starterOverride?: string[] | null;
  /** Explicit user composer-detail choice (wins over any preset). */
  explicitComposerDetail?: ComposerDetail | null;
}

export interface PresetSummary {
  label: string;
  confirmationLabel: string;
  /** Effective-difference bullets; empty when nothing would change. */
  bullets: string[];
  /** Ids whose explicit override masks a proposed preset change. */
  maskedByOverrides: string[];
  primaryOrder: string[];
  starterLabels: string[];
  composerDetail: ComposerDetail;
  footer: string;
}

export const SUMMARY_FOOTER =
  "It will not remove tools, change access, or change how Polyth responds.";

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Generate the exact effective changes a selection would make, before it is
 *  saved. Uses only differences from the current state and never lists an
 *  unavailable capability as a promised change. */
export function presetSummary(input: PresetSummaryInput): PresetSummary {
  const preset = presetById(input.presetId);
  const overrides = input.overrides ?? {};
  const next = resolvePlacements(input.caps, input.presetId, overrides);
  const current = resolvePlacements(input.caps, input.currentPresetId, overrides);
  const labelOf = new Map(input.caps.map((c) => [c.id, c.label]));
  const availableOf = new Map(input.caps.map((c) => [c.id, c.available]));

  const primaryIds = next.filter((p) => p.tier === "primary" && availableOf.get(p.id)).map((p) => p.id);
  const currentPrimaryIds = current.filter((p) => p.tier === "primary" && availableOf.get(p.id)).map((p) => p.id);
  const primaryOrder = primaryIds.map((id) => labelOf.get(id) ?? id);

  const starterLabels = starterLabelsFor(input.presetId, input.starterOverride ?? null);
  const currentStarters = starterLabelsFor(input.currentPresetId, input.starterOverride ?? null);

  const explicit = input.explicitComposerDetail ?? null;
  const composerDetail: ComposerDetail =
    explicit ?? preset?.initialComposerDetail ?? "plain";
  const currentDetail: ComposerDetail =
    explicit ?? presetById(input.currentPresetId)?.initialComposerDetail ?? "plain";

  const bullets: string[] = [];
  if (primaryIds.join("|") !== currentPrimaryIds.join("|")) {
    const shown = primaryIds.filter((id) => id !== "session").map((id) => labelOf.get(id) ?? id);
    if (shown.length > 0) bullets.push(`put ${joinList(shown)} first`);
  }
  if (starterLabels.join("|") !== currentStarters.join("|")) {
    bullets.push(`show starters first: ${starterLabels.join(", ")}`);
  }
  if (composerDetail !== currentDetail) {
    bullets.push(composerDetail === "technical"
      ? "start Technical options open"
      : "start with Technical options closed");
  }

  // An explicit override masks a preset suggestion when the preset proposes a
  // placement the override pins elsewhere.
  const maskedByOverrides: string[] = [];
  if (preset) {
    for (const p of preset.placements) {
      const o = overrides[p.capabilityId];
      if (o && (o.tier !== p.tier || o.rank !== p.rank)) maskedByOverrides.push(p.capabilityId);
    }
  }

  return {
    label: preset?.label ?? NO_PRESET_CARD.label,
    confirmationLabel: preset?.confirmationLabel ?? NO_PRESET_CARD.confirmationLabel,
    bullets,
    maskedByOverrides,
    primaryOrder,
    starterLabels,
    composerDetail,
    footer: SUMMARY_FOOTER,
  };
}

export function formatPresetSummary(s: PresetSummary): string {
  if (s.bullets.length === 0) return `${s.label} matches your current arrangement.\n\n${s.footer}`;
  return `${s.label} will:\n${s.bullets.map((b) => `• ${b}`).join("\n")}\n\n${s.footer}`;
}

// ---- persisted store ----------------------------------------------------------------

const mem = new Map<string, string>();
const storage = {
  get(k: string): string | null {
    try { return localStorage.getItem(k); } catch { return mem.get(k) ?? null; }
  },
  set(k: string, v: string): void {
    try { localStorage.setItem(k, v); } catch { mem.set(k, v); }
  },
};

let record: WorkspacePresetRecord;
let presentation: WorkspacePresentationRecord;
const listeners = new Set<() => void>();

function load(): void {
  const rawRecord = storage.get(PRESET_STORE_KEY);
  if (rawRecord !== null) {
    record = parsePresetRecord(rawRecord);
    presentation = parsePresentationRecord(storage.get(PRESENTATION_STORE_KEY));
    return;
  }
  // One-time migration: the new records are written before migration counts
  // as complete (the presence of PRESET_STORE_KEY is the completion marker).
  const migrated = migrateLegacyPrefs(storage.get(LEGACY_KEY));
  presentation = migrated.presentation;
  record = migrated.record;
  storage.set(PRESENTATION_STORE_KEY, JSON.stringify(presentation));
  storage.set(PRESET_STORE_KEY, JSON.stringify(record));
}
load();

function emit(): void {
  storage.set(PRESET_STORE_KEY, JSON.stringify(record));
  storage.set(PRESENTATION_STORE_KEY, JSON.stringify(presentation));
  for (const l of [...listeners]) l();
}

export function getPresetState(): WorkspacePresetRecord {
  return record;
}

export function getPresentation(): WorkspacePresentationRecord {
  return presentation;
}

export function subscribePresetState(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function usePresetState(): WorkspacePresetRecord {
  return useSyncExternalStore(subscribePresetState, getPresetState);
}

export function usePresentation(): WorkspacePresentationRecord {
  return useSyncExternalStore(subscribePresetState, getPresentation);
}

/** Apply (or switch to) a preset; null applies the standard baseline.
 *  Explicit placement, starter, and disclosure overrides are preserved. */
export function applyPreset(id: WorkspacePresetId | null): void {
  record = { ...record, presetId: id, setup: "completed" };
  emit();
}

/** Skip/close paths: setup is completed with no disguised default written. */
export function completePresetSetup(): void {
  if (record.setup === "completed") return;
  record = { ...record, setup: "completed" };
  emit();
}

/** `Clear preset` selects the standard baseline. It touches nothing else. */
export function clearPreset(): void {
  record = { ...record, presetId: null, setup: "completed" };
  emit();
}

export function setComposerDetail(detail: ComposerDetail): void {
  record = { ...record, composerDetail: detail };
  emit();
}

/** Explicit choice wins; otherwise the preset (or standard) seeds the value. */
export function effectiveComposerDetail(): ComposerDetail {
  return record.composerDetail ?? presetById(record.presetId)?.initialComposerDetail ?? "plain";
}

export function setMoreToolsOpen(open: boolean): void {
  if (record.moreToolsOpen === open) return;
  record = { ...record, moreToolsOpen: open };
  emit();
}

export function setPlacementOverride(id: string, placement: PlacementOverride | null): void {
  const placements = { ...presentation.placements };
  if (placement === null) delete placements[id];
  else if (Object.keys(placements).length < MAX_OVERRIDE_ENTRIES || id in placements) placements[id] = placement;
  presentation = { ...presentation, placements };
  emit();
}

export function setStarterOrder(order: string[] | null): void {
  presentation = { ...presentation, starterOrder: order && order.length > 0 ? order.slice(0, MAX_OVERRIDE_ENTRIES) : null };
  emit();
}

/** `Reset workspace order`: clears placement and starter overrides only. */
export function resetWorkspaceOrder(): void {
  presentation = { version: 1, placements: {}, starterOrder: null };
  emit();
}

/** `Reset disclosure choices`: composer detail returns to preset-seeded and
 *  the More tools disclosure closes. Placement overrides are untouched. */
export function resetDisclosureChoices(): void {
  record = { ...record, composerDetail: null, moreToolsOpen: false };
  emit();
}

/** Test seam: reload state from storage (after a test rewrites raw records). */
export function reloadPresetStateForTest(): void {
  load();
  for (const l of [...listeners]) l();
}
