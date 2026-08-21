import { useEffect, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { getDragWidget, setDragWidget, WIDGET_MIME } from "../dnd.ts";
import { openSettingsPage, useStore } from "../store.ts";
import SlotHost from "../components/slots/SlotHost.ts";
import ViewErrorBoundary from "../components/ViewErrorBoundary.ts";
import { useWidgetCatalog, type WidgetDef } from "./catalog.ts";
import {
  WIDGET_ZONES,
  ensureWidgets,
  moveWidget,
  setWidgetSize,
  setWidgetVisible,
  updateWidgetLayout,
  useWidgetLayout,
  widgetZoneOf,
  type WidgetAudience,
  type WidgetZone,
} from "./widgetLayout.ts";
import "./builtinWidgets.tsx";

const AUDIENCE_RANK: Record<WidgetAudience, number> = { simple: 0, standard: 1, power: 2 };
const ZONE_LABEL: Record<WidgetZone, string> = {
  top: "Top", left: "Left", main: "Main workspace", right: "Right", bottom: "Bottom strip",
};

function allowed(widget: WidgetDef, audience: WidgetAudience): boolean {
  return AUDIENCE_RANK[widget.audience ?? "standard"] <= AUDIENCE_RANK[audience];
}

function WidgetCard({
  widget,
  zone,
  index,
  orderedIds,
  editing,
}: {
  widget: WidgetDef;
  zone: WidgetZone;
  index: number;
  orderedIds: string[];
  editing: boolean;
}) {
  const layout = useWidgetLayout();
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const placement = layout.widgets[widget.id]!;

  const moveBy = (delta: number) => {
    updateWidgetLayout((current) => {
      const sibling = orderedIds[index + delta];
      return sibling
        ? moveWidget(current, widget.id, zone, current.zones[zone].indexOf(sibling))
        : current;
    });
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, ...placement.size };
    const onMove = (next: globalThis.PointerEvent) => {
      const w = start.w + Math.round((next.clientX - start.x) / 70);
      const h = start.h + Math.round((next.clientY - start.y) / 48);
      updateWidgetLayout((current) => setWidgetSize(current, widget.id, { w, h }));
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
    updateWidgetLayout((current) => setWidgetSize(current, widget.id, size));
  };

  return (
    <section
      className={`widget-card${editing ? " editing" : ""}`}
      style={{ "--widget-w": placement.size.w, "--widget-h": placement.size.h } as CSSProperties}
      draggable={editing}
      onDragStart={(event) => {
        setDragWidget(event.dataTransfer, widget.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      data-widget-id={widget.id}
    >
      <header className="widget-card-head">
        <span className="widget-drag" aria-hidden="true">⠿</span>
        <div>
          <strong>{widget.title}</strong>
          {editing && <span>{widget.pluginId}</span>}
        </div>
        {editing && (
          <div className="widget-card-actions">
            <button aria-label={`Move ${widget.title} earlier`} disabled={index === 0} onClick={() => moveBy(-1)}>←</button>
            <button
              aria-label={`Move ${widget.title} later`}
              disabled={index === orderedIds.length - 1}
              onClick={() => moveBy(1)}
            >→</button>
            <select
              aria-label={`Zone for ${widget.title}`}
              value={zone}
              onChange={(event) => updateWidgetLayout((current) =>
                moveWidget(current, widget.id, event.target.value as WidgetZone))}
            >
              {WIDGET_ZONES.map((target) => <option key={target} value={target}>{ZONE_LABEL[target]}</option>)}
            </select>
            <button
              aria-label={`Remove ${widget.title}`}
              onClick={() => updateWidgetLayout((current) => setWidgetVisible(current, widget.id, false))}
            >×</button>
          </div>
        )}
      </header>
      <div className="widget-card-body">
        <ViewErrorBoundary resetKey={`${widget.id}:${projectId ?? ""}:${sessionId ?? ""}`} inline>
          {widget.render({ projectId, sessionId, editing })}
        </ViewErrorBoundary>
      </div>
      {editing && (
        <button
          className="widget-resize-handle"
          aria-label={`Resize ${widget.title}; use arrow keys`}
          onPointerDown={startResize}
          onKeyDown={onResizeKey}
        >⌟</button>
      )}
    </section>
  );
}

function WidgetLibrary({ widgets, onDone }: { widgets: WidgetDef[]; onDone: () => void }) {
  const layout = useWidgetLayout();
  const groups = new Map<string, WidgetDef[]>();
  for (const widget of widgets) {
    const list = groups.get(widget.pluginId) ?? [];
    list.push(widget);
    groups.set(widget.pluginId, list);
  }
  return (
    <aside className="widget-add-panel" aria-label="Widget library">
      <div className="widget-add-head">
        <strong>Widget library</strong>
        <button onClick={onDone}>Done</button>
      </div>
      {[...groups.entries()].map(([pluginId, items]) => (
        <section key={pluginId}>
          <h4>{pluginId} <span>{items.length}</span></h4>
          {items.map((widget) => {
            const visible = layout.widgets[widget.id]?.visible === true;
            return (
              <button
                key={widget.id}
                disabled={visible}
                onClick={() => updateWidgetLayout((current) => {
                  const zone = widgetZoneOf(current, widget.id) ?? widget.zone ?? "main";
                  return moveWidget(setWidgetVisible(current, widget.id, true), widget.id, zone);
                })}
              >
                <span>{widget.title}</span>
                <small>{visible ? "On canvas" : widget.description}</small>
              </button>
            );
          })}
        </section>
      ))}
    </aside>
  );
}

export default function WidgetCanvas() {
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const [editing, setEditing] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const idKey = widgets.map((widget) => widget.id).sort().join("\0");

  useEffect(() => {
    ensureWidgets(widgets);
  }, [idKey]);

  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const shown = widgets.filter((widget) => allowed(widget, layout.audience));

  return (
    <div className={`widget-workspace audience-${layout.audience}${editing ? " editing" : ""}`}>
      <div className="widget-workspace-toolbar">
        <div>
          <strong>Widgets</strong>
          <span>{editing ? "Drag widgets to rearrange" : "Your project workspace"}</span>
        </div>
        <button onClick={() => setLibraryOpen(true)}>+ Add widget</button>
        <button className={editing ? "btn-accent" : ""} onClick={() => setEditing((value) => !value)}>
          {editing ? "Done editing" : "Edit layout"}
        </button>
        <button onClick={() => openSettingsPage("widgets")}>Customize</button>
      </div>
      <div className="widget-canvas">
        {WIDGET_ZONES.map((zone) => {
          const zoneWidgets = layout.zones[zone]
            .map((id) => byId.get(id))
            .filter((widget): widget is WidgetDef =>
              widget !== undefined && layout.widgets[widget.id]?.visible === true && allowed(widget, layout.audience));
          return (
            <div
              key={zone}
              className={`widget-zone zone-${zone}`}
              data-zone={zone}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes(WIDGET_MIME)) event.preventDefault();
              }}
              onDrop={(event) => {
                const id = getDragWidget(event.dataTransfer);
                if (!id) return;
                event.preventDefault();
                updateWidgetLayout((current) => moveWidget(current, id, zone));
              }}
            >
              <div className="widget-zone-label">{ZONE_LABEL[zone]}</div>
              {zoneWidgets.map((widget, index) => (
                <WidgetCard
                  key={widget.id}
                  widget={widget}
                  zone={zone}
                  index={index}
                  orderedIds={zoneWidgets.map((item) => item.id)}
                  editing={editing}
                />
              ))}
              {zoneWidgets.length === 0 && (
                <div className="widget-zone-empty">
                  {editing ? `Drop widgets in ${ZONE_LABEL[zone].toLowerCase()}` : "No visible widgets"}
                </div>
              )}
            </div>
          );
        })}
        <SlotHost
          slot="workspace.canvas"
          context={{ editing, audience: layout.audience, visibleWidgetIds: shown.map((widget) => widget.id) }}
        />
      </div>
      {libraryOpen && <WidgetLibrary widgets={shown} onDone={() => setLibraryOpen(false)} />}
    </div>
  );
}
