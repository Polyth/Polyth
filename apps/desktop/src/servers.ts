import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Which Polyth the window shows, and whether this computer runs one of its own.
 * Only the main process and the trusted server list change this, so it lives
 * apart from DesktopSettings, which every page of the window may read and write.
 */
export type DesktopServerTarget =
  | { kind: "local" }
  | { kind: "link"; id: string }
  | { kind: "address"; url: string };

export interface SavedServerAddress {
  url: string;
  lastUsedAt: number;
}

export interface DesktopServersState {
  active: DesktopServerTarget;
  /** Start this computer's server with the app. Off for someone who only connects. */
  runLocalServer: boolean;
  /** The port is part of a page's origin, so keeping it keeps that server's
   *  shell state (open projects, navigator order) from one launch to the next. */
  linkPorts: Record<string, number>;
  addresses: SavedServerAddress[];
  /** Other servers the person let use this computer's microphone. */
  microphoneServers: string[];
  /** Other servers the person let read this computer's clipboard (Paste). */
  clipboardServers: string[];
  /** Other servers the person let list their remaining servers and those
   *  servers' projects in its navigator (src/serverZones.ts). */
  zoneServers: string[];
  /** Server zones the person folded in the navigator, this computer's
   *  (`local`) included. Kept here so it never joins a server's synced
   *  preferences, where it would name the person's other servers. */
  foldedZones: string[];
}

export const DEFAULT_SERVERS_STATE: DesktopServersState = {
  active: { kind: "local" },
  runLocalServer: true,
  linkPorts: {},
  addresses: [],
  microphoneServers: [],
  clipboardServers: [],
  zoneServers: [],
  foldedZones: [],
};

/** A bound on a file a person fills by hand, not a product limit: the
 *  navigator lists every saved server as a zone. */
const MAX_ADDRESSES = 64;
const CONNECTION_ID = /^[A-Za-z0-9]{1,128}$/;

export const isConnectionId = (value: unknown): value is string =>
  typeof value === "string" && CONNECTION_ID.test(value);

/** The origin of a server address someone typed; throws on anything else. */
export function normalizeServerAddress(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > 2048) throw invalidAddress();
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw invalidAddress();
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) {
    throw invalidAddress();
  }
  return url.origin;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The address names this computer's own server, whatever loopback name it uses. */
export function isThisComputersServer(address: string, localUrl: string): boolean {
  if (!localUrl) return false;
  try {
    const target = new URL(address);
    const local = new URL(localUrl);
    return target.protocol === local.protocol && target.port === local.port && LOOPBACK_HOSTS.has(target.hostname);
  } catch {
    return false;
  }
}

function invalidAddress(): Error {
  return Object.assign(new Error("invalid-address"), { code: "invalid-address" });
}

function normalizeTarget(raw: unknown): DesktopServerTarget | null {
  const value = raw as { kind?: unknown; id?: unknown; url?: unknown } | null;
  if (value?.kind === "local") return { kind: "local" };
  if (value?.kind === "link" && isConnectionId(value.id)) return { kind: "link", id: value.id };
  if (value?.kind === "address") {
    try {
      return { kind: "address", url: normalizeServerAddress(value.url) };
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeServersState(raw: unknown): DesktopServersState {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const linkPorts: Record<string, number> = {};
  if (value.linkPorts && typeof value.linkPorts === "object" && !Array.isArray(value.linkPorts)) {
    for (const [id, port] of Object.entries(value.linkPorts)) {
      if (isConnectionId(id) && Number.isInteger(port) && (port as number) > 0 && (port as number) < 65_536) {
        linkPorts[id] = port as number;
      }
    }
  }
  const addresses: SavedServerAddress[] = [];
  if (Array.isArray(value.addresses)) {
    for (const entry of value.addresses as Array<{ url?: unknown; lastUsedAt?: unknown }>) {
      try {
        const url = normalizeServerAddress(entry?.url);
        if (addresses.some((address) => address.url === url)) continue;
        addresses.push({ url, lastUsedAt: typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : 0 });
      } catch { /* a broken entry is dropped, the rest stay */ }
    }
  }
  return {
    active: normalizeTarget(value.active) ?? { kind: "local" },
    runLocalServer: typeof value.runLocalServer === "boolean" ? value.runLocalServer : true,
    linkPorts,
    addresses: addresses.slice(0, MAX_ADDRESSES),
    microphoneServers: serverKeys(value.microphoneServers),
    clipboardServers: serverKeys(value.clipboardServers),
    zoneServers: serverKeys(value.zoneServers),
    foldedZones: serverKeys(value.foldedZones, true),
  };
}

const serverKeys = (value: unknown, withLocal = false): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((key): key is string =>
      typeof key === "string" && key.length <= 2100 && (/^(?:link|address):/.test(key) || (withLocal && key === "local"))))]
    : [];

/** How a saved server is named in the per-server lists above. */
export const serverKey = (target: DesktopServerTarget): string =>
  target.kind === "local" ? "local" : target.kind === "link" ? `link:${target.id}` : `address:${target.url}`;

/** Everything remembered about a server the person forgot. */
export function forgetServerKey(state: DesktopServersState, key: string): DesktopServersState {
  const kept = (value: string): boolean => value !== key;
  return {
    ...state,
    microphoneServers: state.microphoneServers.filter(kept),
    clipboardServers: state.clipboardServers.filter(kept),
    zoneServers: state.zoneServers.filter(kept),
    foldedZones: state.foldedZones.filter(kept),
  };
}

export function readServersStateSync(path: string): DesktopServersState {
  try {
    return normalizeServersState(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return { ...DEFAULT_SERVERS_STATE };
  }
}

export async function writeServersState(path: string, state: DesktopServersState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export function rememberAddress(state: DesktopServersState, url: string, now: number): DesktopServersState {
  return {
    ...state,
    addresses: [{ url, lastUsedAt: now }, ...state.addresses.filter((address) => address.url !== url)].slice(0, MAX_ADDRESSES),
  };
}

export const sameTarget = (a: DesktopServerTarget, b: DesktopServerTarget): boolean =>
  a.kind === b.kind
  && (a.kind !== "link" || a.id === (b as { id: string }).id)
  && (a.kind !== "address" || a.url === (b as { url: string }).url);

/** What a launch does before anyone chooses anything. */
export function startupPlan(state: DesktopServersState): {
  bootLocal: boolean;
  open: "local" | "address" | "server-list";
  /** The server the list opens by itself. */
  connect?: string;
} {
  switch (state.active.kind) {
    case "link":
      return { bootLocal: state.runLocalServer, open: "server-list", connect: state.active.id };
    case "address":
      return { bootLocal: state.runLocalServer, open: "address" };
    default:
      // Turned off while it was the one on screen: nothing to show until a choice.
      return state.runLocalServer
        ? { bootLocal: true, open: "local" }
        : { bootLocal: false, open: "server-list" };
  }
}
