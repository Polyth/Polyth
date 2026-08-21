import { useEffect, useMemo, useState } from "react";
import { getDragWidget, setDragWidget, WIDGET_MIME } from "../../dnd.ts";
import { setOverlay, updateSettings, useStore } from "../../store.ts";
import { setUiSettings, useUiSettings } from "../../uiPrefs.ts";
import { applyPreset } from "../../workspacePresets.ts";
import { getWidget, useWidgetCatalog, type WidgetDef } from "../../widgets/catalog.ts";
import {
  WIDGET_ZONES,
  applyWidgetLayoutPreset,
  ensureWidgets,
  moveWidget,
  resetWidgetLayout,
  setWidgetAudience,
  setWidgetSize,
  setWidgetVisible,
  updateWidgetLayout,
  useWidgetLayout,
  widgetZoneOf,
  type WidgetAudience,
  type WidgetLayoutPresetId,
  type WidgetZone,
} from "../../widgets/widgetLayout.ts";
import { setWorkspaceMode } from "../../widgets/workspaceMode.ts";
import { PageHead, Toggle } from "./parts.tsx";
import "../../widgets/builtinWidgets.tsx";

const ZONE_LABEL: Record<WidgetZone, string> = {
  top: "Top", left: "Left", main: "Main workspace", right: "Right", bottom: "Bottom strip",
};
const AUDIENCE_RANK: Record<WidgetAudience, number> = { simple: 0, standard: 1, power: 2 };
const PRESETS: Array<[WidgetLayoutPresetId, string, string]> = [
  ["focused", "Focused", "Chat, goal, and essential actions"],
  ["balanced", "Balanced", "Conversation with core engineering tools"],
  ["manager", "Manager view", "Goals, schedule, notes, usage, and review"],
  ["build-debug", "Build & debug", "Files, changes, terminal, preview, and activity"],
  ["custom", "+ Custom", "Keep the current arrangement"],
];

function groupOf(widget: WidgetDef): string {
  if (widget.pluginId === "git" || widget.pluginId === "walkthrough") return "Git tools";
  if (widget.pluginId === "github") return "GitHub";
  if (widget.pluginId === "mcp") return "MCP";
  if (["multirun", "fusion", "schedule", "commands"].includes(widget.pluginId)) return "Tools";
  if (["session", "goals", "files", "terminal", "preview", "knowledge", "usage"].includes(widget.pluginId)) {
    return "Core workspace";
  }
  return "Plugins";
}

function isAllowed(widget: WidgetDef, audience: WidgetAudience): boolean {
  return AUDIENCE_RANK[widget.audience ?? "standard"] <= AUDIENCE_RANK[audience];
}

