import {
  iconifyProjectIconName,
  iconifySearchUrl,
  iconifySvgUrl,
  isSupportedIconifyName,
} from "./projectIconPicker.ts";

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 250;
const MAX_CONCURRENT = 3;

type CacheEntry<T> = { value: T; expiresAt: number };

const jsonCache = new Map<string, CacheEntry<unknown>>();
const svgCache = new Map<string, CacheEntry<string>>();
const blobUrlCache = new Map<string, string>();
const inflight = new Map<string, Promise<unknown>>();

let active = 0;
const waitQueue: Array<() => void> = [];

function cacheTtlMs(): number {
  return 15 * 60 * 1000;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function retryDelay(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) return retryAfterSec * 1000;
  const jitter = Math.floor(Math.random() * 120);
  return Math.min(8_000, BASE_DELAY_MS * (2 ** attempt)) + jitter;
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

async function acquireSlot(signal?: AbortSignal): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const release = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      const index = waitQueue.indexOf(release);
      if (index >= 0) waitQueue.splice(index, 1);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    waitQueue.push(release);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  active += 1;
}

function releaseSlot(): void {
  active = Math.max(0, active - 1);
  waitQueue.shift()?.();
}

async function fetchWithRetry(url: string, signal?: AbortSignal): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await acquireSlot(signal);
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        cache: attempt === 0 ? "default" : "reload",
        signal,
      });
      if (response.ok || !shouldRetry(response.status) || attempt === MAX_ATTEMPTS - 1) return response;
      const delay = retryDelay(attempt, response.headers.get("retry-after"));
      await sleep(delay, signal);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (attempt === MAX_ATTEMPTS - 1) throw error;
      await sleep(retryDelay(attempt, null), signal);
    } finally {
      releaseSlot();
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Icon request failed");
}

function readCache<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  map.set(key, { value, expiresAt: Date.now() + cacheTtlMs() });
}

async function dedupe<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const pending = work().finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

export async function searchProjectIcons(
  query: string,
  library: Parameters<typeof iconifySearchUrl>[1],
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = iconifySearchUrl(query, library, limit);
  const cached = readCache(jsonCache, url);
  if (cached && typeof cached === "object" && cached !== null && "icons" in cached) {
    const icons = (cached as { icons?: unknown }).icons;
    return Array.isArray(icons) ? icons.filter((item): item is string => typeof item === "string") : [];
  }
  const payload = await dedupe(url, async () => {
    const response = await fetchWithRetry(url, signal);
    if (!response.ok) throw new Error(`Iconify HTTP ${response.status}`);
    const body = await response.json();
    writeCache(jsonCache, url, body);
    return body;
  });
  return typeof payload === "object" && payload !== null && "icons" in payload && Array.isArray((payload as { icons?: unknown }).icons)
    ? (payload as { icons: unknown[] }).icons.filter((item): item is string => typeof item === "string")
    : [];
}

type IconifyBatchPayload = {
  icons?: Record<string, { body?: string; width?: number; height?: number }>;
};

function asIconifyBatch(value: unknown): IconifyBatchPayload {
  return typeof value === "object" && value !== null ? value as IconifyBatchPayload : {};
}

function svgFromBatchIcon(body: string, width = 24, height = 24): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

export async function prefetchProjectIconSvgs(names: readonly string[], signal?: AbortSignal): Promise<void> {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    if (!isSupportedIconifyName(name)) continue;
    const separator = name.indexOf(":");
    const prefix = name.slice(0, separator);
    const iconName = name.slice(separator + 1);
    const bucket = groups.get(prefix) ?? [];
    bucket.push(iconName);
    groups.set(prefix, bucket);
  }
  await Promise.all([...groups.entries()].map(async ([prefix, icons]) => {
    const unique = [...new Set(icons)];
    if (!unique.length) return;
    const url = `/api/iconify/${encodeURIComponent(prefix)}.json?icons=${unique.map(encodeURIComponent).join(",")}`;
    const cached = readCache(jsonCache, url);
    const payload = asIconifyBatch(cached ?? await dedupe(url, async () => {
      const response = await fetchWithRetry(url, signal);
      if (!response.ok) throw new Error(`Iconify HTTP ${response.status}`);
      const body = asIconifyBatch(await response.json());
      writeCache(jsonCache, url, body);
      return body;
    }));
    const entries = payload.icons ?? {};
    for (const iconName of unique) {
      const icon = entries[iconName];
      if (!icon?.body) continue;
      const fullName = `${prefix}:${iconName}`;
      const svg = svgFromBatchIcon(icon.body, icon.width ?? 24, icon.height ?? 24);
      writeCache(svgCache, iconifySvgUrl(fullName), svg);
    }
  }));
}

export async function loadProjectIconSvg(name: string, signal?: AbortSignal): Promise<string> {
  if (!isSupportedIconifyName(name)) throw new Error("unsupported icon");
  const url = iconifySvgUrl(name);
  const cached = readCache(svgCache, url);
  if (cached) return cached;
  return dedupe(url, async () => {
    const response = await fetchWithRetry(url, signal);
    if (!response.ok) throw new Error(`Iconify HTTP ${response.status}`);
    const svg = await response.text();
    if (!/^<svg\b/i.test(svg.trim())) throw new Error("invalid icon svg");
    writeCache(svgCache, url, svg);
    return svg;
  });
}

export function projectIconMaskBlobUrl(name: string, svg: string): string {
  const key = name;
  const cached = blobUrlCache.get(key);
  if (cached) return cached;
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(key, url);
  return url;
}

export function projectIconMaskBlobUrlForValue(value: string, svg: string): string {
  const remoteName = iconifyProjectIconName(value);
  return remoteName ? projectIconMaskBlobUrl(remoteName, svg) : "";
}

export function revokeProjectIconMaskBlobUrls(): void {
  for (const url of blobUrlCache.values()) URL.revokeObjectURL(url);
  blobUrlCache.clear();
}

export function resetProjectIconLoaderForTests(): void {
  jsonCache.clear();
  svgCache.clear();
  revokeProjectIconMaskBlobUrls();
  inflight.clear();
  active = 0;
  waitQueue.length = 0;
}

export const __test = {
  fetchWithRetry,
  retryDelay,
  shouldRetry,
  MAX_ATTEMPTS,
  MAX_CONCURRENT,
};
