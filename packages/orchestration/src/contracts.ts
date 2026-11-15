// Shared contract of the Orchestration package: the person's delegation
// routing policy, its live resolution and the HTTP DTOs. Browser-safe — no
// Node imports — so the web entry and the server entry read one definition.

export const ORCHESTRATION_PACKAGE_ID = "orchestration";
export const ORCHESTRATION_API = "/api/orchestration";

/**
 * Routes (all scoped to the gateway-validated Space and the signed-in person):
 * - `GET    /api/orchestration`            → `OrchestrationState` for the saved policy
 * - `POST   /api/orchestration/preview`    `{ policy: RoutingPolicy }` → `OrchestrationState`
 *   resolved for that unsaved draft (`policy` stays the saved one)
 * - `PUT    /api/orchestration/policy`     `{ policy: RoutingPolicy, expectedRevision: string }`
 *   → `OrchestrationState`; 409 `conflict` when the saved revision moved
 * - `DELETE /api/orchestration/policy`     → `OrchestrationState` after reset to `DEFAULT_POLICY`
 * - `GET    /api/orchestration/models`     → `ModelOptionsResponse` for the pickers
 * - `POST   /api/orchestration/recommend`  → `{ policy: RoutingPolicy }`, an unsaved draft
 */

export type BuiltinRoleId = "explore" | "implement" | "verify" | "review" | "vision" | "write";

export const BUILTIN_ROLE_IDS: readonly BuiltinRoleId[] = ["explore", "implement", "verify", "review", "vision", "write"];

/** What work belongs to each built-in role, as agents read it. Model-visible
 *  English; the UI shows its own localized wording. */
export const BUILTIN_ROLE_BRIEFS: Readonly<Record<BuiltinRoleId, string>> = {
  explore: "read-only research: find code or consumers, trace a flow, map a module, read logs, collect docs or web sources",
  implement: "bounded code changes with a known contract and a named check",
  verify: "run tests, typecheck and builds, triage failures, capture screenshots",
  review: "code review, diagnosis and judgment calls a cheaper model would guess at",
  vision: "work on images, screenshots, PDFs or very large inputs",
  write: "documentation, copy, translations and summaries",
};

export const CUSTOM_ROLE_PREFIX = "custom-";

export const POLICY_LIMITS = {
  /** Custom roles beside the six built-in ones. */
  customRoles: 4,
  modelsPerRole: 5,
  excluded: 24,
  labelChars: 48,
  whenChars: 280,
  quotaCeiling: { min: 50, max: 100 },
  overPaceCeiling: { min: 30, max: 100 },
  maxChildren: { min: 1, max: 6 },
  maxConcurrent: { min: 1, max: 6 },
} as const;

/** One model in a role's priority chain. */
export interface ModelChoice {
  harnessId: string;
  providerID: string;
  modelID: string;
  /** Run at most this many children on this model at once. Advisory: agents
   *  are told, Polyth does not refuse a spawn. Absent = no own limit. */
  maxConcurrent?: number;
}

export interface RoutingRole {
  /** A `BuiltinRoleId`, or `custom-<slug>` for the person's own role. */
  id: string;
  /** Custom roles only: the person's name for it. */
  label?: string;
  /** Custom roles only: when an agent should choose this role. Model-visible,
   *  one line, at most `POLICY_LIMITS.whenChars`. */
  when?: string;
  enabled: boolean;
  /** Priority order: an agent uses the first usable one. */
  models: ModelChoice[];
}

/** `auto`: Polyth's ranking alone (favorites, then use, with quota headroom);
 *  agents get no policy block. `roles`: everything below applies. */
export type RoutingMode = "auto" | "roles";

/** When every model of the matching role is skipped (or no role fits):
 *  `shortlist` = choose from the ranked list; `direct` = do the work yourself. */
export type ExhaustedBehavior = "shortlist" | "direct";

export interface RoutingPolicy {
  mode: RoutingMode;
  /** The six built-in roles always present (in `BUILTIN_ROLE_IDS` order),
   *  then custom roles. */
  roles: RoutingRole[];
  /** Skip a model whose fullest applicable quota window is at or above this
   *  percent (an exhausted window always skips). */
  quotaCeiling: number;
  /** While that window runs over pace, skip from this percent instead;
   *  `null` turns the pace rule off. */
  overPaceCeiling: number | null;
  whenExhausted: ExhaustedBehavior;
  /** Most delegated children an agent should run at once. Advisory. */
  maxChildren: number;
  /** `harness::provider/model` keys agents never delegate to. Hidden from the
   *  shortlist and from every role. */
  excluded: string[];
}

export interface StoredRoutingPolicy extends RoutingPolicy {
  /** Content hash of the saved policy; `"default"` before the first save. */
  revision: string;
  updatedAt?: number;
}

