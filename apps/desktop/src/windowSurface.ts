import { isConnectionId } from "./servers.ts";
import type { DesktopSettings } from "./types.ts";

/**
 * What the window is showing, and so what it may ask of the main process.
 *
 * - `local`: this computer's own server, whose code is this build.
 * - `hub`: the bundled server list on its own origin, the only page holding
 *   connection metadata and the only one that may pair, connect or forget.
 * - `remote`: another Polyth. A Link page runs this build's shell, but packages
 *   only that server has load from it; an address page is that server's code
 *   entirely. Either way it may move the window and report activity, and nothing
 *   here lets it reach this computer's files, data folder or sign-in.
 */
export type WindowSurface = "local" | "hub" | "remote";

export const HUB_SCHEME = "polyth-app";
export const HUB_ORIGIN = `${HUB_SCHEME}://hub`;

export interface WindowOrigins {
  /** This computer's server, while it runs. */
  local: string | null;
  /** Other servers this launch has opened. */
  remote: ReadonlySet<string>;
}

/** A custom scheme's `origin` depends on how it was registered, so compare by hand. */
function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === `${HUB_SCHEME}:` ? `${url.protocol}//${url.host}` : url.origin;
  } catch {
    return null;
  }
}

export function windowSurface(rawUrl: string, origins: WindowOrigins): WindowSurface | null {
  const origin = originOf(rawUrl);
  if (!origin || origin === "null") return null;
  if (origin === HUB_ORIGIN) return "hub";
  if (origin === origins.local) return "local";
  return origins.remote.has(origin) ? "remote" : null;
}

/** A page may navigate itself within its own origin. The list may also hand the
 *  window to a server it just connected; every other change of server goes
 *  through the main process, which never asks the page. */
export function navigationAllowed(fromUrl: string, toUrl: string, origins: WindowOrigins): boolean {
  const from = originOf(fromUrl);
  const to = originOf(toUrl);
  if (!to || to === "null") return false;
  if (from === to) return true;
  return from === HUB_ORIGIN && origins.remote.has(to);
}

/**
 * Whether a request from a page in the window must stop short of this computer's
 * server. Sites ignore ports, so a Link page on 127.0.0.1 is the same site as that
 * server: SameSite lets its session cookie through, and packages from the other
 * server run on that page. Only this computer's own page may call it. A
 * navigation is exempt, because `navigationAllowed` and the main process decide
 * those, and it is how the window comes back here.
 */
export function blockedFromLocalServer(
  request: { url: string; resourceType?: string },
  pageUrl: string,
  origins: WindowOrigins,
): boolean {
  if (!origins.local || request.resourceType === "mainFrame") return false;
  try {
    if (new URL(request.url).host !== new URL(origins.local).host) return false;
  } catch {
    return false;
  }
  return windowSurface(pageUrl, origins) !== "local";
}

const WINDOW_CHANNELS = [
  "desktop:surface",
  "desktop:info",
  "desktop:settings:get",
  "desktop:settings:set",
  "desktop:window:get",
  "desktop:window:titlebar",
  "desktop:window",
  "desktop:quit",
  "desktop:update:get",
  "desktop:update:check",
  "desktop:update:download",
  "desktop:update:install",
  "desktop:update:show",
  "desktop:keep-awake:get",
  "desktop:keep-awake:activity",
] as const;

const LEAVE_CHANNELS = ["desktop:servers:menu", "desktop:servers:list"] as const;
const REMOTE_CHANNELS = new Set<string>([...WINDOW_CHANNELS, ...LEAVE_CHANNELS, "desktop:servers:resume"]);
const HUB_CHANNELS = new Set<string>([
  ...WINDOW_CHANNELS,
  ...LEAVE_CHANNELS,
  "desktop:link",
  "desktop:servers:state",
  "desktop:servers:open",
  "desktop:servers:forget-address",
  "desktop:servers:run-local",
]);
/** The list owns connection authority: this computer's page has no use for it. */
const LOCAL_DENIED = new Set<string>([
  "desktop:link",
  "desktop:servers:open",
  "desktop:servers:forget-address",
  "desktop:servers:run-local",
  "desktop:servers:state",
  "desktop:servers:resume",
]);

