import { useMemo, useState, type DragEvent } from "react";
import { getDragWidget, setDragWidget, WIDGET_MIME } from "../../dnd.ts";
import { useEscape } from "../../useEscape.ts";
import type { WidgetDef } from "../../widgets/catalog.ts";
import {
  canPlaceWidget,
  applyWidgetLayoutMutations,
  updateWidgetLayout,
  useWidgetLayout,
  widgetZoneOf,
  type WidgetZone,
} from "../../widgets/widgetLayout.ts";
import {
  filterWidgetLibrary,
  groupWidgetsByPlugin,
  noteWidgetUsed,
  pluginDisplayName,
  readRecentWidgets,
  supportedWidgetZones,
  widgetPluginOptions,
  widgetSizeLabel,
  type WidgetLibraryTab,
  type WidgetSizeFilter,
} from "../../widgets/widgetLibrary.ts";

const ZONE_LABEL: Record<WidgetZone, string> = {
  header: "Header",
  left: "Left side",
  main: "Main workspace",
  right: "Right side",
  bottom: "Bottom strip",
  floating: "Floating",
};

function WidgetGlyph({ widget }: { widget: WidgetDef }) {
  const glyph = widget.id === "core.composer"
    ? "✦"
    : widget.id.includes("quick")
      ? "⌘"
      : widget.id.includes("knowledge")
        ? "◇"
        : widget.id.includes("git")
          ? "⑂"
          : widget.title.slice(0, 1).toUpperCase();
  return <span className="widget-library-glyph" aria-hidden="true">{glyph}</span>;
}

function WidgetLibraryCard({
  widget,
  visible,
  onDrag,
  onAdd,
}: {
  widget: WidgetDef;
  visible: boolean;
  onDrag: (widget: WidgetDef, event: DragEvent<HTMLElement>) => void;
  onAdd: (widget: WidgetDef) => void;
}) {
  const zones = supportedWidgetZones(widget);
  return (
    <article
      className={`widget-library-card${visible ? " on-canvas" : ""}`}
      draggable
      onDragStart={(event) => onDrag(widget, event)}
      onDragEnd={(event) => onDrag(widget, event)}
    >
      <WidgetGlyph widget={widget} />
      <div className="widget-library-card-copy">
        <div className="widget-library-card-title">
          <strong>{widget.title}</strong>
          <button type="button" aria-label={`More about ${widget.title}`} title={`${pluginDisplayName(widget)} widget`}>•••</button>
        </div>
        <p>{widget.description}</p>
        <div className="widget-library-meta">
          <span>Size <b>{widgetSizeLabel(widget)[0]!.toUpperCase()}</b></span>
          <span>Zones <b>{zones.map((zone) => ZONE_LABEL[zone]).join(", ")}</b></span>
        </div>
      </div>
      <button
        type="button"
        className="widget-library-add"
        disabled={visible}
        onClick={() => onAdd(widget)}
        aria-label={visible ? `${widget.title} is on the canvas` : `Add ${widget.title}`}
      >
        {visible ? "Added" : <>Add <b aria-hidden="true">＋</b></>}
      </button>
    </article>
  );
}

