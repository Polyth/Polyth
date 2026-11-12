// Which harnesses get a managed skill, and how. Pure and browser-safe: the
// server stores and delivers with it, the skill page draws with it.
import type {
  CapabilityHarnessRule,
} from "@polyth/contracts";
import type {
  SkillHarnessMode,
  SkillReachDefault,
  SkillReachDto,
} from "@polyth/contracts/capability-installations";

export const SKILL_HARNESS_MODES: readonly SkillHarnessMode[] = ["off", "on", "always"];
export const SKILL_REACH_DEFAULTS: readonly SkillReachDefault[] = ["all", "some", "none"];

/** A harness as reach rules see it. */
export interface ReachHarness {
  id: string;
  family: string;
}

/** Where a harness's mode comes from. `none`: the skill reaches no harness. */
export type ReachSource = "harness" | "family" | "default" | "none";

const ID = /^[a-z][a-z0-9-]*$/;
const MAX_RULES = 256;

const isMode = (value: unknown): value is SkillHarnessMode =>
  value === "off" || value === "on" || value === "always";

const validRules = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= MAX_RULES && entries.every(([id, mode]) => ID.test(id) && id.length <= 128 && isMode(mode));
};

export const validHarnessRuleId = (id: unknown): id is string =>
  typeof id === "string" && id.length <= 128 && ID.test(id);

export function validReach(value: unknown): value is SkillReachDto | undefined {
  if (value === undefined) return true;
  const reach = value as Partial<SkillReachDto> | null;
  return Boolean(reach)
    && typeof reach === "object"
    && SKILL_REACH_DEFAULTS.includes(reach!.default as SkillReachDefault)
    && validRules(reach!.families)
    && validRules(reach!.harnesses);
}

/** A stored skill's reach, reading the exclusion list older files keep. */
export function skillReach(skill: { reach?: SkillReachDto; offHarnesses?: readonly string[] }): SkillReachDto {
  if (skill.reach) return skill.reach;
  const off = (skill.offHarnesses ?? []).filter((id) => validHarnessRuleId(id));
  return off.length
    ? { default: "all", harnesses: Object.fromEntries(off.map((id) => [id, "off" as const])) }
    : { default: "all" };
}

const baseMode = (reach: SkillReachDto): SkillHarnessMode => (reach.default === "all" ? "on" : "off");

/** The mode a harness gets and the rule it comes from. */
export function harnessMode(reach: SkillReachDto, harness: ReachHarness): { mode: SkillHarnessMode; source: ReachSource } {
  if (reach.default === "none") return { mode: "off", source: "none" };
  const own = reach.harnesses?.[harness.id];
  if (own) return { mode: own, source: "harness" };
  const family = reach.families?.[harness.family];
  if (family) return { mode: family, source: "family" };
  return { mode: baseMode(reach), source: "default" };
}

/** The mode a family's harnesses get when none of them has a rule of its own. */
export function familyMode(reach: SkillReachDto, family: string): { mode: SkillHarnessMode; source: ReachSource } {
  if (reach.default === "none") return { mode: "off", source: "none" };
  const mode = reach.families?.[family];
  return mode ? { mode, source: "family" } : { mode: baseMode(reach), source: "default" };
}

const withRules = (
  defaultValue: SkillReachDefault,
  families: Record<string, SkillHarnessMode>,
  harnesses: Record<string, SkillHarnessMode>,
): SkillReachDto => ({
  default: defaultValue,
  ...(Object.keys(families).length ? { families: sortKeys(families) } : {}),
  ...(Object.keys(harnesses).length ? { harnesses: sortKeys(harnesses) } : {}),
});

const sortKeys = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

/** Drops rules that say what the next broader rule already says, so every rule
 * left is a real choice. Harnesses this page does not know keep their rules. */
export function pruneReach(reach: SkillReachDto, harnesses: readonly ReachHarness[]): SkillReachDto {
  if (reach.default === "none") return reach;
  const families = { ...reach.families };
  for (const [family, mode] of Object.entries(families)) {
    if (mode === baseMode(reach)) delete families[family];
  }
  const own = { ...reach.harnesses };
  const known = new Map(harnesses.map((harness) => [harness.id, harness]));
  for (const [id, mode] of Object.entries(own)) {
    const harness = known.get(id);
    if (!harness) continue;
    const inherited = families[harness.family] ?? baseMode(reach);
    if (mode === inherited) delete own[id];
  }
  return withRules(reach.default, families, own);
}

