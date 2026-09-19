declare const __POLYTH_WEB_BUILD_ID__: string;

export const WEB_BUILD_ID_PATH = "/build-id.json";
export const WEB_BUILD_QUERY = "__polyth_build";

const DEFAULT_RETRY_DELAYS_MS = [400, 1_200, 3_000] as const;
const DEFAULT_MIN_CHECK_INTERVAL_MS = 750;

export interface BuildFreshnessOptions {
  fetchImpl?: typeof fetch;
  reload?: (serverBuildId: string) => void;
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
  let retryIndex = 0;
  let retryTimer: number | undefined;

  const clearRetry = (): void => {
    if (retryTimer !== undefined) {
      windowRef.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  const scheduleRetry = (): void => {
    if (disposed || reloadIssued || documentRef.visibilityState === "hidden") return;
    const delay = retryDelaysMs[retryIndex++];
    if (delay === undefined) return;
    clearRetry();
    retryTimer = windowRef.setTimeout(() => {
      retryTimer = undefined;
      void check(false);
    }, delay);
  };

  const check = async (freshEvent: boolean): Promise<void> => {
    if (disposed || reloadIssued || inFlight || documentRef.visibilityState === "hidden") return;
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
      if (!serverBuildId) {
        scheduleRetry();
        return;
      }
      retryIndex = 0;
      clearRetry();
      if (serverBuildId !== currentBuildId) {
        if (requestedBuildId(windowRef) === serverBuildId) return;
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
    void check(true);
  };

  const onVisibility = (): void => {
    if (documentRef.visibilityState === "hidden") markSuspended();
    else resume();
  };

  windowRef.addEventListener("pagehide", markSuspended);
  windowRef.addEventListener("pageshow", resume);
  documentRef.addEventListener("visibilitychange", onVisibility);

  return () => {
    disposed = true;
    clearRetry();
    windowRef.removeEventListener("pagehide", markSuspended);
    windowRef.removeEventListener("pageshow", resume);
    documentRef.removeEventListener("visibilitychange", onVisibility);
  };
}
