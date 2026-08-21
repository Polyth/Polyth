import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { getDragWidget, setDragWidget, WIDGET_MIME } from "../dnd.ts";
import { openSettingsPage, useStore } from "../store.ts";
import SlotHost from "../components/slots/SlotHost.ts";
import ViewErrorBoundary from "../components/ViewErrorBoundary.ts";
import { getWidget, useWidgetCatalog, type WidgetDef } from "./catalog.ts";
import {
  WIDGET_ZONES,
  applyWidgetLayoutMutations,
  canPlaceWidget,
  ensureWidgets,
  updateWidgetLayout,
  useWidgetLayout,
  widgetDefinitionId,
  widgetZoneOf,
  type WidgetAudience,
  type WidgetPlacement,
  type WidgetZone,
} from "./widgetLayout.ts";
import { planWorkspaceCustomization } from "./workspaceCustomize.ts";
import "./builtinWidgets.tsx";
import { setWorkspaceMode, useWorkspaceMode } from "./workspaceMode.ts";
import { setUiSettings, useUiSettings } from "../uiPrefs.ts";
import { Icon } from "../icons.tsx";
import { useEscape } from "../useEscape.ts";

const AUDIENCE_RANK: Record<WidgetAudience, number> = { simple: 0, standard: 1, power: 2 };
const ZONE_LABEL: Record<WidgetZone, string> = {
  header: "Header", left: "Left side", main: "Main workspace", right: "Right side",
  bottom: "Bottom strip", floating: "Floating",
};

function allowed(widget: WidgetDef, audience: WidgetAudience, placement?: WidgetPlacement): boolean {
  return placement?.showIn
    ? placement.showIn.includes(audience)
    : AUDIENCE_RANK[widget.audience ?? "standard"] <= AUDIENCE_RANK[audience];
}