export type ReachPatch =
  | { default: SkillReachDefault }
  | { family: { id: string; mode: SkillHarnessMode | null } }
  | { harness: { id: string; mode: SkillHarnessMode | null } };

const error = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

/** One change to a reach, given the harnesses added here.
 *  - `all` reaches every harness now and later: every `off` goes, `always` stays.
 *  - `some` keeps the skill exactly where it works now, so only harnesses added
 *    later stop getting it.
 *  - `none` reaches no harness and keeps every choice for a later `some`. */
export function applyReachPatch(current: SkillReachDto, patch: ReachPatch, harnesses: readonly ReachHarness[]): SkillReachDto {
  if ("default" in patch) {
    const next = patch.default;
    if (!SKILL_REACH_DEFAULTS.includes(next)) throw error("invalid reach");
    if (next === current.default) return current;
    if (next === "none") return { ...current, default: "none" };
    const keep = (mode: SkillHarnessMode) => next !== "all" || mode !== "off";
    const families = Object.fromEntries(Object.entries(current.families ?? {}).filter(([, mode]) => keep(mode)));
    const own = Object.fromEntries(Object.entries(current.harnesses ?? {}).filter(([, mode]) => keep(mode)));
    if (next === "some" && current.default === "all") {
      // Where it works only because everything gets it, it now works by choice.
      const members = new Map<string, ReachHarness[]>();
      for (const harness of harnesses) members.set(harness.family, [...members.get(harness.family) ?? [], harness]);
      for (const [family, group] of members) {
        if (families[family]) continue;
        const inheriting = group.filter((harness) => !own[harness.id]);
        if (!inheriting.length) continue;
        if (group.length > 1) families[family] = "on";
        else own[group[0]!.id] = "on";
      }
    }
    return pruneReach(withRules(next, families, own), harnesses);
  }
  if (current.default === "none") throw error("this skill reaches no harness; choose where it works first");
  if ("family" in patch) {
    const { id, mode } = patch.family;
    if (!validHarnessRuleId(id) || (mode !== null && !isMode(mode))) throw error("invalid family rule");
    const families = { ...current.families };
    if (mode === null) delete families[id];
    else families[id] = mode;
    return pruneReach(withRules(current.default, families, { ...current.harnesses }), harnesses);
  }
  const { id, mode } = patch.harness;
  if (!validHarnessRuleId(id) || (mode !== null && !isMode(mode))) throw error("invalid harness rule");
  const own = { ...current.harnesses };
  if (mode === null) delete own[id];
  else own[id] = mode;
  return pruneReach(withRules(current.default, { ...current.families }, own), harnesses);
}

/** The delivery rule for one kind of delivery: `on` for the skill itself
 *  (on demand or always), `always` for its instructions in every session.
 *  Undefined means every harness. */
export function capabilityRule(reach: SkillReachDto, delivery: "skill" | "always"): CapabilityHarnessRule | undefined {
  const allows = (mode: SkillHarnessMode) => delivery === "skill" ? mode !== "off" : mode === "always";
  const families = Object.fromEntries(Object.entries(reach.families ?? {}).map(([id, mode]) => [id, allows(mode)]));
  const harnesses = Object.fromEntries(Object.entries(reach.harnesses ?? {}).map(([id, mode]) => [id, allows(mode)]));
  const fallback = delivery === "skill" && reach.default === "all";
  if (fallback && Object.values(families).every(Boolean) && Object.values(harnesses).every(Boolean)) return undefined;
  return {
    default: fallback,
    ...(Object.keys(families).length ? { families } : {}),
    ...(Object.keys(harnesses).length ? { harnesses } : {}),
  };
}

/** Some harness or family gets this skill's instructions in every session. */
export const reachHasAlways = (reach: SkillReachDto): boolean =>
  reach.default !== "none"
  && [...Object.values(reach.families ?? {}), ...Object.values(reach.harnesses ?? {})].includes("always");

/** Equal reaches, ignoring key order. */
export const sameReach = (a: SkillReachDto, b: SkillReachDto): boolean =>
  JSON.stringify(withRules(a.default, { ...a.families }, { ...a.harnesses }))
    === JSON.stringify(withRules(b.default, { ...b.families }, { ...b.harnesses }));
