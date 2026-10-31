import { useSyncExternalStore } from "react";

/**
 * The app's resolved light/dark appearance, so Browser tabs can emulate the
 * same `prefers-color-scheme`. The host publishes it on `<html
 * data-appearance>` and signals changes with `polyth:theme` (System mode
 * included); null until a theme has been applied.
 */
export type AppAppearance = "light" | "dark";

export function appAppearance(): AppAppearance | null {
  if (typeof document === "undefined") return null;
  const value = document.documentElement.dataset.appearance;
  return value === "light" || value === "dark" ? value : null;
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("polyth:theme", listener);
  return () => window.removeEventListener("polyth:theme", listener);
}

export function useAppAppearance(): AppAppearance | null {
  return useSyncExternalStore(subscribe, appAppearance, () => null);
}

// A scheme the user picked in a tab's device controls wins over following
// the app, for that tab only (same per-tab lifetime as the viewport mode).
const pinned = new Set<string>();
const pinKey = (browserId: string) => `polyth.browser.colorSchemePinned.${browserId}`;

export function pinTabColorScheme(browserId: string): void {
  pinned.add(browserId);
  try { sessionStorage.setItem(pinKey(browserId), "1"); } catch { /* private mode */ }
}

export function tabColorSchemePinned(browserId: string): boolean {
  if (pinned.has(browserId)) return true;
  try { return sessionStorage.getItem(pinKey(browserId)) === "1"; } catch { return false; }
}
