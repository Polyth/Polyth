// Pure resolution of a policy against live routing facts, and the agent-facing
// brief. Browser-safe: no Node imports.
import {
  BUILTIN_ROLE_BRIEFS,
  isBuiltinRole,
  modelKey,
  type ChoiceStatus,
  type ModelChoice,
  type ResolvedChoice,
  type ResolvedRole,
  type RoutingPolicy,
} from "./contracts.ts";

/** The part of a Usage routing candidate the resolver reads. */
export interface CandidateFact {
  harnessId: string;
  providerID: string;
  modelID: string;
  runs?: string;
  listed: boolean;
  favorite: boolean;
  available: boolean;
  quotaUsed?: number;
  quotaWindow?: { sourceId: string; label: string; resetsAt?: number; pace?: "under" | "on-track" | "over" };
  blockedUntil?: number;
  blocked: boolean;
}

export interface RoutingFacts {
  /** `harness::provider/model` → the row Usage ranked for it; absent = not offered. */
  candidates: ReadonlyMap<string, CandidateFact>;
  /** Catalog display names by the same key. */
  names?: ReadonlyMap<string, string>;
  /** False when the Usage package is off: nothing can be verified. */
  routingAvailable: boolean;
  /** Usage could not read a live catalog. */
  catalogUnavailable?: boolean;
  /** `harness\u0000<what it runs>` of every excluded row that is an alias, so
   *  another alias of the same model (`default` for an excluded `opus`) is
   *  excluded too — the shortlist hides it the same way. */
  excludedModels?: ReadonlySet<string>;
}

export const sameModelKey = (harnessId: string, runs: string): string => `${harnessId}\u0000${runs}`;

export interface ResolveOptions {
  harnessId?: string;
  now: number;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const clean = (text: string): string => text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();

/** Copy of Usage's `formatDuration` (packages must not import each other). */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 10) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

/** Every distinct chain key of a policy (what one `candidates` call must rank). */
export function chainKeys(policy: RoutingPolicy): string[] {
  const keys = new Set<string>();
  for (const role of policy.roles) for (const choice of role.models) keys.add(modelKey(choice));
  return [...keys];
}

function resolveChoice(policy: RoutingPolicy, choice: ModelChoice, facts: RoutingFacts): ResolvedChoice {
  const key = modelKey(choice);
  const row = facts.candidates.get(key);
  const name = facts.names?.get(key) ?? choice.modelID;
  const base: ResolvedChoice = {
    ...choice,
    key,
    name,
    favorite: row?.favorite ?? false,
    status: "ready",
    ...(row?.runs ? { runs: row.runs } : {}),
    ...(row?.quotaUsed !== undefined ? { quotaUsed: row.quotaUsed } : {}),
    ...(row?.quotaWindow ? { quotaWindow: row.quotaWindow } : {}),
    ...(row?.blockedUntil !== undefined ? { blockedUntil: row.blockedUntil } : {}),
  };
  const status = ((): ChoiceStatus => {
    if (policy.excluded.includes(key)) return "excluded";
    if (row?.runs && facts.excludedModels?.has(sameModelKey(choice.harnessId, row.runs))) return "excluded";
    if (!facts.routingAvailable) return "unverified";
    if (!row) return facts.catalogUnavailable ? "unverified" : "unlisted";
    if (!row.available) return "unavailable";
    if (row.blocked) return "blocked";
    const used = row.quotaUsed === undefined ? undefined : row.quotaUsed * 100;
    if (used !== undefined && policy.overPaceCeiling !== null && row.quotaWindow?.pace === "over" && used >= policy.overPaceCeiling) return "over-pace";
    if (used !== undefined && used >= policy.quotaCeiling) return "ceiling";
    if (!row.listed) return "unverified";
    return "ready";
  })();
  return { ...base, status };
}

const usable = (choice: ResolvedChoice): boolean => choice.status === "ready" || choice.status === "unverified";

