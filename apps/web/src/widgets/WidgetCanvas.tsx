import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useStore } from "../store.ts";
import SlotHost from "../components/slots/SlotHost.ts";
import ViewErrorBoundary from "../components/ViewErrorBoundary.ts";
import { Icon } from "../icons.tsx";
import { useEscape } from "../useEscape.ts";
import { getWidget, useWidgetCatalog, type WidgetDef } from "./catalog.ts";
import {
  applyWidgetLayoutMutations,
  ensureWidgets,
  updateWidgetLayout,
  useWidgetLayout,
  widgetDefinitionId,
  type WidgetPlacement,
  type WidgetPosition,
} from "./widgetLayout.ts";
import { pluginDisplayName } from "./widgetLibrary.ts";
import "./builtinWidgets.tsx";

const GRID_GAP = 10;
const GRID_ROW = 36;

function positionStyle(placement: WidgetPlacement): CSSProperties {
  const width = Math.min(placement.size.w, 12 - placement.position.x);
  return {
    gridColumn: `${placement.position.x + 1} / span ${width}`,
    gridRow: `${placement.position.y + 1} / span ${placement.size.h}`,
    "--widget-w": placement.size.w,
    "--widget-h": placement.size.h,
  } as CSSProperties;
}

function canvasMetrics(element: HTMLElement): { column: number; row: number } {
  const width = element.getBoundingClientRect().width;
  return {
    column: Math.max(24, (width - GRID_GAP * 11) / 12),
    row: GRID_ROW + GRID_GAP,
  };
}

