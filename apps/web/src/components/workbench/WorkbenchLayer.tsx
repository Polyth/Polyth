// Floating and fullscreen presentations for a customized workbench (grid
// mode). The fullscreen layer covers the regions (which the host marks inert)
// and returns the surface to its exact previous placement; floating windows
// keep their remembered size, move by their header, resize from the end/bottom
// edges (pointer or keyboard), and dismiss on outside interaction — the same
// vocabulary the conversation companion window has always had.
import {
  useEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import ModuleView from "../ui/ModuleView.ts";
import { pathBelongsToPackageWindow } from "../ui/PackageWindowContext.ts";
import { tr } from "../../i18n/index.ts";
import { clampPaneDimension } from "../../workspace/panePrefs.ts";
import type { WorkbenchLayout } from "../../workbench/layout.ts";
import {
  workbenchCloseSurface,
  workbenchExitFullscreen,
  workbenchOutsideClose,
  workbenchResizeSurface,
  workbenchSetPresentation,
} from "../../workbench/store.ts";
import { RESIZE_STEP, RESIZE_STEP_LARGE } from "./ResizeSeparator.tsx";
import SurfaceMenu from "./SurfaceMenu.tsx";
import SurfaceSlot from "./SurfaceSlot.tsx";
import type { WorkbenchSurfaceInfo } from "./workbenchModel.ts";

export interface WorkbenchLayerProps {
  layout: WorkbenchLayout;
  surfaces: ReadonlyMap<string, WorkbenchSurfaceInfo>;
  /** Measured workbench box the windows are bounded by. */
  bounds: { width: number; height: number };
  compact: boolean;
}

function FloatingWindow({
  surface, layout, surfaces, bounds, compact, top,
}: {
  surface: WorkbenchSurfaceInfo;
  layout: WorkbenchLayout;
  surfaces: ReadonlyMap<string, WorkbenchSurfaceInfo>;
  bounds: { width: number; height: number };
  compact: boolean;
  top: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const size = layout.surfaceSizes[surface.id] ?? {};
  const minWidth = Math.min(surface.placement?.minInlineSize ?? surface.presentation?.minWidth ?? 320, Math.max(1, bounds.width - 32));
  const minHeight = Math.min(surface.placement?.minBlockSize ?? surface.presentation?.minHeight ?? 240, Math.max(1, bounds.height - 16));
  const maxWidth = Math.max(minWidth, bounds.width - 32);
  const maxHeight = Math.max(minHeight, bounds.height - 16);
  const [live, setLive] = useState<{ width: number | null; height: number | null }>({ width: null, height: null });
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const width = compact
    ? maxWidth
    : clampPaneDimension(live.width ?? size.inline ?? Math.min(surface.presentation?.preferredMaxWidth ?? 640, bounds.width * (surface.presentation?.defaultRatio ?? 0.55)), minWidth, bounds.width);
  const height = compact
    ? maxHeight
    : clampPaneDimension(live.height ?? size.block ?? maxHeight, minHeight, bounds.height, 16);

  useEffect(() => { setOffset({ x: 0, y: 0 }); }, [bounds.width, bounds.height]);

  // Outside interaction dismisses only the topmost floating window.
  useEffect(() => {
    if (!top) return;
    const outside = (event: PointerEvent) => {
      const modal = document.querySelector<HTMLElement>('[aria-modal="true"]');
      if (modal && modal !== ref.current) return;
      if (!pathBelongsToPackageWindow(event.composedPath(), surface.id)) workbenchOutsideClose(surface.id);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [top, surface.id]);

  const beginMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (compact || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select, [role='menu']")) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, offset };
    const move = (pointer: PointerEvent) => {
      setOffset({
        x: Math.min(0, Math.max(-(bounds.width - width - 16), start.offset.x + pointer.clientX - start.x)),
        y: Math.max(0, Math.min(bounds.height - height - 8, start.offset.y + pointer.clientY - start.y)),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const beginResize = (edge: "e" | "s", event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY, width, height };
    document.documentElement.dataset.packageWindowResizing = "true";
    const move = (pointer: PointerEvent) => {
      if (edge === "e") setLive((l) => ({ ...l, width: Math.min(maxWidth, Math.max(minWidth, start.width + pointer.clientX - start.x)) }));
      else setLive((l) => ({ ...l, height: Math.min(maxHeight, Math.max(minHeight, start.height + pointer.clientY - start.y)) }));
    };
    const up = () => {
      delete document.documentElement.dataset.packageWindowResizing;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const box = ref.current?.getBoundingClientRect();
      if (box) workbenchResizeSurface(surface.id, { inline: box.width, block: box.height });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const onResizeKey = (edge: "e" | "s", event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
    if (edge === "e") {
      const next = event.key === "Home" ? minWidth : event.key === "End" ? maxWidth
        : event.key === "ArrowLeft" ? width - step : event.key === "ArrowRight" ? width + step : null;
      if (next === null) return;
      event.preventDefault();
      const clamped = Math.min(maxWidth, Math.max(minWidth, next));
      setLive((l) => ({ ...l, width: clamped }));
      workbenchResizeSurface(surface.id, { inline: clamped });
      return;
    }
    const next = event.key === "Home" ? minHeight : event.key === "End" ? maxHeight
      : event.key === "ArrowUp" ? height - step : event.key === "ArrowDown" ? height + step : null;
    if (next === null) return;
    event.preventDefault();
    const clamped = Math.min(maxHeight, Math.max(minHeight, next));
    setLive((l) => ({ ...l, height: clamped }));
    workbenchResizeSurface(surface.id, { block: clamped });
  };

  return (
    <div
      ref={ref}
      className={`wb-floating rail-workspace${top ? " wb-floating--top" : ""}`}
      role="dialog"
      aria-label={surface.title}
      data-package-window-owner={surface.id}
      data-package-window-mode="dynamic"
      style={{ width, height, transform: `translate(${offset.x}px, ${offset.y}px)` }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || surface.presentation?.escape === "content") return;
        const target = event.target as Element;
        if (target.closest('[role="menu"], [role="listbox"], [role="dialog"]') !== ref.current && target.closest('[role="menu"], [role="listbox"]')) return;
        event.stopPropagation();
        workbenchCloseSurface(surface.id);
      }}
    >
      {!compact && (["e", "s"] as const).map((edge) => (
        <div
          key={edge}
          className={`package-window-resize package-window-resize--${edge}`}
          role="separator"
          tabIndex={0}
          aria-orientation={edge === "e" ? "vertical" : "horizontal"}
          aria-label={tr("contextrail.resizeValue", { value: surface.title })}
          aria-valuemin={edge === "e" ? minWidth : minHeight}
          aria-valuemax={edge === "e" ? maxWidth : maxHeight}
          aria-valuenow={edge === "e" ? width : height}
          onPointerDown={(event) => beginResize(edge, event)}
          onKeyDown={(event) => onResizeKey(edge, event)}
        />
      ))}
      <ModuleView
        id={surface.id}
        title={surface.title}
        {...(surface.description ? { description: surface.description } : {})}
        icon={surface.icon ? surface.icon() : undefined}
        variant="rail"
        contentMode={surface.contextual ? "panel" : "workspace"}
        headingProps={{ onPointerDown: beginMove, title: tr("workbench.dragToMove") }}
        actions={<SurfaceMenu surfaceId={surface.id} layout={layout} surfaces={surfaces} compact={compact} />}
        pinned={false}
        onTogglePin={compact ? undefined : () => workbenchSetPresentation(surface.id, "docked")}
        onToggleFullscreen={compact ? undefined : () => workbenchSetPresentation(surface.id, "fullscreen")}
        onClose={() => workbenchCloseSurface(surface.id)}
      >
        <SurfaceSlot surfaceId={surface.id} className="wb-window-slot" />
      </ModuleView>
    </div>
  );
}

export default function WorkbenchLayer({ layout, surfaces, bounds, compact }: WorkbenchLayerProps) {
  const fullscreen = layout.fullscreen !== null ? surfaces.get(layout.fullscreen.surfaceId) : undefined;
  if (fullscreen) {
    return (
      <div
        className="wb-fullscreen rail-workspace"
        role="dialog"
        aria-label={fullscreen.title}
        data-package-window-owner={fullscreen.id}
        data-package-window-mode="fullscreen"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || fullscreen.presentation?.escape === "content") return;
          const target = event.target as Element;
          if (target.closest('[role="menu"], [role="listbox"]')) return;
          event.stopPropagation();
          workbenchExitFullscreen();
        }}
      >
        <ModuleView
          id={fullscreen.id}
          title={fullscreen.title}
          {...(fullscreen.description ? { description: fullscreen.description } : {})}
          icon={fullscreen.icon ? fullscreen.icon() : undefined}
          variant="rail"
          contentMode={fullscreen.contextual ? "panel" : "workspace"}
          fullscreen
          actions={<SurfaceMenu surfaceId={fullscreen.id} layout={layout} surfaces={surfaces} compact={compact} />}
          onToggleFullscreen={() => workbenchExitFullscreen()}
          onClose={() => workbenchCloseSurface(fullscreen.id)}
        >
          <SurfaceSlot surfaceId={fullscreen.id} className="wb-window-slot" />
        </ModuleView>
      </div>
    );
  }
  const floating = layout.floating.filter((id) => surfaces.has(id));
  if (floating.length === 0) return null;
  return (
    <div className="wb-floating-layer">
      {floating.map((id, index) => (
        <FloatingWindow
          key={id}
          surface={surfaces.get(id)!}
          layout={layout}
          surfaces={surfaces}
          bounds={bounds}
          compact={compact}
          top={index === floating.length - 1}
        />
      ))}
    </div>
  );
}