export function resolveRoles(policy: RoutingPolicy, facts: RoutingFacts, options?: ResolveOptions): ResolvedRole[] {
  return policy.roles.map((role) => {
    const choices = role.models
      .filter((choice) => !options?.harnessId || choice.harnessId === options.harnessId)
      .map((choice) => resolveChoice(policy, choice, facts));
    const pick = choices.findIndex(usable);
    return {
      id: role.id,
      ...(role.label !== undefined ? { label: role.label } : {}),
      ...(role.when !== undefined ? { when: role.when } : {}),
      enabled: role.enabled,
      choices,
      ...(pick >= 0 ? { pick } : {}),
    };
  });
}

const ref = (choice: ResolvedChoice): string => {
  let text = `${choice.harnessId} ${choice.providerID}/${choice.modelID}`;
  if (choice.runs) text += ` (${choice.runs})`;
  if (choice.maxConcurrent !== undefined) text += ` (at most ${choice.maxConcurrent} at once)`;
  if (choice.status === "unverified") text += " (model unverified)";
  return text;
};

const reason = (choice: ResolvedChoice, policy: RoutingPolicy, now: number): string => {
  const pct = Math.round((choice.quotaUsed ?? 0) * 100);
  switch (choice.status) {
    case "ceiling": return `quota ${pct}% ≥ ${policy.quotaCeiling}%`;
    case "over-pace": return `quota ${pct}% ≥ ${policy.overPaceCeiling}% while over pace`;
    case "blocked": return choice.blockedUntil !== undefined ? `BLOCKED ~${formatDuration(Math.max(0, choice.blockedUntil - now))}` : "BLOCKED";
    case "unavailable": return "harness not running";
    case "unlisted": return "no longer offered";
    case "excluded": return "on the never list";
    default: return "";
  }
};

/** The policy block `agent.models` prints before the shortlist (roles mode). */
export function formatBrief(policy: RoutingPolicy, roles: ResolvedRole[], now: number): string {
  const lines: string[] = [
    "Routing policy (the person's own rules from Settings → Orchestration; they take precedence over the ranked list below). Match the work to a role, then delegate to that role's model:",
  ];
  const direct = policy.whenExhausted === "direct";
  const roleLines: string[] = [];
  for (const role of roles) {
    if (!role.enabled || role.choices.length === 0) continue;
    const head = isBuiltinRole(role.id)
      ? `${role.id} (${BUILTIN_ROLE_BRIEFS[role.id]})`
      : `${clean(role.label ?? role.id)} (custom: "${clean(role.when ?? "")}")`;
    const parts: string[] = [];
    const skipped = role.choices.filter((choice) => !usable(choice));
    if (role.pick === undefined) {
      const why = role.choices.map((choice) => `${ref(choice)}: ${reason(choice, policy, now)}`).join("; ");
      parts.push(`none usable now (${why}) → ${direct ? "do the work yourself" : "choose from the ranked list below"}`);
    } else {
      const later = role.choices.slice(role.pick + 1).filter(usable).slice(0, 2);
      parts.push(`use ${ref(role.choices[role.pick]!)}`);
      for (const choice of later) parts.push(`then ${ref(choice)}`);
      if (skipped.length) parts.push(`skipped now: ${skipped.map((choice) => `${ref(choice)} (${reason(choice, policy, now)})`).join("; ")}`);
    }
    roleLines.push(`- ${head}: ${parts.join("; ")}`);
  }
  lines.push(...(roleLines.length ? roleLines : ["No roles have models yet."]));
  if (policy.excluded.length) {
    const refs = policy.excluded.map((key) => {
      const split = key.indexOf("::");
      const rest = key.slice(split + 2);
      return clean(`${key.slice(0, split)} ${rest}`);
    });
    lines.push(`Never delegate to: ${refs.join(", ")}.`);
  }
  lines.push(`Run at most ${policy.maxChildren} delegated children at once.`);
  lines.push(direct
    ? "No role fits the work, or its models are all skipped: do the work yourself."
    : "No role fits the work: choose from the ranked list below.");
  return lines.join("\n");
}
