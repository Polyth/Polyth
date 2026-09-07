// One docked workbench region (start/primary/end/bottom): a tab group of
// surfaces rendered through the shared ModuleView chrome. The active surface's
// keep-alive node is adopted into the slot; inactive tabs wait in the layer's
// vault. Drag a tab (or the single title) to another region, drop to move;
// every drag action also exists in the ⋯ placement menu.
import { useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { WorkbenchRegion } from "@polyth/web-sdk";
import ModuleView from "../ui/ModuleView.ts";
import { Icon } from "../../icons.tsx";
import { ExpandIcon } from "../ui/icons.ts";
import { tr } from "../../i18n/index.ts";
import { CHAT_SURFACE_ID, type WorkbenchLayout } from "../../workbench/layout.ts";
import {
  surfaceAllowsRegion,
  workbenchCloseSurface,
  workbenchMoveSurface,
  workbenchReorderSurface,
  workbenchSetActive,
  workbenchSetCollapsed,
  workbenchSetPresentation,
} from "../../workbench/store.ts";
import SurfaceMenu, { regionLabel } from "./SurfaceMenu.tsx";
import SurfaceSlot from "./SurfaceSlot.tsx";
import type { WorkbenchSurfaceInfo } from "./workbenchModel.ts";

export const SURFACE_MIME = "application/x-polyth-surface";

export function setDragSurface(transfer: DataTransfer, surfaceId: string): void {
  transfer.setData(SURFACE_MIME, surfaceId);
  transfer.effectAllowed = "move";
}

export function getDragSurface(transfer: DataTransfer): string | null {
  const id = transfer.getData(SURFACE_MIME);
  return id ? id : null;
}

export interface RegionHostProps {
  region: WorkbenchRegion;
  layout: WorkbenchLayout;
  surfaces: ReadonlyMap<string, WorkbenchSurfaceInfo>;
  /** Phone/compact shells hide pointer-only affordances. */
  compact: boolean;
  /** A surface drag is in progress anywhere in the workbench. */
  dragging: string | null;
  onDragChange: (surfaceId: string | null) => void;
}

function RegionTabs({
  region, ids, active, surfaces, onDragChange,
}: {
  region: WorkbenchRegion;
  ids: readonly string[];
  active: string;
  surfaces: ReadonlyMap<string, WorkbenchSurfaceInfo>;
  onDragChange: (surfaceId: string | null) => void;
}) {
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = ids.indexOf(active);
    let next: string | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = ids[(index + 1) % ids.length];
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = ids[(index - 1 + ids.length) % ids.length];
    else if (event.key === "Home") next = ids[0];
    else if (event.key === "End") next = ids[ids.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    workbenchSetActive(region, next);
    (event.currentTarget.querySelector<HTMLElement>(`[data-surface-tab="${next}"]`))?.focus();
  };
  return (
    <div className="wb-region-tabs ui-scroll-tabs" role="tablist" aria-label={regionLabel(region)} onKeyDown={onKey}>
      {ids.map((id, index) => {
        const surface = surfaces.get(id);
        if (!surface) return null;
        const selected = id === active;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            data-surface-tab={id}
            className={`wb-region-tab${selected ? " active" : ""}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={surface.title}
            draggable
            onDragStart={(event) => { setDragSurface(event.dataTransfer, id); onDragChange(id); }}
            onDragEnd={() => onDragChange(null)}
            onDragOver={(event) => { if (event.dataTransfer.types.includes(SURFACE_MIME)) event.preventDefault(); }}
            onDrop={(event) => {
              const dragged = getDragSurface(event.dataTransfer);
              if (!dragged) return;
              event.preventDefault();
              event.stopPropagation();
              if (ids.includes(dragged)) workbenchReorderSurface(dragged, index);
              else if (surfaceAllowsRegion(dragged, region)) {
                workbenchMoveSurface(dragged, region);
                workbenchReorderSurface(dragged, index);
              }
              onDragChange(null);
            }}
            onClick={() => workbenchSetActive(region, id)}
            onAuxClick={(event) => { if (event.button === 1 && id !== CHAT_SURFACE_ID) workbenchCloseSurface(id); }}
          >
            {surface.icon ? <span className="wb-region-tab-icon" aria-hidden="true"><surface.icon /></span> : null}
            <span className="wb-region-tab-title">{surface.title}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function RegionHost({ region, layout, surfaces, compact, dragging, onDragChange }: RegionHostProps) {
  const state = layout.regions[region];
  const ids = state.surfaces.filter((id) => surfaces.has(id));
  const active = state.active !== null && surfaces.has(state.active) ? state.active : ids[0] ?? null;
  const collapsed = layout.collapsed[region];
  const [dropTarget, setDropTarget] = useState(false);
  const acceptsDrag = dragging !== null && !ids.includes(dragging) && surfaceAllowsRegion(dragging, region);

  const dropProps = {
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes(SURFACE_MIME)) return;
      const dragged = dragging;
      if (dragged !== null && !surfaceAllowsRegion(dragged, region)) return;
      event.preventDefault();
      if (!dropTarget) setDropTarget(true);
    },
    onDragLeave: () => setDropTarget(false),
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      const dragged = getDragSurface(event.dataTransfer);
      setDropTarget(false);
      onDragChange(null);
      if (!dragged || !surfaceAllowsRegion(dragged, region)) return;
      event.preventDefault();
      workbenchMoveSurface(dragged, region);
    },
  };

  if (ids.length === 0) {
    // Empty regions exist only as drop targets while a surface is dragged.
    if (!acceptsDrag) return null;
    return (
      <section
        className={`wb-region wb-region--${region} wb-region--empty${dropTarget ? " wb-drop-target" : ""}`}
        aria-label={regionLabel(region)}
        {...dropProps}
      >
        <span className="wb-drop-hint">{tr("workbench.dropHere", { region: regionLabel(region) })}</span>
      </section>
    );
  }

  if (collapsed) {
    return (
      <section
        className={`wb-region wb-region--${region} wb-region--collapsed${dropTarget ? " wb-drop-target" : ""}`}
        aria-label={regionLabel(region)}
        {...dropProps}
      >
        <button
          type="button"
          className="ui-icon-btn ui-icon-btn--ghost ui-icon-btn--sm wb-region-expand"
          aria-label={tr("workbench.expandRegion", { region: regionLabel(region) })}
          title={tr("workbench.expandRegion", { region: regionLabel(region) })}
          aria-expanded={false}
          onClick={() => workbenchSetCollapsed(region, false)}
        >
          <ExpandIcon className="ui-icon ui-icon--sm" aria-hidden="true" />
        </button>
        {ids.map((id) => {
          const surface = surfaces.get(id)!;
          return (
            <button
              key={id}
              type="button"
              className={`ui-icon-btn ui-icon-btn--ghost ui-icon-btn--sm wb-collapsed-surface${id === active ? " active" : ""}`}
              aria-label={surface.title}
              title={surface.title}
              onClick={() => { workbenchSetActive(region, id); workbenchSetCollapsed(region, false); }}
            >
              {surface.icon ? <surface.icon /> : <Icon.context />}
            </button>
          );
        })}
      </section>
    );
  }

  const surface = surfaces.get(active!)!;
  const single = ids.length === 1;
  return (
    <section
      className={`wb-region wb-region--${region}${dropTarget ? " wb-drop-target" : ""}`}
      role="region"
      aria-label={`${regionLabel(region)}: ${surface.title}`}
      data-region={region}
      data-surface={surface.id}
      {...dropProps}
    >
      <ModuleView
        id={`region:${region}`}
        title={surface.title}
        {...(surface.description ? { description: surface.description } : {})}
        icon={surface.icon ? surface.icon() : undefined}
        variant="rail"
        className="wb-region-view"
        contentMode={surface.contextual ? "panel" : "workspace"}
        tabs={single ? undefined : (
          <RegionTabs region={region} ids={ids} active={surface.id} surfaces={surfaces} onDragChange={onDragChange} />
        )}
        headingProps={compact ? undefined : {
          draggable: true,
          onDragStart: (event: ReactDragEvent<HTMLElement>) => { setDragSurface(event.dataTransfer, surface.id); onDragChange(surface.id); },
          onDragEnd: () => onDragChange(null),
          title: tr("workbench.dragToMove"),
        }}
        actions={<SurfaceMenu surfaceId={surface.id} layout={layout} surfaces={surfaces} compact={compact} />}
        onToggleFullscreen={compact ? undefined : () => workbenchSetPresentation(surface.id, "fullscreen")}
        onClose={() => {
          if (surface.id === CHAT_SURFACE_ID) workbenchSetCollapsed(region, true);
          else workbenchCloseSurface(surface.id);
        }}
        closeLabel={surface.id === CHAT_SURFACE_ID ? tr("workbench.collapseRegion") : tr("workbench.closePanel")}
      >
        <SurfaceSlot surfaceId={surface.id} className="wb-region-slot" />
      </ModuleView>
    </section>
  );
}