export function channelAllowed(surface: WindowSurface | null, channel: string): boolean {
  if (surface === "hub") return HUB_CHANNELS.has(channel);
  if (surface === "remote") return REMOTE_CHANNELS.has(channel);
  return surface === "local" && !LOCAL_DENIED.has(channel);
}

/** Choices that outlive the window and decide what runs on this computer. A
 *  page from another server may not make them; they stay in the tray menu and
 *  on this computer's own Settings page. */
const REMOTE_DENIED_SETTINGS = new Set<keyof DesktopSettings>(["launchAtLogin", "automaticUpdates", "updateChannel"]);

export function settingsPatchFor(surface: WindowSurface | null, patch: unknown): Partial<DesktopSettings> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return {};
  if (surface !== "remote") return patch as Partial<DesktopSettings>;
  return Object.fromEntries(Object.entries(patch)
    .filter(([key]) => !REMOTE_DENIED_SETTINGS.has(key as keyof DesktopSettings))) as Partial<DesktopSettings>;
}

const invalid = (): Error => Object.assign(new Error("invalid-request"), { code: "invalid-request" });
const text = (value: unknown, limit: number): string => {
  if (typeof value !== "string" || !value || value.length > limit) throw invalid();
  return value;
};
const connection = (params: Record<string, unknown>): { connectionId: string } => {
  if (!isConnectionId(params.connectionId)) throw invalid();
  return { connectionId: params.connectionId };
};
const attempt = (params: Record<string, unknown>): { attemptId: string } => ({ attemptId: text(params.attemptId, 128) });

const LINK_METHODS: Readonly<Record<string, (params: Record<string, unknown>) => Record<string, unknown>>> = {
  "pairing.parse": (params) => ({ ticket: text(params.ticket, 8192) }),
  "pairing.begin": (params) => ({
    ticket: text(params.ticket, 8192),
    ...(typeof params.label === "string" && params.label ? { label: params.label.slice(0, 80) } : {}),
  }),
  "pairing.confirm": attempt,
  "pairing.cancel": attempt,
  "connections.list": () => ({}),
  "connections.rename": (params) => ({
    ...connection(params),
    label: typeof params.label === "string" ? params.label.slice(0, 80) : "",
  }),
  connect: connection,
  "connection.recover": connection,
  disconnect: connection,
  forget: connection,
  status: connection,
};

/** The Link client requests the server list may make, with only the fields each one uses. */
export function linkRequest(method: unknown, params: unknown): { method: string; params: Record<string, unknown> } {
  const build = typeof method === "string" && Object.hasOwn(LINK_METHODS, method) ? LINK_METHODS[method] : undefined;
  if (!build) throw invalid();
  const fields = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
  return { method: method as string, params: build(fields) };
}

/** A path the list may open on the server it connects: the app's own routes only. */
export function safeNextPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.length > 2048) return undefined;
  return /[\\\s\u0000-\u001f]/u.test(value) ? undefined : value;
}

export interface HubOptions {
  /** Connect to this server by itself. */
  open?: string;
  /** Lead with adding a server. */
  add?: boolean;
  /** The page of the open server lost its proxy and asked to come back. */
  resume?: boolean;
  next?: string;
  error?: string;
}

export function hubUrl(options: HubOptions = {}): string {
  const query = new URLSearchParams();
  if (options.open) query.set("open", options.open);
  if (options.add) query.set("add", "1");
  if (options.resume) query.set("resume", "1");
  const next = safeNextPath(options.next);
  if (next) query.set("next", next);
  if (options.error) query.set("error", options.error);
  const search = query.toString();
  return `${HUB_ORIGIN}/${search ? `?${search}` : ""}`;
}
