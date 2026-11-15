// Pure helpers of the Orchestration settings page: draft comparison, chain
// edits, custom-role ids and the status/meter vocabulary. No React, no host.
import {
  CUSTOM_ROLE_PREFIX,
  type ModelOption,
  POLICY_LIMITS,
  type ChoiceStatus,
  type ModelChoice,
  type RoutingPolicy,
  type RoutingRole,
  type StoredRoutingPolicy,
} from "../src/contracts.ts";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The saved policy minus its bookkeeping (`revision`, `updatedAt`). */
export function policyOf(stored: RoutingPolicy | StoredRoutingPolicy): RoutingPolicy {
  return {
    mode: stored.mode,
    roles: stored.roles.map(cloneRole),
    quotaCeiling: stored.quotaCeiling,
    overPaceCeiling: stored.overPaceCeiling,
    whenExhausted: stored.whenExhausted,
    maxChildren: stored.maxChildren,
    excluded: [...stored.excluded],
  };
}

export const cloneChoice = (choice: ModelChoice): ModelChoice => ({
  harnessId: choice.harnessId,
  providerID: choice.providerID,
  modelID: choice.modelID,
  ...(choice.maxConcurrent !== undefined ? { maxConcurrent: choice.maxConcurrent } : {}),
});

export const cloneRole = (role: RoutingRole): RoutingRole => ({
  id: role.id,
  ...(role.label !== undefined ? { label: role.label } : {}),
  ...(role.when !== undefined ? { when: role.when } : {}),
  enabled: role.enabled,
  models: role.models.map(cloneChoice),
});

const canonicalRole = (role: RoutingRole) =>
  [role.id, role.label ?? "", role.when ?? "", role.enabled, role.models.map((m) => [m.harnessId, m.providerID, m.modelID, m.maxConcurrent ?? null])];

/** True when two drafts would save the same policy. */
export function policiesEqual(a: RoutingPolicy, b: RoutingPolicy): boolean {
  if (a.mode !== b.mode || a.quotaCeiling !== b.quotaCeiling || a.overPaceCeiling !== b.overPaceCeiling
    || a.whenExhausted !== b.whenExhausted || a.maxChildren !== b.maxChildren) return false;
  if (a.excluded.length !== b.excluded.length || a.excluded.some((key, i) => key !== b.excluded[i])) return false;
  if (a.roles.length !== b.roles.length) return false;
  return JSON.stringify(a.roles.map(canonicalRole)) === JSON.stringify(b.roles.map(canonicalRole));
}

/** Move the entry at `from` to `to` (clamped). Returns the same array when nothing moves. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  if (target === from) return next;
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

export function removeItem<T>(items: readonly T[], index: number): T[] {
  return items.filter((_, i) => i !== index);
}

/** `a-z0-9-` slug of a role name, at most 32 characters; empty when nothing usable remains. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

/** `custom-<slug>` that collides with none of `taken`; `-2`, `-3` … on collision. */
export function customRoleId(name: string, taken: readonly string[]): string {
  const base = `${CUSTOM_ROLE_PREFIX}${slugify(name) || "role"}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${taken.length + 1}`;
}

/** Keep the over-pace level at or below the quota threshold. */
export function withQuotaCeiling(policy: RoutingPolicy, ceiling: number): RoutingPolicy {
  const quotaCeiling = clamp(ceiling, POLICY_LIMITS.quotaCeiling.min, POLICY_LIMITS.quotaCeiling.max);
  const over = policy.overPaceCeiling;
  return { ...policy, quotaCeiling, overPaceCeiling: over === null ? null : Math.min(over, quotaCeiling) };
}

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** Status chip vocabulary: i18n key and tone per `ChoiceStatus`. `ready` is quiet. */
export const STATUS_KEY: Record<ChoiceStatus, string> = {
  ready: "orchestration.status.ready",
  unverified: "orchestration.status.unverified",
  ceiling: "orchestration.status.ceiling",
  "over-pace": "orchestration.status.overPace",
  blocked: "orchestration.status.blocked",
  unavailable: "orchestration.status.unavailable",
  unlisted: "orchestration.status.unlisted",
  excluded: "orchestration.status.excluded",
};

export function statusTone(status: ChoiceStatus): Tone {
  switch (status) {
    case "ready": return "success";
    case "blocked": return "danger";
    case "ceiling":
    case "over-pace": return "warning";
    default: return "neutral";
  }
}

