import { createApiTransport } from "@polyth/web-sdk";

export const api = createApiTransport();
export const endpoint = (action: string, projectId: string, params: Readonly<Record<string, string>> = {}): string =>
  `/api/monitoring/${action}?${new URLSearchParams({ projectId, ...params })}`;

const number = (value: number, locale: string, digits: number): string => {
  try { return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value); }
  catch { return value.toFixed(digits); }
};
export const fixed = (value: number, locale: string, digits = 2): string => {
  try { return new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value); }
  catch { return value.toFixed(digits); }
};
export const whole = (value: number, locale: string): string => number(Math.round(value), locale, 0);
export const bytes = (value: number, locale: string): string => `${number(value / 1024 ** 3, locale, value >= 100 * 1024 ** 3 ? 0 : 1)} GiB`;

type Unit = "minute" | "hour" | "day";
export const unitText = (value: number, unit: Unit, locale: string, display: "short" | "long" | "narrow" = "short"): string => {
  try { return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: display }).format(value); }
  catch { return `${value} ${unit}`; }
};
/** Uptime in the largest unit that means something: "9 days", "4 hr", "12 min". */
export const uptimeText = (seconds: number, locale: string): string =>
  seconds >= 86_400 ? unitText(Math.floor(seconds / 86_400), "day", locale, "long")
    : seconds >= 3_600 ? unitText(Math.floor(seconds / 3_600), "hour", locale)
      : unitText(Math.max(1, Math.floor(seconds / 60)), "minute", locale);
export const agoText = (at: number, now: number, locale: string): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  const [value, unit]: [number, Unit] = minutes < 60 ? [minutes, "minute"] : minutes < 2_880 ? [Math.round(minutes / 60), "hour"] : [Math.round(minutes / 1_440), "day"];
  try { return new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" }).format(-value, unit); }
  catch { return `${value} ${unit}`; }
};
export const clockText = (at: number, locale: string, seconds = false): string => {
  // A log column stays one width and sorts by eye, so it is always 24-hour.
  try { return new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit", hourCycle: "h23" as const } : {}) }); }
  catch { return new Date(at).toISOString().slice(11, seconds ? 19 : 16); }
};
