import { useEffect, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { getDragWidget, setDragWidget, WIDGET_MIME } from "../dnd.ts";
import { openSettingsPage, useStore } from "../store.ts";
import SlotHost from "../components/slots/SlotHost.ts";
import ViewErrorBoundary from "../components/ViewErrorBoundary.ts";
import { useWidgetCatalog, type WidgetDef } from "./catalog.ts";
import {
  WIDGET_ZONES,
  applyWidgetLayoutPreset,
  ensureWidgets,
  moveWidget,
  setWidgetSize,
  setWidgetAudience,
  setWidgetVisible,
  updateWidgetLayout,
  useWidgetLayout,
  widgetZoneOf,
  type WidgetAudience,
  type WidgetZone,
} from "./widgetLayout.ts";
import "./builtinWidgets.tsx";
import { setWorkspaceMode, useWorkspaceMode } from "./workspaceMode.ts";
import { setUiSettings, useUiSettings } from "../uiPrefs.ts";
import { Icon } from "../icons.tsx";

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
  const [menuOpen, setMenuOpen] = useState(false);

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
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
      data-widget-id={widget.id}
    >
      <header className="widget-card-head">
        <span className="widget-drag" aria-hidden="true">⠿</span>
        <div>
          <strong>{widget.title}</strong>
          {editing && <span>{widget.pluginId}</span>}
        </div>
        <div className="widget-card-menu-shell">
          <button
            className="widget-card-more"
            aria-label={`More options for ${widget.title}`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >⋮</button>
          {menuOpen && (
            <div className="widget-card-menu" role="menu">
              {editing && <button role="menuitem" disabled={index === 0} onClick={() => { moveBy(-1); setMenuOpen(false); }}>Move earlier</button>}
              {editing && <button role="menuitem" disabled={index === orderedIds.length - 1} onClick={() => { moveBy(1); setMenuOpen(false); }}>Move later</button>}
              {editing && WIDGET_ZONES.map((target) => (
                target !== zone && <button key={target} role="menuitem" onClick={() => {
                  updateWidgetLayout((current) => moveWidget(current, widget.id, target));
                  setMenuOpen(false);
                }}>Move to {ZONE_LABEL[target]}</button>
              ))}
              <button role="menuitem" onClick={() => { setMenuOpen(false); openSettingsPage("widgets"); }}>Widget settings</button>
              <button role="menuitem" onClick={() => {
                updateWidgetLayout((current) => setWidgetVisible(current, widget.id, false));
                setMenuOpen(false);
              }}>Hide widget</button>
            </div>
          )}
        </div>
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

function CustomizeWorkspace({
  widgets,
  tab,
  onTab,
  onClose,
}: {
  widgets: WidgetDef[];
  tab: "customize" | "widgets";
  onTab: (tab: "customize" | "widgets") => void;
  onClose: () => void;
}) {
  const layout = useWidgetLayout();
  const ui = useUiSettings();
  const [command, setCommand] = useState("");
  const [result, setResult] = useState("");
  const visibleCount = widgets.filter((widget) => layout.widgets[widget.id]?.visible).length;
  const runCommand = () => {
    const text = command.trim().toLowerCase();
    if (!text) return;
    let changed = false;
    const preset = text.includes("focused")
      ? "focused"
      : text.includes("manager")
        ? "manager"
        : text.includes("build") || text.includes("debug")
          ? "build-debug"
          : text.includes("balanced")
            ? "balanced"
            : null;
    if (preset) {
      updateWidgetLayout((current) => applyWidgetLayoutPreset(current, preset));
      changed = true;
    }
    if (text.includes("compact")) {
      setUiSettings({ density: "compact" });
      changed = true;
    } else if (text.includes("comfortable")) {
      setUiSettings({ density: "comfortable" });
      changed = true;
    }
    const request = text.match(/\b(hide|show)\s+([\w -]+)/);
    if (request) {
      const target = widgets.find((widget) =>
        `${widget.id} ${widget.title}`.toLowerCase().includes(request[2]!.trim()));
      if (target) {
        updateWidgetLayout((current) => setWidgetVisible(current, target.id, request[1] === "show"));
        changed = true;
      }
    }
    setResult(changed ? "Workspace updated locally." : "Try “balanced”, “compact”, “hide terminal”, or “show notes”.");
    if (changed) setCommand("");
  };
  return (
    <aside className="workspace-customize-panel" aria-label="Customize Workspace">
      <header>
        <div><strong>Customize Workspace</strong><small>Saved automatically</small></div>
        <button aria-label="Close customize panel" onClick={onClose}>×</button>
      </header>
      <div className="customize-tabs" role="tablist">
        <button className={tab === "customize" ? "active" : ""} onClick={() => onTab("customize")}>Customize</button>
        <button className={tab === "widgets" ? "active" : ""} onClick={() => onTab("widgets")}>Widgets <span>({visibleCount})</span></button>
      </div>
      {tab === "customize" ? (
        <div className="customize-panel-body">
          <label className="customize-command">
            <span>Ask Polyth to change this workspace</span>
            <textarea value={command} placeholder="Make this compact and hide terminal" onChange={(event) => setCommand(event.target.value)} />
            <button onClick={runCommand}>Apply change</button>
            {result && <small role="status">{result}</small>}
          </label>
          <section>
            <h4>Layout presets</h4>
            <div className="layout-preset-icons">
              {[
                ["focused", "▣"], ["balanced", "▦"], ["manager", "▤"],
                ["build-debug", "▥"], ["balanced", "▧"], ["focused", "□"],
              ].map(([preset, icon], index) => (
                <button key={`${preset}:${index}`} title={`${preset} layout`} onClick={() =>
                  updateWidgetLayout((current) => applyWidgetLayoutPreset(current, preset as "focused" | "balanced" | "manager" | "build-debug"))}>
                  {icon}
                </button>
              ))}
            </div>
          </section>
          <section>
            <h4>Density</h4>
            <div className="customize-segmented">
              {(["comfortable", "balanced", "compact"] as const).map((density) => (
                <button className={ui.density === density ? "active" : ""} key={density} onClick={() => setUiSettings({ density })}>
                  {density[0]!.toUpperCase() + density.slice(1)}
                </button>
              ))}
            </div>
          </section>
          <section>
            <h4>Audience</h4>
            <div className="customize-segmented">
              {(["simple", "standard", "power"] as const).map((audience) => (
                <button className={layout.audience === audience ? "active" : ""} key={audience} onClick={() =>
                  updateWidgetLayout((current) => setWidgetAudience(current, audience))}>
                  {audience[0]!.toUpperCase() + audience.slice(1)}
                </button>
              ))}
            </div>
          </section>
          <section className="customize-toggles">
            <h4>Controls</h4>
            {[
              ["Technical buttons", "showTechnicalButtons"],
              ["Dictate", "showDictate"],
              ["Quick Actions", "showQuickActions"],
            ].map(([label, key]) => {
              const setting = key as "showTechnicalButtons" | "showDictate" | "showQuickActions";
              const on = ui[setting];
              return (
                <label key={key}>
                  <span className="toggle-drag">⠿</span><span>{label}</span>
                  <input type="checkbox" checked={on} onChange={(event) => {
                    setUiSettings({ [setting]: event.target.checked });
                    if (setting === "showQuickActions") {
                      updateWidgetLayout((current) => setWidgetVisible(current, "core.quick-actions", event.target.checked));
                    }
                  }} />
                </label>
              );
            })}
          </section>
        </div>
      ) : (
        <WidgetLibrary widgets={widgets} onDone={() => onTab("customize")} />
      )}
    </aside>
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
                draggable={!visible}
                disabled={visible}
                onDragStart={(event) => setDragWidget(event.dataTransfer, widget.id)}
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
  const workspaceMode = useWorkspaceMode();
  const editing = workspaceMode === "edit";
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(editing);
  const [customizeTab, setCustomizeTab] = useState<"customize" | "widgets">("customize");
  const idKey = widgets.map((widget) => widget.id).sort().join("\0");

  useEffect(() => {
    ensureWidgets(widgets);
  }, [idKey]);
  useEffect(() => {
    if (editing) setCustomizeOpen(true);
  }, [editing]);

  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const shown = widgets.filter((widget) => allowed(widget, layout.audience));

  return (
    <div className={`widget-workspace audience-${layout.audience}${editing ? " editing" : ""}`}>
      <div className="widget-workspace-toolbar">
        <div>
          <strong>{editing ? "Editing workspace" : "Project canvas"}</strong>
          <span>{editing ? "Drag and resize the outlined widgets" : "Live project tools in one place"}</span>
        </div>
        <button onClick={() => { setCustomizeTab("customize"); setCustomizeOpen(true); }}><Icon.gear /> Customize</button>
        {editing && <button className="btn-accent" onClick={() => setWorkspaceMode("widgets")}>Done editing</button>}
      </div>
      <div className="widget-workspace-main">
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
      {customizeOpen && (
        <CustomizeWorkspace
          widgets={shown}
          tab={customizeTab}
          onTab={setCustomizeTab}
          onClose={() => setCustomizeOpen(false)}
        />
      )}
      </div>
      <div className="widget-canvas-footer">
        <span>Drag widgets to rearrange <b>•</b> Resize from corners <b>•</b> Right-click for more options</span>
        <button onClick={() => { setCustomizeTab("widgets"); setCustomizeOpen(true); setLibraryOpen(true); }}>+ Add widget</button>
      </div>
      {libraryOpen && !customizeOpen && <WidgetLibrary widgets={shown} onDone={() => setLibraryOpen(false)} />}
    </div>
  );
}
