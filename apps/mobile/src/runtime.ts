import { App } from "@capacitor/app";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

const HOSTS_KEY = "polyth.mobile.hosts.v1";
const MAX_RECENT_HOSTS = 5;

export interface MobileHost {
  url: string;
  lastUsedAt: number;
}

interface HostState {
  active?: string;
  recent: MobileHost[];
}

export type ConnectionCheck =
  | { ok: true; authRequired: boolean }
  | { ok: false; message: string };

export type MobileLaunch =
  | { kind: "web" }
  | { kind: "app"; deepLinkPath?: string }
  | { kind: "navigating" }
  | {
      kind: "connect";
      recent: MobileHost[];
      preferred?: string;
      error?: string;
      deepLinkPath?: string;
    };

export function isNativeMobile(): boolean {
  return Capacitor.isNativePlatform()
    && (Capacitor.getPlatform() === "android" || Capacitor.getPlatform() === "ios");
}

export function normalizePolythHost(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter the address of your Polyth server.");
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("Enter a valid Polyth server address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Polyth server addresses must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Do not put credentials in the server address.");
  }
  if (!url.hostname) throw new Error("Enter a valid Polyth server address.");
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function parseHostState(value: string | null): HostState {
  try {
    const parsed = JSON.parse(value ?? "null") as Partial<HostState> | null;
    const recent = Array.isArray(parsed?.recent)
      ? parsed.recent.filter((host): host is MobileHost =>
          !!host && typeof host.url === "string" && typeof host.lastUsedAt === "number")
      : [];
    return {
      ...(typeof parsed?.active === "string" ? { active: parsed.active } : {}),
      recent: recent.slice(0, MAX_RECENT_HOSTS),
    };
  } catch {
    return { recent: [] };
  }
}

export async function loadMobileHosts(): Promise<HostState> {
  const { value } = await Preferences.get({ key: HOSTS_KEY });
  return parseHostState(value);
}

export async function rememberMobileHost(raw: string): Promise<string> {
  const url = normalizePolythHost(raw);
  const state = await loadMobileHosts();
  const recent = [
    { url, lastUsedAt: Date.now() },
    ...state.recent.filter((host) => host.url !== url),
  ].slice(0, MAX_RECENT_HOSTS);
  await Preferences.set({
    key: HOSTS_KEY,
    value: JSON.stringify({ active: url, recent }),
  });
  return url;
}

export async function forgetMobileHost(raw: string): Promise<HostState> {
  const url = normalizePolythHost(raw);
  const state = await loadMobileHosts();
  const recent = state.recent.filter((host) => host.url !== url);
  const active = state.active === url ? recent[0]?.url : state.active;
  const next: HostState = { ...(active ? { active } : {}), recent };
  await Preferences.set({ key: HOSTS_KEY, value: JSON.stringify(next) });
  return next;
}

export async function checkPolythHost(raw: string): Promise<ConnectionCheck> {
  let url: string;
  try {
    url = normalizePolythHost(raw);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    const response = isNativeMobile()
      ? await CapacitorHttp.get({
          url: `${url}/api/auth/status`,
          connectTimeout: 8_000,
          readTimeout: 8_000,
        })
      : {
          status: 200,
          data: await fetch(`${url}/api/auth/status`, {
            credentials: "include",
          }).then(async (result) => {
            if (!result.ok) throw new Error(`HTTP ${result.status}`);
            return await result.json() as unknown;
          }),
        };
    if (response.status !== 200) {
      return { ok: false, message: `The server returned HTTP ${response.status}.` };
    }
    const data = response.data as { required?: unknown };
    if (!data || typeof data !== "object" || typeof data.required !== "boolean") {
      return { ok: false, message: "This address did not return a Polyth server response." };
    }
    return { ok: true, authRequired: data.required };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const secureHint = url.startsWith("http:")
      ? " Confirm that the phone can reach this host on the same network."
      : " Check the certificate and server address.";
    return { ok: false, message: `Could not reach Polyth. ${detail}.${secureHint}` };
  }
}

function decodedPathSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !decoded.includes("/") ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function mobileDeepLinkPath(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return /^\/p\/[^/]+(?:\/s\/[^/]+)?\/?$/.test(url.pathname)
      // A universal/app link may carry tracking or credential-like query
      // parameters from another application. Canonical project/session paths
      // need none of them, so never copy that data to the selected Polyth host.
      ? url.pathname
      : url.searchParams.has("session")
        ? `/?session=${encodeURIComponent(url.searchParams.get("session") ?? "")}`
        : undefined;
  }
  if (url.protocol !== "polyth:") return undefined;
  const session = url.searchParams.get("session");
  const project = url.searchParams.get("project");
  if (session) return `/?session=${encodeURIComponent(session)}`;
  if (project) return `/p/${encodeURIComponent(project)}`;
  if (url.hostname === "session" && url.pathname.length > 1) {
    const id = decodedPathSegment(url.pathname.slice(1));
    return id ? `/?session=${encodeURIComponent(id)}` : undefined;
  }
  if (url.hostname === "project" && url.pathname.length > 1) {
    const id = decodedPathSegment(url.pathname.slice(1));
    return id ? `/p/${encodeURIComponent(id)}` : undefined;
  }
  if (url.hostname === "open" && /^\/p\/[^/]+(?:\/s\/[^/]+)?\/?$/.test(url.pathname)) {
    return url.pathname;
  }
  return undefined;
}

function isBundledOrigin(): boolean {
  return location.hostname === "localhost"
    && (location.protocol === "capacitor:" || location.protocol === "https:");
}

export function navigateToMobileHost(host: string, deepLinkPath = "/"): void {
  location.replace(`${normalizePolythHost(host)}${deepLinkPath.startsWith("/") ? deepLinkPath : `/${deepLinkPath}`}`);
}

export async function prepareMobileLaunch(): Promise<MobileLaunch> {
  if (!isNativeMobile()) return { kind: "web" };
  const hosts = await loadMobileHosts();
  const launchUrl = await App.getLaunchUrl().catch(() => undefined);
  const deepLinkPath = launchUrl?.url ? mobileDeepLinkPath(launchUrl.url) : undefined;

  if (!isBundledOrigin()) {
    await rememberMobileHost(location.origin);
    if (deepLinkPath && `${location.pathname}${location.search}` !== deepLinkPath) {
      history.replaceState(null, "", deepLinkPath);
    }
    return { kind: "app", ...(deepLinkPath ? { deepLinkPath } : {}) };
  }

  if (hosts.active) {
    const checked = await checkPolythHost(hosts.active);
    if (checked.ok) {
      navigateToMobileHost(hosts.active, deepLinkPath);
      return { kind: "navigating" };
    }
    return {
      kind: "connect",
      recent: hosts.recent,
      preferred: hosts.active,
      error: checked.message,
      ...(deepLinkPath ? { deepLinkPath } : {}),
    };
  }
  return {
    kind: "connect",
    recent: hosts.recent,
    ...(deepLinkPath ? { deepLinkPath } : {}),
  };
}
