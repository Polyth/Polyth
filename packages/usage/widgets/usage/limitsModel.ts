import type { JsonObject, QuotaPace, QuotaWindow, SessionProjection } from "@polyth/contracts";
import type { UsageLimitBalance } from "../../src/limits.ts";
import { fmtCost, fmtTokens } from "../../../../apps/web/src/format.ts";
import { getLocale, tr } from "../../../../apps/web/src/i18n/index.ts";
import { displayHarness, displayProvider } from "../../src/providerIdentity.ts";
import { currentLimitSources, sourceFamily, windowAppliesToModel, type LimitsSession } from "../../src/limitSources.ts";

export { currentLimitSources, windowAppliesToModel };
import type { UsageLimitSnapshotDto } from "./limitsClient.ts";
import {
  isLimitSourceVisible,
  sourceId,
  type LimitBarColor,
  type LimitBarFactor,
  type LimitPaceSensitivity,
  type LimitResetFormat,
  type UsageLimitsPrefs,
} from "./limitsPrefs.ts";

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export const splitWindowLabel = (label: string): { label: string; valueLabel?: string } => {
  const separator = label.indexOf(" · ");
  return separator > 0
    ? { label: label.slice(0, separator), valueLabel: label.slice(separator + 3) }
    : { label };
};

export const relativeTime = (at: number, now: number): string => {
  const delta = at - now;
  const abs = Math.abs(delta);
  const formatter = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  if (abs < 90_000) return formatter.format(Math.round(delta / 60_000), "minute");
  if (abs < 36 * 3_600_000) return formatter.format(Math.round(delta / 3_600_000), "hour");
  return formatter.format(Math.round(delta / 86_400_000), "day");
};

const exactTime = (at: number): string =>
  new Intl.DateTimeFormat(getLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);

export const formatLimitReset = (
  at: number | undefined,
  mode: LimitResetFormat,
  now = Date.now(),
): string | null => {
  if (!at || !Number.isFinite(at)) return null;
  const relative = relativeTime(at, now);
  const exact = exactTime(at);
  if (mode === "exact") return exact;
  if (mode === "both") return `${relative} · ${exact}`;
  return relative;
};

const quantity = (value: number, unit: QuotaWindow["unit"]): string => {
  if (unit === "currency") return fmtCost(value);
  if (unit === "tokens") return fmtTokens(Math.round(value));
  if (unit === "percent") return `${Math.round(value)}%`;
  return Math.round(value).toLocaleString(getLocale());
};

export const remainingFraction = (window: QuotaWindow): number | null =>
  window.limit > 0 ? clamp01(1 - window.used / window.limit) : null;

export const measurableValue = (
  window: QuotaWindow,
  mode: "remaining" | "used",
): { primary: string; detail: string } => {
  const { valueLabel } = splitWindowLabel(window.label);
  if (window.limit <= 0) {
    return {
      primary: valueLabel ?? tr(/unlimited/i.test(window.label) ? "usage.limitUnlimited" : "usage.limitAvailable"),
      detail: tr("usage.limitNoCap"),
    };
  }

  const remaining = Math.max(0, window.limit - window.used);
  const percent = Math.round((mode === "remaining" ? remaining : window.used) / window.limit * 100);
  if (window.unit === "percent") {
    return {
      primary: tr(mode === "remaining" ? "usage.limitShareLeft" : "usage.limitShareUsed", { value: `${percent}%` }),
      detail: tr("usage.limitUsedOfLimit", { used: `${Math.round(window.used)}%`, limit: "100%" }),
    };
  }

  const selected = mode === "remaining" ? remaining : window.used;
  return {
    primary: tr(mode === "remaining" ? "usage.limitShareLeft" : "usage.limitShareUsed", { value: quantity(selected, window.unit) }),
    detail: tr("usage.limitUsedOfLimit", { used: quantity(window.used, window.unit), limit: quantity(window.limit, window.unit) }),
  };
};

export const balanceValue = (balance: UsageLimitBalance): string => {
  if (balance.valueLabel) return balance.valueLabel;
  if (balance.amount !== undefined) return quantity(balance.amount, balance.unit);
  return tr("usage.limitAvailable");
};

export type PaceState = "comfortable" | "on-track" | "elevated" | "likely" | "exhausted";

const paceThresholds = (sensitivity: LimitPaceSensitivity): { low: number; high: number } => {
  if (sensitivity === "stable") return { low: .75, high: 1.25 };
  if (sensitivity === "responsive") return { low: .92, high: 1.08 };
  return { low: .85, high: 1.15 };
};

