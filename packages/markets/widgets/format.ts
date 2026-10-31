import { formatNumber, getLocale } from "../../../apps/web/src/i18n/index.ts";

/** Locale-aware market formatters shared by the package surfaces. The host
 *  locale drives grouping, decimal separators, currency and percent signs. */

export const formatDecimal = (value: number | undefined, digits = 2): string => value === undefined
  ? "—"
  : formatNumber(value, { maximumFractionDigits: digits });

export const formatCompact = (value: number | undefined): string => value === undefined
  ? "—"
  : formatNumber(value, { notation: "compact", maximumFractionDigits: 2 });

export const formatPercent = (value: number | undefined, digits = 2): string => value === undefined
  ? "—"
  : formatNumber(value / 100, {
      style: "percent",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: "always",
    });

export const formatPercentValue = (value: number | undefined, digits = 2): string => value === undefined
  ? "—"
  : formatNumber(value / 100, {
      style: "percent",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });

export const formatSignedNumber = (value: number | undefined, digits = 2): string => value === undefined
  ? "—"
  : formatNumber(value, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: "always",
    });

export const formatMarketPrice = (value: number | undefined, currency?: string): string => {
  if (value === undefined) return "—";
  const digits = value < 1 ? 4 : 2;
  if (!currency) return formatNumber(value, { maximumFractionDigits: digits });
  try {
    return formatNumber(value, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    });
  } catch {
    return `${formatNumber(value, { maximumFractionDigits: digits })} ${currency}`;
  }
};

export const formatMarketDate = (
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions,
): string => new Intl.DateTimeFormat(getLocale(), options).format(new Date(value));

export const formatMarketDateTime = (value: Date | number | string): string => formatMarketDate(value, {
  dateStyle: "medium",
  timeStyle: "short",
});

export const formatMarketTime = (value: Date | number | string): string => formatMarketDate(value, {
  timeStyle: "medium",
});

export const formatMarketDay = (value: Date | number | string): string => formatMarketDate(value, {
  year: "numeric",
  month: "short",
  day: "2-digit",
});
