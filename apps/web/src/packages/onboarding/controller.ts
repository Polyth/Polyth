// Open/close/step state for the package tour overlay. One tour at a time;
// pure module state (no React) so PackagesPage, SettingsView, and the overlay
// share it, and tests drive it headlessly.
import type { PackageOnboardingTour } from "./types.ts";
import { getPackageOnboarding } from "./registry.ts";
import { isPackageTourAutoShow, markPackageTourSeen, skipAllPackageTours } from "./prefs.ts";

/** "first-run" = auto-shown on first visit; "preview" = explicit replay from
 * Settings → Packages, shown regardless of skip flags. */
export type PackageTourMode = "first-run" | "preview";

/** How a tour closed: "dismiss" (Esc / scrim click) persists nothing so the
 * tour returns on the next app session; "skip" and "done" mark the package
 * seen; "skip-all" turns auto-show off for every package. */
export type PackageTourCloseReason = "dismiss" | "skip" | "skip-all" | "done";

export interface PackageTourState {
  tour: PackageOnboardingTour;
  mode: PackageTourMode;
  step: number;
}

let state: PackageTourState | null = null;
/** Packages whose tour already opened this app session — even a dismissed
 * tour will not pop again until the next page load. */
const shownThisSession = new Set<string>();
const listeners = new Set<() => void>();

function setState(next: PackageTourState | null): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

export function getPackageTourState(): PackageTourState | null {
  return state;
}

export function subscribePackageTour(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

/** Open a package's tour. Preview ignores skip flags entirely. Returns false
 * when no tour is registered for the package. */
export function openPackageTour(packageId: string, mode: PackageTourMode): boolean {
  const tour = getPackageOnboarding(packageId);
  if (!tour) return false;
  shownThisSession.add(packageId);
  setState({ tour, mode, step: 0 });
  return true;
}

/** First-visit trigger: opens the tour only when one is registered, nothing
 * else is open, it has not been skipped, and it has not already shown this
 * session. */
export function maybeAutoShowPackageTour(packageId: string): boolean {
  if (state) return false;
  if (shownThisSession.has(packageId)) return false;
  if (!isPackageTourAutoShow(packageId)) return false;
  return openPackageTour(packageId, "first-run");
}

export function closePackageTour(reason: PackageTourCloseReason): void {
  const current = state;
  if (!current) return;
  if (reason === "skip" || reason === "done") markPackageTourSeen(current.tour.packageId);
  if (reason === "skip-all") skipAllPackageTours();
  setState(null);
}

export function setPackageTourStep(step: number): void {
  if (!state) return;
  const clamped = Math.max(0, Math.min(step, state.tour.steps.length - 1));
  if (clamped !== state.step) setState({ ...state, step: clamped });
}

/** Advance one step; on the last step this completes the tour ("done"). */
export function nextPackageTourStep(): void {
  if (!state) return;
  if (state.step >= state.tour.steps.length - 1) {
    closePackageTour("done");
    return;
  }
  setState({ ...state, step: state.step + 1 });
}

export function previousPackageTourStep(): void {
  if (!state) return;
  setPackageTourStep(state.step - 1);
}