export const percent = (used: number | undefined): number | undefined =>
  used === undefined || !Number.isFinite(used) ? undefined : Math.round(clamp(used, 0, 1) * 100);

/** Bar tone: below the ceiling neutral, at/above it warning, an exhausted window danger. */
export function meterTone(used: number | undefined, ceiling: number, blocked = false): Tone {
  if (blocked || (used !== undefined && used >= 1)) return "danger";
  const value = percent(used);
  return value !== undefined && value >= ceiling ? "warning" : "neutral";
}

/** Compact span ("42 min", "3 h", "2 d") for a millisecond distance. */
export function formatSpan(ms: number, translate: Translate): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return translate("orchestration.time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return translate("orchestration.time.hours", { count: hours });
  return translate("orchestration.time.days", { count: Math.round(hours / 24) });
}

export function formatAgo(at: number, now: number, translate: Translate): string {
  const delta = now - at;
  if (delta < 60_000) return translate("orchestration.time.now");
  return translate("orchestration.time.ago", { time: formatSpan(delta, translate) });
}

/** Status text of a chain row, already filled with its numbers. */
export function statusText(
  choice: { status: ChoiceStatus; quotaUsed?: number; blockedUntil?: number },
  ceiling: number,
  now: number,
  translate: Translate,
): string {
  const used = percent(choice.quotaUsed) ?? 0;
  switch (choice.status) {
    case "ceiling": return translate(STATUS_KEY.ceiling, { used, limit: ceiling });
    case "over-pace": return translate(STATUS_KEY["over-pace"], { used });
    case "blocked":
      return choice.blockedUntil && choice.blockedUntil > now
        ? translate(STATUS_KEY.blocked, { time: formatSpan(choice.blockedUntil - now, translate) })
        : translate("orchestration.status.blockedNoTime");
    default: return translate(STATUS_KEY[choice.status]);
  }
}

/** `"{n}/{max}"` counter value, counting by characters not UTF-16 units. */
export const charCount = (text: string): number => [...text].length;

export function limitText(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

export interface PickerGroup {
  id: string;
  title: string;
  models: ModelOption[];
}

/** Starred (the person's order), recently used, then one group per harness. A model sits in one group. */
export function groupModels(models: readonly ModelOption[], query: string, harnessTitle: (id: string) => string, labels: { starred: string; recent: string }): PickerGroup[] {
  const needle = query.trim().toLowerCase();
  const match = (m: ModelOption) => needle === ""
    || [m.name, m.modelID, m.providerID, m.providerName ?? "", m.harnessId, m.runs ?? ""].some((part) => part.toLowerCase().includes(needle));
  const visible = models.filter(match);
  const starred = visible.filter((m) => m.favorite).sort((a, b) => (a.favoriteIndex ?? 1e9) - (b.favoriteIndex ?? 1e9));
  const taken = new Set(starred.map((m) => m.key));
  const recent = visible.filter((m) => !taken.has(m.key) && m.turns > 0).sort((a, b) => b.turns - a.turns);
  for (const m of recent) taken.add(m.key);
  const groups: PickerGroup[] = [];
  if (starred.length) groups.push({ id: "starred", title: labels.starred, models: starred });
  if (recent.length) groups.push({ id: "recent", title: labels.recent, models: recent });
  const byHarness = new Map<string, ModelOption[]>();
  for (const m of visible) {
    if (taken.has(m.key)) continue;
    const list = byHarness.get(m.harnessId) ?? [];
    list.push(m);
    byHarness.set(m.harnessId, list);
  }
  for (const [id, list] of byHarness) groups.push({ id: `harness:${id}`, title: harnessTitle(id), models: list });
  return groups;
}

/** "128K" / "1M" / "1.5M" for a context window in tokens. */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = Math.round(tokens / 100_000) / 10;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/** "Name — status" for the first `limit` choices of a role that none can serve. */
export function skippedReasons(
  choices: ReadonlyArray<{ name: string; status: ChoiceStatus; quotaUsed?: number; blockedUntil?: number }>,
  ceiling: number,
  now: number,
  translate: Translate,
  limit = 2,
): string {
  return choices.slice(0, limit).map((c) => `${c.name} — ${statusText(c, ceiling, now, translate)}`).join(" · ");
}
