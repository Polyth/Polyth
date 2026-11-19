import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isConnectionId,
  normalizeServerAddress,
  serverKey,
  type DesktopServersState,
  type DesktopServerTarget,
} from "./servers.ts";
import type { DesktopServerZone, DesktopServerZoneProject, DesktopServerZonesView } from "./types.ts";

/**
 * Server zones: every Polyth this app can open, listed in the navigator with
 * its projects, so a person works on this computer and in any number of teams
 * from one list.
 *
 * Only the server on screen has a page, so nothing here keeps a connection
 * open. Each server's own page lists its projects to the main process while
 * it is on screen (`report`); the main process remembers the last list per
 * server and hands the other servers' lists to the page on screen. The lists
 * are a snapshot from the last visit, never live.
 *
 * A page is trusted only for its own server: the key a list is filed under
 * comes from the sender's origin, never from what the page says. Another
 * server's page runs that server's packages, so it reads the other zones only
 * once the person allowed that server to (`zoneServers`).
 */

export const LOCAL_ZONE = "local";

const MAX_PROJECTS = 200;
const MAX_NAME = 120;
const MAX_ICON = 4096;
const PROJECT_ID = /^[^\s/\\?#%\u0000-\u001f\u007f]{1,128}$/u;
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export interface ZoneSnapshot {
  projects: DesktopServerZoneProject[];
  /** When that server's page last listed them. */
  reportedAt: number;
}

export type ZoneSnapshots = Record<string, ZoneSnapshot>;

/** The server a key names, or nothing for a key this app never wrote. */
export function zoneTarget(key: unknown): DesktopServerTarget | null {
  if (key === LOCAL_ZONE) return { kind: "local" };
  if (typeof key !== "string") return null;
  if (key.startsWith("link:")) {
    const id = key.slice(5);
    return isConnectionId(id) ? { kind: "link", id } : null;
  }
  if (key.startsWith("address:")) {
    try {
      const url = normalizeServerAddress(key.slice(8));
      return key === `address:${url}` ? { kind: "address", url } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * A page's own project list, reduced to what a row shows. The page may be
 * another server's code: anything odd is dropped rather than repaired, and the
 * size is bounded whatever it sends.
 */
export function normalizeZoneProjects(raw: unknown): DesktopServerZoneProject[] {
  if (!Array.isArray(raw)) return [];
  const projects: DesktopServerZoneProject[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_PROJECTS * 2) as Array<Record<string, unknown> | null>) {
    if (projects.length >= MAX_PROJECTS) break;
    if (!entry || typeof entry !== "object") continue;
    const { id, name, icon, color } = entry;
    if (typeof id !== "string" || !PROJECT_ID.test(id) || seen.has(id)) continue;
    if (typeof name !== "string") continue;
    const label = name.replace(/\s+/gu, " ").trim().slice(0, MAX_NAME);
    if (!label || CONTROL.test(label)) continue;
    seen.add(id);
    projects.push({
      id,
      name: label,
      ...(typeof icon === "string" && icon && icon.length <= MAX_ICON && !CONTROL.test(icon) ? { icon } : {}),
      ...(typeof color === "string" && COLOR.test(color) ? { color } : {}),
    });
  }
  return projects;
}

export function normalizeZoneSnapshots(raw: unknown): ZoneSnapshots {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const snapshots: ZoneSnapshots = {};
  for (const [key, entry] of Object.entries(value)) {
    const target = zoneTarget(key);
    const snapshot = entry as { projects?: unknown; reportedAt?: unknown } | null;
    if (!target || !snapshot || typeof snapshot !== "object") continue;
    snapshots[serverKey(target)] = {
      projects: normalizeZoneProjects(snapshot.projects),
      reportedAt: typeof snapshot.reportedAt === "number" && Number.isFinite(snapshot.reportedAt) ? snapshot.reportedAt : 0,
    };
  }
  return snapshots;
}

export function readZoneSnapshotsSync(path: string): ZoneSnapshots {
  try {
    return normalizeZoneSnapshots(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return {};
  }
}

export async function writeZoneSnapshots(path: string, snapshots: ZoneSnapshots): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(snapshots)}\n`, { mode: 0o600 });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const sameProjects = (a: readonly DesktopServerZoneProject[], b: readonly DesktopServerZoneProject[]): boolean =>
  a.length === b.length && a.every((project, index) => {
    const other = b[index]!;
    return project.id === other.id && project.name === other.name && project.icon === other.icon && project.color === other.color;
  });

/** Files a server's list; returns the same object when nothing changed, so
 *  the caller skips the write. */
export function recordZoneReport(snapshots: ZoneSnapshots, key: string, rawProjects: unknown, now: number): ZoneSnapshots {
  const projects = normalizeZoneProjects(rawProjects);
  const previous = snapshots[key];
  if (previous && sameProjects(previous.projects, projects)) return snapshots;
  return { ...snapshots, [key]: { projects, reportedAt: now } };
}

/** Drops the lists of servers that are no longer saved. */
export function pruneZoneSnapshots(snapshots: ZoneSnapshots, known: ReadonlySet<string>): ZoneSnapshots {
  const kept = Object.entries(snapshots).filter(([key]) => known.has(key));
  return kept.length === Object.keys(snapshots).length ? snapshots : Object.fromEntries(kept);
}

export interface ZoneLink {
  id: string;
  hostLabel: string;
  revoked: boolean;
}

export interface ZoneSources {
  servers: DesktopServersState;
  links: readonly ZoneLink[];
  /** This computer's server is set up, so there is something to go back to. */
  localAvailable: boolean;
  snapshots: ZoneSnapshots;
}

const addressLabel = (url: string): string => {
  try { return new URL(url).host; } catch { return url; }
};

/** Every saved server as a zone, in an order that does not move as servers
 *  are used: this computer, paired servers by name, addresses by host. */
export function allServerZones(sources: ZoneSources): DesktopServerZone[] {
  const { servers, snapshots } = sources;
  const zone = (
    target: DesktopServerTarget,
    label: string,
    available: boolean,
  ): DesktopServerZone => {
    const key = serverKey(target);
    const snapshot = snapshots[key];
    return {
      key,
      kind: target.kind,
      label,
      available,
      folded: servers.foldedZones.includes(key),
      projects: snapshot?.projects ?? [],
      reportedAt: snapshot ? snapshot.reportedAt : null,
    };
  };
  const byLabel = (a: DesktopServerZone, b: DesktopServerZone): number =>
    a.label.localeCompare(b.label, "en", { sensitivity: "base" }) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return [
    ...(sources.localAvailable ? [zone({ kind: "local" }, "", true)] : []),
    ...sources.links.map((link) => zone({ kind: "link", id: link.id }, link.hostLabel || "Polyth", !link.revoked)).sort(byLabel),
    ...servers.addresses.map((address) => zone({ kind: "address", url: address.url }, addressLabel(address.url), true)).sort(byLabel),
  ];
}

/** A page's own server may always read the zones; another server's page only
 *  once the person allowed that server. */
export function zonesAllowed(sender: DesktopServerTarget, servers: DesktopServersState): boolean {
  return sender.kind === "local" || servers.zoneServers.includes(serverKey(sender));
}

/**
 * What the page of `sender` shows: the other servers. Until another server is
 * allowed, it learns only that there is something to ask for, never a name.
 */
export function serverZonesView(sender: DesktopServerTarget, sources: ZoneSources): DesktopServerZonesView {
  const own = serverKey(sender);
  const others = allServerZones(sources).filter((zone) => zone.key !== own);
  if (others.length === 0) return { access: "granted", zones: [] };
  return zonesAllowed(sender, sources.servers)
    ? { access: "granted", zones: others }
    : { access: "ask", zones: [] };
}

/** The route of a project on its own server. */
export function zoneProjectPath(projectId: unknown): string | undefined {
  return typeof projectId === "string" && PROJECT_ID.test(projectId) ? `/p/${encodeURIComponent(projectId)}` : undefined;
}

export type ZoneOpenPlan =
  | { kind: "local"; path?: string }
  | { kind: "address"; url: string; path?: string }
  | { kind: "link"; id: string; path?: string }
  /** The pairing was revoked: the server list says so and offers to pair again. */
  | { kind: "server-list" };

/**
 * Where the window goes for a click on a zone. The zone must be one the
 * sender may see, and the project one that zone listed: a page never sends
 * the window to a server or a path of its own choosing.
 */
export function planZoneOpen(
  sender: DesktopServerTarget,
  sources: ZoneSources,
  request: { key?: unknown; projectId?: unknown } | null | undefined,
): ZoneOpenPlan | null {
  const view = serverZonesView(sender, sources);
  if (view.access !== "granted") return null;
  const zone = view.zones.find((candidate) => candidate.key === request?.key);
  const target = zone ? zoneTarget(zone.key) : null;
  if (!zone || !target) return null;
  let path: string | undefined;
  if (request?.projectId !== undefined && request.projectId !== null) {
    if (!zone.projects.some((project) => project.id === request.projectId)) return null;
    path = zoneProjectPath(request.projectId);
    if (!path) return null;
  }
  const route = path ? { path } : {};
  if (target.kind === "local") return { kind: "local", ...route };
  if (target.kind === "address") return { kind: "address", url: target.url, ...route };
  return zone.available ? { kind: "link", id: target.id, ...route } : { kind: "server-list" };
}

/** Folds or unfolds a zone the sender's page shows. */
export function foldZone(
  sender: DesktopServerTarget,
  sources: ZoneSources,
  request: { key?: unknown; folded?: unknown } | null | undefined,
): DesktopServersState {
  const { servers } = sources;
  const key = serverZonesView(sender, sources).zones.find((zone) => zone.key === request?.key)?.key;
  if (!key) return servers;
  const folded = request?.folded === true;
  if (servers.foldedZones.includes(key) === folded) return servers;
  return {
    ...servers,
    foldedZones: folded ? [...servers.foldedZones, key] : servers.foldedZones.filter((value) => value !== key),
  };
}
