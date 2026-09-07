import type { AuthUrlKind } from "@polyth/contracts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

export const safeHttpUrl = (raw: string | undefined): string | undefined => {
  if (!raw?.trim()) return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
};

export const classifyAuthUrl = (raw: string | undefined): AuthUrlKind => {
  const href = safeHttpUrl(raw);
  if (!href) return "unknown";
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return "unknown";
  }
  const path = `${url.hostname}${url.pathname}`.toLowerCase();
  if (/\/device\b|verification[_-]?uri|\/activate\b/.test(path)) return "device_verification";
  if (/\/(authorize|oauth|oauth2|login\/oauth)\b/.test(path)) return "authorization";
  if (/\/(docs?|documentation|help|readme|pricing|quickstart)\b/.test(path)) return "informational";
  return "unknown";
};

export const hostnameIsLoopback = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
};

export const urlHasLoopbackRedirect = (raw: string | undefined): boolean => {
  const href = safeHttpUrl(raw);
  if (!href) return false;
  try {
    const url = new URL(href);
    if (hostnameIsLoopback(url.hostname)) return true;
    for (const key of ["redirect_uri", "redirect_url", "redirectUri", "callback", "return_to"]) {
      const value = url.searchParams.get(key);
      if (!value) continue;
      try {
        if (hostnameIsLoopback(new URL(value).hostname)) return true;
      } catch {
        if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(value)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
};
