declare const __POLYTH_WEB_BUILD_ID__: string;

export const WEB_BUILD_ID_PATH = "/build-id.json";

const DEFAULT_RETRY_DELAYS_MS = [400, 1_200, 3_000] as const;
const DEFAULT_MIN_CHECK_INTERVAL_MS = 750;

export interface BuildFreshnessOptions {
  fetchImpl?: typeof fetch;
  reload?: () => void;
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

/**
 * A standalone iOS PWA may resume the exact same frozen WebView after the
 * server has rebuilt. Keep that page on one frontend generation: when it
 * becomes visible again, compare the build compiled into this shell with the
 * server's current build and silently reload the same route on mismatch.
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

  const reload = options.reload ?? (() => windowRef.location.reload());
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const minCheckIntervalMs = options.minCheckIntervalMs ?? DEFAULT_MIN_CHECK_INTERVAL_MS;

  let disposed = false;
  let inFlight = false;
  let reloadIssued = false;
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
        reloadIssued = true;
        reload();
      }
    } catch {
      scheduleRetry();
    } finally {
      inFlight = false;
    }
  };

  const onResume = (): void => {
    if (documentRef.visibilityState !== "hidden") void check(true);
  };
  const onVisibility = (): void => {
    if (documentRef.visibilityState !== "hidden") void check(true);
  };

  windowRef.addEventListener("pageshow", onResume);
  windowRef.addEventListener("focus", onResume);
  documentRef.addEventListener("visibilitychange", onVisibility);
  void check(true);

  return () => {
    disposed = true;
    clearRetry();
    windowRef.removeEventListener("pageshow", onResume);
    windowRef.removeEventListener("focus", onResume);
    documentRef.removeEventListener("visibilitychange", onVisibility);
  };
}
