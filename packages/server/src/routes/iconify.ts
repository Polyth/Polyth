// Same-origin proxy for Iconify project-icon search and SVG fetch. The browser
// must never call api.iconify.design directly (CORS + rate limits). Only the
// five libraries used by apps/web/src/projectIconPicker.ts are allowed.
import type { RouteHandler } from "../http.ts";

const ICONIFY_ORIGIN = "https://api.iconify.design";
const ALLOWED_PREFIXES = new Set(["hugeicons", "mingcute", "ph", "mynaui", "tabler"]);
const ICON_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const MAX_QUERY_LEN = 120;
const MAX_SEARCH_LIMIT = 999;
const MAX_BATCH_ICONS = 64;

export type IconifyFetch = typeof fetch;

function isAllowedPrefix(value: string): boolean {
  return ALLOWED_PREFIXES.has(value);
}

function isAllowedIconName(value: string): boolean {
  return ICON_NAME.test(value);
}

function deny(rc: Parameters<RouteHandler>[0], code: number, error: string, message: string): true {
  rc.json(code, { error, message });
  return true;
}

function upstreamUrl(path: string, search = ""): URL | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("..")) {
    return null;
  }
  const url = new URL(path, ICONIFY_ORIGIN);
  if (search) url.search = search;
  if (
    url.protocol !== "https:"
    || url.hostname !== "api.iconify.design"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.origin !== ICONIFY_ORIGIN
  ) {
    return null;
  }
  return url;
}

async function proxyText(
  rc: Parameters<RouteHandler>[0],
  url: URL,
  contentType: string,
  fetchImpl: IconifyFetch,
): Promise<true> {
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: "error" });
  } catch (error) {
    rc.json(502, { error: "upstream", message: error instanceof Error ? error.message : String(error) });
    return true;
  }
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) rc.res.setHeader("retry-after", retryAfter);
  const body = await response.text();
  if (!response.ok) {
    rc.res.statusCode = response.status;
    rc.res.setHeader("content-type", "application/json");
    rc.res.end(body || JSON.stringify({ error: "upstream", message: `Iconify HTTP ${response.status}` }));
    return true;
  }
  rc.res.statusCode = 200;
  rc.res.setHeader("content-type", contentType);
  rc.res.setHeader("cache-control", "public, max-age=86400");
  rc.res.end(body);
  return true;
}

async function proxyOrDeny(
  rc: Parameters<RouteHandler>[0],
  path: string,
  search: string,
  contentType: string,
  fetchImpl: IconifyFetch,
): Promise<true> {
  const url = upstreamUrl(path, search);
  if (!url) return deny(rc, 400, "invalid-input", "invalid upstream");
  return proxyText(rc, url, contentType, fetchImpl);
}

export function parseAllowlistedIconifyName(value: string): string | null {
  const name = value.startsWith("iconify:") ? value.slice("iconify:".length) : value;
  const separator = name.indexOf(":");
  if (separator <= 0 || separator === name.length - 1) return null;
  const prefix = name.slice(0, separator);
  const icon = name.slice(separator + 1);
  if (!isAllowedPrefix(prefix) || !isAllowedIconName(icon)) return null;
  return `${prefix}:${icon}`;
}

export async function loadAllowlistedIconifySvg(
  name: string,
  fetchImpl: IconifyFetch = fetch,
): Promise<string> {
  const parsed = parseAllowlistedIconifyName(name.startsWith("iconify:") ? name : `iconify:${name}`);
  if (!parsed) throw Object.assign(new Error("unsupported icon"), { code: "invalid-input" });
  const separator = parsed.indexOf(":");
  const prefix = parsed.slice(0, separator);
  const icon = parsed.slice(separator + 1);
  const url = upstreamUrl(`/${encodeURIComponent(prefix)}/${encodeURIComponent(icon)}.svg`);
  if (!url) throw Object.assign(new Error("invalid upstream"), { code: "invalid-input" });
  const response = await fetchImpl(url, { redirect: "error" });
  if (!response.ok) {
    throw Object.assign(new Error(`Iconify HTTP ${response.status}`), { code: "upstream" });
  }
  const svg = (await response.text()).trim();
  if (!/^<svg\b/i.test(svg)) throw Object.assign(new Error("invalid icon svg"), { code: "upstream" });
  return svg;
}

export function iconifyRoutes(fetchImpl: IconifyFetch = fetch): RouteHandler {
  return async (rc) => {
    const { path, method } = rc;
    if (method !== "GET" || !path.startsWith("/api/iconify/")) return false;

    if (path === "/api/iconify/search") {
      const query = (rc.url.searchParams.get("query") ?? "").trim().slice(0, MAX_QUERY_LEN);
      if (!query) return deny(rc, 400, "invalid-input", "query is required");
      const limitRaw = Number(rc.url.searchParams.get("limit") ?? "64");
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limitRaw)))
        : 64;
      const params = new URLSearchParams({ query, limit: String(limit) });
      const prefix = rc.url.searchParams.get("prefix");
      const prefixes = rc.url.searchParams.get("prefixes");
      if (prefix && prefixes) return deny(rc, 400, "invalid-input", "use prefix or prefixes, not both");
      if (prefix) {
        if (!isAllowedPrefix(prefix)) return deny(rc, 400, "invalid-input", "unsupported icon library");
        params.set("prefix", prefix);
      } else if (prefixes) {
        const parts = prefixes.split(",").map((part) => part.trim()).filter(Boolean);
        if (!parts.length || parts.some((part) => !isAllowedPrefix(part))) {
          return deny(rc, 400, "invalid-input", "unsupported icon library");
        }
        params.set("prefixes", parts.join(","));
      } else {
        params.set("prefixes", [...ALLOWED_PREFIXES].join(","));
      }
      return proxyOrDeny(rc, "/search", params.toString(), "application/json", fetchImpl);
    }

    const batchMatch = path.match(/^\/api\/iconify\/([^/]+)\.json$/);
    if (batchMatch) {
      const prefix = decodeURIComponent(batchMatch[1]!);
      if (!isAllowedPrefix(prefix)) return deny(rc, 400, "invalid-input", "unsupported icon library");
      const iconsParam = (rc.url.searchParams.get("icons") ?? "").trim();
      if (!iconsParam) return deny(rc, 400, "invalid-input", "icons is required");
      const icons = [...new Set(iconsParam.split(",").map((part) => part.trim()).filter(Boolean))];
      if (!icons.length || icons.length > MAX_BATCH_ICONS || icons.some((icon) => !isAllowedIconName(icon))) {
        return deny(rc, 400, "invalid-input", "invalid icon name");
      }
      const params = new URLSearchParams({ icons: icons.join(",") });
      return proxyOrDeny(rc, `/${encodeURIComponent(prefix)}.json`, params.toString(), "application/json", fetchImpl);
    }

    const svgMatch = path.match(/^\/api\/iconify\/([^/]+)\/([^/]+)\.svg$/);
    if (svgMatch) {
      const prefix = decodeURIComponent(svgMatch[1]!);
      const icon = decodeURIComponent(svgMatch[2]!);
      if (!isAllowedPrefix(prefix) || !isAllowedIconName(icon)) {
        return deny(rc, 400, "invalid-input", "invalid icon");
      }
      return proxyOrDeny(
        rc,
        `/${encodeURIComponent(prefix)}/${encodeURIComponent(icon)}.svg`,
        "",
        "image/svg+xml",
        fetchImpl,
      );
    }

    return deny(rc, 404, "not-found", "unknown iconify route");
  };
}