// Use the same observed rate as the projection when enough samples exist.
// Dividing usage by near-zero elapsed time otherwise exaggerates an initial burst.
const observedPaceRatio = (pace: QuotaPace, window: QuotaWindow): number =>
  pace.predictedAtReset !== undefined && window.limit > 0
    ? pace.predictedAtReset / window.limit
    : pace.usageFraction / pace.timeFraction;

export const classifyLimitPace = (
  pace: QuotaPace | null | undefined,
  window: QuotaWindow,
  sensitivity: LimitPaceSensitivity,
): PaceState | null => {
  const remaining = remainingFraction(window);
  if (remaining !== null && remaining <= 0) return "exhausted";
  if (!pace) return null;
  if (pace.exhaustsAt !== undefined && window.resetsAt !== undefined && pace.exhaustsAt < window.resetsAt) return "likely";
  if (pace.predictedAtReset === undefined && pace.timeFraction * (window.periodMs ?? 0) < 5 * 60_000) return null;
  const ratio = observedPaceRatio(pace, window);
  const { low, high } = paceThresholds(sensitivity);
  if (ratio > high) return "elevated";
  if (ratio < low) return "comfortable";
  return "on-track";
};

/**
 * Continuous pacing pressure in `[0, 1]` for a window's progress fill:
 * `0` is comfortably below the steady budget, `0.5` sits on it, and `1` is at
 * or past the sensitivity threshold that flags the window. It follows the same
 * observed rate as {@link classifyLimitPace}, so the fill colour and the status
 * text cannot contradict each other, and it depends on pace alone — never on
 * the raw remaining share. `null` means there is not yet a usable pace reading.
 */
export const pacePressure = (
  pace: QuotaPace | null | undefined,
  window: QuotaWindow,
  sensitivity: LimitPaceSensitivity,
): number | null => {
  const remaining = remainingFraction(window);
  if (remaining !== null && remaining <= 0) return 1;
  if (!pace) return null;
  if (pace.exhaustsAt !== undefined && window.resetsAt !== undefined && pace.exhaustsAt < window.resetsAt) return 1;
  if (pace.predictedAtReset === undefined && pace.timeFraction * (window.periodMs ?? 0) < 5 * 60_000) return null;
  const ratio = observedPaceRatio(pace, window);
  if (Number.isNaN(ratio)) return null;
  const { low, high } = paceThresholds(sensitivity);
  return clamp01((ratio - low) / (high - low));
};

export const paceLabel = (state: PaceState): string => {
  if (state === "comfortable") return tr("usage.paceComfortable");
  if (state === "on-track") return tr("usage.paceOnTrack");
  if (state === "elevated") return tr("usage.paceElevated");
  if (state === "likely") return tr("usage.paceLikely");
  return tr("usage.paceExhausted");
};

export type LimitBarTone = "ok" | "warning" | "critical";

export interface LimitBarColorView {
  /** Which preference produced this colour. */
  factor: LimitBarFactor;
  /** Weight in `[0, 1]`: 0 stays in the calm colour, 1 is the alarm colour. */
  pressure: number | null;
  /** Set only while `factor` is `static`; the palette slot to paint. */
  color: LimitBarColor | null;
  /** Coarse bucket, used for widget meters and for text that mirrors the bar. */
  tone: LimitBarTone;
}

/**
 * Continuous pressure from the remaining share alone: below the critical
 * threshold the bar is fully alarmed, at and above the low threshold it is
 * calm, and the ramp between them is linear. A cap-less window has no share to
 * read, so it reports `null` rather than a healthy-looking zero.
 */
export const percentPressure = (
  remainingFraction: number | null,
  lowPercent: number,
  criticalPercent: number,
): number | null => {
  if (remainingFraction === null) return null;
  const remaining = clamp01(remainingFraction) * 100;
  // A share that reads as the threshold within float noise belongs to that band:
  // a 5% window must not land a hair inside the ramp because 0.05 * 100 is
  // 5.000000000000001. Widen the endpoints by a tolerance and keep the ramp
  // itself continuous.
  const EPSILON = 1e-9;
  // A degenerate scale (critical at or above low) is a step: everything below
  // the low threshold is fully alarmed, so this must be decided before the ramp.
  if (criticalPercent >= lowPercent) return remaining >= lowPercent - EPSILON ? 0 : 1;
  if (remaining >= lowPercent - EPSILON) return 0;
  if (remaining <= criticalPercent + EPSILON) return 1;
  return clamp01((lowPercent - remaining) / (lowPercent - criticalPercent));
};

