// Client-side registry of package onboarding tours. Package installers
// register their tour alongside their settings page so disabling the package
// removes the tour too; built-in pages register through builtinTours.ts.
// Same-id registration replaces (like the slot registry) and a superseded
// unregister is a no-op.
import type { PackageOnboardingTour } from "./types.ts";

const tours = new Map<string, PackageOnboardingTour>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function registerPackageOnboarding(tour: PackageOnboardingTour): () => void {
  if (tour.steps.length === 0) return () => {};
  tours.set(tour.packageId, tour);
  notify();
  return () => {
    if (tours.get(tour.packageId) !== tour) return;
    tours.delete(tour.packageId);
    notify();
  };
}

export function getPackageOnboarding(packageId: string): PackageOnboardingTour | undefined {
  return tours.get(packageId);
}

export function listPackageOnboardings(): PackageOnboardingTour[] {
  return [...tours.values()].sort((a, b) => a.packageId.localeCompare(b.packageId));
}

/** Notifies on every register/replace/unregister (for UI re-render). */
export function subscribePackageOnboardings(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}
