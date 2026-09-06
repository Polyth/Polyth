import { useMemo, useState, type DragEvent } from "react";
import type { UiSlot } from "@polyth/contracts";
import { setDragWidget } from "../../dnd.ts";
import { useStore } from "../../store.ts";
import type { WidgetDef } from "../../widgets/catalog.ts";
import {
  filterWidgetLibrary,
  mergeRecommendedWidgetIds,
  noteWidgetUsed,
  readRecentWidgets,
  RECOMMENDED_WIDGET_IDS,
  type WidgetLibraryTab,
} from "../../widgets/widgetLibrary.ts";
import { useWidgetLayout } from "../../widgets/widgetLayout.ts";
import { useProjectContextRecommendedWidgetIds } from "../../packages/projectContext.ts";
import { Button, PlusIcon, Select, Tabs, TextInput } from "../ui/index.ts";
import WidgetGlyph from "../WidgetGlyph.tsx";

/** Discovery is separate from placement: cards go to canvas; buttons go to a
 * real shell surface selected by the user. */
export default function WidgetLibraryPanel({
  widgets,
  onAdd,
}: {
  widgets: WidgetDef[];
  onAdd: (widget: WidgetDef, target?: UiSlot) => void;
}) {
  const layout = useWidgetLayout();
  const projectId = useStore((s) => s.activeProjectId);
  const contextRecommended = useProjectContextRecommendedWidgetIds(projectId);
  const recommendedIds = useMemo(
    () => mergeRecommendedWidgetIds(RECOMMENDED_WIDGET_IDS, contextRecommended),
    [contextRecommended],
  );
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"widget" | "mini-widget">("widget");
  const [buttonSurface, setButtonSurface] = useState<UiSlot>("app.header.center");
  const [tab, setTab] = useState<WidgetLibraryTab>("all");
  const [recent, setRecent] = useState(readRecentWidgets);
  const shown = useMemo(() => filterWidgetLibrary(widgets, {
    query, pluginId: "all", size: "all", zone: "all", category: "all", tab, recentlyUsed: recent,
    recommendedIds,
  }, layout.audience).filter((widget) => (widget.kind ?? "widget") === kind), [widgets, query, kind, tab, recent, layout.audience, recommendedIds]);
  const add = (widget: WidgetDef) => {
    setRecent(noteWidgetUsed(widget.id));
    onAdd(widget, kind === "mini-widget" ? buttonSurface : undefined);
  };
  const drag = (widget: WidgetDef, event: DragEvent<HTMLElement>) => {
    setDragWidget(event.dataTransfer, widget.id);
    event.dataTransfer.effectAllowed = "copyMove";
  };
  return <aside className="workspace-library" aria-label="Widget library">
    <header><strong>Library</strong></header>
    <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search widgets…" aria-label="Search widgets" />
    <div className="workspace-library-kinds" role="group" aria-label="What to add">
      {(["widget", "mini-widget"] as const).map((value) => <Button key={value} type="button" size="sm" variant={kind === value ? "primary" : "ghost"} onClick={() => setKind(value)}>{value === "widget" ? "Widgets" : "Buttons"}</Button>)}
    </div>
    {kind === "mini-widget" && <label className="workspace-button-surface">Add buttons to<Select label="Add buttons to" value={buttonSurface} onChange={(value) => setButtonSurface(value as UiSlot)} options={[
      { value: "app.header.center", label: "Top toolbar" }, { value: "workspace.rail", label: "Right rail" },
      { value: "composer.leading", label: "Composer, left" }, { value: "composer.trailing", label: "Composer, right" },
      { value: "session.footer", label: "Above composer" },
    ]} /></label>}
    <Tabs label="Widget collections" tabs={[{ id: "all", label: "All" }, { id: "recommended", label: "Recommended" }, { id: "recent", label: "Recent" }]} value={tab} onChange={(id) => setTab(id as WidgetLibraryTab)} />
    <div className="workspace-library-results">
      {shown.map((widget) => <article key={widget.id} className="workspace-library-item" draggable onDragStart={(event) => drag(widget, event)}>
        <WidgetGlyph widget={widget} />
        <div><strong>{widget.title}</strong><small>{widget.pluginName ?? widget.pluginId}</small></div>
        <Button type="button" size="sm" variant="ghost" iconStart={PlusIcon} aria-label={`Add ${widget.title}`} onClick={() => add(widget)} />
      </article>)}
      {shown.length === 0 && <p className="workspace-library-empty">No matching {kind === "widget" ? "widgets" : "buttons"}.</p>}
    </div>
  </aside>;
}
