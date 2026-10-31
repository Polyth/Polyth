// Server-side GitHub Releases lookup for the web "download the app" section.
// The browser cannot call api.github.com anonymously (no CORS headers, and a
// 60 req/h/IP limit), so the server proxies one cached /releases/latest read —
// the same reason and shape as routes/iconify.ts.
import type { ReleaseDownloadDto, ReleaseDownloadsDto } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";

export type ReleasesFetch = typeof fetch;

const API_ORIGIN = "https://api.github.com";
const CACHE_TTL_MS = 10 * 60 * 1000;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;

/** `owner/repo` → coordinates, or null when unset/malformed. Read per request
 * so a configured repository needs no code change and a malformed value simply
 * disables the feature. */
export function parseReleaseRepository(value: string | null | undefined): { owner: string; repo: string } | null {
  const raw = value?.trim();
  if (!raw) return null;
  const match = REPOSITORY.exec(raw);
  if (!match || match[2] === "." || match[2] === "..") return null;
  return { owner: match[1]!, repo: match[2]! };
}

interface GitHubAsset { name?: unknown; browser_download_url?: unknown; size?: unknown }
interface GitHubRelease { tag_name?: unknown; html_url?: unknown; published_at?: unknown; assets?: unknown }

type Platform = ReleaseDownloadDto["platform"];

const PLATFORM_ORDER: Record<Platform, number> = { windows: 0, macos: 1, linux: 2, android: 3 };

/** Map an installer filename to a user-facing download entry, or null for
 * update metadata (.yml, .blockmap) and installer-unfriendly archives. Only
 * the exact assets the release pipeline publishes are accepted. */
export function classifyReleasesAsset(name: string): {
  platform: Platform;
  arch: ReleaseDownloadDto["arch"];
  label: string;
} | null {
  const lower = name.toLowerCase();
  if (lower.endsWith("-win-x64.exe")) {
    return { platform: "windows", arch: "x64", label: "Windows (x64) installer" };
  }
  const mac = lower.match(/-mac-(x64|arm64)\.dmg$/);
  if (mac) {
    const arm = mac[1] === "arm64";
    return { platform: "macos", arch: arm ? "arm64" : "x64", label: arm ? "macOS (Apple silicon)" : "macOS (Intel)" };
  }
  const linux = lower.match(/-linux-(x86_64|amd64|aarch64|arm64)\.appimage$/);
  if (linux) {
    const arm = linux[1] === "aarch64" || linux[1] === "arm64";
    return { platform: "linux", arch: arm ? "arm64" : "x64", label: arm ? "Linux (arm64)" : "Linux (x64)" };
  }
  if (lower.endsWith("-android.apk")) {
    return { platform: "android", arch: null, label: "Android (APK)" };
  }
  return null;
}

function safeAssetUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "github.com" && !url.hostname.endsWith(".githubusercontent.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Turn a GitHub `releases/latest` payload into the bounded download DTO.
 * Deduplicates platform+arch and returns null when the payload is unusable. */
export function parseReleaseDownloads(payload: unknown): ReleaseDownloadsDto["release"] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const release = payload as GitHubRelease;
  const tag = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  const releaseUrl = typeof release.html_url === "string" ? safeAssetUrl(release.html_url) ?? "" : "";
  if (!version || !releaseUrl) return null;
  const publishedAt = typeof release.published_at === "string" ? release.published_at : "";
  const downloads: ReleaseDownloadDto[] = [];
  const seen = new Set<string>();
  if (Array.isArray(release.assets)) {
    for (const raw of release.assets) {
      if (!raw || typeof raw !== "object") continue;
      const asset = raw as GitHubAsset;
      const name = typeof asset.name === "string" ? asset.name : "";
      const kind = classifyReleasesAsset(name);
      if (!kind) continue;
      const url = typeof asset.browser_download_url === "string"
        ? safeAssetUrl(asset.browser_download_url)
        : null;
      if (!url) continue;
      const key = `${kind.platform}:${kind.arch ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const size = typeof asset.size === "number" && Number.isFinite(asset.size) && asset.size > 0
        ? Math.floor(asset.size)
        : null;
      downloads.push({ platform: kind.platform, arch: kind.arch, label: kind.label, url, size });
    }
  }
  downloads.sort((a, b) =>
    PLATFORM_ORDER[a.platform] - PLATFORM_ORDER[b.platform]
    || (a.arch ?? "").localeCompare(b.arch ?? ""));
  return { version, releaseUrl, publishedAt, downloads };
}

export interface ReleasesRouteDeps {
  fetchImpl?: ReleasesFetch;
  /** `owner/repo` value, or a getter read per request (default: the env var). */
  repository?: string | null | (() => string | null | undefined);
  now?: () => number;
}

/** `GET /api/system/releases` — authenticated, cached GitHub lookup. */
export function releasesRoutes(deps: ReleasesRouteDeps = {}): RouteHandler {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const readRepository = (): string | null | undefined => deps.repository === undefined
    ? process.env.POLYTH_UPDATE_REPOSITORY
    : (typeof deps.repository === "function" ? deps.repository() : deps.repository);
  let cache: { at: number; key: string; body: ReleaseDownloadsDto } | null = null;
  let inflight: { key: string; promise: Promise<ReleaseDownloadsDto> } | null = null;

  const load = async (owner: string, repo: string): Promise<ReleaseDownloadsDto> => {
    const key = `${owner}/${repo}`;
    if (cache && cache.key === key && now() - cache.at < CACHE_TTL_MS) return cache.body;
    if (inflight && inflight.key === key) return inflight.promise;
    const promise = (async (): Promise<ReleaseDownloadsDto> => {
      const url = `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          redirect: "error",
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "polyth-server",
            "x-github-api-version": "2022-11-28",
          },
        });
      } catch (error) {
        return { enabled: true, release: null, error: error instanceof Error ? error.message : String(error) };
      }
      if (response.status === 404) {
        return { enabled: true, release: null, error: "no published release" };
      }
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        const detail = retryAfter ? `retry after ${retryAfter}s` : `HTTP ${response.status}`;
        return { enabled: true, release: null, error: `GitHub API ${detail}` };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { enabled: true, release: null, error: "invalid GitHub response" };
      }
      const release = parseReleaseDownloads(payload);
      if (!release) return { enabled: true, release: null, error: "unexpected release payload" };
      return { enabled: true, release, error: null };
    })();
    inflight = { key, promise };
    try {
      const body = await promise;
      if (body.error === null) cache = { at: now(), key, body };
      return body;
    } finally {
      if (inflight?.key === key) inflight = null;
    }
  };

  return async (rc) => {
    if (rc.path !== "/api/system/releases" || rc.method !== "GET") return false;
    if (rc.principal.kind === "anonymous") {
      throw Object.assign(new Error("authentication required"), { code: "unauthorized" });
    }
    if (rc.principal.kind === "paired-device") {
      throw Object.assign(new Error("not allowed"), { code: "forbidden" });
    }
    const rawRepository = readRepository();
    const coordinates = parseReleaseRepository(rawRepository);
    if (!coordinates) {
      rc.json(200, { enabled: false, release: null, error: null } satisfies ReleaseDownloadsDto);
      return true;
    }
    rc.json(200, await load(coordinates.owner, coordinates.repo));
    return true;
  };
}
