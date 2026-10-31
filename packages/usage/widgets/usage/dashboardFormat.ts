import { fmtCost, fmtDuration, fmtMs, fmtTokens } from "../../../../apps/web/src/format.ts";
import { formatNumber, getLocale, tr } from "../../../../apps/web/src/i18n/index.ts";
import type { UsageBucket, UsageChartMetric, UsageTrend } from "../../src/analytics/contracts.ts";
import type { UsageDashboardRange } from "./dashboardLayout.ts";

const known = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

export const formatCount = (value: number | null | undefined): string =>
  known(value) ? value.toLocaleString(getLocale()) : "—";

export const formatPercent = (value: number | null | undefined): string =>
  known(value) ? `${Math.round(value)}%` : "—";

export const formatMoney = (value: number | null | undefined, complete = true): string => {
  if (!known(value)) return "—";
  const formatted = fmtCost(value);
  return complete ? formatted : `≥${formatted}`;
};

export const formatTokens = (value: number | null | undefined, complete = true): string => {
  if (!known(value)) return "—";
  const formatted = fmtTokens(Math.round(value));
  return complete ? formatted : `≥${formatted}`;
};

export const formatRate = (value: number | null | undefined): string =>
  known(value)
    ? tr("usage.tokensPerSecond", {
      value: formatNumber(value, {
        minimumFractionDigits: value >= 100 ? 0 : 1,
        maximumFractionDigits: value >= 100 ? 0 : 1,
      }),
    })
    : "—";

export const formatDurationValue = (value: number | null | undefined): string =>
  known(value) ? fmtDuration(value) : "—";

export const formatLatency = (value: number | null | undefined): string =>
  known(value) ? fmtMs(value) : "—";

export const formatMetric = (metric: UsageChartMetric, value: number | null | undefined, complete = true): string => {
  if (metric === "tokens") return formatTokens(value, complete);
  if (metric === "cost") return formatMoney(value, complete);
  const count = formatCount(value);
  return complete || count === "—" ? count : `≥${count}`;
};

/** Compact axis tick; a tick is a scale position, so it never carries a lower-bound marker. */
export const formatAxisValue = (metric: UsageChartMetric, value: number, step: number): string => {
  // Compact notation keeps the axis column narrow: "3B", "500M", "2.5K".
  if (metric === "tokens") return formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });
  if (metric === "turns") return formatNumber(value, { maximumFractionDigits: 1 });
  // Ticks share the step's precision so a $0.25 scale never prints $0.2500.
  const digits = Number.isInteger(step) ? 0 : step >= .01 ? 2 : 4;
  return formatNumber(value, { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
};

export const metricLabel = (metric: UsageChartMetric): string =>
  metric === "tokens" ? tr("usage.tokens") : metric === "cost" ? tr("usage.cost") : tr("usage.turns");

// The leading LRM keeps "<" from being mirrored to ">" inside right-to-left text.
export const formatShare = (share: number): string =>
  share > 0 && share < .01 ? "‎<1%" : `${Math.round(share * 100)}%`;

export const rangeLabel = (range: UsageDashboardRange): string =>
  range === "all" ? tr("usage.allTime") : tr("usage.days", { count: Number.parseInt(range, 10) });

/** "+12%" / "−8%" / "±0%": the sign carries direction, never color alone. */
export const formatTrendPercent = (trend: UsageTrend): string | null => {
  if (!known(trend.percent)) return null;
  const rounded = Math.round(Math.abs(trend.percent));
  if (trend.direction === "flat" || rounded === 0) return "±0%";
  // Past +1000% a multiple reads better than a four-digit percentage.
  if (trend.direction === "up" && rounded >= 1000) {
    return `\u200E×${formatNumber(1 + trend.percent / 100, { maximumFractionDigits: 0 })}`;
  }
  return `\u200E${trend.direction === "up" ? "+" : "\u2212"}${formatNumber(rounded)}%`;
};

/** Headline money: cents above a dollar, whole dollars from $100, four places below $1. */
export const formatMoneyCompact = (value: number | null | undefined, complete = true): string => {
  if (!known(value)) return "—";
  const digits = value >= 100 ? 0 : value >= 1 || value === 0 ? 2 : 4;
  const formatted = formatNumber(value, { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
  return complete ? formatted : `≥${formatted}`;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatter = (timezone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const key = `${getLocale()}\u0000${timezone}\u0000${JSON.stringify(options)}`;
  let value = formatters.get(key);
  if (!value) {
    try {
      value = new Intl.DateTimeFormat(getLocale(), { timeZone: timezone, ...options });
    } catch {
      value = new Intl.DateTimeFormat(getLocale(), options);
    }
    formatters.set(key, value);
  }
  return value;
};

/** Short axis label for one bucket start in the report's timezone. */
export const formatBucketTick = (start: number, bucket: UsageBucket, timezone: string): string =>
  formatter(timezone, bucket === "month"
    ? { month: "short", year: "2-digit" }
    : bucket === "hour"
      ? { hour: "numeric" }
      : { month: "short", day: "numeric" }).format(start);

/** Full tooltip label for one bucket, as a range where the bucket spans days. */
export const formatBucketRange = (start: number, end: number, bucket: UsageBucket, timezone: string): string => {
  if (bucket === "hour") return formatter(timezone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(start);
  if (bucket === "day") return formatter(timezone, { weekday: "short", month: "short", day: "numeric" }).format(start);
  if (bucket === "month") return formatter(timezone, { month: "long", year: "numeric" }).format(start);
  const format = formatter(timezone, { month: "short", day: "numeric" });
  // The week ends one millisecond before the next bucket begins.
  return `${format.format(start)} – ${format.format(Math.max(start, end - 1))}`;
};

// Resolving the viewer's zone builds a formatter; list rows must not pay that per call.
let viewerZone: string | null = null;
const viewerTimezone = (): string =>
  viewerZone ??= Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const formatDateTime = (timestamp: number): string =>
  formatter(viewerTimezone(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(timestamp);

export const formatClock = (timestamp: number): string =>
  formatter(viewerTimezone(), { hour: "numeric", minute: "2-digit" }).format(timestamp);
