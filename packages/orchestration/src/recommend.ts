// Deterministic "recommend" heuristic: a draft policy built from the person's
// favorites and use. Pure and browser-safe.
import {
  BUILTIN_ROLE_IDS,
  type BuiltinRoleId,
  type ModelChoice,
  type ModelOption,
  type ModelTier,
  type RoutingPolicy,
} from "./contracts.ts";

const STRONG = /opus|fable|ultra|thinking|\bmax\b/;
const FAST = /flash|haiku|mini|nano|lite|small|spark|air|fast|free/;

/** Name-based guess; never shown as a fact. */
export function tierOf(name: string, modelID: string): ModelTier {
  const text = `${name} ${modelID}`.toLowerCase();
  if (STRONG.test(text)) return "strong";
  if (FAST.test(text)) return "fast";
  return "balanced";
}

const TIER_ORDER: Record<BuiltinRoleId, readonly ModelTier[]> = {
  explore: ["fast", "balanced"],
  verify: ["fast", "balanced"],
  implement: ["balanced", "fast"],
  write: ["balanced", "fast"],
  review: ["strong", "balanced"],
  vision: ["fast", "balanced", "strong"],
};

const PER_ROLE = 3;

const rank = (a: ModelOption, b: ModelOption): number =>
  (a.favoriteIndex ?? Number.POSITIVE_INFINITY) - (b.favoriteIndex ?? Number.POSITIVE_INFINITY)
  || b.turns - a.turns
  || a.key.localeCompare(b.key);

export function recommendPolicy(saved: RoutingPolicy, options: ModelOption[]): RoutingPolicy {
  const excluded = new Set(saved.excluded);
  const pool = options.filter((option) => (option.favorite || option.turns > 0) && !excluded.has(option.key));

  const pickFor = (id: BuiltinRoleId): ModelChoice[] => {
    const source = id === "vision" ? pool.filter((option) => option.vision) : pool;
    const ordered = TIER_ORDER[id].flatMap((tier) => source.filter((option) => option.tier === tier).sort(rank));
    const chosen: ModelOption[] = [];
    const first = ordered[0];
    if (first) {
      chosen.push(first);
      // One quota running out should not empty the role: position 2 prefers another harness.
      const other = ordered.find((option) => option !== first && option.harnessId !== first.harnessId);
      if (other) chosen.push(other);
    }
    for (const option of ordered) {
      if (chosen.length >= PER_ROLE) break;
      if (!chosen.includes(option)) chosen.push(option);
    }
    return chosen.slice(0, PER_ROLE).map((option) => ({
      harnessId: option.harnessId,
      providerID: option.providerID,
      modelID: option.modelID,
    }));
  };

  const savedRole = (id: string) => saved.roles.find((role) => role.id === id);
  return {
    ...saved,
    mode: "roles",
    roles: [
      ...BUILTIN_ROLE_IDS.map((id) => ({ id, enabled: true, models: pickFor(id) })),
      ...saved.roles.filter((role) => !BUILTIN_ROLE_IDS.includes(role.id as BuiltinRoleId) && savedRole(role.id)),
    ],
  };
}
