// F17 right-pane surface host: a declarative registry that replaces the old
// hardcoded RailPlugin union. Built-in surfaces register themselves
// (components/railSurfaces.tsx); plugins contribute either through the
// "workspace.right.tabs" slot or window.__polythSurfaces.registerSurface —
// neither path requires editing ContextRail. Ordering, plugin gating, and
// content-driven visibility are pure and tested.
import { useSyncExternalStore } from "react";
import type { JSX, ReactNode } from "react";
import { hasSlotRegistration, listSlots } from "./slots.ts";
import { assertOwnerCanReplace } from "./packages/ownership.ts";
import type { ProjectAffinity } from "@polyth/contracts/project-composition";
import { isProjectContributionRelevant, subscribeProjectRelevance } from "./packages/projectRelevance.ts";

/** Values the rail computes once per render for badge/visibility decisions —
 *  shared so surfaces never spin up their own pollers (e.g. git status). */
export interface RailSurfaceContext {
  changeCount: number;
  eventCount: number;
  totalTokens: number;
  hasSession: boolean;
}

/** UX-PANE-MODEL: presentation metadata for a canonical workspace surface
 *  (Files/Git/Terminal/Preview). Layout policy stays in the host; the
 *  component never decides dock versus full-screen geometry. */
export type WorkspacePaneDock = "side" | "bottom";

export interface WorkspacePanePresentation {
  kind: "workspace";
  /** Initializer for a MISSING width preference, as a ratio of the measured
   *  post-sidebar workspace. A remembered pixel width always wins. */
  defaultRatio: number;
  /** Content minimum: docking below this promotes to full-screen. */
  minWidth: number;
  /** Dynamic-window content minimum. */
  minHeight?: number;
  /** Cap applied to the dock candidate before the geometry cap. */
  preferredMaxWidth: number;
  keepAlive: boolean;
  /** "close": Escape closes the pane. "content": the surface consumes Escape
   *  (terminal) — only its visible close affordances leave it. */
  escape: "close" | "content";
  /** UX-PANE-MODEL: which edge a PINNED pane attaches to. Optional — omitted
   *  (or "side") keeps the classic dock beside Chat. "bottom" pins the pane
   *  as a full-width strip under the workspace, lifting Chat's composer above
   *  it. Only the pinned mode reads this; dynamic/fullscreen ignore it. */
  dock?: WorkspacePaneDock;
  /** Edges supported by the pinned window. If omitted, only the default edge
   *  is offered, preserving the classic side-dock behavior for old packages. */
  dockOptions?: readonly WorkspacePaneDock[];
}

function defaultPaneDockEdge(presentation: WorkspacePanePresentation | undefined): WorkspacePaneDock {
  return presentation?.dock === "bottom" ? "bottom" : "side";
}

/** The package-declared edges available to the host's pinned-window controls. */
export function paneDockOptions(presentation: WorkspacePanePresentation | undefined): WorkspacePaneDock[] {
  if (!presentation) return [];
  const configured = [...new Set((presentation.dockOptions ?? []).filter(
    (edge): edge is WorkspacePaneDock => edge === "side" || edge === "bottom",
  ))];
  return configured.length > 0 ? configured : [defaultPaneDockEdge(presentation)];
}

/** The edge a pinned pane attaches to. Undefined presentation, or a
 *  presentation without an explicit `dock`, means the classic side dock.
 *  A persisted selection is honored only while it remains package-supported. */
export function paneDockEdge(
  presentation: WorkspacePanePresentation | undefined,
  selected?: WorkspacePaneDock,
): "side" | "bottom" {
  const options = paneDockOptions(presentation);
  if (selected && options.includes(selected)) return selected;
  const preferred = defaultPaneDockEdge(presentation);
  return options.includes(preferred) ? preferred : options[0] ?? "side";
}

/** Keep-alive surface components can pause background work while hidden. */
export interface RailSurfaceComponentProps {
  /** Omitted by legacy/plugin callers; the host always supplies it. */
  active?: boolean;
}

