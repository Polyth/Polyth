// Skip/complete flags for package onboarding tours. This is pure UI
// preference state: it lives in localStorage under a versioned key and never
// touches the session event log or the server. Distinct from the first-run
// project onboarding overlay ("onboarding" in store.ts) — package tours keep
// their own state entirely.

export const PACKAGE_TOUR_PREFS_KEY = "polyth.packageTours.v1";

export interface PackageTourPrefs {
  /** True once the user chose "Skip all onboardings": no tour auto-shows. */
  skippedAll: boolean;
  /** Package ids whose tour was finished or individually skipped. */
  completed: Record<string, true>;
}

const EMPTY: PackageTourPrefs = { skippedAll: false, completed: {} };

export function parsePackageTourPrefs(raw: string | null): PackageTourPrefs {
  try {
    const data = JSON.parse(raw ?? "") as Partial<PackageTourPrefs> | null;
    if (!data || typeof data !== "object") return { ...EMPTY, completed: {} };
    const completed: Record<string, true> = {};
    if (data.completed && typeof data.completed === "object" && !Array.isArray(data.completed)) {
      for (const [key, value] of Object.entries(data.completed)) {
        if (key !== "" && value === true) completed[key] = true;
      }
    }
    return { skippedAll: data.skippedAll === true, completed };
  } catch {
    return { ...EMPTY, completed: {} };
  }
}

const read = (): string | null => {
  try { return localStorage.getItem(PACKAGE_TOUR_PREFS_KEY); } catch { return null; }
};

let cache: PackageTourPrefs | null = null;
const listeners = new Set<() => void>();

export function getPackageTourPrefs(): PackageTourPrefs {
  cache ??= parsePackageTourPrefs(read());
  return cache;
}

function save(next: PackageTourPrefs): void {
  cache = next;
  try { localStorage.setItem(PACKAGE_TOUR_PREFS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  for (const listener of [...listeners]) listener();
}

/** "Skip all onboardings": never auto-show any tour again (preview still works). */
export function skipAllPackageTours(): void {
  save({ ...getPackageTourPrefs(), skippedAll: true });
}

/** Mark one tour finished or skipped: it never auto-shows again. */
export function markPackageTourSeen(packageId: string): void {
  const prefs = getPackageTourPrefs();
  if (prefs.completed[packageId]) return;
  save({ ...prefs, completed: { ...prefs.completed, [packageId]: true } });
}

/** Forget one tour's seen flag so it can auto-show again. */
export function resetPackageTour(packageId: string): void {
  const prefs = getPackageTourPrefs();
  if (!prefs.completed[packageId]) return;
  const completed = { ...prefs.completed };
  delete completed[packageId];
  save({ ...prefs, completed });
}

/** Whether this package's tour may still open automatically. */
export function isPackageTourAutoShow(packageId: string): boolean {
  const prefs = getPackageTourPrefs();
  return !prefs.skippedAll && prefs.completed[packageId] !== true;
}

export function subscribePackageTourPrefs(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}
