// F17 right-pane surface host: a declarative registry that replaces the old
// hardcoded RailPlugin union. Built-in surfaces register themselves
// (components/railSurfaces.tsx); plugins contribute either through the
// "workspace.right.tabs" slot or window.__polythSurfaces.registerSurface —
// neither path requires editing ContextRail. Ordering, plugin gating, and
// content-driven visibility are pure and tested.
import { useSyncExternalStore } from "react";
import type { JSX, ReactNode } from "react";
import { listSlots } from "./slots.ts";
import type { PluginId } from "./prefs.ts";

/** Values the rail computes once per render for badge/visibility decisions —
 *  shared so surfaces never spin up their own pollers (e.g. git status). */
export interface RailSurfaceContext {
  changeCount: number;
  eventCount: number;
  totalTokens: number;
  hasSession: boolean;
}

export interface RailSurfaceComponentProps {
  active: boolean;
}

export interface RailSurface {
  id: string;
  title: string;
  /** Short strip label; falls back to title. */
  shortLabel?: string;
  icon?: () => JSX.Element;
  /** Plugin toggle gating the surface; undefined = always available. */
  plugin?: PluginId;
  order: number;
  /** Panel body — a component, so it owns its hooks and state. */
  component: (props: RailSurfaceComponentProps) => ReactNode;
  /** Count badge on the strip button. */
  badge?: (ctx: RailSurfaceContext) => number;
  /** Content-driven visibility: false hides the strip button (OC#2418). */
  visible?: (ctx: RailSurfaceContext) => boolean;
}

const registry = new Map<string, RailSurface>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of [...listeners]) l();
}

/** Register (or replace by id). Returns an unregister function. */
export function registerSurface(surface: RailSurface): () => void {
  registry.set(surface.id, surface);
  bump();
  return () => {
    if (registry.get(surface.id) === surface) {
      registry.delete(surface.id);
      bump();
    }
  };
}

export function listSurfaces(): RailSurface[] {
  return [...registry.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function useSurfaceVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    () => version,
  );
}

/** Slot bridge: "workspace.right.tabs" items become surfaces (meta.title /
 *  meta.order / meta.icon optional). Plugins that only know the slot API get a
 *  rail surface without touching the registry. */
export function slotSurfaces(): RailSurface[] {
  return listSlots("workspace.right.tabs").map((item) => ({
    id: `slot:${item.id}`,
    title: typeof item.meta?.title === "string" ? (item.meta.title as string) : item.id,
    order: 100 + item.order,
    component: () => item.render({}) as ReactNode,
  }));
}

/** Pure gate: plugin toggles first, then content-driven visibility. */
export function visibleSurfaces(
  surfaces: RailSurface[],
  enabledPlugins: readonly string[],
  ctx: RailSurfaceContext,
): RailSurface[] {
  return surfaces
    .filter((s) => s.plugin === undefined || enabledPlugins.includes(s.plugin))
    .filter((s) => s.visible === undefined || s.visible(ctx));
}

export interface PolythSurfacesApi {
  registerSurface: typeof registerSurface;
  listSurfaces: typeof listSurfaces;
}

declare global {
  interface Window {
    __polythSurfaces?: PolythSurfacesApi;
  }
}

export function exposeSurfaces(): void {
  if (typeof window !== "undefined") {
    window.__polythSurfaces = { registerSurface, listSurfaces };
  }
}
