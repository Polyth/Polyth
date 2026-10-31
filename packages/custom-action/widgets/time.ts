// Clock and time formatting for run feedback, localized through Intl so no
// per-unit message keys are needed.
import { useEffect, useState } from "react";
import { getLocale } from "../../../apps/web/src/i18n/index.ts";

/** Current time, re-read every `interval` ms while `active`. */
export function useNow(active: boolean, interval = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [active, interval]);
  return active ? now : Date.now();
}

/** A running stopwatch: 0:07, 1:23, 1:02:05. */
export function stopwatch(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

const unit = (value: number, name: "second" | "minute" | "hour") =>
  new Intl.NumberFormat(getLocale(), { style: "unit", unit: name, unitDisplay: "narrow", maximumFractionDigits: name === "second" && value < 10 ? 1 : 0 }).format(value);

/** A finished duration: 0.8s, 12s, 3m, 1h. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = ms / 1_000;
  if (seconds < 60) return unit(Math.max(0.1, seconds), "second");
  if (seconds < 3_600) return unit(Math.round(seconds / 60), "minute");
  return unit(Math.round(seconds / 360) / 10, "hour");
}

/** "2 minutes ago", "yesterday". */
export function ago(timestamp: number, now = Date.now()): string {
  const diff = (timestamp - now) / 1_000;
  const format = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 45) return format.format(0, "second");
  if (abs < 45 * 60) return format.format(Math.round(diff / 60), "minute");
  if (abs < 22 * 3_600) return format.format(Math.round(diff / 3_600), "hour");
  return format.format(Math.round(diff / 86_400), "day");
}
