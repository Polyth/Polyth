import { useMemo, useState, type DragEvent } from "react";
import { setDragWidget } from "../../dnd.ts";
import type { WidgetDef } from "../../widgets/catalog.ts";
import { filterWidgetLibrary, noteWidgetUsed, readRecentWidgets, type WidgetLibraryTab } from "../../widgets/widgetLibrary.ts";
import { useWidgetLayout } from "../../widgets/widgetLayout.ts";
import { Button, PlusIcon, Tabs, TextInput } from "../ui/index.ts";

/** The library deliberately owns discovery only. Placement stays in the shared
 * layout mutation pipeline supplied by its editor. */
export default function WidgetLibraryPanel({
  widgets,
  onAdd,
}: {
  widgets: WidgetDef[];
  onAdd: (widget: WidgetDef) => void;
}) {
  const layout = useWidgetLayout();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "widget" | "mini-widget">("all");
  const [tab, setTab] = useState<WidgetLibraryTab>("all");
  const [recent, setRecent] = useState(readRecentWidgets);
  const shown = useMemo(() => filterWidgetLibrary(widgets, {
    query, pluginId: "all", size: "all", zone: "all", category: "all", tab, recentlyUsed: recent,
  }, layout.audience).filter((widget) => kind === "all" || widget.kind === kind), [widgets, query, kind, tab, recent, layout.audience]);
  const add = (widget: WidgetDef) => { setRecent(noteWidgetUsed(widget.id)); onAdd(widget); };
  const drag = (widget: WidgetDef, event: DragEvent<HTMLElement>) => {
    setDragWidget(event.dataTransfer, widget.id);
    event.dataTransfer.effectAllowed = "copyMove";
  };
  return <aside className="workspace-library" aria-label="Widget library">
    <header><strong>Library</strong></header>
    <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search widgets…" aria-label="Search widgets" />
    <div className="workspace-library-kinds" role="group" aria-label="Widget type">
      {(["all", "widget", "mini-widget"] as const).map((value) => <Button key={value} type="button" size="sm" variant={kind === value ? "primary" : "ghost"} onClick={() => setKind(value)}>{value === "all" ? "All" : value === "widget" ? "Widgets" : "Controls"}</Button>)}
    </div>
    <Tabs label="Widget collections" tabs={[{ id: "all", label: "All" }, { id: "recommended", label: "Recommended" }, { id: "recent", label: "Recent" }]} value={tab} onChange={(id) => setTab(id as WidgetLibraryTab)} />
    <div className="workspace-library-results">
      {shown.map((widget) => <article key={widget.id} className="workspace-library-item" draggable onDragStart={(event) => drag(widget, event)}>
        <div><strong>{widget.title}</strong><small>{widget.pluginName ?? widget.pluginId}{widget.kind === "mini-widget" ? " · Control" : ""}</small></div>
        <Button type="button" size="sm" variant="ghost" iconStart={PlusIcon} aria-label={`Add ${widget.title}`} onClick={() => add(widget)} />
      </article>)}
      {shown.length === 0 && <p className="workspace-library-empty">No matching widgets.</p>}
    </div>
  </aside>;
}