const toneForPressure = (pressure: number | null): LimitBarTone =>
  pressure === null ? "ok" : pressure >= .75 ? "critical" : pressure >= .5 ? "warning" : "ok";

/**
 * The colour a used-limit bar follows, resolved from the user's bar-colour
 * preference. All three modes live here so the Limits page bar, the widget
 * meters and their text can never disagree: `percent` follows the remaining
 * share, `pace` follows the burn rate through {@link pacePressure}, and
 * `static` pins one palette slot. `pace` falls back to the percent reading
 * while a window has no usable pace sample, so a bar is never uncoloured for
 * lack of data the user can still see.
 */
export function limitBarColor(
  window: QuotaWindow,
  pace: QuotaPace | null | undefined,
  prefs: Pick<UsageLimitsPrefs, "barFactor" | "barColor" | "lowRemainingPercent" | "criticalRemainingPercent" | "paceSensitivity">,
): LimitBarColorView {
  const remaining = remainingFraction(window);
  const percent = percentPressure(remaining, prefs.lowRemainingPercent, prefs.criticalRemainingPercent);
  if (prefs.barFactor === "static") {
    return { factor: "static", pressure: null, color: prefs.barColor, tone: "ok" };
  }
  if (prefs.barFactor === "percent") {
    return { factor: "percent", pressure: percent, color: null, tone: toneForPressure(percent) };
  }
  const paced = pacePressure(pace, window, prefs.paceSensitivity);
  const pressure = paced === null ? percent : paced;
  return { factor: "pace", pressure, color: null, tone: toneForPressure(pressure) };
}

export const paceProjection = (
  pace: QuotaPace,
  window: QuotaWindow,
  now: number,
): string | null => {
  // An already exhausted window has nothing left to forecast: the remaining
  // share alone says it, and appending "may exhaust …" contradicts the state.
  const remaining = remainingFraction(window);
  if (remaining !== null && remaining <= 0) return null;
  if (pace.exhaustsAt !== undefined && window.resetsAt !== undefined && pace.exhaustsAt < window.resetsAt) {
    return tr("usage.paceMayExhaust", { when: relativeTime(pace.exhaustsAt, now) });
  }
  if (pace.predictedAtReset === undefined || window.limit <= 0) return null;
  const predictedRemaining = clamp01(1 - pace.predictedAtReset / window.limit);
  return tr("usage.paceLeftAtReset", { percent: Math.round(predictedRemaining * 100) });
};

/** Wall-clock time of a moment: `22:25` today, `Thu 06:10` on another day. */
const clockTime = (at: number, now: number): string => {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(getLocale(), sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { weekday: "short", hour: "numeric", minute: "2-digit" }).format(at);
};

/**
 * The pace verdict in a few words, for a row that has no room for the full
 * forecast: when a window will run out if that is before its reset, otherwise
 * the pace label with the share left at reset. Projections follow the user's
 * preference, so with them off only the label remains.
 */
export const paceBrief = (
  state: PaceState,
  pace: QuotaPace,
  window: QuotaWindow,
  now: number,
  showProjections: boolean,
): string => {
  if (!showProjections || state === "exhausted") return paceLabel(state);
  if (pace.exhaustsAt !== undefined && window.resetsAt !== undefined && pace.exhaustsAt < window.resetsAt) {
    return tr("usage.paceRunsOut", { time: clockTime(pace.exhaustsAt, now) });
  }
  if (pace.predictedAtReset === undefined || window.limit <= 0) return paceLabel(state);
  const left = Math.round(clamp01(1 - pace.predictedAtReset / window.limit) * 100);
  return tr("usage.paceLabelLeftAtReset", { label: paceLabel(state), percent: left });
};

export const formatLimitPaceBudget = (pace: QuotaPace): string | null => {
  // The elapsed-window budget and the observed-rate forecast are different
  // measures. Show the budget only when there is no observed-rate forecast.
  if (pace.predictedAtReset !== undefined) return null;
  const delta = Math.round((pace.usageFraction - pace.timeFraction) * 100);
  if (delta === 0) return tr("usage.paceAtBudget");
  return tr(delta > 0 ? "usage.paceAboveBudget" : "usage.paceBelowBudget", { points: Math.abs(delta) });
};

// ---- Limits widget ---------------------------------------------------------

export const LIMITS_WIDGET_STYLES = ["bars", "pace", "rings", "segments", "chips", "table", "hero"] as const;
export type LimitsWidgetStyle = (typeof LIMITS_WIDGET_STYLES)[number];
export type LimitsWidgetSource = "current" | "selected" | "all";

