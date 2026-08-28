import { useMemo, useState, type DragEvent } from "react";
import type { UiSlot } from "@polyth/contracts";
import { getDragWidget, setDragWidget, WIDGET_MIME } from "../../dnd.ts";
import { useEscape } from "../../useEscape.ts";
import type { WidgetDef } from "../../widgets/catalog.ts";
import {
  canPlaceWidget,
  applyWidgetLayoutMutations,
  updateWidgetLayout,
  useWidgetLayout,
  widgetSlotFromZone,
  widgetSlotOf,
  type WidgetZone,
} from "../../widgets/widgetLayout.ts";
import {
  filterWidgetLibrary,
  groupWidgetsByPlugin,
  noteWidgetUsed,
  pluginDisplayName,
  readRecentWidgets,
  supportedWidgetSlots,
  widgetPluginOptions,
  widgetSizeLabel,
  type WidgetLibraryTab,
  type WidgetSizeFilter,
} from "../../widgets/widgetLibrary.ts";
import { tr } from "../../i18n/index.ts";

const ZONE_LABEL: Record<WidgetZone, string> = {
  header: tr("settings.widgetlibraryoverlay.header"),
  left: tr("settings.widgetlibraryoverlay.leftSide"),
  main: tr("settings.widgetlibraryoverlay.mainWorkspace"),
  right: tr("settings.widgetlibraryoverlay.rightSide"),
  bottom: tr("settings.widgetlibraryoverlay.bottomStrip"),
  floating: tr("settings.widgetlibraryoverlay.floating"),
};

const slotLabel = (slot: UiSlot): string => {
  const zone = slot.startsWith(tr("settings.widgetlibraryoverlay.workspace")) ? slot.slice(tr("settings.widgetlibraryoverlay.workspace").length) as WidgetZone : null;
  return zone && zone in ZONE_LABEL
    ? ZONE_LABEL[zone]
    : slot.split(".").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" · ");
};

const defaultSlot = (widget: WidgetDef): UiSlot =>
  widget.defaultSlot ?? widgetSlotFromZone(widget.zone ?? "main");

