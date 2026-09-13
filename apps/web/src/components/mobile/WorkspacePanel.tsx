import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
} from "react";
import { useResolvedCapabilities } from "../../capabilities.ts";
import { getCapabilityPlacements } from "../../capabilityLayout.ts";
import { railIconFor, widgetIconFor } from "../../railIcons.ts";
import { useStore } from "../../store.ts";
import { getWidget, useWidgetCatalog } from "../../widgets/catalog.ts";
import {
  setWidgetConfig,
  updateWidgetLayout,
  useWidgetLayout,
  widgetDefinitionId,
} from "../../widgets/widgetLayout.ts";
import {
  addPanelItem,
  createWorkspacePanelLayout,
  movePanelItem,
  panelItemCatalog,
  parseWorkspacePanelLayout,
  removePanelItem,
  updatePanelItem,
  workspacePanelStorageKey,
  type PanelItemDefinition,
  type PanelItemInstance,
  type WorkspacePanelLayout,
} from "../../workspacePanel.ts";
import MoveControls from "../MoveControls.tsx";
import ViewErrorBoundary from "../ViewErrorBoundary.ts";
import { ChevronRightIcon, IconButton, MinusIcon, PlusIcon } from "../ui/index.ts";
import Sheet from "./Sheet.tsx";

function storedLayout(projectId: string | null, catalog: readonly PanelItemDefinition[], migrated: readonly string[]): WorkspacePanelLayout {
  if (!projectId) return createWorkspacePanelLayout(catalog, migrated);
  try { return parseWorkspacePanelLayout(localStorage.getItem(workspacePanelStorageKey(projectId)), catalog, migrated); }
  catch { return createWorkspacePanelLayout(catalog, migrated); }
}

function persist(projectId: string | null, layout: WorkspacePanelLayout): void {
  if (!projectId) return;
  try { localStorage.setItem(workspacePanelStorageKey(projectId), JSON.stringify(layout)); } catch { /* private/full */ }
}

function LayoutItem({ item, editing, onLabel }: { item: PanelItemInstance; editing: boolean; onLabel: (label: string) => void }) {
  const label = typeof item.config.label === "string" ? item.config.label : item.type === "header" ? "Heading" : "Section";
  if (item.type === "divider") return <div className="workspace-panel-divider" role="separator" />;
  if (item.type === "header") return editing
    ? <input className="workspace-panel-label-input" aria-label="Header text" value={label} onChange={(event) => onLabel(event.target.value)} />
    : <h3 className="workspace-panel-heading">{label}</h3>;
  return <div className="workspace-panel-labeled-divider" role="separator">
    <i />
    {editing
      ? <input className="workspace-panel-label-input" aria-label="Divider label" value={label} onChange={(event) => onLabel(event.target.value)} />
      : <span>{label}</span>}
    <i />
  </div>;
}

