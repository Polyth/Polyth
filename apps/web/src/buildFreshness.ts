declare const __POLYTH_WEB_BUILD_ID__: string;
declare const __POLYTH_WEB_BUILD_FRESHNESS_ENABLED__: boolean;

export const WEB_BUILD_ID_PATH = "/build-id.json";
export const WEB_BUILD_QUERY = "__polyth_build";

const DEFAULT_RETRY_DELAYS_MS = [400, 1_200, 3_000] as const;
const DEFAULT_MIN_CHECK_INTERVAL_MS = 750;

let freshnessEnabled = typeof __POLYTH_WEB_BUILD_FRESHNESS_ENABLED__ === "boolean"
  ? __POLYTH_WEB_BUILD_FRESHNESS_ENABLED__
  : true;
const freshnessStateListeners = new Set<(enabled: boolean) => void>();

export function isBuildFreshnessEnabled(): boolean {
  return freshnessEnabled;
}

export function setBuildFreshnessEnabled(enabled: boolean): void {
  const next = Boolean(enabled);
  if (next === freshnessEnabled) return;
  freshnessEnabled = next;
  for (const listener of [...freshnessStateListeners]) listener(next);
}

export interface BuildFreshnessOptions {
  fetchImpl?: typeof fetch;
  reload?: (serverBuildId: string) => void;
  /** Offer a newer build instead of reloading by itself: called once per new
   *  server build with the reload to run when the person agrees. Without it,
   *  a resumed stale shell reloads on its own. */
  offerReload?: (serverBuildId: string, reload: () => void) => void;
  retryDelaysMs?: readonly number[];
  minCheckIntervalMs?: number;
  windowRef?: Window;
  documentRef?: Document;
}

export function parseWebBuildId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const build = (value as { build?: unknown }).build;
  return typeof build === "string" && build.trim() ? build.trim() : null;
}

