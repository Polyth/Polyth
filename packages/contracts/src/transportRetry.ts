// A phone returning from the background (iOS suspends the WebView and drops
// its keep-alive sockets), a Wi-Fi ↔ cellular hand-off or a Polyth Link proxy
// restart makes the next fetch reject with a bare network TypeError ("Load
// failed" in WebKit, "Failed to fetch" in Chromium) although the server is
// fine. A read can simply ask again; the first attempt usually only hit the
// dead socket. Reads only: GET/HEAD are safe to repeat, while a mutation
// without a response has an unknown outcome and must never be replayed here.

/** Backoff between attempts after a network failure; its length bounds retries. */
export const READ_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 3_000];

/** A fetch that never produced an HTTP response (not an HTTP error, not an abort). */
export function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return (error as { name?: string }).name !== "AbortError";
}

export interface ReadRetryOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  /** Resolves once a retry can reach the network: page visible and online. */
  untilReachable?: (signal?: AbortSignal | null) => Promise<void>;
}

const methodOf = (input: RequestInfo | URL, init?: RequestInit): string =>
  (init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

const defaultSleep = (ms: number, signal?: AbortSignal | null): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError(signal));
  const onAbort = () => {
    clearTimeout(timer);
    reject(abortError(signal!));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

/** Dispatched on `window` each time the web shell's live connection to Polyth
 *  opens. A view whose read failed for lack of a connection loads again then,
 *  instead of keeping "Load failed" until someone presses Retry. */
export const CONNECTION_RESTORED_EVENT = "polyth:connection-restored";

/** Subscribe to `CONNECTION_RESTORED_EVENT`; returns the unsubscribe. Outside
 *  a browser it is a no-op. */
export function onConnectionRestored(listener: () => void): () => void {
  const win = (globalThis as { window?: Window }).window;
  if (!win) return () => undefined;
  win.addEventListener(CONNECTION_RESTORED_EVENT, listener);
  return () => win.removeEventListener(CONNECTION_RESTORED_EVENT, listener);
}

type ConnectionGate = (signal?: AbortSignal | null) => Promise<void>;
let connectionGate: ConnectionGate | undefined;

/** The web shell's live connection (its WebSocket) rides the same transport as
 *  every read — on a phone, the Polyth Link, which can take seconds to come
 *  back after a suspend or a network hand-off. Retrying on a fixed schedule
 *  spent the few attempts on a link that was still returning, so the shell
 *  registers a gate here that resolves once it is connected again: at once
 *  while connected, bounded while reconnecting. `undefined` removes it. */
export function setConnectionGate(gate: ConnectionGate | undefined): void {
  connectionGate = gate;
}

/** Waits while the page is hidden or the device reports itself offline (a
 *  retry from a suspended page only fails again), then for the registered
 *  connection gate. Outside a browser it is a no-op. */
export async function untilReachable(signal?: AbortSignal | null): Promise<void> {
  await untilPageReachable(signal);
  await connectionGate?.(signal);
}

function untilPageReachable(signal?: AbortSignal | null): Promise<void> {
  const doc = (globalThis as { document?: Document }).document;
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const win = (globalThis as { window?: Window }).window;
  const reachable = () => (!doc || doc.visibilityState !== "hidden") && nav?.onLine !== false;
  if (reachable() || !win) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!reachable()) return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal!));
    };
    const cleanup = () => {
      doc?.removeEventListener("visibilitychange", check);
      win.removeEventListener("online", check);
      win.removeEventListener("pageshow", check);
      signal?.removeEventListener("abort", onAbort);
    };
    doc?.addEventListener("visibilitychange", check);
    win.addEventListener("online", check);
    win.addEventListener("pageshow", check);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `fetch`, except a GET/HEAD that fails before any HTTP response is retried a
 * bounded number of times once the page can reach the network again. HTTP
 * error responses, aborts and every other method pass through unchanged.
 */
export async function fetchWithReadRetry(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
  options: ReadRetryOptions = {},
): Promise<Response> {
  const method = methodOf(input, init);
  if (method !== "GET" && method !== "HEAD") return fetchImpl(input, init);
  const delays = options.delaysMs ?? READ_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const wait = options.untilReachable ?? untilReachable;
  const signal = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      if (attempt >= delays.length || signal?.aborted || !isNetworkFailure(error)) throw error;
      await wait(signal);
      await sleep(delays[attempt]!, signal);
    }
  }
}
