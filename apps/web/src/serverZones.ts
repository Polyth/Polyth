// Server zones: the other Polyth servers this desktop app can open, listed in
// the navigator with their projects, so a person works on this computer and in
// any number of teams from one list.
//
// Only the server on screen has a page. This page lists its own projects to
// the desktop main process, which keeps the last list per server and hands the
// other servers' lists back (apps/desktop/src/serverZones.ts). The rows are a
// snapshot from each server's last visit; a click moves the window there.
// Outside the desktop app, and in shells older than zones, nothing installs.
import { useSyncExternalStore } from "react";
import { rootProjects, type Project } from "@polyth/contracts";
import type {
  DesktopServerInfo,
  DesktopServerZone,
  DesktopServerZoneProject,
  DesktopServerZonesView,
  PolythDesktopApi,
} from "./desktopBridge.ts";
import type { ProjectRegistryState } from "./projectRegistry.ts";

/** The main process keeps at most this many rows per server. */
export const ZONE_PROJECT_LIMIT = 200;
const ZONE_ICON_LIMIT = 4096;
const REPORT_DELAY_MS = 600;

/**
 * Pure: this page's projects as another server's navigator may list them.
 * Only what a row draws leaves the page: no folder path, no Space, no
 * settings. Private rooms stay out, as they do in this navigator.
 */
export function zoneProjectsOf(projects: readonly Project[]): DesktopServerZoneProject[] {
  return rootProjects(projects).slice(0, ZONE_PROJECT_LIMIT).map((project) => ({
    id: project.id,
    name: project.name || project.path,
    // A large custom icon is not worth carrying: the row draws the default.
    ...(project.icon && project.icon.length <= ZONE_ICON_LIMIT ? { icon: project.icon } : {}),
    ...(project.color ? { color: project.color } : {}),
  }));
}

export interface ServerZonesState {
  /** Null until the app answered, and where there are no zones at all. */
  view: DesktopServerZonesView | null;
  /** The server on screen, for its own zone's heading. */
  current: DesktopServerInfo | null;
  /** The zone row the window is moving to: `key` or `key/projectId`. */
  opening: string | null;
}

const EMPTY: ServerZonesState = { view: null, current: null, opening: null };

export interface ServerZonesStore {
  getState(): ServerZonesState;
  subscribe(listener: () => void): () => void;
  /** Lists the page's projects once they are known and whenever they change. */
  noteRegistry(registry: ProjectRegistryState): void;
  open(zone: DesktopServerZone, projectId?: string): Promise<void>;
  allow(): Promise<void>;
  fold(zone: DesktopServerZone, folded: boolean): Promise<void>;
  dispose(): void;
}

type ZonesApi = Pick<PolythDesktopApi, "getInfo"> & { servers?: PolythDesktopApi["servers"] };

export function createServerZonesStore(
  api: ZonesApi,
  timers: { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = {
    set: (run, ms) => setTimeout(run, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): ServerZonesStore {
  const servers = api.servers;
  let state = EMPTY;
  let disposed = false;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ServerZonesState>): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const adopt = (view: DesktopServerZonesView | undefined | null): void => {
    if (view && Array.isArray(view.zones)) set({ view });
  };

  let seenRegistry: ProjectRegistryState | null = null;
  let sent: string | null = null;
  let pending: unknown = null;
  let queued: DesktopServerZoneProject[] | null = null;

  const flush = (): void => {
    pending = null;
    const projects = queued;
    queued = null;
    if (!projects || disposed) return;
    const body = JSON.stringify(projects);
    if (body === sent) return;
    sent = body;
    void servers?.reportZoneProjects?.(projects).catch(() => {
      // Not filed: the next change of the list tries again.
      if (sent === body) sent = null;
    });
  };

  if (servers?.zones) {
    void servers.zones().then(adopt, () => undefined);
    void api.getInfo().then((info) => set({ current: info.server ?? null }), () => undefined);
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    noteRegistry: (registry) => {
      // The store publishes for every keystroke and event: an identity check
      // keeps this off that path.
      if (registry === seenRegistry || !servers?.reportZoneProjects) return;
      seenRegistry = registry;
      // Only a list the server confirmed: an empty one mid-load would wipe
      // this server's zone everywhere else.
      if (registry.status !== "ready") return;
      queued = zoneProjectsOf(registry.projects);
      if (pending === null) pending = timers.set(flush, REPORT_DELAY_MS);
    },
    open: async (zone, projectId) => {
      if (!servers?.openZone || state.opening !== null) return;
      set({ opening: projectId ? `${zone.key}/${projectId}` : zone.key });
      try {
        // On success the window is already leaving this page. A failure is
        // shown by the app's server list, which the window moves to instead.
        await servers.openZone(zone.key, projectId);
      } catch { /* the bridge went away with the page */ }
      set({ opening: null });
    },
    allow: async () => {
      adopt(await servers?.allowZones?.().catch(() => undefined));
    },
    fold: async (zone, folded) => {
      const view = state.view;
      // Shown at once; the app's answer is the truth.
      if (view) set({ view: { ...view, zones: view.zones.map((item) => item.key === zone.key ? { ...item, folded } : item) } });
      adopt(await servers?.foldZone?.(zone.key, folded).catch(() => undefined));
    },
    dispose: () => {
      disposed = true;
      if (pending !== null) timers.clear(pending);
      pending = null;
      listeners.clear();
    },
  };
}

let installed: ServerZonesStore | null = null;
const idle = (): (() => void) => () => {};

/** Called once by the desktop integration, on a server's own page only. */
export function installServerZones(
  api: PolythDesktopApi,
  registry: { get: () => ProjectRegistryState; subscribe: (listener: () => void) => () => void },
): () => void {
  // The server list has no navigator; a shell with no `surface` predates zones.
  if ((api.surface !== "local" && api.surface !== "remote") || !api.servers?.zones) return idle();
  const store = createServerZonesStore(api);
  installed = store;
  store.noteRegistry(registry.get());
  const unsubscribe = registry.subscribe(() => store.noteRegistry(registry.get()));
  return () => {
    unsubscribe();
    store.dispose();
    if (installed === store) installed = null;
  };
}

const subscribeInstalled = (listener: () => void): (() => void) => installed?.subscribe(listener) ?? idle();
const readInstalled = (): ServerZonesState => installed?.getState() ?? EMPTY;

export function useServerZones(): ServerZonesState {
  return useSyncExternalStore(subscribeInstalled, readInstalled, () => EMPTY);
}

export const serverZoneActions = {
  open: (zone: DesktopServerZone, projectId?: string): void => { void installed?.open(zone, projectId); },
  allow: (): void => { void installed?.allow(); },
  fold: (zone: DesktopServerZone, folded: boolean): void => { void installed?.fold(zone, folded); },
};

/** Rows a zone shows before "Show N more": a long server must not push the
 *  rest of the navigator out of reach. */
export const ZONE_ROWS_SHOWN = 6;

/** Pure: the rows on show and how many are held back. Seven projects show
 *  all seven: a "1 more" row would cost the line it saves. */
export function zoneRows<T>(projects: readonly T[], expanded: boolean): { shown: readonly T[]; more: number } {
  if (expanded || projects.length <= ZONE_ROWS_SHOWN + 1) return { shown: projects, more: 0 };
  return { shown: projects.slice(0, ZONE_ROWS_SHOWN), more: projects.length - ZONE_ROWS_SHOWN };
}
