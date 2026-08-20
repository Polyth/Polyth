// EXTENSION-SEAMS slice 2: reactive registry for workspace surfaces — the
// main-area views that used to be an AppView switch in components/Main.tsx.
// Built-ins register in components/workspace/builtinSurfaces.tsx; plugins can
// reach the registry via window.__polythWorkspaceSurfaces. The host
// (components/workspace/WorkspaceHost.ts) subscribes through
// subscribeWorkspaceSurfaces / workspaceSurfaceVersion so registration after
// the initial React mount, replacement, and disposal all re-render without
// editing the host. Gating and fallback selection are pure and DOM-free so
// node:test can cover them directly.
import type { ReactNode } from "react";
import type { PluginId } from "../prefs.ts";

/** What must be active before a surface can render its component. The host
 *  renders the standard project/session empty state when the requirement is
 *  absent — surfaces never invent their own "open a project first" screens. */
export type WorkspaceSurfaceRequirement = "none" | "project" | "session";

/** Canonical ids the host derives from shared stores. Surfaces read these and
 *  the stores; they never receive an arbitrary cwd — worktree resolution stays
 *  server-owned. */
export interface WorkspaceSurfaceContext {
  projectId: string | null;
  sessionId: string | null;
}

export interface WorkspaceSurface {
  id: string;
  title: string;
  /** Deterministic position for fallback selection: `order` then `id`. */
  order: number;
  /** Plugin toggle gating the surface; undefined = always available. */
  plugin?: PluginId;
  /** Requirement gate applied by the host (default "none"). */
  requires?: WorkspaceSurfaceRequirement;
  /** Surface body — a component, so it owns its hooks and state. */
  component: () => ReactNode;
}

const registry = new Map<string, WorkspaceSurface>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of [...listeners]) l();
}

/** Register (or replace by id). Returns an unregister function that removes
 *  only its own registration — a superseded off() is a no-op. */
export function registerWorkspaceSurface(surface: WorkspaceSurface): () => void {
  registry.set(surface.id, surface);
  bump();
  return () => {
    if (registry.get(surface.id) === surface) {
      registry.delete(surface.id);
      bump();
    }
  };
}

/** Deterministic listing: `order` then `id`, independent of registration time. */
export function listWorkspaceSurfaces(): WorkspaceSurface[] {
  return [...registry.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function getWorkspaceSurface(id: string): WorkspaceSurface | undefined {
  return registry.get(id);
}

/** Notifies on every registration/replacement/disposal (useSyncExternalStore). */
export function subscribeWorkspaceSurfaces(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function workspaceSurfaceVersion(): number {
  return version;
}

/** Pure plugin gate: a surface tied to a disabled plugin is unavailable. */
export function availableWorkspaceSurfaces(
  surfaces: WorkspaceSurface[],
  enabledPlugins: readonly string[],
): WorkspaceSurface[] {
  return surfaces.filter((s) => s.plugin === undefined || enabledPlugins.includes(s.plugin));
}

/** Pure selection: the requested surface when it is registered and enabled;
 *  otherwise a deterministic fallback — "session" first (it cannot be
 *  disabled), then the first available surface in (order, id) listing. Null
 *  only when nothing at all is available. */
export function resolveWorkspaceSurface(
  requestedId: string,
  surfaces: WorkspaceSurface[],
  enabledPlugins: readonly string[],
): WorkspaceSurface | null {
  const available = availableWorkspaceSurfaces(surfaces, enabledPlugins);
  return (
    available.find((s) => s.id === requestedId)
    ?? available.find((s) => s.id === "session")
    ?? available[0]
    ?? null
  );
}

export type WorkspaceSurfaceGate = "ok" | "needs-project" | "needs-session";

/** Pure requirement gate. Needing a session implies needing its project, so a
 *  missing project reports "needs-project" first. */
export function workspaceSurfaceGate(
  surface: WorkspaceSurface,
  ctx: WorkspaceSurfaceContext,
): WorkspaceSurfaceGate {
  const requires = surface.requires ?? "none";
  if (requires === "none") return "ok";
  if (ctx.projectId === null) return "needs-project";
  if (requires === "session" && ctx.sessionId === null) return "needs-session";
  return "ok";
}

export interface PolythWorkspaceSurfacesApi {
  registerWorkspaceSurface: typeof registerWorkspaceSurface;
  listWorkspaceSurfaces: typeof listWorkspaceSurfaces;
  getWorkspaceSurface: typeof getWorkspaceSurface;
}

declare global {
  interface Window {
    __polythWorkspaceSurfaces?: PolythWorkspaceSurfacesApi;
  }
}

export function exposeWorkspaceSurfaces(): void {
  if (typeof window !== "undefined") {
    window.__polythWorkspaceSurfaces = {
      registerWorkspaceSurface,
      listWorkspaceSurfaces,
      getWorkspaceSurface,
    };
  }
}