export default function WorkspacePanel({ onClose }: { onClose: () => void }) {
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const capabilities = useResolvedCapabilities();
  const widgets = useWidgetCatalog();
  const widgetLayout = useWidgetLayout();
  const catalog = useMemo(() => panelItemCatalog(capabilities, widgets), [capabilities, widgets]);
  const definitions = useMemo(() => new Map(catalog.map((item) => [item.id, item])), [catalog]);
  const migrated = useMemo(() => {
    const placements = getCapabilityPlacements();
    if (Object.keys(placements).length === 0) return [];
    return capabilities.filter(({ descriptor, tier }) => descriptor.id !== "session" && tier !== "technical").map(({ descriptor }) => descriptor.id);
  }, [capabilities]);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState(() => storedLayout(projectId, catalog, migrated));
  const [dragging, setDragging] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchDrag = useRef<{ id: string; pointerId: number } | null>(null);
  const touchPending = useRef<{ x: number; y: number; pointerId: number } | null>(null);

  useEffect(() => setLayout(storedLayout(projectId, catalog, migrated)), [projectId]);
  useEffect(() => () => { if (touchTimer.current) clearTimeout(touchTimer.current); }, []);

  const commit = (next: WorkspacePanelLayout, message?: string) => {
    setLayout(next);
    persist(projectId, next);
    if (message) setAnnouncement(message);
  };
  const open = (definition: PanelItemDefinition) => {
    if (editing || !definition.capabilityId) return;
    const capability = capabilities.find(({ descriptor }) => descriptor.id === definition.capabilityId)?.descriptor;
    if (!capability) return;
    onClose();
    capability.open();
  };
  const reorder = (id: string, index: number) => {
    const next = movePanelItem(layout, id, index);
    if (next !== layout) commit(next, `Moved item to position ${index + 1}`);
  };
  const onDragStart = (event: DragEvent<HTMLElement>, id: string) => {
    setDragging(id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-polyth-panel-item", id);
  };
  const onDrop = (event: DragEvent<HTMLElement>, index: number) => {
    const id = event.dataTransfer.getData("application/x-polyth-panel-item") || dragging;
    if (!id) return;
    event.preventDefault();
    reorder(id, index);
    setDragging(null);
  };
  const onTouchDown = (event: PointerEvent<HTMLElement>, id: string) => {
    if (!editing || event.pointerType !== "touch" || (event.target as Element).closest("button,input,select")) return;
    const target = event.currentTarget;
    touchPending.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    touchTimer.current = setTimeout(() => {
      touchPending.current = null;
      touchDrag.current = { id, pointerId: event.pointerId };
      target.setPointerCapture(event.pointerId);
      setDragging(id);
    }, 320);
  };
  const onTouchMove = (event: PointerEvent<HTMLElement>) => {
    const pending = touchPending.current;
    if (pending?.pointerId === event.pointerId && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 8) {
      if (touchTimer.current) clearTimeout(touchTimer.current);
      touchTimer.current = null;
      touchPending.current = null;
    }
    const active = touchDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-panel-instance]");
    if (target?.dataset.panelInstance && target.dataset.panelInstance !== active.id) {
      const index = layout.items.findIndex((item) => item.id === target.dataset.panelInstance);
      if (index >= 0) reorder(active.id, index);
    }
    const scroller = event.currentTarget.closest<HTMLElement>(".sheet-body");
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      if (event.clientY < rect.top + 44) scroller.scrollBy({ top: -24 });
      else if (event.clientY > rect.bottom - 44) scroller.scrollBy({ top: 24 });
    }
  };
  const endTouch = (event: PointerEvent<HTMLElement>) => {
    if (touchTimer.current) clearTimeout(touchTimer.current);
    touchTimer.current = null;
    touchPending.current = null;
    if (touchDrag.current?.pointerId === event.pointerId) {
      touchDrag.current = null;
      setDragging(null);
    }
  };
  const shown = catalog.filter((item) => `${item.title} ${item.description} ${item.sourcePackage}`.toLowerCase().includes(query.trim().toLowerCase()));

  return <Sheet
    title="Workspace"
    size="tall"
    className="mobile-tools-sheet workspace-panel-sheet"
    onClose={onClose}
    dismiss="back"
    action={{ label: editing ? "Done" : "Edit", pressed: editing, onClick: () => setEditing((value) => !value) }}
  >
    <p className="workspace-panel-subtitle">Tools &amp; widgets</p>
    <div className="workspace-panel-items" aria-label="Configured workspace" aria-roledescription={editing ? "Editable workspace" : undefined}>
      {layout.items.map((item, index) => {
        const definition = definitions.get(item.definitionId);
        if (!definition) return null;
        const widget = definition.widgetId ? getWidget(definition.widgetId) : undefined;
        const placement = definition.widgetId
          ? widgetLayout.widgets[Object.keys(widgetLayout.widgets).find((id) => widgetDefinitionId(widgetLayout, id) === definition.widgetId) ?? definition.widgetId]
          : undefined;
        const Icon = definition.type === "launcher" ? railIconFor(definition.capabilityId ?? definition.sourcePackage) : widget ? widgetIconFor(widget) : null;
        const config = placement?.config ?? item.config;
        const updateConfig = (next: typeof item.config) => {
          if (widget && placement) {
            const instanceId = Object.keys(widgetLayout.widgets).find((id) => widgetDefinitionId(widgetLayout, id) === widget.id) ?? widget.id;
            updateWidgetLayout((current) => setWidgetConfig(current, instanceId, next));
          }
          commit(updatePanelItem(layout, item.id, { config: next }));
        };
        return <section
          key={item.id}
          data-panel-instance={item.id}
          className={`workspace-panel-item workspace-panel-item--${definition.type} workspace-panel-item--${item.size}${dragging === item.id ? " dragging" : ""}`}
          draggable={editing}
          onDragStart={(event) => onDragStart(event, item.id)}
          onDragEnd={() => setDragging(null)}
          onDragOver={(event) => { if (editing) event.preventDefault(); }}
          onDrop={(event) => onDrop(event, index)}
          onPointerDown={(event) => onTouchDown(event, item.id)}
          onPointerMove={onTouchMove}
          onPointerUp={endTouch}
          onPointerCancel={endTouch}
        >
          {editing && <div className="workspace-panel-edit-controls">
            <span className="workspace-panel-drag-handle" aria-hidden="true">⠿</span>
            <MoveControls label={definition.title} index={index} count={layout.items.length} onMove={(next) => reorder(item.id, next)} />
            {definition.supportedSizes.length > 1 && <select
              aria-label={`Size of ${definition.title}`}
              value={item.size}
              onChange={(event) => commit(updatePanelItem(layout, item.id, { size: event.target.value as PanelItemInstance["size"] }))}
            >{definition.supportedSizes.map((size) => <option key={size}>{size}</option>)}</select>}
            <IconButton icon={MinusIcon} size="sm" variant="ghost" label={`Remove ${definition.title}`} onClick={() => commit(removePanelItem(layout, item.id), `${definition.title} removed`)} />
          </div>}
          {definition.type === "launcher" ? <button className="workspace-panel-launcher" type="button" disabled={editing} onClick={() => open(definition)}>
            {Icon && <Icon />}
            <span>{definition.title}</span>
          </button> : definition.type === "widget" && widget ? <>
            <button className="workspace-panel-widget-head" type="button" disabled={editing || !definition.capabilityId} onClick={() => open(definition)}>
              {Icon && <Icon />}<strong>{definition.title}</strong>{definition.capabilityId && <ChevronRightIcon className="workspace-panel-disclosure" aria-hidden="true" />}
            </button>
            <div className="workspace-panel-widget-body">
              <ViewErrorBoundary inline resetKey={`${item.id}:${projectId ?? ""}:${sessionId ?? ""}`}>
                {widget.render({ projectId, sessionId, editing, instanceId: item.id, config, updateConfig })}
              </ViewErrorBoundary>
            </div>
          </> : <LayoutItem item={item} editing={editing} onLabel={(label) => commit(updatePanelItem(layout, item.id, { config: { ...item.config, label } }))} />}
        </section>;
      })}
    </div>
    {editing && <section className="workspace-panel-library" aria-labelledby="workspace-panel-library-title">
      <header><h3 id="workspace-panel-library-title">Available items</h3><p>Drag or tap to add</p></header>
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search items…" aria-label="Search available items" />
      <div className="workspace-panel-library-grid">
        {shown.map((definition) => {
          const used = definition.singleton && layout.items.some((item) => item.definitionId === definition.id);
          const Icon = definition.type === "launcher" ? railIconFor(definition.capabilityId ?? definition.sourcePackage) : definition.widgetId ? widgetIconFor(getWidget(definition.widgetId) ?? { id: definition.id, pluginId: definition.sourcePackage }) : null;
          return <button key={definition.id} type="button" disabled={used} aria-label={used ? `${definition.title} already added` : `Add ${definition.title}`} onClick={() => commit(addPanelItem(layout, definition), `${definition.title} added`)}>
            {Icon ? <Icon /> : <span aria-hidden="true">{definition.type === "header" ? "H" : "—"}</span>}
            <span>{definition.title}</span>
            <span aria-hidden="true">{used ? "✓" : <PlusIcon />}</span>
          </button>;
        })}
      </div>
    </section>}
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </Sheet>;
}
