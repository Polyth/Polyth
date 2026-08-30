// Widget-areas (WA2): the Widget Library. Browse every widget, see how well
// each one fits the area you're placing into, and drop it into ANY area —
// nothing is off-limits. `supportedSlots` / per-area `recommends` only order
// and label the list.
import { useMemo, useState, type DragEvent } from "react";
import type { UiSlot } from "@polyth/contracts";
import { getDragWidget, setDragWidget, WIDGET_MIME } from "../../dnd.ts";
import { useEscape } from "../../useEscape.ts";
import type { WidgetDef } from "../../widgets/catalog.ts";
import {
  applyWidgetLayoutMutations,
  canPlaceWidget,
  updateWidgetLayout,
  useWidgetLayout,
  widgetSlotOf,
} from "../../widgets/widgetLayout.ts";
import { useAreas, type WidgetArea, type WidgetAreaGroup } from "../../widgets/areas.ts";
import {
  areaLabel,
  areaWidgetEntries,
  bucketWidgetsForArea,
  fitBadgeLabel,
  fitTone,
  widgetFitInArea,
} from "../../widgets/areaFit.ts";
import {
  filterWidgetLibrary,
  noteWidgetUsed,
  pluginDisplayName,
  readRecentWidgets,
  widgetPluginOptions,
  type WidgetLibraryTab,
} from "../../widgets/widgetLibrary.ts";
import { tr } from "../../i18n/index.ts";
import { Badge, Button, CloseIcon, IconButton, Notice, PlusIcon, Select, Tabs, TextInput } from "../ui/index.ts";

const GROUP_ORDER: WidgetAreaGroup[] = ["shell", "sidebar", "workspace", "session", "composer"];
const GROUP_LABEL: Record<WidgetAreaGroup, string> = {
  shell: tr("settings.widgetlibraryoverlay.groupShell"),
  sidebar: tr("settings.widgetlibraryoverlay.groupSidebar"),
  workspace: tr("settings.widgetlibraryoverlay.groupWorkspace"),
  session: tr("settings.widgetlibraryoverlay.groupSession"),
  composer: tr("settings.widgetlibraryoverlay.groupComposer"),
};

type KindFilter = "all" | "widget" | "mini-widget";

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

function areaOptions(areas: readonly WidgetArea[]) {
  return [...areas]
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.order - b.order)
    .map((area) => ({ value: area.id, label: area.label, group: GROUP_LABEL[area.group] }));
}