export interface RailSurface {
  id: string;
  /** Host-bound owner package. Missing means a host/core contribution. */
  ownerPackageId?: string;
  projectAffinity?: ProjectAffinity;
  title: string;
  /** One-line purpose shown under the title in the shared module header. */
  description?: string;
  /** Short strip label; falls back to title. */
  shortLabel?: string;
  icon?: () => JSX.Element;
  /** Capability the panel belongs to in the navigation metadata layer
   *  (UX-PERSONAS); defaults to the surface id. Placement metadata only —
   *  never an availability gate. */
  capabilityId?: string;
  order: number;
  /** Panel body — a component, so it owns its hooks and state. */
  component: (props?: RailSurfaceComponentProps) => ReactNode;
  /** Count badge on the strip button. */
  badge?: (ctx: RailSurfaceContext) => number;
  /** Content-driven visibility: false hides the strip button (OC#2418). */
  visible?: (ctx: RailSurfaceContext) => boolean;
  /** Present on canonical workspace surfaces only; contextual surfaces
   *  (Context/Knowledge/Usage/Events) leave it undefined. */
  presentation?: WorkspacePanePresentation;
  /** Workbench placement constraints. Optional until a package opts in. */
  placement?: import("@polyth/web-sdk").WorkbenchSurfacePlacement;
}

const registry = new Map<string, RailSurface>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of [...listeners]) l();
}

subscribeProjectRelevance(bump);

/** Register (or same-owner replace by id). Cross-owner collisions throw.
 *  Unregister is identity-safe. */
export function registerSurface(surface: RailSurface): () => void {
  const existing = registry.get(surface.id);
  if (existing) {
    assertOwnerCanReplace({
      registry: "surface",
      id: surface.id,
      existingOwner: existing.ownerPackageId,
      nextOwner: surface.ownerPackageId,
    });
  }
  registry.set(surface.id, surface);
  bump();
  return () => {
    if (registry.get(surface.id) === surface) {
      registry.delete(surface.id);
      bump();
    }
  };
}

/** Raw registration probe used only by lifecycle cleanup. A project-irrelevant
 * contribution is still registered; an unknown id may simply belong to a web
 * package that has not loaded yet and must remain restorable. */
export function hasSurfaceRegistration(id: string): boolean {
  if (registry.has(id)) return true;
  return id.startsWith("slot:") && hasSlotRegistration("workspace.right.tabs", id.slice("slot:".length));
}

/** Project relevance probe without content-driven visibility. */
export function isSurfaceProjectRelevant(id: string): boolean {
  const direct = registry.get(id);
  if (direct) return isProjectContributionRelevant(direct.ownerPackageId, direct.projectAffinity);
  if (!id.startsWith("slot:")) return false;
  const slotId = id.slice("slot:".length);
  return listSlots("workspace.right.tabs").some((item) => item.id === slotId);
}

export function listSurfaces(): RailSurface[] {
  return [...registry.values()]
    .filter((surface) => isProjectContributionRelevant(surface.ownerPackageId, surface.projectAffinity))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
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
 *  meta.description / meta.order / meta.icon optional). Plugins that only know the slot API get a
 *  rail surface without touching the registry. The host's already-derived
 *  RailSurfaceContext is the bounded context every bridged renderer receives
 *  (EXT-SEAMS-V2) so contributed panels never spin up independent fetchers. */
export function slotSurfaces(ctx: RailSurfaceContext): RailSurface[] {
  return listSlots("workspace.right.tabs").map((item) => {
    const icon = item.meta?.icon;
    const capabilityId = item.meta?.capabilityId;
    const description = item.meta?.description;
    return {
      id: `slot:${item.id}`,
      title: typeof item.meta?.title === "string" ? item.meta.title : item.id,
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof capabilityId === "string" ? { capabilityId } : {}),
      ...(typeof icon === "function" ? { icon: icon as NonNullable<RailSurface["icon"]> } : {}),
      order: 100 + item.order,
      component: () => item.render({ ...ctx }) as ReactNode,
    };
  });
}

/** Pure gate: content-driven visibility only. The old plugin allow-list is
 *  gone (UX-PERSONAS) — presets and preferences place panels, they never
 *  remove them. */
export function visibleSurfaces(
  surfaces: RailSurface[],
  ctx: RailSurfaceContext,
): RailSurface[] {
  return surfaces.filter((s) => s.visible === undefined || s.visible(ctx));
}