function WidgetCard({
  instanceId,
  widget,
  placement,
  projectId,
  sessionId,
}: {
  instanceId: string;
  widget: WidgetDef;
  placement: WidgetPlacement;
  projectId: string | null;
  sessionId: string | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEscape(menuOpen, () => setMenuOpen(false));

  const startMove = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const canvas = event.currentTarget.closest<HTMLElement>(".widget-canvas-grid");
    if (!canvas) return;
    const metrics = canvasMetrics(canvas);
    const start = { x: event.clientX, y: event.clientY, position: placement.position };
    let last = placement.position;
    const onMove = (next: globalThis.PointerEvent) => {
      const position: WidgetPosition = {
        x: Math.max(0, Math.min(12 - placement.size.w,
          start.position.x + Math.round((next.clientX - start.x) / (metrics.column + GRID_GAP)))),
        y: Math.max(0, start.position.y + Math.round((next.clientY - start.y) / metrics.row)),
      };
      if (position.x === last.x && position.y === last.y) return;
      last = position;
      updateWidgetLayout((current) => applyWidgetLayoutMutations(
        current,
        [{ type: "position", id: instanceId, position }],
        [widget],
      ));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const canvas = event.currentTarget.closest<HTMLElement>(".widget-canvas-grid");
    if (!canvas) return;
    const metrics = canvasMetrics(canvas);
    const start = { x: event.clientX, y: event.clientY, ...placement.size };
    let last = placement.size;
    const onMove = (next: globalThis.PointerEvent) => {
      const size = {
        w: Math.max(1, Math.min(12 - placement.position.x,
          start.w + Math.round((next.clientX - start.x) / (metrics.column + GRID_GAP)))),
        h: Math.max(1, Math.min(12, start.h + Math.round((next.clientY - start.y) / metrics.row))),
      };
      if (size.w === last.w && size.h === last.h) return;
      last = size;
      updateWidgetLayout((current) => applyWidgetLayoutMutations(
        current,
        [{ type: "resize", id: instanceId, size }],
        [widget],
      ));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onResizeKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 2 : 1;
    let size = placement.size;
    if (event.key === "ArrowRight") size = { ...size, w: size.w + step };
    else if (event.key === "ArrowLeft") size = { ...size, w: size.w - step };
    else if (event.key === "ArrowDown") size = { ...size, h: size.h + step };
    else if (event.key === "ArrowUp") size = { ...size, h: size.h - step };
    else return;
    event.preventDefault();
    updateWidgetLayout((current) => applyWidgetLayoutMutations(
      current,
      [{ type: "resize", id: instanceId, size }],
      [widget],
    ));
  };

  return (
    <section className="widget-card editing" style={positionStyle(placement)} data-widget-id={instanceId}>
      <header className="widget-card-head">
        <button
          className="widget-drag"
          aria-label={`Move ${placement.title ?? widget.title}`}
          title="Drag to move"
          onPointerDown={startMove}
        >⠿</button>
        <strong>{placement.title ?? widget.title}</strong>
        <div className="widget-card-menu-shell">
          <button
            className="widget-card-more"
            aria-label={`More options for ${widget.title}`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >⋮</button>
          {menuOpen && (
            <div className="widget-card-menu" role="menu">
              {widget.duplicatable && (
                <button role="menuitem" onClick={() => {
                  updateWidgetLayout((current) => applyWidgetLayoutMutations(
                    current,
                    [{ type: "duplicate", id: instanceId }],
                    [widget],
                  ));
                  setMenuOpen(false);
                }}>Duplicate</button>
              )}
              <button role="menuitem" onClick={() => {
                updateWidgetLayout((current) => applyWidgetLayoutMutations(
                  current,
                  [{ type: "visibility", id: instanceId, visible: false }],
                  [widget],
                ));
                setMenuOpen(false);
              }}>Remove from canvas</button>
            </div>
          )}
        </div>
      </header>
      <div className="widget-card-body">
        <ViewErrorBoundary resetKey={`${instanceId}:${projectId ?? ""}:${sessionId ?? ""}`} inline>
          {widget.render({ projectId, sessionId, editing: true })}
        </ViewErrorBoundary>
      </div>
      {widget.resizable !== false && (
        <button
          className="widget-resize-handle"
          aria-label={`Resize ${widget.title}; use arrow keys`}
          title="Drag to resize"
          onPointerDown={startResize}
          onKeyDown={onResizeKey}
        >⌟</button>
      )}
    </section>
  );
}

function WidgetMenu({ widgets, onClose }: { widgets: WidgetDef[]; onClose: () => void }) {
  const layout = useWidgetLayout();
  const [query, setQuery] = useState("");
  const shown = widgets.filter((widget) => {
    const text = `${widget.title} ${widget.description} ${pluginDisplayName(widget)}`.toLowerCase();
    return text.includes(query.trim().toLowerCase());
  });
  const groups = new Map<string, WidgetDef[]>();
  for (const widget of shown) {
    const name = pluginDisplayName(widget);
    groups.set(name, [...(groups.get(name) ?? []), widget]);
  }
  return (
    <aside className="widget-add-panel widget-menu-single" aria-label="Add widgets">
      <div className="widget-add-head">
        <strong>Add widgets</strong>
        <button className="icon-btn" aria-label="Close widget menu" onClick={onClose}>×</button>
      </div>
      <input
        className="widget-menu-search"
        value={query}
        placeholder="Search widgets…"
        aria-label="Search widgets"
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="widget-menu-list">
        {[...groups.entries()].map(([plugin, items]) => (
          <section key={plugin}>
            <h4>{plugin}</h4>
            {items.map((widget) => {
              const visible = layout.widgets[widget.id]?.visible === true;
              return (
                <button
                  key={widget.id}
                  className={visible ? "active" : ""}
                  aria-pressed={visible}
                  onClick={() => updateWidgetLayout((current) => applyWidgetLayoutMutations(
                    current,
                    [{ type: "visibility", id: widget.id, visible: !visible }],
                    widgets,
                  ))}
                >
                  <span><strong>{widget.title}</strong><small>{widget.description}</small></span>
                  <span aria-hidden="true">{visible ? "−" : "+"}</span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}

export default function WidgetCanvas() {
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const [menuOpen, setMenuOpen] = useState(false);
  useEscape(menuOpen, () => setMenuOpen(false));

  useEffect(() => {
    ensureWidgets(widgets);
  }, [widgets]);

  const cards = useMemo(() => {
    const placed = [...new Set(Object.values(layout.zones).flat())];
    return placed.flatMap((instanceId) => {
      const placement = layout.widgets[instanceId];
      const widget = getWidget(widgetDefinitionId(layout, instanceId));
      return placement?.visible && widget ? [{ instanceId, placement, widget }] : [];
    }).sort((a, b) =>
      a.placement.position.y - b.placement.position.y
      || a.placement.position.x - b.placement.position.x);
  }, [layout]);

  return (
    <div className="widget-workspace">
      <button
        className="widget-menu-trigger"
        aria-label="Add widgets"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <Icon.plus /><span>Widgets</span>
      </button>
      <div className="widget-canvas-grid">
        {cards.map(({ instanceId, placement, widget }) => (
          <WidgetCard
            key={instanceId}
            instanceId={instanceId}
            widget={widget}
            placement={placement}
            projectId={projectId}
            sessionId={sessionId}
          />
        ))}
        {cards.length === 0 && (
          <button className="widget-canvas-empty" onClick={() => setMenuOpen(true)}>
            <Icon.plus /> Add your first widget
          </button>
        )}
        <SlotHost
          slot="workspace.canvas"
          context={{ editing: true, visibleWidgetIds: cards.map((card) => card.instanceId) }}
        />
      </div>
      {menuOpen && <WidgetMenu widgets={widgets} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}