export default function WidgetsPage() {
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const ui = useUiSettings();
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const [selected, setSelected] = useState<string | null>("terminal.shell");
  const [preset, setPreset] = useState<WidgetLayoutPresetId>("balanced");
  const [command, setCommand] = useState("");
  const [commandResult, setCommandResult] = useState("");

  // `widgets` is referentially stable per catalog version; ensureWidgets
  // early-returns when nothing is missing, so this can never loop.
  useEffect(() => {
    ensureWidgets(widgets);
  }, [widgets]);

  const selectedWidget = selected ? getWidget(selected) ?? null : null;
  const selectedPlacement = selected ? layout.widgets[selected] : undefined;
  const groups = useMemo(() => {
    const result = new Map<string, WidgetDef[]>();
    for (const widget of widgets) {
      if (!isAllowed(widget, layout.audience)) continue;
      const name = groupOf(widget);
      const list = result.get(name);
      if (list) list.push(widget);
      else result.set(name, [widget]);
    }
    return result;
  }, [widgets, layout.audience]);

  const applyLayoutPreset = (id: WidgetLayoutPresetId) => {
    setPreset(id);
    updateWidgetLayout((current) => applyWidgetLayoutPreset(current, id));
    if (id === "build-debug") applyPreset("build-debug");
    if (id === "manager") applyPreset("plan-coordinate");
  };

  const runCommand = () => {
    const text = command.trim().toLowerCase();
    if (!text) return;
    let changed = false;
    if (text.includes("compact")) {
      setUiSettings({ density: "compact" });
      updateSettings({ density: "compact" });
      changed = true;
    } else if (text.includes("comfortable")) {
      setUiSettings({ density: "comfortable" });
      updateSettings({ density: "comfortable" });
      changed = true;
    }
    const presetId = text.includes("focused")
      ? "focused"
      : text.includes("manager")
        ? "manager"
        : text.includes("build") || text.includes("debug")
          ? "build-debug"
          : null;
    if (presetId) {
      applyLayoutPreset(presetId);
      changed = true;
    }
    const hide = text.match(/\bhide\s+([\w -]+)/)?.[1]?.trim();
    const show = text.match(/\bshow\s+([\w -]+)/)?.[1]?.trim();
    const target = hide ?? show;
    if (target) {
      const widget = widgets.find((item) =>
        item.id.toLowerCase().includes(target) || item.title.toLowerCase().includes(target));
      if (widget) {
        updateWidgetLayout((current) => setWidgetVisible(current, widget.id, show !== undefined));
        changed = true;
      }
    }
    setCommandResult(changed
      ? "Workspace updated locally."
      : "Try “compact”, “hide terminal”, “show preview”, “focused”, or “build & debug”.");
    if (changed) setCommand("");
  };

  return (
    <>
      <PageHead title="Widgets & Layout" blurb="Arrange project tools without changing the session event log." />
      <div className="widget-settings-steps" aria-label="Workspace customization steps">
        <span>1 <b>Choose layout</b></span>
        <span className="active">2 <b>Place widgets</b></span>
        <span>3 <b>Fine-tune</b></span>
      </div>

      <div className="widget-preset-grid" data-settings-item="widgets.presets">
        {PRESETS.map(([id, label, description]) => (
          <button
            key={id}
            className={preset === id ? "active" : ""}
            aria-pressed={preset === id}
            onClick={() => applyLayoutPreset(id)}
          >
            <strong>{label}</strong>
            <span>{description}</span>
          </button>
        ))}
      </div>

      <div className="widget-settings-toolbar">
        <label>
          Density
          <select
            value={ui.density}
            onChange={(event) => {
              const density = event.target.value as "comfortable" | "balanced" | "compact";
              setUiSettings({ density });
              updateSettings({ density });
            }}
          >
            <option value="comfortable">Comfortable</option>
            <option value="balanced">Balanced</option>
            <option value="compact">Compact</option>
          </select>
        </label>
        <label>
          Audience
          <select
            value={layout.audience}
            onChange={(event) => updateWidgetLayout((current) =>
              setWidgetAudience(current, event.target.value as WidgetAudience))}
          >
            <option value="simple">Simple</option>
            <option value="standard">Standard</option>
            <option value="power">Power</option>
          </select>
        </label>
        <button onClick={() => {
          if (window.confirm("Reset widget placement and visibility?")) resetWidgetLayout(widgets);
        }}>Reset layout</button>
        <button
          onClick={() => {
            setWorkspaceMode("widgets");
            setOverlay(null);
          }}
        >Preview</button>
      </div>

      <div className="widget-settings-workbench">
        <div className="widget-settings-center">
          <div className="widget-layout-editor" data-settings-item="widgets.layout">
            {WIDGET_ZONES.map((zone) => {
              const items = layout.zones[zone]
                .map((id) => getWidget(id))
                .filter((widget): widget is WidgetDef =>
                  widget !== undefined && layout.widgets[widget.id]?.visible === true
                  && isAllowed(widget, layout.audience));
              return (
                <div
                  className={`widget-layout-zone zone-${zone}`}
                  key={zone}
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes(WIDGET_MIME)) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    const id = getDragWidget(event.dataTransfer);
                    if (!id) return;
                    event.preventDefault();
                    updateWidgetLayout((current) => moveWidget(current, id, zone));
                    setSelected(id);
                    setPreset("custom");
                  }}
                >
                  <span className="widget-layout-zone-title">{ZONE_LABEL[zone]}</span>
                  {items.map((widget, index) => (
                    <button
                      key={widget.id}
                      draggable
                      className={`widget-layout-tile ${selected === widget.id ? "selected" : ""}`}
                      onDragStart={(event) => setDragWidget(event.dataTransfer, widget.id)}
                      onClick={() => setSelected(widget.id)}
                      onKeyDown={(event) => {
                        if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
                        const sibling = items[index + (event.key === "ArrowLeft" ? -1 : 1)];
                        if (!sibling) return;
                        event.preventDefault();
                        updateWidgetLayout((current) =>
                          moveWidget(current, widget.id, zone, current.zones[zone].indexOf(sibling.id)));
                        setPreset("custom");
                      }}
                    >
                      <span aria-hidden="true">⠿</span>
                      <span>{widget.title}</span>
                      <small>{layout.widgets[widget.id]!.size.w}×{layout.widgets[widget.id]!.size.h}</small>
                    </button>
                  ))}
                  {items.length === 0 && <em>Drop widgets here</em>}
                </div>
              );
            })}
          </div>

          <div className="widget-recommended">
            <h3>Recommended to start</h3>
            <div>
              {["core.composer", "goals.current", "git.recent", "core.quick-actions"].map((id) => getWidget(id)).filter((widget): widget is WidgetDef => !!widget).map((widget) => (
                <button key={widget.id} onClick={() => {
                  updateWidgetLayout((current) => moveWidget(setWidgetVisible(current, widget.id, true), widget.id, widget.zone ?? "main"));
                  setSelected(widget.id);
                }}>
                  <strong>{widget.title}</strong><span>{widget.description}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="widget-library-settings">
            <h3>Plugin widget library</h3>
            {["Core workspace", "Git tools", "GitHub", "MCP", "Tools", "Plugins"].map((group) => (
              <section key={group}>
                <h4>{group} <span>{groups.get(group)?.length ?? 0}</span></h4>
                <div>
                  {(groups.get(group) ?? []).map((widget) => {
                    const visible = layout.widgets[widget.id]?.visible === true;
                    return (
                      <button
                        key={widget.id}
                        className={visible ? "visible" : ""}
                        onClick={() => {
                          updateWidgetLayout((current) => {
                            const next = setWidgetVisible(current, widget.id, !visible);
                            return !visible
                              ? moveWidget(next, widget.id, widgetZoneOf(next, widget.id) ?? widget.zone ?? "main")
                              : next;
                          });
                          setSelected(widget.id);
                          setPreset("custom");
                        }}
                      >
                        <span>{widget.title}</span>
                        <small>{visible ? "Added" : "+"}</small>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>

        <aside className="widget-inspector" aria-label="Widget inspector">
          {selectedWidget && selectedPlacement ? (
            <>
              <div className="widget-inspector-head">
                <div className="widget-inspector-identity">
                  <span className="widget-inspector-icon">{selectedWidget.title.slice(0, 1)}</span>
                  <span><small>{selectedWidget.pluginId}</small><h3>{selectedWidget.title}</h3></span>
                  <i aria-hidden="true"><b /><b /><b /></i>
                </div>
                <p>{selectedWidget.description}</p>
              </div>
              <div className="widget-inspector-tabs">
                <button className="active">Settings</button><button>Preview</button>
              </div>
              <div className="widget-inspector-section">
                <strong>Identity</strong>
                <label>Title<input defaultValue={selectedWidget.title} aria-label="Widget title" /></label>
                <label>Description<textarea defaultValue={selectedWidget.description} aria-label="Widget description" rows={2} /></label>
              </div>
              <label>
                Size
                <span>
                  <select defaultValue={selectedPlacement.size.w >= 9 ? "large" : selectedPlacement.size.w >= 5 ? "medium" : "small"}>
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                  <input
                    type="number" min={1} max={12} value={selectedPlacement.size.w}
                    aria-label="Widget width"
                    onChange={(event) => updateWidgetLayout((current) =>
                      setWidgetSize(current, selectedWidget.id, {
                        ...selectedPlacement.size, w: Number(event.target.value),
                      }))}
                  />
                  ×
                  <input
                    type="number" min={1} max={12} value={selectedPlacement.size.h}
                    aria-label="Widget height"
                    onChange={(event) => updateWidgetLayout((current) =>
                      setWidgetSize(current, selectedWidget.id, {
                        ...selectedPlacement.size, h: Number(event.target.value),
                      }))}
                  />
                </span>
              </label>
              <label>
                Visibility
                <Toggle
                  on={selectedPlacement.visible}
                  label={`Visibility for ${selectedWidget.title}`}
                  onChange={(visible) => updateWidgetLayout((current) =>
                    setWidgetVisible(current, selectedWidget.id, visible))}
                />
              </label>
              <label>
                Audience
                <span className="tag">{selectedWidget.audience ?? "standard"}</span>
              </label>
              <fieldset className="widget-context-options">
                <legend>Context <small>Where it appears</small></legend>
                <label><input type="checkbox" defaultChecked={selectedWidget.pluginId === "session"} />Global</label>
                <label><input type="checkbox" defaultChecked />Workspace</label>
                <label><input type="checkbox" defaultChecked={selectedWidget.pluginId !== "session"} />Plugin</label>
              </fieldset>
              {selectedWidget.settingsRender?.({ projectId, sessionId, widgetId: selectedWidget.id, editing: true })}
              <div className="widget-inspector-actions">
                <button
                  className="danger-btn"
                  onClick={() => updateWidgetLayout((current) =>
                    setWidgetVisible(current, selectedWidget.id, false))}
                >Remove this widget</button>
                <button onClick={() => setSelected(null)}>Cancel</button>
                <button className="btn-accent" onClick={() => setSelected(null)}>Done</button>
              </div>
            </>
          ) : (
            <p className="muted">Select a widget to fine-tune it.</p>
          )}
        </aside>
      </div>

      <div className="workspace-command">
        <label htmlFor="workspace-command-input">Ask Polyth to change this workspace</label>
        <div>
          <input
            id="workspace-command-input"
            value={command}
            placeholder='Try “compact and hide terminal”'
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") runCommand(); }}
          />
          <button onClick={runCommand}>Apply</button>
        </div>
        {commandResult && <p role="status">{commandResult}</p>}
      </div>
    </>
  );
}
