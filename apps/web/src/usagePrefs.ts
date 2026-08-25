// F13 quota half: model-family grouping for provider quota windows plus
// browser-local display preferences (per-provider visibility, collapsed
// groups). Prefs live in localStorage under polyth.usagePrefs — they are
// telemetry display choices and never touch the event log or the server.
import { useSyncExternalStore } from "react";
import { tr } from "./i18n/index.ts";

// ---- model-family grouping (pure) ------------------------------------------

/** Canonical family per recognizable token; sub-brands fold into the vendor line. */
const FAMILY_ALIAS: Record<string, string> = {
  claude: "claude", sonnet: "claude", opus: "claude", haiku: "claude",
  gpt: "gpt", chatgpt: "gpt",
  codex: "codex",
  gemini: "gemini", gemma: "gemini",
  grok: "grok",
  llama: "llama",
  mistral: "mistral", mixtral: "mistral", codestral: "mistral",
  deepseek: "deepseek",
  qwen: "qwen", qwq: "qwen",
  kimi: "kimi",
  glm: "glm",
  phi: "phi",
};

const UPPER_LABELS = new Set([tr("usageprefs.gpt"), tr("usageprefs.glm")]);

/** Derive a model family from a quota window id/label. Returns null when the
 *  text does not look like a model name (e.g. "requests-day", "Spend (month)")
 *  so such windows group honestly under a general bucket instead of a fake
 *  family. Pure and total — never throws. */
export function modelFamily(text: string): string | null {
  const tokens = text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  for (const token of tokens) {
    const exact = FAMILY_ALIAS[token];
    if (exact) return exact;
    // o-series reasoning models: each generation is its own family (o1/o3/o4)
    if (/^o\d$/.test(token)) return token;
    // glued version suffixes: gpt4o, claude3, gemini15
    const prefix = /^([a-z]+)\d/.exec(token)?.[1];
    if (prefix && FAMILY_ALIAS[prefix]) return FAMILY_ALIAS[prefix];
  }
  return null;
}

/** Human label for a family id ("gpt" → "GPT", "claude" → "Claude", "o3" → "o3"). */
export function familyLabel(family: string): string {
  if (UPPER_LABELS.has(family)) return family.toUpperCase();
  if (/^o\d$/.test(family)) return family;
  return family.charAt(0).toUpperCase() + family.slice(1);
}

export interface QuotaWindowLike { id: string; label: string }

export interface QuotaWindowGroup<W extends QuotaWindowLike> {
  /** null = provider-level windows not tied to any model family */
  family: string | null;
  label: string;
  windows: W[];
}

/** Group quota windows by model family. The general (non-model) bucket comes
 *  first; family groups follow in first-appearance order so provider ordering
 *  is preserved. Window order inside each group is untouched. */
export function groupQuotaWindows<W extends QuotaWindowLike>(windows: readonly W[]): QuotaWindowGroup<W>[] {
  const byKey = new Map<string, QuotaWindowGroup<W>>();
  for (const w of windows) {
    const family = modelFamily(`${w.id} ${w.label}`);
    const key = family ?? "";
    let group = byKey.get(key);
    if (!group) {
      group = { family, label: family ? familyLabel(family) : tr("usageprefs.general"), windows: [] };
      byKey.set(key, group);
    }
    group.windows.push(w);
  }
  const all = [...byKey.values()];
  return [...all.filter((g) => g.family === null), ...all.filter((g) => g.family !== null)];
}

// ---- persisted display prefs ------------------------------------------------

export interface UsagePrefs {
  /** Provider ids unchecked in Settings → Usage; stay hidden after reload. */
  hiddenProviders: string[];
  /** Collapsed quota groups as "providerId/family" keys. */
  collapsedGroups: string[];
  /** Browser-local dashboard presentation, restored whenever Settings remounts. */
  dashboard: UsageDashboardPrefs;
}

export const USAGE_PREFS_KEY = "polyth.usagePrefs";

const MAX_ENTRIES = 128;
const DEFAULT_DASHBOARD_PREFS: UsageDashboardPrefs = {
  view: "overview",
  layout: "expanded",
  rangeDays: 7,
};

export interface UsageDashboardPrefs {
  view: "overview" | "providers";
  layout: "expanded" | "compact";
  rangeDays: 7 | 30 | 90;
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((s): s is string => typeof s === "string" && s !== "").slice(0, MAX_ENTRIES)
    : [];

export function parseUsagePrefs(raw: string | null): UsagePrefs {
  try {
    const data = JSON.parse(raw ?? "") as Partial<UsagePrefs>;
    const dashboard = data.dashboard as Partial<UsageDashboardPrefs> | undefined;
    return {
      hiddenProviders: stringList(data.hiddenProviders),
      collapsedGroups: stringList(data.collapsedGroups),
      dashboard: {
        view: dashboard?.view === "providers" ? "providers" : "overview",
        layout: dashboard?.layout === "compact" ? "compact" : "expanded",
        rangeDays: dashboard?.rangeDays === 30 || dashboard?.rangeDays === 90
          ? dashboard.rangeDays
          : 7,
      },
    };
  } catch {
    return {
      hiddenProviders: [],
      collapsedGroups: [],
      dashboard: { ...DEFAULT_DASHBOARD_PREFS },
    };
  }
}

const read = (): string | null => {
  try { return localStorage.getItem(USAGE_PREFS_KEY); } catch { return null; }
};

let prefs: UsagePrefs = parseUsagePrefs(read());
const listeners = new Set<() => void>();

export function getUsagePrefs(): UsagePrefs {
  return prefs;
}

function save(next: UsagePrefs): void {
  prefs = next;
  try { localStorage.setItem(USAGE_PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  for (const l of [...listeners]) l();
}

const toggled = (list: string[], entry: string, on: boolean): string[] =>
  on ? (list.includes(entry) ? list : [...list, entry].slice(-MAX_ENTRIES)) : list.filter((e) => e !== entry);

export function setProviderHidden(providerId: string, hidden: boolean): void {
  save({ ...prefs, hiddenProviders: toggled(prefs.hiddenProviders, providerId, hidden) });
}

export function setGroupCollapsed(key: string, collapsed: boolean): void {
  save({ ...prefs, collapsedGroups: toggled(prefs.collapsedGroups, key, collapsed) });
}

export function setUsageDashboardPrefs(patch: Partial<UsageDashboardPrefs>): void {
  save({ ...prefs, dashboard: { ...prefs.dashboard, ...patch } });
}

export function useUsagePrefs(): UsagePrefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    getUsagePrefs,
  );
}
