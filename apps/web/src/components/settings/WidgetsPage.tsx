import { useEffect, useMemo, useState } from "react";
import { getDragWidget, setDragWidget, WIDGET_MIME } from "../../dnd.ts";
import { setOverlay, updateSettings, useStore } from "../../store.ts";
import { setUiSettings, useUiSettings } from "../../uiPrefs.ts";
import { applyPreset } from "../../workspacePresets.ts";
import { useWidgetCatalog, type WidgetDef } from "../../widgets/catalog.ts";
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
  if (["multirun", "fusion", "schedule", "commands"].includes(widget.pluginId)) return "MCP / Tools";
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
  const [selected, setSelected] = useState<string | null>("core.chat");
  const [preset, setPreset] = useState<WidgetLayoutPresetId>("balanced");
  const [command, setCommand] = useState("");
  const [commandResult, setCommandResult] = useState("");
  const idKey = widgets.map((widget) => widget.id).sort().join("\0");

  useEffect(() => {
    ensureWidgets(widgets);
  }, [idKey]);

  const byId = useMemo(() => new Map(widgets.map((widget) => [widget.id, widget])), [idKey]);
  const selectedWidget = selected ? byId.get(selected) ?? null : null;
  const selectedPlacement = selected ? layout.widgets[selected] : undefined;
  const groups = useMemo(() => {
    const result = new Map<string, WidgetDef[]>();
    for (const widget of widgets.filter((item) => isAllowed(item, layout.audience))) {
      const name = groupOf(widget);
      result.set(name, [...(result.get(name) ?? []), widget]);
    }
    return result;
  }, [idKey, layout.audience]);

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
                .map((id) => byId.get(id))
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

          <div className="widget-library-settings">
            <h3>Widget library</h3>
            {[...groups.entries()].map(([group, items]) => (
              <section key={group}>
                <h4>{group} <span>{items.length}</span></h4>
                <div>
                  {items.map((widget) => {
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
                <span>{selectedWidget.pluginId}</span>
                <h3>{selectedWidget.title}</h3>
                <p>{selectedWidget.description}</p>
              </div>
              <label>
                Size
                <span>
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
              <label>
                Context
                <select defaultValue={selectedWidget.pluginId === "session" ? "workspace" : "plugin"}>
                  <option value="global">Global</option>
                  <option value="workspace">Workspace</option>
                  <option value="plugin">Plugin</option>
                </select>
              </label>
              {selectedWidget.settingsRender?.({ projectId, sessionId, widgetId: selectedWidget.id, editing: true })}
              <div className="widget-inspector-actions">
                <button
                  className="danger-btn"
                  onClick={() => updateWidgetLayout((current) =>
                    setWidgetVisible(current, selectedWidget.id, false))}
                >Remove</button>
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
