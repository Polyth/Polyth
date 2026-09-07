// Shared workbench render model: one lookup of every placeable surface (the
// package surfaces from the registry, slot-bridged panels, and the built-in
// Chat surface) plus the pure visibility rules the hosts and the keep-alive
// layer must agree on. createElement-based so DOM-free tests can import it.
import { createElement, type JSX, type ReactNode } from "react";
import type { WorkbenchSurfacePlacement } from "@polyth/web-sdk";
import Main from "../Main.tsx";
import StatusBar from "../StatusBar.tsx";
import ViewErrorBoundary from "../ViewErrorBoundary.ts";
import { useStore } from "../../store.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { Icon } from "../../icons.tsx";
import { tr } from "../../i18n/index.ts";
import {
  listSurfaces,
  slotSurfaces,
  type RailSurface,
  type RailSurfaceContext,
  type WorkspacePanePresentation,
} from "../../surfaces.ts";
import { useRailSurfaceModel } from "../ContextRail.tsx";
import {
  CHAT_SURFACE_ID,
  WORKBENCH_REGIONS,
  placedSurfaces,
  type WorkbenchLayout,
  type WorkbenchRegion,
} from "../../workbench/layout.ts";

export interface WorkbenchSurfaceInfo {
  id: string;
  title: string;
  description?: string;
  icon?: () => JSX.Element;
  capabilityId: string;
  presentation?: WorkspacePanePresentation;
  placement?: WorkbenchSurfacePlacement;
  component: (props?: { active?: boolean }) => ReactNode;
  keepAlive: boolean;
  /** Contextual panels (no workspace presentation) keep their panel chrome. */
  contextual: boolean;
}

/** The built-in Chat surface body: the same WorkspaceHost-backed session
 *  surface the shell always rendered, now placeable like any other surface. */
export function ChatSurface(): ReactNode {
  const viewResetKey = useStore(
    (s) => `${s.activeProjectId ?? ""}:${s.activeSessionId ?? ""}:${s.activeView}`,
  );
  const shellMode = useShellMode();
  return createElement(
    "div",
    { className: "wb-chat" },
    createElement(ViewErrorBoundary, { resetKey: viewResetKey }, createElement(Main)),
    shellMode !== "phone" ? createElement(StatusBar) : null,
  );
}

export function chatSurfaceInfo(): WorkbenchSurfaceInfo {
  return {
    id: CHAT_SURFACE_ID,
    title: tr("header.chat"),
    description: tr("workbench.chatDescription"),
    icon: Icon.session,
    capabilityId: "session",
    component: ChatSurface,
    keepAlive: true,
    contextual: false,
  };
}

export function surfaceInfoOf(surface: RailSurface): WorkbenchSurfaceInfo {
  return {
    id: surface.id,
    title: surface.title,
    ...(surface.description ? { description: surface.description } : {}),
    ...(surface.icon ? { icon: surface.icon } : {}),
    capabilityId: surface.capabilityId ?? surface.id,
    ...(surface.presentation ? { presentation: surface.presentation } : {}),
    ...(surface.placement ? { placement: surface.placement } : {}),
    component: surface.component,
    keepAlive: surface.placement?.keepAlive ?? surface.presentation?.keepAlive ?? true,
    contextual: surface.presentation === undefined,
  };
}

export interface WorkbenchSurfaceModel {
  /** Every known surface by id (registry + slot bridge + Chat). */
  surfaces: Map<string, WorkbenchSurfaceInfo>;
  /** Content-visible surfaces in strip order (for launchers). */
  visible: RailSurface[];
  ctx: RailSurfaceContext;
}

export function useWorkbenchSurfaces(): WorkbenchSurfaceModel {
  const { surfaces: visible, ctx } = useRailSurfaceModel();
  const surfaces = new Map<string, WorkbenchSurfaceInfo>();
  surfaces.set(CHAT_SURFACE_ID, chatSurfaceInfo());
  for (const surface of [...listSurfaces(), ...slotSurfaces(ctx)]) surfaces.set(surface.id, surfaceInfoOf(surface));
  return { surfaces, visible, ctx };
}

// ---- pure visibility rules -------------------------------------------------------------

export interface VisibilityInput {
  layout: WorkbenchLayout;
  /** Regions the responsive host currently shows (grid mode). */
  shownRegions: ReadonlySet<WorkbenchRegion>;
  known: (surfaceId: string) => boolean;
}

/** Which placed surfaces the user can see right now: a fullscreen layer wins
 *  alone; otherwise every floating window plus each shown, uncollapsed
 *  region's active surface. */
export function visibleSurfaces({ layout, shownRegions, known }: VisibilityInput): Set<string> {
  const out = new Set<string>();
  if (layout.fullscreen && known(layout.fullscreen.surfaceId)) {
    out.add(layout.fullscreen.surfaceId);
    return out;
  }
  for (const id of layout.floating) if (known(id)) out.add(id);
  for (const region of WORKBENCH_REGIONS) {
    if (!shownRegions.has(region) || layout.collapsed[region]) continue;
    const active = layout.regions[region].active;
    if (active !== null && known(active)) out.add(active);
  }
  return out;
}

/** Placed surfaces the layer must mount (unknown ids wait for their package). */
export function knownPlaced(layout: WorkbenchLayout, known: (surfaceId: string) => boolean): string[] {
  return placedSurfaces(layout).filter(known);
}