function WidgetCard({
  instanceId,
  widget,
  placement,
  zone,
  index,
  orderedIds,
  editing,
  projectId,
  sessionId,
  onDrag,
}: {
  instanceId: string;
  widget: WidgetDef;
  placement: WidgetPlacement;
  zone: WidgetZone;
  index: number;
  orderedIds: string[];
  editing: boolean;
  projectId: string | null;
  sessionId: string | null;
  onDrag: (id: string | null) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEscape(menuOpen, () => setMenuOpen(false));

  const moveBy = (delta: number) => {
    updateWidgetLayout((current) => {
      const sibling = orderedIds[index + delta];
      return sibling
        ? applyWidgetLayoutMutations(current, [{
            type: "move",
            id: instanceId,
            zone,
            index: current.zones[zone].indexOf(sibling),
          }], [widget])
        : current;
    });
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, ...placement.size };
    // Commit only when the pointer crosses a grid cell — not on every
    // pointermove — so drags don't storm the layout store.
    let lastW = start.w;
    let lastH = start.h;
    const onMove = (next: globalThis.PointerEvent) => {
      const w = Math.min(12, Math.max(1, start.w + Math.round((next.clientX - start.x) / 70)));
      const h = Math.min(12, Math.max(1, start.h + Math.round((next.clientY - start.y) / 48)));
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      updateWidgetLayout((current) => applyWidgetLayoutMutations(
        current,
        [{ type: "resize", id: instanceId, size: { w, h } }],
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
    <section
      className={`widget-card${editing ? " editing" : ""}`}
      style={{ "--widget-w": placement.size.w, "--widget-h": placement.size.h } as CSSProperties}
      draggable={editing}
      onDragStart={(event) => {
        setDragWidget(event.dataTransfer, instanceId);
        event.dataTransfer.effectAllowed = "move";
        onDrag(instanceId);
      }}
      onDragEnd={() => onDrag(null)}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
      data-widget-id={instanceId}
    >
      <header className="widget-card-head">
        <span className="widget-drag" aria-hidden="true">⠿</span>
        <div>
          <strong>{placement.title ?? widget.title}</strong>
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
                  updateWidgetLayout((current) => applyWidgetLayoutMutations(
                    current,
                    [{ type: "move", id: instanceId, zone: target }],
                    [widget],
                  ));
                  setMenuOpen(false);
                }} disabled={!canPlaceWidget(widget, target).ok}>Move to {ZONE_LABEL[target]}</button>
              ))}
              <button role="menuitem" onClick={() => { setMenuOpen(false); openSettingsPage("widgets"); }}>Widget settings</button>
              {widget.duplicatable && <button role="menuitem" onClick={() => {
                updateWidgetLayout((current) => applyWidgetLayoutMutations(
                  current,
                  [{ type: "duplicate", id: instanceId }],
                  [widget],
                ));
                setMenuOpen(false);
              }}>Duplicate</button>}
              <button role="menuitem" onClick={() => {
                updateWidgetLayout((current) => applyWidgetLayoutMutations(
                  current,
                  [{ type: "visibility", id: instanceId, visible: false }],
                  [widget],
                ));
                setMenuOpen(false);
              }}>Hide widget</button>
            </div>
          )}
        </div>
      </header>
      <div className="widget-card-body">
        <ViewErrorBoundary resetKey={`${instanceId}:${projectId ?? ""}:${sessionId ?? ""}`} inline>
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
    const plan = planWorkspaceCustomization(command, widgets);
    if (plan.density) setUiSettings({ density: plan.density });
    if (plan.mutations.length > 0) {
      updateWidgetLayout((current) => applyWidgetLayoutMutations(current, plan.mutations, widgets));
    }
    setResult(plan.message);
    if (plan.mutations.length > 0 || plan.density) setCommand("");
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
                  updateWidgetLayout((current) => applyWidgetLayoutMutations(current, [{
                    type: "preset",
                    preset: preset as "focused" | "balanced" | "manager" | "build-debug",
                  }], widgets))}>
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
                  updateWidgetLayout((current) => applyWidgetLayoutMutations(
                    current,
                    [{ type: "audience", audience }],
                    widgets,
                  ))}>
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
                      updateWidgetLayout((current) => applyWidgetLayoutMutations(current, [{
                        type: "visibility",
                        id: "core.quick-actions",
                        visible: event.target.checked,
                      }], widgets));
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
                  return applyWidgetLayoutMutations(current, [
                    { type: "visibility", id: widget.id, visible: true },
                    { type: "move", id: widget.id, zone },
                  ], widgets);
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
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const editing = workspaceMode === "edit";
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(editing);
  const [customizeTab, setCustomizeTab] = useState<"customize" | "widgets">("customize");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [overZone, setOverZone] = useState<WidgetZone | null>(null);

  // `widgets` is referentially stable per catalog version, so this runs only
  // when a widget actually registers/unregisters (and ensureWidgets itself
  // early-returns when nothing is missing) — never a render loop.
  useEffect(() => {
    ensureWidgets(widgets);
  }, [widgets]);
  useEffect(() => {
    if (editing) setCustomizeOpen(true);
  }, [editing]);

  const shown = useMemo(
    () => widgets.filter((widget) => allowed(widget, layout.audience, layout.widgets[widget.id])),
    [widgets, layout.audience, layout.widgets],
  );

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
            .map((instanceId) => ({
              instanceId,
              widget: getWidget(widgetDefinitionId(layout, instanceId)),
              placement: layout.widgets[instanceId],
            }))
            .filter((item): item is { instanceId: string; widget: WidgetDef; placement: WidgetPlacement } =>
              item.widget !== undefined
              && item.placement?.visible === true
              && allowed(item.widget, layout.audience, item.placement));
          const draggedWidget = draggedId
            ? getWidget(widgetDefinitionId(layout, draggedId))
            : undefined;
          const check = draggedWidget ? canPlaceWidget(draggedWidget, zone) : { ok: true };
          return (
            <div
              key={zone}
              className={[
                "widget-zone",
                `zone-${zone}`,
                draggedWidget ? (check.ok ? "compatible" : "incompatible") : "",
                overZone === zone ? "over" : "",
              ].filter(Boolean).join(" ")}
              data-zone={zone}
              onDragEnter={() => setOverZone(zone)}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverZone(null);
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(WIDGET_MIME)) return;
                if (check.ok) event.preventDefault();
                event.dataTransfer.dropEffect = check.ok ? "move" : "none";
              }}
              onDrop={(event) => {
                const id = getDragWidget(event.dataTransfer);
                const widget = id ? getWidget(widgetDefinitionId(layout, id)) : undefined;
                if (!id || !widget || !canPlaceWidget(widget, zone).ok) return;
                event.preventDefault();
                updateWidgetLayout((current) => applyWidgetLayoutMutations(
                  current,
                  [{ type: "move", id, zone }],
                  widgets,
                ));
                setDraggedId(null);
                setOverZone(null);
              }}
            >
              <div className="widget-zone-label">{ZONE_LABEL[zone]}</div>
              {zoneWidgets.map(({ instanceId, widget, placement }, index) => (
                <WidgetCard
                  key={instanceId}
                  instanceId={instanceId}
                  widget={widget}
                  placement={placement}
                  zone={zone}
                  index={index}
                  orderedIds={zoneWidgets.map((item) => item.instanceId)}
                  editing={editing}
                  projectId={projectId}
                  sessionId={sessionId}
                  onDrag={setDraggedId}
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
