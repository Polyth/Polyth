import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { api } from "../../api.ts";
import { getDragWidget, setDragWidget, WIDGET_MIME } from "../../dnd.ts";
import { setOverlay, updateSettings, useStore } from "../../store.ts";
import { setUiSettings, useUiSettings } from "../../uiPrefs.ts";
import { applyPreset } from "../../workspacePresets.ts";
import { getWidget, useWidgetCatalog, type WidgetDef } from "../../widgets/catalog.ts";
import {
  WIDGET_ZONES,
  applyWidgetLayoutMutations,
  canPlaceWidget,
  ensureWidgets,
  parseWidgetLayout,
  resetWidgetLayout,
  retryWidgetSave,
  serializeWidgetLayout,
  undoWidgetLayout,
  updateWidgetLayout,
  useWidgetLayout,
  useWidgetStoreStatus,
  widgetDefinitionId,
  widgetZoneOf,
  type WidgetAudience,
  type WidgetLayout,
  type WidgetLayoutMutation,
  type WidgetLayoutPresetId,
  type WidgetPlacement,
  type WidgetScope,
  type WidgetZone,
} from "../../widgets/widgetLayout.ts";
import {
  missingWidgetPlaceholders,
  pluginDisplayName,
  supportedWidgetZones,
} from "../../widgets/widgetLibrary.ts";
import { planWorkspaceCustomization } from "../../widgets/workspaceCustomize.ts";
import { setWorkspaceMode } from "../../widgets/workspaceMode.ts";
import WidgetLibraryOverlay from "./WidgetLibraryOverlay.tsx";
import { PageHead, Toggle } from "./parts.tsx";
import "../../widgets/builtinWidgets.tsx";

const ZONE_LABEL: Record<WidgetZone, string> = {
  header: "Header",
  left: "Left side",
  main: "Main workspace",
  right: "Right side",
  bottom: "Bottom strip",
  floating: "Floating",
};

const AUDIENCE_COPY: Record<WidgetAudience, { label: string; description: string }> = {
  simple: { label: "Simple", description: "Only the essentials, with friendly defaults." },
  standard: { label: "Standard", description: "Everyday controls without extra technical detail." },
  power: { label: "Power", description: "All workspace controls and advanced widgets." },
};

const PRESETS: Array<[WidgetLayoutPresetId, string, string]> = [
  ["focused", "Focused", "Composer, goal, and essential actions"],
  ["balanced", "Balanced", "Conversation with everyday project tools"],
  ["manager", "Manager", "Goals, schedule, notes, usage, and review"],
  ["build-debug", "Build & Debug", "Files, changes, terminal, preview, and activity"],
  ["custom", "Custom", "Keep your current arrangement"],
];

const RANK: Record<WidgetAudience, number> = { simple: 0, standard: 1, power: 2 };

function shownFor(
  widget: WidgetDef,
  placement: WidgetPlacement,
  audience: WidgetAudience,
): boolean {
  return placement.showIn
    ? placement.showIn.includes(audience)
    : RANK[widget.audience ?? "standard"] <= RANK[audience];
}

function widgetFor(layout: WidgetLayout, instanceId: string): WidgetDef | undefined {
  return getWidget(widgetDefinitionId(layout, instanceId));
}

function changeSummary(before: WidgetLayout, after: WidgetLayout): string[] {
  const result: string[] = [];
  let moved = 0;
  let shown = 0;
  let hidden = 0;
  let resized = 0;
  for (const id of new Set([...Object.keys(before.widgets), ...Object.keys(after.widgets)])) {
    const previous = before.widgets[id];
    const next = after.widgets[id];
    if (!previous && next) shown++;
    else if (previous && !next) hidden++;
    else if (previous && next) {
      if (!previous.visible && next.visible) shown++;
      if (previous.visible && !next.visible) hidden++;
      if (previous.size.w !== next.size.w || previous.size.h !== next.size.h) resized++;
      if (widgetZoneOf(before, id) !== widgetZoneOf(after, id)) moved++;
    }
  }
  if (moved) result.push(`${moved} moved`);
  if (shown) result.push(`${shown} added`);
  if (hidden) result.push(`${hidden} hidden`);
  if (resized) result.push(`${resized} resized`);
  if (before.audience !== after.audience) result.push(`mode: ${after.audience}`);
  return result;
}