export const DEFAULT_POLICY: RoutingPolicy = {
  mode: "auto",
  roles: BUILTIN_ROLE_IDS.map((id) => ({ id, enabled: true, models: [] })),
  quotaCeiling: 85,
  overPaceCeiling: 70,
  whenExhausted: "shortlist",
  maxChildren: 3,
  excluded: [],
};

/** `harness::provider/model`; the model id itself may contain `/`. */
export const modelKey = (choice: { harnessId: string; providerID: string; modelID: string }): string =>
  `${choice.harnessId}::${choice.providerID}/${choice.modelID}`;

/**
 * Why a model in a chain is or is not the one to use now, in precedence order:
 * `excluded` (in the never list) > `unlisted` (its harness's live catalog no
 * longer offers it) > `unavailable` (harness not running) > `blocked` (a quota
 * window is exhausted) > `over-pace` (at/above `overPaceCeiling` while over
 * pace) > `ceiling` (at/above `quotaCeiling`) > `ready`. `unverified` is
 * `ready` without a readable catalog.
 */
export type ChoiceStatus = "ready" | "unverified" | "ceiling" | "over-pace" | "blocked" | "unavailable" | "unlisted" | "excluded";

export interface QuotaWindowRef {
  sourceId: string;
  /** Window label as the quota source names it ("Weekly limit", "5h"). */
  label: string;
  resetsAt?: number;
  pace?: "under" | "on-track" | "over";
}

export interface ResolvedChoice extends ModelChoice {
  key: string;
  status: ChoiceStatus;
  /** Readable model name (catalog name, else a friendly id). */
  name: string;
  /** What an alias row runs now ("Claude Opus 5.5" for `opus`). */
  runs?: string;
  favorite: boolean;
  /** Fullest applicable window, 0..1; absent when unknown. */
  quotaUsed?: number;
  quotaWindow?: QuotaWindowRef;
  blockedUntil?: number;
}

export interface ResolvedRole {
  id: string;
  /** Custom roles: the person's name. */
  label?: string;
  when?: string;
  enabled: boolean;
  choices: ResolvedChoice[];
  /** Index into `choices` of the model an agent uses now; absent when none
   *  is usable (or the role has no models). */
  pick?: number;
}

/** One row of the shortlist agents see, as the Usage package ranked it. */
export interface ShortlistRow {
  key: string;
  harnessId: string;
  providerID: string;
  modelID: string;
  name: string;
  runs?: string;
  favorite: boolean;
  turns: number;
  sessions: number;
  failed: number;
  lastUsedAt?: number;
  available: boolean;
  listed: boolean;
  blocked: boolean;
  blockedUntil?: number;
  quotaUsed?: number;
  quotaWindow?: QuotaWindowRef;
}

export interface QuotaSourceRow {
  sourceId: string;
  label?: string;
  windows: Array<{ id: string; label: string; used: number; resetsAt?: number; pace?: "under" | "on-track" | "over" }>;
  stale: boolean;
  fetchedAt: number;
}

export interface OrchestrationState {
  /** The saved policy (a preview resolves a draft but still returns this). */
  policy: StoredRoutingPolicy;
  generatedAt: number;
  /** Roles of the saved policy, or of the draft for a preview. */
  roles: ResolvedRole[];
  /** False when the Usage package is off: no quota, use or catalog naming. */
  routingAvailable: boolean;
  shortlist: {
    rows: ShortlistRow[];
    quotas: QuotaSourceRow[];
    /** Rows beyond what agents see by default. */
    omitted: number;
    unlisted: number;
    excluded: number;
    windowDays: number;
    catalogUnavailable?: boolean;
  };
  /** Exactly what `agent.models` prints for this person with this policy:
   *  the policy block (roles mode only), a blank line, then the shortlist. */
  agentText: string;
}

export type ModelTier = "fast" | "balanced" | "strong";

export interface ModelOption {
  key: string;
  harnessId: string;
  providerID: string;
  modelID: string;
  name: string;
  providerName?: string;
  runs?: string;
  favorite: boolean;
  /** Position among the person's favorites; absent when not starred. */
  favoriteIndex?: number;
  /** Turns in the usage window. */
  turns: number;
  /** The catalog says the model reads images. */
  vision: boolean;
  context?: number;
  /** Name-based guess used only by "recommend"; never shown as a fact. */
  tier: ModelTier;
  /** Its harness is registered on this server now. */
  available: boolean;
}

export interface ModelOptionsResponse {
  /** Favorites first (in the person's order), then used, then the rest of
   *  the live catalog by harness and name. */
  models: ModelOption[];
  catalogUnavailable?: boolean;
}

export const isCustomRole = (id: string): boolean => id.startsWith(CUSTOM_ROLE_PREFIX);
export const isBuiltinRole = (id: string): id is BuiltinRoleId => (BUILTIN_ROLE_IDS as readonly string[]).includes(id);