export default function WidgetLibraryOverlay({
  widgets,
  onClose,
}: {
  widgets: WidgetDef[];
  onClose: () => void;
}) {
  const layout = useWidgetLayout();
  const [query, setQuery] = useState("");
  const [pluginId, setPluginId] = useState("all");
  const [size, setSize] = useState<WidgetSizeFilter>("all");
  const [zone, setZone] = useState<WidgetZone | "all">("all");
  const [tab, setTab] = useState<WidgetLibraryTab>("recommended");
  const [recent, setRecent] = useState(readRecentWidgets);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [overZone, setOverZone] = useState<WidgetZone | null>(null);
  const [status, setStatus] = useState("");
  useEscape(true, onClose);

  const plugins = useMemo(
    () => widgetPluginOptions(widgets),
    [widgets],
  );
  const filtered = useMemo(() => filterWidgetLibrary(widgets, {
    query, pluginId, size, zone, category: "all", tab, recentlyUsed: recent,
  }, layout.audience), [widgets, query, pluginId, size, zone, tab, recent, layout.audience]);
  const groups = useMemo(() => groupWidgetsByPlugin(filtered), [filtered]);
  const dragged = draggedId ? widgets.find((widget) => widget.id === draggedId) : undefined;

  const add = (widget: WidgetDef, target = widget.zone ?? "main") => {
    const check = canPlaceWidget(widget, target);
    if (!check.ok) {
      setStatus(check.reason ?? "That zone is not compatible.");
      return;
    }
    updateWidgetLayout((current) => applyWidgetLayoutMutations(current, [
      { type: "visibility", id: widget.id, visible: true },
      { type: "move", id: widget.id, zone: target },
    ], widgets));
    setRecent(noteWidgetUsed(widget.id));
    setStatus(`${widget.title} added to ${ZONE_LABEL[target]}.`);
  };

  const startDrag = (widget: WidgetDef, event: DragEvent<HTMLElement>) => {
    if (event.type === "dragend") {
      setDraggedId(null);
      setOverZone(null);
      return;
    }
    setDragWidget(event.dataTransfer, widget.id);
    event.dataTransfer.effectAllowed = "copyMove";
    setDraggedId(widget.id);
    setStatus(`You’re dragging: ${widget.title}`);
  };

  const drop = (target: WidgetZone, event: DragEvent<HTMLDivElement>) => {
    const id = getDragWidget(event.dataTransfer) ?? draggedId;
    const widget = widgets.find((item) => item.id === id);
    if (!widget) return;
    event.preventDefault();
    add(widget, target);
    setDraggedId(null);
    setOverZone(null);
  };

  const resetFilters = () => {
    setQuery("");
    setPluginId("all");
    setSize("all");
    setZone("all");
  };
  const hasFilters = query !== "" || pluginId !== "all" || size !== "all" || zone !== "all";

  return (
    <div className="widget-library-overlay" aria-label="Add widget">
      <section className="widget-library-browser">
        <header className="widget-library-heading">
          <div>
            <h2>Add widget</h2>
            <p>Browse and add widgets to your workspace. Drag to a zone or click Add.</p>
          </div>
          <span><kbd>Esc</kbd> close</span>
          <button type="button" onClick={onClose} aria-label="Close widget library">×</button>
        </header>

        <div className="widget-library-filters">
          <label className="widget-library-search">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search widgets…" aria-label="Search widgets" />
          </label>
          <select aria-label="Filter by plugin" value={pluginId} onChange={(event) => setPluginId(event.target.value)}>
            <option value="all">All plugins</option>
            {plugins.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
          <select aria-label="Filter by size" value={size} onChange={(event) => setSize(event.target.value as WidgetSizeFilter)}>
            <option value="all">All sizes</option>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
          <select aria-label="Filter by zone" value={zone} onChange={(event) => setZone(event.target.value as WidgetZone | "all")}>
            <option value="all">All zones</option>
            {Object.entries(ZONE_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <button type="button" className="widget-library-clear" disabled={!hasFilters} onClick={resetFilters}>Clear filters</button>
        </div>

        <div className="widget-library-tabs" role="tablist" aria-label="Widget collections">
          {([
            ["recommended", "Recommended"],
            ["plugin", "By plugin"],
            ["recent", "Recently used"],
          ] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        <div className="widget-library-results">
          {tab === "recommended" ? (
            <section>
              <div className="widget-library-section-head">
                <div><h3>Recommended for you</h3><p>Useful building blocks for your current workspace.</p></div>
                <span>{Math.min(filtered.length, 6)} widgets</span>
              </div>
              <div className="widget-library-card-grid">
                {filtered.slice(0, 6).map((widget) => (
                  <WidgetLibraryCard
                    key={widget.id}
                    widget={widget}
                    visible={layout.widgets[widget.id]?.visible === true}
                    onDrag={startDrag}
                    onAdd={add}
                  />
                ))}
              </div>
            </section>
          ) : (
            <section className="widget-library-plugin-groups">
              <div className="widget-library-section-head">
                <div><h3>{tab === "recent" ? "Recently used" : "Widgets by plugin"}</h3><p>Widgets come from your installed plugins.</p></div>
                <span>{filtered.length} widgets</span>
              </div>
              {[...groups.entries()].map(([name, items], index) => (
                <details key={name} open={index < 2 || tab === "recent"}>
                  <summary><span>{name}</span><b>{items.length}</b></summary>
                  <div className="widget-library-card-grid">
                    {items.map((widget) => (
                      <WidgetLibraryCard
                        key={widget.id}
                        widget={widget}
                        visible={layout.widgets[widget.id]?.visible === true}
                        onDrag={startDrag}
                        onAdd={add}
                      />
                    ))}
                  </div>
                </details>
              ))}
            </section>
          )}
          {filtered.length === 0 && (
            <div className="widget-library-empty">
              <strong>No matching widgets</strong>
              <span>Clear a filter or try a different search.</span>
              <button type="button" onClick={resetFilters}>Clear filters</button>
            </div>
          )}
        </div>

        <footer className="widget-library-footer">
          <span>Can’t find what you need? Install a plugin to add more widgets.</span>
          <button type="button" onClick={() => {
            onClose();
            window.dispatchEvent(new CustomEvent("polyth:settings-page", { detail: "plugins" }));
          }}>Browse plugins →</button>
        </footer>
      </section>

      <aside className="widget-library-preview" aria-label="Live workspace preview">
        <header>
          <div><strong>Live Workspace Preview</strong><span>Drop a widget into a compatible zone.</span></div>
          <span className="live-badge"><i /> Live</span>
        </header>
        <div className={`widget-preview-canvas${dragged ? " is-dragging" : ""}`}>
          {(["header", "left", "main", "right", "bottom", "floating"] as const).map((target) => {
            const check = dragged ? canPlaceWidget(dragged, target) : { ok: true };
            const itemIds = layout.zones[target].filter((id) => layout.widgets[id]?.visible);
            return (
              <div
                key={target}
                className={[
                  "widget-preview-zone",
                  `zone-${target}`,
                  dragged ? (check.ok ? "compatible" : "incompatible") : "",
                  overZone === target ? "over" : "",
                ].filter(Boolean).join(" ")}
                onDragEnter={() => setOverZone(target)}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverZone(null);
                }}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(WIDGET_MIME)) return;
                  if (check.ok) event.preventDefault();
                  event.dataTransfer.dropEffect = check.ok ? "move" : "none";
                }}
                onDrop={(event) => drop(target, event)}
                aria-label={`${ZONE_LABEL[target]} drop zone`}
              >
                <span>{ZONE_LABEL[target]}</span>
                <div>
                  {itemIds.slice(0, 3).map((id) => (
                    <i key={id} title={layout.widgets[id]?.title ?? id}>
                      {(layout.widgets[id]?.title ?? id).slice(0, 1)}
                    </i>
                  ))}
                  {itemIds.length > 3 && <small>+{itemIds.length - 3}</small>}
                </div>
                {dragged && check.ok && <b>＋ Drop here</b>}
                {dragged && !check.ok && <em>{check.reason}</em>}
              </div>
            );
          })}
        </div>
        <div className="widget-preview-status" aria-live="polite">
          {dragged ? <><WidgetGlyph widget={dragged} /><span><small>You’re dragging</small><strong>{dragged.title}</strong></span></> : <span>{status || "Drag a widget to preview where it can go."}</span>}
        </div>
        <div className="widget-preview-tips">
          <h3>Tips</h3>
          <ul>
            <li><b>↔</b><span><strong>Drag and drop</strong><small>Move widgets directly into highlighted zones.</small></span></li>
            <li><b>＋</b><span><strong>Quick add</strong><small>Add puts a widget in its preferred zone.</small></span></li>
            <li><b>⌕</b><span><strong>Filter by plugin</strong><small>Narrow the library by source, size, or zone.</small></span></li>
            <li><b>✓</b><span><strong>Zone compatibility</strong><small>Only zones where a widget fits become active.</small></span></li>
          </ul>
        </div>
        <footer><span>Changes save automatically</span><b>{layout.widgets[draggedId ?? ""] ? ZONE_LABEL[widgetZoneOf(layout, draggedId ?? "") ?? "main"] : ""}</b></footer>
      </aside>
    </div>
  );
}