function WidgetTile({
  instanceId,
  widget,
  placement,
  zone,
  index,
  selected,
  siblings,
  onSelect,
  onDrag,
  mutate,
}: {
  instanceId: string;
  widget: WidgetDef;
  placement: WidgetPlacement;
  zone: WidgetZone;
  index: number;
  selected: boolean;
  siblings: string[];
  onSelect: () => void;
  onDrag: (id: string | null) => void;
  mutate: (...mutations: WidgetLayoutMutation[]) => void;
}) {
  const moveBy = (delta: number) => {
    const target = siblings[index + delta];
    if (!target) return;
    mutate({ type: "move", id: instanceId, zone, index: siblings.indexOf(target) });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      moveBy(event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (!event.ctrlKey || !event.altKey || !event.key.startsWith("Arrow")) return;
    const current = WIDGET_ZONES.indexOf(zone);
    const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const candidates = [...WIDGET_ZONES.slice(current + direction), ...WIDGET_ZONES.slice(0, current + direction)];
    const target = candidates.find((candidate) => canPlaceWidget(widget, candidate).ok);
    if (!target) return;
    event.preventDefault();
    mutate({ type: "move", id: instanceId, zone: target });
  };
  return (
    <article
      className={`widget-layout-tile${selected ? " selected" : ""}`}
      draggable
      onDragStart={(event) => {
        setDragWidget(event.dataTransfer, instanceId);
        event.dataTransfer.effectAllowed = "move";
        onDrag(instanceId);
      }}
      onDragEnd={() => onDrag(null)}
    >
      <button
        type="button"
        className="widget-layout-drag"
        onClick={onSelect}
        onKeyDown={onKeyDown}
        aria-label={`${widget.title}, drag to move; Alt plus arrows reorders; Control Alt plus arrows changes zone`}
      >⠿</button>
      <button type="button" className="widget-layout-tile-name" onClick={onSelect}>
        <strong>{placement.title ?? widget.title}</strong>
        <span>{pluginDisplayName(widget)}</span>
      </button>
      <small>{placement.size.w}×{placement.size.h}</small>
      <button type="button" className="widget-layout-remove" onClick={() => mutate({ type: "visibility", id: instanceId, visible: false })} aria-label={`Hide ${widget.title}`}>×</button>
    </article>
  );
}

export default function WidgetsPage() {
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const ui = useUiSettings();
  const storeStatus = useWidgetStoreStatus();
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const [selected, setSelected] = useState<string | null>("core.composer");
  const [preset, setPreset] = useState<WidgetLayoutPresetId>("balanced");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [overZone, setOverZone] = useState<WidgetZone | null>(null);
  const [message, setMessage] = useState("");
  const [command, setCommand] = useState("");
  const [baseline, setBaseline] = useState(() => serializeWidgetLayout(layout));

  useEffect(() => {
    ensureWidgets(widgets);
  }, [widgets]);

  const mutate = (...mutations: WidgetLayoutMutation[]) => {
    updateWidgetLayout((current) => applyWidgetLayoutMutations(current, mutations, widgets));
    setPreset("custom");
  };

  const selectedPlacement = selected ? layout.widgets[selected] : undefined;
  const selectedWidget = selected ? widgetFor(layout, selected) : undefined;
  const missing = useMemo(() => missingWidgetPlaceholders(layout, widgets), [layout, widgets]);
  const baselineLayout = useMemo(() => parseWidgetLayout(baseline, widgets), [baseline, widgets]);
  const summary = changeSummary(baselineLayout, layout);
  const changed = baseline !== serializeWidgetLayout(layout);

  const applyLayoutPreset = (id: WidgetLayoutPresetId) => {
    setPreset(id);
    updateWidgetLayout((current) => applyWidgetLayoutMutations(current, [{ type: "preset", preset: id }], widgets));
    if (id === "build-debug") applyPreset("build-debug");
    if (id === "manager") applyPreset("plan-coordinate");
  };

  const runCommand = () => {
    const plan = planWorkspaceCustomization(command, widgets);
    if (plan.density) {
      setUiSettings({ density: plan.density });
      updateSettings({ density: plan.density });
    }
    if (plan.mutations.length > 0) mutate(...plan.mutations);
    setMessage(plan.message);
    if (plan.mutations.length > 0 || plan.density) setCommand("");
  };

  const resetSelected = () => {
    if (!selected || !selectedWidget || !selectedPlacement) return;
    mutate(
      {
        type: "identity",
        id: selected,
        title: selectedWidget.title,
        description: selectedWidget.description,
      },
      {
        type: "resize",
        id: selected,
        size: selectedWidget.defaultSize ?? { w: 6, h: 4 },
      },
      {
        type: "move",
        id: selected,
        zone: selectedWidget.zone ?? "main",
      },
      {
        type: "show-in",
        id: selected,
        showIn: selectedWidget.showIn
          ? [...selectedWidget.showIn]
          : (["simple", "standard", "power"] as const).filter(
              (audience) => RANK[audience] >= RANK[selectedWidget.audience ?? "standard"],
            ),
      },
    );
  };

  if (libraryOpen) return <WidgetLibraryOverlay widgets={widgets} onClose={() => setLibraryOpen(false)} />;

  return (
    <>
      <PageHead title="Widgets & Layout" blurb="Build a workspace that feels like yours. Every preset is only a starting point." />

      <div className="widget-settings-steps" aria-label="Workspace customization steps">
        <span className="done"><i>1</i><b>Choose layout</b></span>
        <span className="active"><i>2</i><b>Place widgets</b></span>
        <span><i>3</i><b>Fine-tune</b></span>
      </div>

      <section className="widget-preset-section" data-settings-item="widgets.presets">
        <div className="widget-section-title">
          <div><h3>Choose a starting layout</h3><p>Change anything after you choose.</p></div>
          <button type="button" onClick={() => setOverlay("onboarding")}>Help me set up my workspace</button>
        </div>
        <div className="widget-preset-grid">
          {PRESETS.map(([id, label, description]) => (
            <button
              key={id}
              className={preset === id ? "active" : ""}
              aria-pressed={preset === id}
              onClick={() => applyLayoutPreset(id)}
            >
              <span className={`preset-miniature preset-${id}`} aria-hidden="true"><i /><i /><i /></span>
              <strong>{label}</strong>
              <span>{description}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="widget-settings-toolbar">
        <div className="widget-audience-picker">
          <span>Who is this for</span>
          <div role="group" aria-label="Workspace complexity">
            {(Object.keys(AUDIENCE_COPY) as WidgetAudience[]).map((audience) => (
              <button
                key={audience}
                className={layout.audience === audience ? "active" : ""}
                aria-pressed={layout.audience === audience}
                title={AUDIENCE_COPY[audience].description}
                onClick={() => mutate({ type: "audience", audience })}
              >{AUDIENCE_COPY[audience].label}</button>
            ))}
          </div>
        </div>
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
        <span className={`widget-save-state ${storeStatus.saveStatus}`} role="status">
          {storeStatus.saveStatus === "saving"
            ? "Saving…"
            : storeStatus.saveStatus === "error"
              ? <>Couldn’t save <button type="button" onClick={retryWidgetSave}>Retry</button></>
              : "Changes saved automatically"}
        </span>
        <button type="button" onClick={undoWidgetLayout} disabled={!storeStatus.canUndo}>Undo</button>
        <button type="button" onClick={() => {
          if (window.confirm("Reset widget placement, size, and visibility?")) resetWidgetLayout(widgets);
        }}>Reset layout</button>
        <button type="button" className="btn-accent" onClick={() => setLibraryOpen(true)}>＋ Add widget</button>
      </div>

      <div className="widget-settings-workbench">
        <main className="widget-settings-center">
          <div className="widget-layout-editor" data-settings-item="widgets.layout">
            <div className="widget-layout-editor-head">
              <div><strong>Workspace preview</strong><span>Drag widgets between compatible zones.</span></div>
              <button type="button" onClick={() => {
                setWorkspaceMode("edit");
                setOverlay(null);
              }}>Open live preview ↗</button>
            </div>
            {WIDGET_ZONES.map((zone) => {
              const ids = layout.zones[zone].filter((id) => {
                const widget = widgetFor(layout, id);
                const placement = layout.widgets[id];
                return widget && placement?.visible && shownFor(widget, placement, layout.audience);
              });
              const draggedWidget = draggedId ? widgetFor(layout, draggedId) : undefined;
              const compatibility = draggedWidget ? canPlaceWidget(draggedWidget, zone) : { ok: true };
              return (
                <section
                  className={[
                    "widget-layout-zone",
                    `zone-${zone}`,
                    draggedWidget ? (compatibility.ok ? "compatible" : "incompatible") : "",
                    overZone === zone ? "over" : "",
                  ].filter(Boolean).join(" ")}
                  key={zone}
                  onDragEnter={() => setOverZone(zone)}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverZone(null);
                  }}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes(WIDGET_MIME)) return;
                    if (compatibility.ok) event.preventDefault();
                    event.dataTransfer.dropEffect = compatibility.ok ? "move" : "none";
                  }}
                  onDrop={(event: DragEvent<HTMLElement>) => {
                    const id = getDragWidget(event.dataTransfer);
                    const widget = id ? widgetFor(layout, id) : undefined;
                    if (!id || !widget) return;
                    const check = canPlaceWidget(widget, zone);
                    if (!check.ok) {
                      setMessage(check.reason ?? "That widget does not fit there.");
                      return;
                    }
                    event.preventDefault();
                    mutate({ type: "move", id, zone });
                    setSelected(id);
                    setDraggedId(null);
                    setOverZone(null);
                    setMessage(`${widget.title} moved to ${ZONE_LABEL[zone]}.`);
                  }}
                >
                  <header><span>{ZONE_LABEL[zone]}</span><small>{ids.length} {ids.length === 1 ? "widget" : "widgets"}</small></header>
                  <div className="widget-layout-zone-items">
                    {ids.map((id, index) => {
                      const widget = widgetFor(layout, id)!;
                      return (
                        <WidgetTile
                          key={id}
                          instanceId={id}
                          widget={widget}
                          placement={layout.widgets[id]!}
                          zone={zone}
                          index={index}
                          selected={selected === id}
                          siblings={ids}
                          onSelect={() => setSelected(id)}
                          onDrag={setDraggedId}
                          mutate={mutate}
                        />
                      );
                    })}
                    <button type="button" className="widget-zone-add" onClick={() => setLibraryOpen(true)}>＋ Drop widget here</button>
                  </div>
                  {draggedWidget && compatibility.ok && <b className="widget-zone-drop">＋ Drop here</b>}
                  {draggedWidget && !compatibility.ok && <em className="widget-zone-incompatible">{compatibility.reason}</em>}
                </section>
              );
            })}
          </div>

          <section className="widget-plugin-library">
            <div className="widget-section-title">
              <div><h3>Widgets from your plugins</h3><p>Installed plugins contribute widgets without adding them to your layout.</p></div>
              <button type="button" onClick={() => setLibraryOpen(true)}>Browse all widgets →</button>
            </div>
            <div className="widget-plugin-chips">
              {[...new Map(widgets.map((widget) => [widget.pluginId, pluginDisplayName(widget)])).entries()].map(([id, name]) => (
                <button type="button" key={id} onClick={() => setLibraryOpen(true)}>
                  <span>{name.slice(0, 1)}</span><strong>{name}</strong>
                  <small>{widgets.filter((widget) => widget.pluginId === id).length}</small>
                </button>
              ))}
            </div>
            {missing.length > 0 && (
              <div className="widget-missing-list">
                <h4>Widgets needing a plugin</h4>
                {missing.map((item) => (
                  <article key={item.instanceId}>
                    <span>!</span>
                    <div><strong>{item.title}</strong><small>{item.description} · {item.pluginId}</small></div>
                    <button type="button" onClick={() => void api.pluginsOp(item.pluginId, "enable")
                      .then(() => setMessage(`${item.pluginId} enabled. Reload its contributions to restore this widget.`))
                      .catch(() => setMessage(`Open Plugins to reinstall or enable ${item.pluginId}.`))}>Enable plugin</button>
                    <button type="button" onClick={() => mutate({ type: "forget", id: item.instanceId })}>Remove</button>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="workspace-command">
            <div>
              <span aria-hidden="true">✦</span>
              <label htmlFor="workspace-command-input">Customize with Polyth</label>
              <small>What would you like to change?</small>
            </div>
            <div>
              <input
                id="workspace-command-input"
                value={command}
                placeholder='Try “make it compact and move changes to the left”'
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") runCommand(); }}
              />
              <button type="button" className="btn-accent" disabled={!command.trim()} onClick={runCommand}>Apply change</button>
            </div>
            {message && <p role="status">{message}</p>}
          </section>
        </main>

        <aside className="widget-inspector" aria-label="Widget inspector">
          {selectedWidget && selectedPlacement && selected ? (
            <>
              <div className="widget-inspector-head">
                <div className="widget-inspector-identity">
                  <span className="widget-inspector-icon">{selectedWidget.title.slice(0, 1)}</span>
                  <span><small>{pluginDisplayName(selectedWidget)}</small><h3>{selectedPlacement.title ?? selectedWidget.title}</h3></span>
                  <i aria-hidden="true"><b /><b /><b /></i>
                </div>
                <p>{selectedPlacement.description ?? selectedWidget.description}</p>
              </div>
              <div className="widget-inspector-tabs">
                <button type="button" className="active">Settings</button><button type="button">Preview</button>
              </div>
              <div className="widget-inspector-section">
                <strong>Identity</strong>
                <label>Title<input value={selectedPlacement.title ?? selectedWidget.title} onChange={(event) => mutate({ type: "identity", id: selected, title: event.target.value, description: selectedPlacement.description ?? selectedWidget.description })} /></label>
                <label>Description<textarea value={selectedPlacement.description ?? selectedWidget.description} rows={2} onChange={(event) => mutate({ type: "identity", id: selected, title: selectedPlacement.title ?? selectedWidget.title, description: event.target.value })} /></label>
              </div>
              <div className="widget-inspector-section">
                <strong>Size and position</strong>
                <label>
                  Size
                  <span className="widget-size-fields">
                    <select
                      value={selectedPlacement.size.w >= 9 ? "large" : selectedPlacement.size.w >= 5 ? "medium" : "small"}
                      onChange={(event) => {
                        const size = event.target.value === "large"
                          ? { w: 12, h: 8 }
                          : event.target.value === "medium"
                            ? { w: 6, h: 5 }
                            : { w: 4, h: 3 };
                        mutate({ type: "resize", id: selected, size });
                      }}
                    >
                      <option value="small">Small</option>
                      <option value="medium">Medium</option>
                      <option value="large">Large</option>
                    </select>
                    <input type="number" min={1} max={12} value={selectedPlacement.size.w} aria-label="Widget width" onChange={(event) => mutate({ type: "resize", id: selected, size: { ...selectedPlacement.size, w: Number(event.target.value) } })} />
                    <span>×</span>
                    <input type="number" min={1} max={12} value={selectedPlacement.size.h} aria-label="Widget height" onChange={(event) => mutate({ type: "resize", id: selected, size: { ...selectedPlacement.size, h: Number(event.target.value) } })} />
                  </span>
                </label>
                <label>
                  Zone
                  <select value={widgetZoneOf(layout, selected) ?? selectedWidget.zone ?? "main"} onChange={(event) => mutate({ type: "move", id: selected, zone: event.target.value as WidgetZone })}>
                    {WIDGET_ZONES.map((zone) => <option key={zone} value={zone} disabled={!supportedWidgetZones(selectedWidget).includes(zone)}>{ZONE_LABEL[zone]}</option>)}
                  </select>
                </label>
              </div>
              <label>
                Visible
                <Toggle on={selectedPlacement.visible} label={`Visibility for ${selectedWidget.title}`} onChange={(visible) => mutate({ type: "visibility", id: selected, visible })} />
              </label>
              <fieldset className="widget-show-in">
                <legend>Show in <small>Presentation modes</small></legend>
                {(Object.keys(AUDIENCE_COPY) as WidgetAudience[]).map((audience) => (
                  <label key={audience}>
                    <input
                      type="checkbox"
                      checked={(selectedPlacement.showIn ?? []).includes(audience)}
                      onChange={(event) => {
                        const current = selectedPlacement.showIn ?? [];
                        mutate({
                          type: "show-in",
                          id: selected,
                          showIn: event.target.checked
                            ? [...current, audience]
                            : current.filter((item) => item !== audience),
                        });
                      }}
                    />
                    {AUDIENCE_COPY[audience].label}
                  </label>
                ))}
              </fieldset>
              <label>
                Where it appears
                <select value={selectedPlacement.scope ?? selectedWidget.scope ?? "workspace"} onChange={(event) => mutate({ type: "scope", id: selected, scope: event.target.value as WidgetScope })}>
                  <option value="global">Global</option>
                  <option value="workspace">Workspace</option>
                  <option value="plugin">Plugin</option>
                </select>
              </label>
              {selectedWidget.settingsRender?.({ projectId, sessionId, widgetId: selected, editing: true })}
              <div className="widget-inspector-actions">
                <button type="button" onClick={resetSelected}>Reset widget</button>
                {selectedWidget.duplicatable && <button type="button" onClick={() => mutate({ type: "duplicate", id: selected })}>Duplicate</button>}
                <button type="button" className="danger-btn" onClick={() => mutate({ type: "visibility", id: selected, visible: false })}>Remove</button>
              </div>
            </>
          ) : (
            <div className="widget-inspector-empty"><span>◇</span><strong>Select a widget</strong><p>Choose a widget in the preview to configure its title, size, visibility, and placement.</p></div>
          )}
        </aside>
      </div>

      <footer className="widget-preview-changes">
        <div>
          <strong>{changed ? "Preview changes" : "Layout is up to date"}</strong>
          <span>{changed ? <>Current → New · {summary.join(" · ") || "customized"}</> : "Make a change to compare it with the current layout."}</span>
        </div>
        <button type="button" disabled={!changed} onClick={() => setMessage("Keep editing — your draft is saved automatically.")}>Keep editing</button>
        <button type="button" disabled={!changed} onClick={() => updateWidgetLayout(parseWidgetLayout(baseline, widgets))}>Reset to current</button>
        <button type="button" className="btn-accent" disabled={!changed} onClick={() => {
          setBaseline(serializeWidgetLayout(layout));
          setMessage("Workspace layout applied.");
        }}>Apply</button>
      </footer>
    </>
  );
}
