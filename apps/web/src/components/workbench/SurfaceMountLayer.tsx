// The keep-alive host every workbench surface renders through — exactly once,
// into its stable mount node (surfaceMounts.ts). Region slots, the companion
// window, floating windows, and the fullscreen layer only ADOPT those nodes,
// so re-arranging the workbench never remounts a surface: Chat keeps its
// scroll, composer draft, and streaming turn; a terminal keeps its PTY socket;
// an editor keeps its buffers. Kept-alive surfaces that are currently not
// placed anywhere wait in a hidden, inert vault (still attached, so iframes
// and observers survive the way `hidden` panes always did).
import { createPortal } from "react-dom";
import { useEffect, useRef, type ReactNode } from "react";
import { PackageWindowContext } from "../ui/PackageWindowContext.ts";
import { PaneVisibilityContext } from "../../workspace/paneVisibility.ts";
import ViewErrorBoundary from "../ViewErrorBoundary.ts";
import { useStore } from "../../store.ts";
import { releaseSurfaceMountNode, surfaceMountNode } from "./surfaceMounts.ts";
import type { WorkbenchSurfaceInfo } from "./workbenchModel.ts";

// Module-level so a layer remount (never expected) cannot forget visits.
const visited = new Set<string>();

export interface SurfaceMountLayerProps {
  /** Every surface the layout currently places somewhere. */
  placed: readonly string[];
  /** Surfaces the user can currently see (drives `active` / visibility). */
  visible: ReadonlySet<string>;
  /** Lookup for every known surface (built-in Chat included). */
  surfaces: ReadonlyMap<string, WorkbenchSurfaceInfo>;
}

function SurfaceBody({ surface, visible, projectId }: { surface: WorkbenchSurfaceInfo; visible: boolean; projectId: string | null }): ReactNode {
  const Body = surface.component;
  return (
    <PackageWindowContext.Provider value={surface.id}>
      <PaneVisibilityContext.Provider value={visible}>
        <ViewErrorBoundary inline resetKey={`${surface.id}:${projectId ?? ""}`}>
          <Body active={visible} />
        </ViewErrorBoundary>
      </PaneVisibilityContext.Provider>
    </PackageWindowContext.Provider>
  );
}

export default function SurfaceMountLayer({ placed, visible, surfaces }: SurfaceMountLayerProps) {
  const projectId = useStore((s) => s.activeProjectId);
  const vaultRef = useRef<HTMLDivElement>(null);
  const previousKept = useRef<string[]>([]);

  for (const id of placed) if (surfaces.has(id)) visited.add(id);
  const kept: WorkbenchSurfaceInfo[] = [];
  for (const surface of surfaces.values()) {
    if (placed.includes(surface.id) || (surface.keepAlive && visited.has(surface.id))) kept.push(surface);
  }
  const keptIds = kept.map((surface) => surface.id);

  // After every commit: park nodes no slot adopted, release nodes whose
  // surface left the keep-alive set (its portal has already unmounted).
  useEffect(() => {
    const vault = vaultRef.current;
    for (const id of keptIds) {
      const node = surfaceMountNode(id);
      const adopted = node.parentElement?.hasAttribute("data-surface-slot") === true;
      if (!adopted && vault && node.parentElement !== vault) vault.appendChild(node);
    }
    for (const id of previousKept.current) {
      if (!keptIds.includes(id)) releaseSurfaceMountNode(id);
    }
    previousKept.current = keptIds;
  });

  return (
    <>
      <div ref={vaultRef} className="wb-surface-vault" hidden inert aria-hidden="true" />
      {kept.map((surface) => createPortal(
        <SurfaceBody surface={surface} visible={visible.has(surface.id)} projectId={projectId} />,
        surfaceMountNode(surface.id),
        surface.id,
      ))}
    </>
  );
}

/** Test seam: forget which surfaces were visited. */
export function resetVisitedSurfacesForTest(): void {
  visited.clear();
}