/** Surfaces that must stay mounted for this render: the open one, plus any
 *  keep-alive surface already visited. A visited keep-alive surface stays in
 *  this list after `rail` goes null (its `.rail` node lives on, merely hidden)
 *  — so "in keptSurfaces" is NOT "open". The open/closed UI state is `rail`
 *  (mirrored to the `.railbar-open` class); CSS must key off that, never off
 *  `.rail` presence. */
export function keptSurfaces(
  surfaces: RailSurface[],
  rail: string | null,
  visited: readonly string[],
): RailSurface[] {
  return surfaces.filter((s) =>
    s.id === rail || (s.presentation?.keepAlive === true && visited.includes(s.id)));
}

// ---- workspace/context split (UX-PANE-MODEL) ---------------------------------

export function isWorkspaceSurface(s: RailSurface): boolean {
  return s.presentation?.kind === "workspace";
}

/** Canonical workspace surfaces (Files/Git/Terminal/Preview) in rail order. */
export function workspaceSurfacesOf(surfaces: RailSurface[]): RailSurface[] {
  return surfaces.filter(isWorkspaceSurface);
}

/** Contextual surfaces (Context/Knowledge/Usage/Events + plugin panels). */
export function contextSurfacesOf(surfaces: RailSurface[]): RailSurface[] {
  return surfaces.filter((s) => !isWorkspaceSurface(s));
}

// ---- dock admission -----------------------------------------------------------
// Container-geometry math only — no viewport, user-agent, hover, or pointer
// test. The host measures the post-sidebar workspace (Chat + pane + chrome)
// and this pure function decides docked versus full-screen and the width.

/** Chat's content-box floor: docking may never squeeze Chat below this. */
export const CHAT_FLOOR = 320;

export interface DockGeometry {
  /** Measured post-sidebar workspace available to Chat plus the pane. The
   *  launcher strip is outside this number when it is a sibling. */
  workspaceWidth: number;
  /** Separator width plus safe-area inline insets (measured, never doubled). */
  chrome: number;
}

export interface DockDecision {
  dock: boolean;
  /** The width to use when docked (candidate, already ≥ minWidth). */
  width: number;
  /** The geometry cap (aria-valuemax for the separator). */
  maxPane: number;
}

/** The remembered preferred width if valid, else the surface's default ratio
 *  of the measured workspace. Ratios initialize only a missing preference. */
export function preferredOrDefaultWidth(
  remembered: number | null | undefined,
  presentation: WorkspacePanePresentation,
  geo: DockGeometry,
): number {
  if (typeof remembered === "number" && Number.isFinite(remembered) && remembered > 0) {
    return Math.round(remembered);
  }
  return Math.round(presentation.defaultRatio * geo.workspaceWidth);
}

/** Spec formula:
 *    maxPane   = workspaceWidth - CHAT_FLOOR - chrome
 *    candidate = min(rememberedOrDefault, preferredMaxWidth, maxPane)
 *    dock      = candidate >= minWidth
 *  A remembered width is clamped when possible and falls back to full-screen
 *  when its content minimum plus the Chat floor cannot both fit. */
export function decideDock(
  remembered: number | null | undefined,
  presentation: WorkspacePanePresentation,
  geo: DockGeometry,
): DockDecision {
  const maxPane = geo.workspaceWidth - CHAT_FLOOR - geo.chrome;
  const candidate = Math.min(
    preferredOrDefaultWidth(remembered, presentation, geo),
    presentation.preferredMaxWidth,
    maxPane,
  );
  return { dock: candidate >= presentation.minWidth, width: candidate, maxPane };
}

/** Clamp a live resize to the separator's legal range. Crossing below either
 *  invariant is the caller's cue to promote to full-screen instead. */
export function clampDockWidth(
  width: number,
  presentation: WorkspacePanePresentation,
  geo: DockGeometry,
): number {
  const maxPane = geo.workspaceWidth - CHAT_FLOOR - geo.chrome;
  return Math.min(Math.max(Math.round(width), presentation.minWidth), Math.max(maxPane, presentation.minWidth));
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