function WidgetLibraryCard({
  widget,
  areaId,
  placed,
  onDrag,
  onAdd,
}: {
  widget: WidgetDef;
  areaId: UiSlot;
  placed: boolean;
  onDrag: (widget: WidgetDef, event: DragEvent<HTMLElement>) => void;
  onAdd: (widget: WidgetDef) => void;
}) {
  const fit = widgetFitInArea(widget, areaId);
  return (
    <article
      className={`widget-library-card${placed ? " on-canvas" : ""}`}
      draggable
      onDragStart={(event) => onDrag(widget, event)}
      onDragEnd={(event) => onDrag(widget, event)}
    >
      <WidgetGlyph widget={widget} />
      <div className="widget-library-card-copy">
        <div className="widget-library-card-title">
          <strong>{widget.title}</strong>
          <Badge tone={fitTone(fit)} className="widget-fit-chip">{fitBadgeLabel(fit)}</Badge>
        </div>
        <p>{widget.description}</p>
        <div className="widget-library-meta">
          <span>{pluginDisplayName(widget)}</span>
          {widget.kind === "mini-widget" && <span>{tr("settings.widgetlibraryoverlay.controls")}</span>}
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant={placed ? "ghost" : "primary"}
        className="widget-library-add"
        iconStart={placed ? undefined : PlusIcon}
        disabled={placed}
        onClick={() => onAdd(widget)}
      >
        {placed ? tr("settings.widgetlibraryoverlay.added") : tr("common.add")}
      </Button>
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
  const areas = useAreas();
  const [query, setQuery] = useState("");
  const [pluginId, setPluginId] = useState("all");
  const [kind, setKind] = useState<KindFilter>("all");
  const [tab, setTab] = useState<WidgetLibraryTab>("all");
  const [recent, setRecent] = useState(readRecentWidgets);
  const [focusedArea, setFocusedArea] = useState<UiSlot>(
    () => (areas.find((area) => area.id === "workspace.main") ?? areas[0])?.id ?? "workspace.main",
  );
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [overArea, setOverArea] = useState<UiSlot | null>(null);
  const [status, setStatus] = useState("");
  useEscape(true, onClose);

  const plugins = useMemo(() => widgetPluginOptions(widgets), [widgets]);
  const filtered = useMemo(() => {
    const base = filterWidgetLibrary(widgets, {
      query, pluginId, size: "all", zone: "all", category: "all",
      tab, recentlyUsed: recent,
    }, layout.audience);
    return kind === "all" ? base : base.filter((widget) => (widget.kind ?? "widget") === kind);
  }, [widgets, query, pluginId, kind, tab, recent, layout.audience]);

  const entries = useMemo(
    () => areaWidgetEntries(filtered, focusedArea),
    [filtered, focusedArea],
  );
  const focused = areas.find((area) => area.id === focusedArea);
  const placedIds = new Set([
    ...(layout.slotPlacements[focusedArea] ?? []),
    ...Object.values(layout.zones).flat().filter((id) => widgetSlotOf(layout, id) === focusedArea),
  ].filter((id) => layout.widgets[id]?.visible));

  const dragged = draggedId ? widgets.find((widget) => widget.id === draggedId) : undefined;
  const buckets = useMemo(() => bucketWidgetsForArea(filtered, focusedArea), [filtered, focusedArea]);
  const recommendedUnplaced = buckets.recommended.filter((widget) => !placedIds.has(widget.id));

  const add = (widget: WidgetDef, target: UiSlot = focusedArea) => {
    const check = canPlaceWidget(widget, target);
    updateWidgetLayout((current) => applyWidgetLayoutMutations(current, [
      { type: "visibility", id: widget.id, visible: true },
      { type: "place", id: widget.id, slot: target },
    ], widgets));
    setRecent(noteWidgetUsed(widget.id));
    setStatus(check.note
      ? check.note
      : tr("settings.widgetlibraryoverlay.valueAddedToValue", {
          title: widget.title,
          slot: areaLabel(target),
        }));
  };

  const remove = (instanceId: string) => {
    updateWidgetLayout((current) => applyWidgetLayoutMutations(
      current, [{ type: "visibility", id: instanceId, visible: false }], widgets,
    ));
  };

  const startDrag = (widget: WidgetDef, event: DragEvent<HTMLElement>) => {
    if (event.type === "dragend") {
      setDraggedId(null);
      setOverArea(null);
      return;
    }
    setDragWidget(event.dataTransfer, widget.id);
    event.dataTransfer.effectAllowed = "copyMove";
    setDraggedId(widget.id);
    setStatus(tr("settings.widgetlibraryoverlay.youReDraggingValue", { title: widget.title }));
  };

  const drop = (target: UiSlot, event: DragEvent<HTMLElement>) => {
    const id = getDragWidget(event.dataTransfer) ?? draggedId;
    const widget = widgets.find((item) => item.id === id);
    if (!widget) return;
    event.preventDefault();
    add(widget, target);
    setDraggedId(null);
    setOverArea(null);
  };

  const resetFilters = () => {
    setQuery("");
    setPluginId("all");
    setKind("all");
    setTab("all");
  };
  const hasFilters = query !== "" || pluginId !== "all" || kind !== "all" || tab !== "all";

  const groupedAreas = GROUP_ORDER
    .map((group) => [group, areas.filter((area) => area.group === group)] as const)
    .filter(([, list]) => list.length > 0);

  return (
    <div className="widget-library-overlay" aria-label={tr("settings.widgetlibraryoverlay.addWidget")}>
      <section className="widget-library-browser">
        <header className="widget-library-heading">
          <div>
            <h2>{tr("settings.widgetlibraryoverlay.addWidget")}</h2>
            <p>{tr("settings.widgetlibraryoverlay.dropOntoAnyArea")}</p>
          </div>
          <span><kbd>{tr("settings.widgetlibraryoverlay.esc")}</kbd> {tr("settings.widgetlibraryoverlay.close")}</span>
          <IconButton icon={CloseIcon} size="sm" variant="ghost" label={tr("settings.widgetlibraryoverlay.closeWidgetLibrary")} onClick={onClose} />
        </header>

        <div className="widget-library-filters">
          <label className="widget-library-search">
            <span aria-hidden="true">⌕</span>
            <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("settings.widgetlibraryoverlay.searchWidgets")} aria-label={tr("settings.widgetlibraryoverlay.searchWidgets2")} />
          </label>
          <Select
            label={tr("settings.widgetlibraryoverlay.filterByPlugin")}
            value={pluginId}
            onChange={setPluginId}
            options={[{ value: "all", label: tr("settings.widgetlibraryoverlay.allPlugins") }, ...plugins.map(({ id, label }) => ({ value: id, label }))]}
          />
          <Select
            label={tr("settings.widgetlibraryoverlay.filterByType")}
            value={kind}
            onChange={(value) => setKind(value as KindFilter)}
            options={[
              { value: "all", label: tr("settings.widgetlibraryoverlay.allTypes") },
              { value: "widget", label: tr("settings.widgetlibraryoverlay.panels") },
              { value: "mini-widget", label: tr("settings.widgetlibraryoverlay.controls") },
            ]}
          />
          <Button type="button" size="sm" variant="ghost" className="widget-library-clear" disabled={!hasFilters} onClick={resetFilters}>{tr("settings.widgetlibraryoverlay.clearFilters")}</Button>
        </div>

        <Tabs
          className="widget-library-tabs"
          label={tr("settings.widgetlibraryoverlay.widgetCollections")}
          tabs={[
            { id: "all", label: tr("settings.widgetlibraryoverlay.tabAll") },
            { id: "recommended", label: tr("projectsetup.recommended") },
            { id: "recent", label: tr("settings.widgetlibraryoverlay.recentlyUsed") },
          ]}
          value={tab}
          onChange={(id) => setTab(id as WidgetLibraryTab)}
        />

        <div className="widget-library-results">
          <div className="widget-library-section-head">
            <div>
              <h3>{tr("settings.widgetlibraryoverlay.recommendedForValue", { value: focused?.label ?? areaLabel(focusedArea) })}</h3>
              <p>{focused?.description ?? ""}</p>
            </div>
            <span>{entries.length} {tr("settings.widgetlibraryoverlay.widgets")}</span>
          </div>
          <div className="widget-library-card-grid">
            {entries.map(({ widget }) => (
              <WidgetLibraryCard
                key={widget.id}
                widget={widget}
                areaId={focusedArea}
                placed={layout.widgets[widget.id]?.visible === true && widgetSlotOf(layout, widget.id) === focusedArea}
                onDrag={startDrag}
                onAdd={(item) => add(item)}
              />
            ))}
          </div>
          {entries.length === 0 && (
            <div className="widget-library-empty">
              <strong>{tr("settings.widgetlibraryoverlay.noMatchingWidgets")}</strong>
              <span>{tr("settings.widgetlibraryoverlay.clearAFilterOrTryADifferent")}</span>
              <Button type="button" size="sm" onClick={resetFilters}>{tr("settings.widgetlibraryoverlay.clearFilters")}</Button>
            </div>
          )}
        </div>

        <footer className="widget-library-footer">
          <span>{tr("settings.widgetlibraryoverlay.canTFindWhatYouNeedInstall")}</span>
          <Button type="button" size="sm" variant="ghost" className="widget-library-browse" onClick={() => {
            onClose();
            window.dispatchEvent(new CustomEvent("polyth:settings-page", { detail: "plugins" }));
          }}>{tr("settings.widgetlibraryoverlay.browsePlugins")}</Button>
        </footer>
      </section>

      <aside className="widget-library-preview" aria-label={tr("settings.widgetlibraryoverlay.liveWorkspacePreview")}>
        <header>
          <div><strong>{tr("settings.widgetlibraryoverlay.placingIn")}</strong></div>
        </header>
        <Select
          label={tr("settings.widgetlibraryoverlay.placingIn")}
          value={focusedArea}
          onChange={(value) => setFocusedArea(value as UiSlot)}
          options={areaOptions(areas)}
        />

        <div className="widget-inspector-now">
          <h3>{tr("settings.widgetlibraryoverlay.inThisAreaNow")}</h3>
          {[...placedIds].length === 0 && <p className="widget-inspector-empty">{tr("settings.widgetlibraryoverlay.nothingPlacedHere")}</p>}
          {[...placedIds].map((instanceId) => {
            const placement = layout.widgets[instanceId];
            return (
              <div key={instanceId} className="widget-inspector-row">
                <span>{placement?.title ?? instanceId}</span>
                <IconButton icon={CloseIcon} size="sm" variant="ghost" label={tr("common.remove")} onClick={() => remove(instanceId)} />
              </div>
            );
          })}
        </div>

        {recommendedUnplaced.length > 0 && (
          <div className="widget-inspector-recommend">
            <h3>{tr("projectsetup.recommended")}</h3>
            <div className="widget-inspector-chips">
              {recommendedUnplaced.map((widget) => (
                <Button key={widget.id} type="button" size="sm" variant="ghost" iconStart={PlusIcon} onClick={() => add(widget)}>
                  {widget.title}
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className={`widget-area-droplist${dragged ? " is-dragging" : ""}`}>
          <h3>{tr("settings.widgetlibraryoverlay.dropOntoAnyArea")}</h3>
          {groupedAreas.map(([group, list]) => (
            <section key={group}>
              <h4>{GROUP_LABEL[group]}</h4>
              {list.map((area) => {
                const fit = dragged ? widgetFitInArea(dragged, area.id) : null;
                return (
                  <div
                    key={area.id}
                    className={[
                      "widget-area-drop",
                      area.id === focusedArea ? "focused" : "",
                      overArea === area.id ? "over" : "",
                      fit === "unusual" ? "unusual" : "",
                    ].filter(Boolean).join(" ")}
                    onClick={() => setFocusedArea(area.id)}
                    onDragEnter={() => setOverArea(area.id)}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverArea(null);
                    }}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes(WIDGET_MIME)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(event) => drop(area.id, event)}
                  >
                    <span>{area.label}</span>
                    {fit && <Badge tone={fitTone(fit)}>{fitBadgeLabel(fit)}</Badge>}
                  </div>
                );
              })}
            </section>
          ))}
        </div>

        {status && (
          <Notice tone={dragged ? "info" : "success"} className="widget-inspector-status">{status}</Notice>
        )}
      </aside>
    </div>
  );
}
