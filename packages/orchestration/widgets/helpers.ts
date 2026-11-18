// Pure helpers of the Orchestration settings page: draft comparison, chain
// edits, custom-role ids and the status/meter vocabulary. No React, no host.
import {
  CUSTOM_ROLE_PREFIX,
  type ModelOption,
  POLICY_LIMITS,
  type ChoiceStatus,
  type HarnessRule,
  type ModelChoice,
  type ShortlistRow,
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
    // A state from an older server has no order fields.
    pinned: [...(stored.pinned ?? [])],
    demoted: [...(stored.demoted ?? [])],
    harnesses: { ...(stored.harnesses ?? {}) },
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
  const sameList = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((key, i) => key === y[i]);
  if (!sameList(a.excluded, b.excluded) || !sameList(a.pinned, b.pinned) || !sameList(a.demoted, b.demoted)) return false;
  const rules = (p: RoutingPolicy) => JSON.stringify(Object.entries(p.harnesses).sort(([x], [y]) => x.localeCompare(y)));
  if (rules(a) !== rules(b)) return false;
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
/** Readable harness id when the registry has no name for it: `opencode-go` → "Opencode Go". */
export const harnessLabel = (id: string): string =>
  id.split(/[-_]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") || id;

/** The registry's name when the server sent one, else a readable id. */
export const harnessDisplay = (id: string, name?: string): string => name?.trim() || harnessLabel(id);

const squash = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A quota source reads as its harness with the plan beside it. A label that
 *  already names the harness or restates the source ("OpenCode Go" for
 *  `opencode-go`, metering OpenCode) becomes the title on its own. */
export function quotaSourceName(source: { sourceId: string; label?: string | undefined; harnessName?: string | undefined }): { title: string; plan: string } {
  const label = source.label?.trim() ?? "";
  const harness = source.harnessName?.trim();
  if (label && (squash(label) === squash(source.sourceId) || (harness && squash(label).includes(squash(harness))))) {
    return { title: label, plan: "" };
  }
  return { title: harness || harnessLabel(source.sourceId), plan: label ? label.charAt(0).toUpperCase() + label.slice(1) : "" };
}

export type Placement = NonNullable<ShortlistRow["placed"]>;
type OrderPolicy = Pick<RoutingPolicy, "excluded" | "pinned" | "demoted" | "harnesses">;
const TIER: Record<Placement | "none", number> = { pinned: 0, preferred: 1, none: 2, avoided: 3, demoted: 4 };

/** The person's order applied to rows the server ranked, so an edit shows at
 *  once; the server's preview then confirms it. Same rule as Usage: usable
 *  rows first, then pins, preferred harnesses, the rest, avoided harnesses
 *  and demotions; the server's order inside each tier. Never-listed rows go. */
export function orderRows(rows: readonly ShortlistRow[], policy: OrderPolicy): ShortlistRow[] {
  const never = new Set(policy.excluded);
  const pin = new Map(policy.pinned.map((key, i) => [key, i]));
  const demote = new Map(policy.demoted.map((key, i) => [key, i]));
  const placedOf = (row: ShortlistRow): Placement | undefined => {
    if (pin.has(row.key)) return "pinned";
    if (demote.has(row.key)) return "demoted";
    const rule = policy.harnesses[row.harnessId];
    return rule === "prefer" ? "preferred" : rule === "avoid" ? "avoided" : undefined;
  };
  const usable = (row: ShortlistRow): number => row.available && !row.blocked ? 0 : 1;
  const within = (row: ShortlistRow): number => pin.get(row.key) ?? demote.get(row.key) ?? 0;
  return rows
    .filter((row) => !never.has(row.key) && policy.harnesses[row.harnessId] !== "never")
    .map((row, index): { row: ShortlistRow; index: number } => {
      const { placed: _old, ...rest } = row;
      const placed = placedOf(row);
      return { row: placed ? { ...rest, placed } : rest, index };
    })
    .sort((a, b) => usable(a.row) - usable(b.row)
      || TIER[a.row.placed ?? "none"] - TIER[b.row.placed ?? "none"]
      || within(a.row) - within(b.row)
      || a.index - b.index)
    .map(({ row }) => row);
}

/** Why a row sits where it does, most decisive reason first. */
export function rankReasons(row: ShortlistRow, windowDays: number, translate: Translate): string[] {
  const harness = harnessDisplay(row.harnessId, row.harnessName);
  const out: string[] = [];
  if (!row.available || row.blocked) out.push(translate("orchestration.why.unusable"));
  if (row.placed) out.push(translate(`orchestration.why.${row.placed}`, { harness }));
  if (row.favorite) out.push(translate("orchestration.why.starred", { n: (row.favoriteIndex ?? 0) + 1 }));
  out.push(row.turns > 0
    ? translate("orchestration.why.turns", { count: row.turns, days: windowDays })
    : translate("orchestration.why.unused", { days: windowDays }));
  const used = percent(row.quotaUsed);
  if (used !== undefined && row.quotaWindow) out.push(translate("orchestration.why.quota", { window: row.quotaWindow.label, used }));
  return out;
}

/** Policy edits from a ranked row. Each keeps a key in one list only. */
export const orderEdits = {
  pin(policy: RoutingPolicy, key: string): RoutingPolicy {
    if (policy.pinned.includes(key) || policy.pinned.length >= POLICY_LIMITS.pinned) return policy;
    return { ...policy, pinned: [key, ...policy.pinned], demoted: policy.demoted.filter((k) => k !== key) };
  },
  unpin: (policy: RoutingPolicy, key: string): RoutingPolicy => ({ ...policy, pinned: policy.pinned.filter((k) => k !== key) }),
  move(policy: RoutingPolicy, key: string, delta: -1 | 1): RoutingPolicy {
    const from = policy.pinned.indexOf(key);
    if (from < 0) return policy;
    return { ...policy, pinned: moveItem(policy.pinned, from, from + delta) };
  },
  demote(policy: RoutingPolicy, key: string): RoutingPolicy {
    if (policy.demoted.includes(key) || policy.demoted.length >= POLICY_LIMITS.demoted) return policy;
    return { ...policy, demoted: [...policy.demoted, key], pinned: policy.pinned.filter((k) => k !== key) };
  },
  undemote: (policy: RoutingPolicy, key: string): RoutingPolicy => ({ ...policy, demoted: policy.demoted.filter((k) => k !== key) }),
  never(policy: RoutingPolicy, key: string): RoutingPolicy {
    if (policy.excluded.includes(key) || policy.excluded.length >= POLICY_LIMITS.excluded) return policy;
    return {
      ...policy,
      excluded: [...policy.excluded, key],
      pinned: policy.pinned.filter((k) => k !== key),
      demoted: policy.demoted.filter((k) => k !== key),
    };
  },
  harness(policy: RoutingPolicy, id: string, rule: HarnessRule | "normal"): RoutingPolicy {
    const { [id]: _old, ...rest } = policy.harnesses;
    if (rule === "normal") return { ...policy, harnesses: rest };
    if (!(id in policy.harnesses) && Object.keys(rest).length >= POLICY_LIMITS.harnesses) return policy;
    return { ...policy, harnesses: { ...rest, [id]: rule } };
  },
};

/** Harnesses to filter by: those with listed rows, then any the policy rules. */
export function harnessChips(
  rows: readonly ShortlistRow[],
  known: ReadonlyArray<{ id: string; name: string }>,
  policy: Pick<RoutingPolicy, "harnesses">,
): Array<{ id: string; name: string; count: number; rule?: HarnessRule }> {
  const names = new Map(known.map((h) => [h.id, h.name]));
  const out = new Map<string, { id: string; name: string; count: number; rule?: HarnessRule }>();
  for (const row of rows) {
    const chip = out.get(row.harnessId) ?? { id: row.harnessId, name: harnessDisplay(row.harnessId, row.harnessName ?? names.get(row.harnessId)), count: 0 };
    chip.count += 1;
    out.set(row.harnessId, chip);
  }
  for (const id of Object.keys(policy.harnesses)) {
    if (!out.has(id)) out.set(id, { id, name: harnessDisplay(id, names.get(id)), count: 0 });
  }
  for (const chip of out.values()) {
    const rule = policy.harnesses[chip.id];
    if (rule) chip.rule = rule;
  }
  return [...out.values()];
}

/** Rows a quota window meters, with their rank (1-based). */
export function rowsMeteredBy(rows: readonly ShortlistRow[], sourceId: string, windowId: string): Array<{ rank: number; row: ShortlistRow }> {
  return rows.flatMap((row, i) =>
    row.quotaWindows?.some((w) => w.sourceId === sourceId && w.windowId === windowId) ? [{ rank: i + 1, row }] : []);
}

/** `overPace` is the roles-mode over-pace level, applied while the window runs over pace. */
export function meterTone(used: number | undefined, ceiling: number, blocked = false, overPace?: { level: number | null; pace?: string | undefined }): Tone {
  if (blocked || (used !== undefined && used >= 1)) return "danger";
  const value = percent(used);
  if (value === undefined) return "neutral";
  if (value >= ceiling) return "warning";
  const level = overPace?.level;
  if (level !== null && level !== undefined && overPace?.pace === "over" && value >= level) return "warning";
  return "neutral";
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
