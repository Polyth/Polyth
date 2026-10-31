import { App } from "@capacitor/app";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { consumeNativePendingUrl, nativeNavigationAvailable } from "./nativeNavigation.ts";
import { consumeNativePushOpen, type NativePushOpen } from "./nativePush.ts";
import { coverPageForLeave } from "./launch.ts";
import { consumeNativeServerChoice, presentNativeServerMenu, type ServerMenuAnchor } from "./nativePolythLink.ts";

const HOSTS_KEY = "polyth.mobile.hosts.v1";
const PENDING_DEEP_LINK_KEY = "polyth.mobile.pending-deep-link.v1";
const PROXY_RECOVERY_ERROR = "proxy-recovery-failed";
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
      pendingPair?: string;
      pendingPushOpen?: NativePushOpen;
      selectServer?: boolean;
      /** The server picked from the native server menu: open it right away. */
      switchTo?: string;
      /** "Add server" from the native server menu: lead with pairing. */
      addServer?: boolean;
      /** The open server's page lost its local proxy and asked to be re-opened. */
      resume?: boolean;
      developerUnlocked?: boolean;
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

export function isPolythLinkLoopbackOrigin(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
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

function canonicalProjectPath(pathname: string): string | undefined {
  const match = /^\/p\/([^/]+)(?:\/s\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return undefined;
  const projectId = decodedPathSegment(match[1]!);
  const sessionId = match[2] ? decodedPathSegment(match[2]) : undefined;
  if (!projectId || (match[2] && !sessionId)) return undefined;
  return `/p/${encodeURIComponent(projectId)}${sessionId ? `/s/${encodeURIComponent(sessionId)}` : ""}`;
}

function canonicalMobilePath(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw, "https://localhost");
  } catch {
    return undefined;
  }
  if (url.origin !== "https://localhost" || url.hash) return undefined;
  const projectPath = canonicalProjectPath(url.pathname);
  if (projectPath && !url.search) return projectPath;
  const keys = [...url.searchParams.keys()];
  if (url.pathname === "/" && keys.length === 1 && keys[0] === "session") {
    const session = url.searchParams.get("session");
    return session ? `/?session=${encodeURIComponent(session)}` : undefined;
  }
  return undefined;
}

export function isPairingDeepLink(raw: string): boolean {
  const value = raw.trim();
  return value.startsWith("polyth://pair?") || value.startsWith("polyth://pair/?");
}

