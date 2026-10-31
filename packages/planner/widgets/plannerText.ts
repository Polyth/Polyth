import { useSyncExternalStore } from "react";
import { getLocale, subscribeLocale } from "../../../apps/web/src/i18n/index.ts";
import { translatePlanner, type PlannerMessageKey } from "../src/i18n/index.ts";

/** Planner copy in the app's current locale. */
export function t(key: PlannerMessageKey, params?: Record<string, string | number>): string {
  return translatePlanner(getLocale(), key, params);
}

/** Re-render on locale changes; returns the active locale. */
export function usePlannerLocale(): string {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