function WidgetGlyph({ widget }: { widget: WidgetDef }) {
  const glyph = widget.id === "core.chat"
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
  const slots = supportedWidgetSlots(widget);
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
          <button type="button" aria-label={tr("settings.widgetlibraryoverlay.moreAboutValue", { title: widget.title })} title={tr("settings.widgetlibraryoverlay.valueWidget", { value: pluginDisplayName(widget) })}>•••</button>
        </div>
        <p>{widget.description}</p>
        <div className="widget-library-meta">
          <span>{tr("settings.widgetlibraryoverlay.size")}{" "}<b>{widgetSizeLabel(widget)[0]!.toUpperCase()}</b></span>
          <span>{tr("settings.widgetlibraryoverlay.placements")}{" "}<b>{slots.map(slotLabel).join(", ")}</b></span>
        </div>
      </div>
      <button
        type="button"
        className="widget-library-add"
        disabled={visible}
        onClick={() => onAdd(widget)}
        aria-label={visible ? tr("settings.widgetlibraryoverlay.valueIsOnTheCanvas", { title: widget.title }) : tr("settings.widgetlibraryoverlay.addValue", { title: widget.title })}
      >
        {visible ? tr("settings.widgetlibraryoverlay.added") : <>{tr("common.add")}{" "}<b aria-hidden="true">＋</b></>}
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

  const add = (widget: WidgetDef, target: UiSlot = defaultSlot(widget)) => {
    const check = canPlaceWidget(widget, target);
    if (!check.ok) {
      setStatus(check.reason ?? tr("settings.widgetlibraryoverlay.zoneNotCompatible"));
      return;
    }
    updateWidgetLayout((current) => applyWidgetLayoutMutations(current, [
      { type: "visibility", id: widget.id, visible: true },
      { type: "place", id: widget.id, slot: target },
    ], widgets));
    setRecent(noteWidgetUsed(widget.id));
    setStatus(tr("settings.widgetlibraryoverlay.valueAddedToValue", {
      title: widget.title,
      slot: slotLabel(target),
    }));
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
    setStatus(tr("settings.widgetlibraryoverlay.youReDraggingValue", { title: widget.title }));
  };

  const drop = (target: WidgetZone, event: DragEvent<HTMLDivElement>) => {
    const id = getDragWidget(event.dataTransfer) ?? draggedId;
    const widget = widgets.find((item) => item.id === id);
    if (!widget) return;
    event.preventDefault();
    add(widget, widgetSlotFromZone(target));
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
    <div className="widget-library-overlay" aria-label={tr("settings.widgetlibraryoverlay.addWidget")}>
      <section className="widget-library-browser">
        <header className="widget-library-heading">
          <div>
            <h2>{tr("settings.widgetlibraryoverlay.addWidget")}</h2>
            <p>{tr("settings.widgetlibraryoverlay.browseAndAddWidgetsToYourWorkspace")}</p>
          </div>
          <span><kbd>{tr("settings.widgetlibraryoverlay.esc")}</kbd> {tr("settings.widgetlibraryoverlay.close")}</span>
          <button type="button" onClick={onClose} aria-label={tr("settings.widgetlibraryoverlay.closeWidgetLibrary")}>{tr("settings.widgetlibraryoverlay.message")}</button>
        </header>

        <div className="widget-library-filters">
          <label className="widget-library-search">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("settings.widgetlibraryoverlay.searchWidgets")} aria-label={tr("settings.widgetlibraryoverlay.searchWidgets2")} />
          </label>
          <select aria-label={tr("settings.widgetlibraryoverlay.filterByPlugin")} value={pluginId} onChange={(event) => setPluginId(event.target.value)}>
            <option value="all">{tr("settings.widgetlibraryoverlay.allPlugins")}</option>
            {plugins.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
          <select aria-label={tr("settings.widgetlibraryoverlay.filterBySize")} value={size} onChange={(event) => setSize(event.target.value as WidgetSizeFilter)}>
            <option value="all">{tr("settings.widgetlibraryoverlay.allSizes")}</option>
            <option value="small">{tr("settings.widgetlibraryoverlay.small")}</option>
            <option value="medium">{tr("settings.widgetlibraryoverlay.medium")}</option>
            <option value="large">{tr("settings.widgetlibraryoverlay.large")}</option>
          </select>
          <select aria-label={tr("settings.widgetlibraryoverlay.filterByZone")} value={zone} onChange={(event) => setZone(event.target.value as WidgetZone | "all")}>
            <option value="all">{tr("settings.widgetlibraryoverlay.allZones")}</option>
            {Object.entries(ZONE_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <button type="button" className="widget-library-clear" disabled={!hasFilters} onClick={resetFilters}>{tr("settings.widgetlibraryoverlay.clearFilters")}</button>
        </div>

        <div className="widget-library-tabs ui-scroll-tabs" role="tablist" aria-label={tr("settings.widgetlibraryoverlay.widgetCollections")}>
          {([
            ["recommended", tr("projectsetup.recommended")],
            ["plugin", tr("settings.widgetlibraryoverlay.byPlugin")],
            ["recent", tr("settings.widgetlibraryoverlay.recentlyUsed")],
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
                <div><h3>{tr("settings.widgetlibraryoverlay.recommendedForYou")}</h3><p>{tr("settings.widgetlibraryoverlay.usefulBuildingBlocksForYourCurrentWorkspace")}</p></div>
                <span>{Math.min(filtered.length, 6)} {tr("settings.widgetlibraryoverlay.widgets")}</span>
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
                <div><h3>{tab === "recent" ? tr("settings.widgetlibraryoverlay.recentlyUsed") : tr("settings.widgetlibraryoverlay.widgetsByPlugin")}</h3><p>{tr("settings.widgetlibraryoverlay.widgetsComeFromYourInstalledPlugins")}</p></div>
                <span>{filtered.length} {tr("settings.widgetlibraryoverlay.widgets")}</span>
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
              <strong>{tr("settings.widgetlibraryoverlay.noMatchingWidgets")}</strong>
              <span>{tr("settings.widgetlibraryoverlay.clearAFilterOrTryADifferent")}</span>
              <button type="button" onClick={resetFilters}>{tr("settings.widgetlibraryoverlay.clearFilters")}</button>
            </div>
          )}
        </div>

        <footer className="widget-library-footer">
          <span>{tr("settings.widgetlibraryoverlay.canTFindWhatYouNeedInstall")}</span>
          <button type="button" onClick={() => {
            onClose();
            window.dispatchEvent(new CustomEvent("polyth:settings-page", { detail: "plugins" }));
          }}>{tr("settings.widgetlibraryoverlay.browsePlugins")}</button>
        </footer>
      </section>

      <aside className="widget-library-preview" aria-label={tr("settings.widgetlibraryoverlay.liveWorkspacePreview")}>
        <header>
          <div><strong>{tr("settings.widgetlibraryoverlay.liveWorkspacePreview2")}</strong><span>{tr("settings.widgetlibraryoverlay.dropAWidgetIntoACompatibleZone")}</span></div>
          <span className="live-badge"><i /> {tr("settings.widgetlibraryoverlay.live")}</span>
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
                aria-label={tr("settings.widgetlibraryoverlay.valueDropZone", { value: ZONE_LABEL[target] })}
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
                {dragged && check.ok && <b>{tr("settings.widgetlibraryoverlay.dropHere")}</b>}
                {dragged && !check.ok && <em>{check.reason}</em>}
              </div>
            );
          })}
        </div>
        <div className="widget-preview-status" aria-live="polite">
          {dragged
            ? <><WidgetGlyph widget={dragged} /><span><small>{tr("settings.widgetlibraryoverlay.youReDragging")}</small><strong>{dragged.title}</strong></span></>
            : <span>{status || tr("settings.widgetlibraryoverlay.dragWidgetToPreview")}</span>}
        </div>
        <div className="widget-preview-tips">
          <h3>{tr("settings.widgetlibraryoverlay.tips")}</h3>
          <ul>
            <li><b>↔</b><span><strong>{tr("settings.widgetlibraryoverlay.dragAndDrop")}</strong><small>{tr("settings.widgetlibraryoverlay.moveWidgetsDirectlyIntoHighlightedZones")}</small></span></li>
            <li><b>＋</b><span><strong>{tr("settings.widgetlibraryoverlay.quickAdd")}</strong><small>{tr("settings.widgetlibraryoverlay.addPutsAWidgetInItsPreferred")}</small></span></li>
            <li><b>⌕</b><span><strong>{tr("settings.widgetlibraryoverlay.filterByPlugin")}</strong><small>{tr("settings.widgetlibraryoverlay.narrowTheLibraryBySourceSizeOr")}</small></span></li>
            <li><b>✓</b><span><strong>{tr("settings.widgetlibraryoverlay.zoneCompatibility")}</strong><small>{tr("settings.widgetlibraryoverlay.onlyZonesWhereAWidgetFitsBecome")}</small></span></li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