export async function fetchWebBuildId(fetchImpl: typeof fetch = globalThis.fetch): Promise<string | null> {
  const response = await fetchImpl(WEB_BUILD_ID_PATH, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  return parseWebBuildId(await response.json());
}

// A lazy `import()` that rejects because its content-hashed chunk is gone is
// indistinguishable from a generic TypeError at the call site; only the
// message names the real cause. Cover the engines Polyth ships to rather than
// trusting `error.name`, which every browser reports as "TypeError".
const CHUNK_LOAD_ERROR_PATTERNS: readonly RegExp[] = [
  // Chrome/Edge: "Failed to fetch dynamically imported module: <url>".
  /dynamically imported module/i,
  // Safari: "Importing a module script failed.".
  /importing a module script failed/i,
  // Firefox: "error loading dynamically imported module".
  /error loading dynamically imported module/i,
  // Bundler-agnostic fallback when a chunk 404/504 surfaces as a load error.
  /chunkloaderror|failed to load chunk|loading chunk \d+ failed/i,
];

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  return message !== "" && CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export interface ChunkLoadRecoveryOptions {
  fetchImpl?: typeof fetch;
  windowRef?: Window;
  /** Compiled-in build id; injectable so the recovery is testable. */
  buildId?: string;
}

let chunkRecoveryInFlight = false;

/**
 * A stale foreground shell that hits a missing lazy chunk is the same failure
 * as a resumed frozen PWA: the server rebuilt, replaced `dist`, and the old
 * `chunks/g-<digest>/` directory is gone. Eagerly loaded assets survive in the
 * immutable HTTP cache, so the tab looks healthy until it lazily imports a
 * chunk that was never fetched (ModelDetails is the usual one). Recover by
 * navigating once toward the server's current build; a chunk error under the
 * current build is a genuine failure and is left to the caller.
 *
 * Bound by the same rule as the resume watcher: a navigation that already
 * targets the server's build id fails stable instead of reloading forever.
 */
export async function recoverFromChunkLoadFailure(
  error: unknown,
  options: ChunkLoadRecoveryOptions = {},
): Promise<boolean> {
  if (!freshnessEnabled || chunkRecoveryInFlight || !isChunkLoadError(error)) return false;
  const windowRef = options.windowRef ?? (typeof window !== "undefined" ? window : undefined);
  if (!windowRef) return false;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return false;
  const currentBuildId = options.buildId ?? __POLYTH_WEB_BUILD_ID__;

  chunkRecoveryInFlight = true;
  try {
    const serverBuildId = await fetchWebBuildId(fetchImpl);
    if (!freshnessEnabled || !serverBuildId || serverBuildId === currentBuildId) return false;
    // The URL already targets this generation: an earlier reload did not
    // produce a shell that can load the chunk, so do not reload again.
    if (requestedBuildId(windowRef) === serverBuildId) return false;
    replaceIntoBuild(windowRef, serverBuildId);
    return true;
  } catch {
    return false;
  } finally {
    chunkRecoveryInFlight = false;
  }
}

function requestedBuildId(windowRef: Window): string | null {
  try {
    return new URL(windowRef.location.href).searchParams.get(WEB_BUILD_QUERY);
  } catch {
    return null;
  }
}

function replaceIntoBuild(windowRef: Window, serverBuildId: string): void {
  try {
    const target = new URL(windowRef.location.href);
    target.searchParams.set(WEB_BUILD_QUERY, serverBuildId);
    windowRef.location.replace(target.href);
  } catch {
    windowRef.location.reload();
  }
}

/**
 * A frozen standalone PWA can resume on an older frontend generation after the
 * server rebuilt. Freshness checks therefore run only after an actual
 * hidden/pagehide -> visible/pageshow transition. Never check during ordinary
 * boot or window-focus churn: that can tear down the client before hydration.
 *
 * The target build id is put in the navigation URL. If WebKit still restores a
 * stale shell for that exact target generation, do not reload it again; this
 * makes the recovery path fail stable instead of entering a reload loop.
 */
// Found while the page is healthy, a newer build is the person's to take:
// `offerReload` (main.tsx → webUpdateNotice.ts) shows it as an `update`
// notification. The chunk-load recovery above stays silent — that page is
// already broken.
export function installBuildFreshnessWatcher(
  currentBuildId: string = __POLYTH_WEB_BUILD_ID__,
  options: BuildFreshnessOptions = {},
): () => void {
  const windowRef = options.windowRef ?? (typeof window !== "undefined" ? window : undefined);
  const documentRef = options.documentRef ?? (typeof document !== "undefined" ? document : undefined);
  if (!windowRef || !documentRef) return () => {};

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return () => {};

  const reload = options.reload ?? ((serverBuildId: string) => replaceIntoBuild(windowRef, serverBuildId));
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const minCheckIntervalMs = options.minCheckIntervalMs ?? DEFAULT_MIN_CHECK_INTERVAL_MS;

  let disposed = false;
  let inFlight = false;
  let reloadIssued = false;
  let suspended = documentRef.visibilityState === "hidden";
  let lastCheckAt = 0;
  let offeredBuildId: string | null = null;
  let retryIndex = 0;
  let retryTimer: number | undefined;

  const clearRetry = (): void => {
    if (retryTimer !== undefined) {
      windowRef.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  const scheduleRetry = (): void => {
    if (!freshnessEnabled || disposed || reloadIssued || documentRef.visibilityState === "hidden") return;
    const delay = retryDelaysMs[retryIndex++];
    if (delay === undefined) return;
    clearRetry();
    retryTimer = windowRef.setTimeout(() => {
      retryTimer = undefined;
      void check(false);
    }, delay);
  };

  const check = async (freshEvent: boolean): Promise<void> => {
    if (!freshnessEnabled || disposed || reloadIssued || inFlight || documentRef.visibilityState === "hidden") return;
    const now = Date.now();
    if (freshEvent && now - lastCheckAt < minCheckIntervalMs) return;
    if (freshEvent) {
      retryIndex = 0;
      clearRetry();
    }
    lastCheckAt = now;
    inFlight = true;
    try {
      const serverBuildId = await fetchWebBuildId(fetchImpl);
      if (!freshnessEnabled) return;
      if (!serverBuildId) {
        scheduleRetry();
        return;
      }
      retryIndex = 0;
      clearRetry();
      if (serverBuildId !== currentBuildId) {
        if (requestedBuildId(windowRef) === serverBuildId) return;
        if (options.offerReload) {
          if (offeredBuildId === serverBuildId) return;
          offeredBuildId = serverBuildId;
          options.offerReload(serverBuildId, () => {
            if (reloadIssued || disposed) return;
            reloadIssued = true;
            reload(serverBuildId);
          });
          return;
        }
        reloadIssued = true;
        reload(serverBuildId);
      }
    } catch {
      scheduleRetry();
    } finally {
      inFlight = false;
    }
  };

  const markSuspended = (): void => {
    suspended = true;
    clearRetry();
  };

  const resume = (): void => {
    if (disposed || !suspended || documentRef.visibilityState === "hidden") return;
    suspended = false;
    if (freshnessEnabled) void check(true);
  };

  const onVisibility = (): void => {
    if (documentRef.visibilityState === "hidden") markSuspended();
    else resume();
  };

  const onFreshnessState = (enabled: boolean): void => {
    if (!enabled) clearRetry();
  };

  freshnessStateListeners.add(onFreshnessState);
  windowRef.addEventListener("pagehide", markSuspended);
  windowRef.addEventListener("pageshow", resume);
  documentRef.addEventListener("visibilitychange", onVisibility);

  return () => {
    disposed = true;
    clearRetry();
    freshnessStateListeners.delete(onFreshnessState);
    windowRef.removeEventListener("pagehide", markSuspended);
    windowRef.removeEventListener("pageshow", resume);
    documentRef.removeEventListener("visibilitychange", onVisibility);
  };
}
