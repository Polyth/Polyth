// Device-local navigator state: which projects the user left open, how many
// sessions each one shows, and how the projects are sorted (with the manual
// order the user dragged them into). It is presentation, not history, so it
// never reaches the server and stays out of the synced account preferences.
//
// A browser keeps it in localStorage, which is durable there. The paired mobile
// app is the exception: its Link loopback shell is served from a new port on
// every launch, so the shell's localStorage starts empty. There the same keys
// are also mirrored into the app-owned client-context store (clientPersistence)
// and put back before the first render. localStorage stays the synchronous
// cache every reader uses.
import {
  clientPersistenceBackendGeneration,
  hasClientPersistenceBackend,
  hydrateClientRecord,
  readClientRecord,
  writeClientPreference,
  type PersistenceScope,
} from "./clientPersistence.ts";

/** Project ids the user left open (JSON array). */
export const EXPANDED_PROJECTS_KEY = "polyth.sidebar.expandedProjects";
/** Phone: projects that list every loaded chat after "Show more" (JSON array). */
export const SHOW_ALL_PROJECTS_KEY = "polyth.sidebar.showAllProjects";
/** Wide navigator: rows shown per project, view and worktree (JSON object). */
export const SESSION_VISIBLE_COUNTS_KEY = "polyth.sidebar.visibleSessionCounts";
/** Project sort chosen in the navigator toolbar: recent, name or manual. */
export const PROJECT_SORT_KEY = "polyth.sidebar.projectSort";
/** Manual project order the user dragged into place (JSON array of ids). */
export const PROJECT_ORDER_KEY = "polyth.sidebar.projectOrder";
/** Phone composer button arrangements, one entry per Space + project (JSON object). */
export const MOBILE_RAIL_MAP_KEY = "polyth.composer.mobile-rail.v2";

export type NavigatorStateKey =
  | typeof EXPANDED_PROJECTS_KEY
  | typeof SHOW_ALL_PROJECTS_KEY
  | typeof SESSION_VISIBLE_COUNTS_KEY
  | typeof PROJECT_SORT_KEY
  | typeof PROJECT_ORDER_KEY
  | typeof MOBILE_RAIL_MAP_KEY;

const RECORD_KIND: Record<NavigatorStateKey, string> = {
  [EXPANDED_PROJECTS_KEY]: "navigator-open-projects",
  [SHOW_ALL_PROJECTS_KEY]: "navigator-show-all",
  [SESSION_VISIBLE_COUNTS_KEY]: "navigator-session-counts",
  [PROJECT_SORT_KEY]: "navigator-project-sort",
  [PROJECT_ORDER_KEY]: "navigator-project-order",
  [MOBILE_RAIL_MAP_KEY]: "mobile-composer-rail",
};
const KEYS = Object.keys(RECORD_KIND) as NavigatorStateKey[];

/** A stalled loopback must not hold the first render. Past this the page keeps
 * what it has and never writes the durable copy. */
const HYDRATE_TIMEOUT_MS = 1_500;

/** Set once the durable copy was read for this page. Until then a write would
 * replace a record this page has not seen with its own defaults. */
let durable: { scope: PersistenceScope; generation: number } | null = null;
const hydratedListeners = new Set<() => void>();

export function readNavigatorState(key: NavigatorStateKey): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeNavigatorState(key: NavigatorStateKey, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode or quota: best effort */ }
  if (!durable || durable.generation !== clientPersistenceBackendGeneration()) return;
  const kind = RECORD_KIND[key];
  if (readClientRecord(kind, durable.scope) === value) return;
  writeClientPreference(kind, durable.scope, value);
}

/** Put the durable copy back into localStorage before the navigators first read
 * it. A no-op in browsers, where there is no app-owned store. Resolves false
 * when nothing was restored; the page then runs on localStorage alone. */
export async function hydrateNavigatorState(
  scope: PersistenceScope,
  timeoutMs = HYDRATE_TIMEOUT_MS,
): Promise<boolean> {
  durable = null;
  if (!hasClientPersistenceBackend()) return false;
  const generation = clientPersistenceBackendGeneration();
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restore = Promise.all(KEYS.map(async (key) => [key, await hydrateClientRecord(RECORD_KIND[key], scope)] as const))
    .then((entries) => {
      // A read that outlives the wait must not rewrite what the page already
      // runs on.
      if (abandoned || generation !== clientPersistenceBackendGeneration()) return false;
      for (const [key, value] of entries) {
        if (value === null) continue;
        try { localStorage.setItem(key, value); } catch { /* private mode or quota */ }
      }
      return true;
    }, () => false);
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const restored = await Promise.race([restore, timeout]);
  clearTimeout(timer);
  if (!restored) {
    abandoned = true;
    return false;
  }
  durable = { scope, generation };
  for (const listener of [...hydratedListeners]) listener();
  return true;
}

/** Modules that cache a key in memory re-read it here. */
export function subscribeNavigatorStateHydrated(listener: () => void): () => void {
  hydratedListeners.add(listener);
  return () => { hydratedListeners.delete(listener); };
}

/** Test seam: forget the hydrated scope so the next test starts unhydrated. */
export function resetNavigatorStateForTest(): void {
  durable = null;
}