export function mobileDeepLinkPath(raw: string): string | undefined {
  if (isPairingDeepLink(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    const projectPath = canonicalProjectPath(url.pathname);
    return projectPath
      ? projectPath
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
  if (url.hostname === "open") {
    return canonicalProjectPath(url.pathname);
  }
  return undefined;
}

function isBundledOrigin(): boolean {
  return location.hostname === "localhost"
    && (location.protocol === "capacitor:" || location.protocol === "https:");
}

function bundledRecoveryError(): string | undefined {
  if (!isBundledOrigin()) return undefined;
  return new URLSearchParams(location.search).get("connectionError") === PROXY_RECOVERY_ERROR
    ? "Could not restore the secure local connection. Choose a Polyth server to try again."
    : undefined;
}

function bundledMobileOrigin(): string {
  return Capacitor.getPlatform() === "ios" ? "capacitor://localhost" : "https://localhost";
}

async function consumePendingMobilePath(): Promise<string | undefined> {
  const { value } = await Preferences.get({ key: PENDING_DEEP_LINK_KEY });
  await Preferences.remove({ key: PENDING_DEEP_LINK_KEY });
  return value ? canonicalMobilePath(value) : undefined;
}

/**
 * Leave the current page for the bundled Connection Hub. `resume` marks a
 * recovery bounce from the open server's own page (its local proxy stopped
 * answering): the hub then re-opens that server at `deepLinkPath` by itself
 * instead of waiting on a tap, which an unrelated OS deep link never gets.
 */
export async function returnToMobileConnectionHub(
  deepLinkPath?: string,
  options?: HubOptions,
): Promise<void> {
  try {
    const canonical = deepLinkPath ? canonicalMobilePath(deepLinkPath) : undefined;
    if (canonical) {
      await Preferences.set({ key: PENDING_DEEP_LINK_KEY, value: canonical });
    }
  } finally {
    // The page's veil comes back and the native curtain covers the swap: the
    // hub that re-opens a server never flashes between the two pages.
    await coverPageForLeave().catch(() => undefined);
    location.replace(mobileConnectionHubUrl(bundledMobileOrigin(), options));
  }
}

interface HubOptions {
  selectServer?: boolean;
  addServer?: boolean;
  resume?: boolean;
}

export function mobileConnectionHubUrl(origin: string, options?: HubOptions): string {
  if (options?.addServer) return `${origin}?selectServer=1&addServer=1`;
  if (options?.selectServer) return `${origin}?selectServer=1`;
  if (options?.resume) return `${origin}?resume=1`;
  return origin;
}

/**
 * The server button: the app's own menu of paired servers at `anchor`. The
 * page never sees the list (the Link plugin serves it to the bundled hub
 * only); a picked server travels natively to the hub, which opens it. Where
 * the menu cannot show, the hub's full server list stands in.
 */
export async function chooseMobileServer(anchor?: ServerMenuAnchor): Promise<void> {
  const action = anchor ? await presentNativeServerMenu(anchor) : null;
  if (action === "current" || action === "cancel") return;
  await returnToMobileConnectionHub(undefined, action === "add" ? { addServer: true } : { selectServer: true });
}

export function navigateToMobileHost(host: string, deepLinkPath = "/"): void {
  location.replace(`${normalizePolythHost(host)}${deepLinkPath.startsWith("/") ? deepLinkPath : `/${deepLinkPath}`}`);
}

export async function prepareMobileLaunch(): Promise<MobileLaunch> {
  if (!isNativeMobile()) return { kind: "web" };
  const hosts = await loadMobileHosts();

  // Never apply an OS/custom deep link directly to an already connected
  // origin. The link may belong to another paired server and loopback Polyth
  // Link origins deliberately do not expose privileged connection metadata.
  if (!isBundledOrigin()) {
    if (!isPolythLinkLoopbackOrigin(location.origin)) {
      await rememberMobileHost(location.origin);
    }
    return { kind: "app" };
  }

  const pendingPath = await consumePendingMobilePath().catch(() => undefined);
  // A provider payload has already been strictly mapped to a trusted native
  // connection/account before this point. It carries no URL or session data.
  const pendingPushOpen = await consumeNativePushOpen().catch(() => undefined);
  const opened = nativeNavigationAvailable()
    ? await consumeNativePendingUrl().catch(() => undefined)
    : (await App.getLaunchUrl().catch(() => undefined))?.url;
  const deepLinkPath = (opened ? mobileDeepLinkPath(opened) : undefined) ?? pendingPath;
  const launchPair = opened && isPairingDeepLink(opened) ? opened : undefined;

  if (launchPair) {
    return {
      kind: "connect",
      recent: hosts.recent,
      pendingPair: launchPair,
      ...(deepLinkPath ? { deepLinkPath } : {}),
      ...(pendingPushOpen ? { pendingPushOpen } : {}),
    };
  }

  const recoveryError = bundledRecoveryError();
  const search = new URLSearchParams(location.search);
  const selectServer = search.get("selectServer") === "1";
  const addServer = selectServer && search.get("addServer") === "1";
  // Only a hub opened for a server choice takes one; a stale choice is
  // dropped by the native side, never replayed into an unrelated launch.
  const switchTo = selectServer && !addServer && !opened
    ? await consumeNativeServerChoice().catch(() => undefined)
    : undefined;
  // An OS deep link that arrived meanwhile wins over resuming the old page.
  const resume = search.get("resume") === "1" && !opened;
  return {
    kind: "connect",
    recent: hosts.recent,
    ...(hosts.active ? { preferred: hosts.active } : {}),
    ...(recoveryError ? { error: recoveryError } : {}),
    ...(selectServer ? { selectServer: true } : {}),
    ...(addServer ? { addServer: true } : {}),
    ...(switchTo ? { switchTo } : {}),
    ...(resume ? { resume: true } : {}),
    ...(deepLinkPath ? { deepLinkPath } : {}),
    ...(pendingPushOpen ? { pendingPushOpen } : {}),
  };
}