export interface LimitsWidgetPrefs {
  style: LimitsWidgetStyle;
  source: LimitsWidgetSource;
  /** Normalized provider ids, used only by the `selected` source. */
  sources: string[];
  showReset: boolean;
}

/**
 * Per-instance presentation config; unknown or legacy values fall back to the
 * defaults. Pace is the default style: the steady-budget tick and the short
 * verdict explain the bar's colour, which plain bars leave unexplained.
 */
export function limitsWidgetPreferences(config: Readonly<JsonObject>): LimitsWidgetPrefs {
  return {
    style: LIMITS_WIDGET_STYLES.find((style) => style === config.style) ?? "pace",
    source: config.source === "selected" || config.source === "all" ? config.source : "current",
    sources: Array.isArray(config.sources)
      ? [...new Set(config.sources.filter((id): id is string => typeof id === "string").map(sourceId).filter(Boolean))].slice(0, 64)
      : [],
    showReset: config.showReset !== false,
  };
}

type LimitSourceRef = Pick<UsageLimitSnapshotDto, "providerId" | "account">;

/** A source's display name; one account of a multi-account harness reads `<source> · <account>`. */
export function limitSourceName(source: LimitSourceRef): string {
  const family = source.account?.family ?? source.providerId;
  const name = displayProvider(family) || family;
  return source.account ? `${name} · ${source.account.label}` : name;
}

/**
 * Keeps every account beside its family's default source, otherwise in snapshot
 * order. `userOrder` (the dragged Limits layout) takes precedence for the ids it
 * names; sources it does not name keep the family grouping after them, so a
 * newly reported source still appears beside its family.
 */
export function orderLimitSources<T extends LimitSourceRef>(sources: readonly T[], userOrder: readonly string[] = []): T[] {
  const rank = new Map(userOrder.map((id, index) => [sourceId(id), index]));
  const first = new Map<string, number>();
  sources.forEach((source, index) => {
    const family = sourceFamily(source);
    if (!first.has(family)) first.set(family, index);
  });
  return sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) => {
      const aRank = rank.get(sourceId(a.source.providerId));
      const bRank = rank.get(sourceId(b.source.providerId));
      if (aRank !== undefined || bRank !== undefined) {
        if (aRank === undefined) return 1;
        if (bRank === undefined) return -1;
        return aRank - bRank || a.index - b.index;
      }
      return first.get(sourceFamily(a.source))! - first.get(sourceFamily(b.source))!
        || Number(Boolean(a.source.account)) - Number(Boolean(b.source.account))
        || a.index - b.index;
    })
    .map(({ source }) => source);
}

/**
 * Put the visible panels' new order back into the full layout: hidden sources
 * keep their slots, so showing one again returns it where the user left it.
 * `baseOrder` is the full current order as drawn; `visibleBefore` and
 * `visibleAfter` are the same visible ids before and after the drag.
 */
export function mergeLimitSourceOrder(
  baseOrder: readonly string[],
  visibleBefore: readonly string[],
  visibleAfter: readonly string[],
): string[] {
  const moving = new Set(visibleBefore);
  let cursor = 0;
  const merged = baseOrder.map((id) => moving.has(id) ? visibleAfter[cursor++] ?? id : id);
  for (const id of visibleAfter) {
    if (!merged.includes(id)) merged.push(id);
  }
  return merged;
}

/** The session harness's name, using a limits source's account label when it has one. */
export function limitsHarnessName(harnessId: string, sources: readonly LimitSourceRef[]): string {
  const id = sourceId(harnessId);
  const account = sources.find((source) => source.account && sourceId(source.account.harnessId) === id)?.account;
  return account ? `${displayHarness(account.family)} · ${account.label}` : displayHarness(harnessId);
}

/** Sources the widget shows: the current harness/model's, the chosen ones, or every visible one. */
export function limitProviders(
  providers: readonly UsageLimitSnapshotDto[],
  prefs: LimitsWidgetPrefs,
  limitsPrefs: UsageLimitsPrefs,
  session: LimitsSession | null,
): UsageLimitSnapshotDto[] {
  const ordered = orderLimitSources(providers);
  if (prefs.source === "selected") return ordered.filter((provider) => prefs.sources.includes(sourceId(provider.providerId)));
  if (prefs.source === "all") return ordered.filter((provider) => isLimitSourceVisible(provider.providerId, limitsPrefs));
  const current = currentLimitSources(session, providers);
  return ordered.filter((provider) => current.includes(provider.providerId));
}

export type LimitTone = LimitBarTone;

export interface LimitRowView {
  key: string;
  label: string;
  /** Full value, e.g. "98% left". */
  value: string;
  /** Compact value for chips and rings, e.g. "98%". */
  short: string;
  /** "left" or "used" beside a measurable value. */
  word: string;
  detail: string;
  /** Remaining fraction of the cap; null when the source reports no comparable cap. */
  remaining: number | null;
  /** Fraction a meter fills: remaining or used, following the display preference. */
  fill: number | null;
  tone: LimitTone;
  /** Colour the fill follows, from the bar-colour preference. */
  bar: LimitBarColorView;
  reset: string | null;
  /** Steady-budget position along the meter, from the window's elapsed time. */
  tick: number | null;
  /** `brief` is the few-word verdict a row's meta line has room for; `text` the full forecast. */
  pace: { label: string; text: string; brief: string } | null;
}

export interface LimitGroupView {
  providerId: string;
  name: string;
  account: string | undefined;
  stale: boolean;
  error: string | undefined;
  rows: LimitRowView[];
}

const windowRow = (
  providerId: string,
  window: QuotaWindow,
  pace: QuotaPace | null | undefined,
  prefs: UsageLimitsPrefs,
  now: number,
): LimitRowView => {
  const remaining = remainingFraction(window);
  const remainingPercent = remaining === null ? null : Math.round(remaining * 100);
  const fill = remaining === null ? null : prefs.displayMode === "remaining" ? remaining : clamp01(window.used / window.limit);
  const value = measurableValue(window, prefs.displayMode);
  const state = classifyLimitPace(pace, window, prefs.paceSensitivity);
  const paced = prefs.showPace && window.resetsAt !== undefined && window.periodMs !== undefined && pace;
  const bar = limitBarColor(window, pace, prefs);
  return {
    key: `${providerId}/${window.id}`,
    label: splitWindowLabel(window.label).label,
    value: value.primary,
    short: fill === null ? value.primary : `${Math.round(fill * 100)}%`,
    word: fill === null ? "" : prefs.displayMode === "remaining" ? tr("usage.limitWordLeft") : tr("usage.limitWordUsed"),
    detail: value.detail,
    remaining,
    fill,
    // The bar's colour follows the user's bar-colour preference; the row tone
    // stays the attention marker (low remaining or a pace warning), so the two
    // can disagree only where the user asked them to.
    tone: state === "exhausted" || (prefs.paceWarnings && state === "likely")
      ? "critical"
      : remainingPercent !== null && remainingPercent <= prefs.lowRemainingPercent ? "warning" : "ok",
    bar,
    reset: formatLimitReset(window.resetsAt, prefs.resetFormat, now),
    tick: paced ? (prefs.displayMode === "remaining" ? 1 - paced.timeFraction : paced.timeFraction) : null,
    pace: paced && state
      ? {
        label: paceLabel(state),
        text: [paceLabel(state), formatLimitPaceBudget(paced), prefs.showProjections ? paceProjection(paced, window, now) : null]
          .filter(Boolean).join(" · "),
        brief: paceBrief(state, paced, window, now, prefs.showProjections),
      }
      : null,
  };
};

const balanceRow = (providerId: string, balance: UsageLimitBalance): LimitRowView => {
  const value = balanceValue(balance);
  return {
    key: `${providerId}/${balance.id}`,
    label: balance.label,
    value,
    short: value,
    word: "",
    detail: "",
    remaining: null,
    fill: null,
    tone: "ok",
    bar: { factor: "static", pressure: null, color: null, tone: "ok" },
    reset: null,
    tick: null,
    pace: null,
  };
};

/**
 * Display rows per source. `model` is passed for the current harness/model:
 * windows scoped to a different model are then left out.
 */
export function limitGroups(
  providers: readonly UsageLimitSnapshotDto[],
  prefs: UsageLimitsPrefs,
  now: number,
  model?: { id: string | undefined },
): LimitGroupView[] {
  return providers.flatMap((provider) => {
    const name = limitSourceName(provider);
    const rows = [
      ...provider.windows
        .filter((window) => !model || windowAppliesToModel(window.id, model.id))
        .map((window) => windowRow(provider.providerId, window, provider.pace?.[window.id], prefs, now)),
      ...provider.balances.map((balance) => balanceRow(provider.providerId, balance)),
    ];
    return rows.length > 0 || provider.error
      ? [{
        providerId: provider.providerId,
        name,
        // Most sources label the account with their own name; repeating it says nothing.
        account: provider.accountLabel?.trim().toLowerCase() === name.toLowerCase() ? undefined : provider.accountLabel,
        stale: provider.stale,
        error: provider.error?.message,
        rows,
      }]
      : [];
  });
}
