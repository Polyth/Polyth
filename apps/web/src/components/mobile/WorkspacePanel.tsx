import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useResolvedCapabilities } from "../../capabilities.ts";
import { getCapabilityPlacements } from "../../capabilityLayout.ts";
import { selectionFeedback, successFeedback } from "../../haptics.ts";
import {
  markProjectPresentationChanged,
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  projectPresentationEventProjectId,
} from "../../projectPresentationSync.ts";
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
import ViewErrorBoundary from "../ViewErrorBoundary.ts";
import {
  ChevronRightIcon,
  DeleteIcon,
  DragHandleIcon,
  Icon,
  PlusIcon,
} from "../ui/index.ts";
import Sheet from "./Sheet.tsx";

function storedLayout(projectId: string | null, catalog: readonly PanelItemDefinition[], migrated: readonly string[]): WorkspacePanelLayout {
  if (!projectId) return createWorkspacePanelLayout(catalog, migrated);
  try { return parseWorkspacePanelLayout(localStorage.getItem(workspacePanelStorageKey(projectId)), catalog, migrated); }
  catch { return createWorkspacePanelLayout(catalog, migrated); }
}

function persist(projectId: string | null, layout: WorkspacePanelLayout): void {
  if (!projectId) return;
  try {
    localStorage.setItem(workspacePanelStorageKey(projectId), JSON.stringify(layout));
    markProjectPresentationChanged(projectId, "workspacePanel");
  } catch { /* private/full */ }
}

function LayoutItem({ item, editing, onLabel }: { item: PanelItemInstance; editing: boolean; onLabel: (label: string) => void }) {
  const label = typeof item.config.label === "string" ? item.config.label : item.type === "header" ? "Heading" : "Section";
  if (item.type === "divider") return <div className="workspace-panel-divider" role="separator" />;
  if (item.type === "header") return editing
    ? <input
      data-no-item-drag
      className="workspace-panel-label-input"
      aria-label="Header text"
      value={label}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => onLabel(event.target.value)}
    />
    : <h3 className="workspace-panel-heading">{label}</h3>;
  return <div className="workspace-panel-labeled-divider" role="separator">
    <i />
    {editing
      ? <input
        data-no-item-drag
        className="workspace-panel-label-input"
        aria-label="Divider label"
        value={label}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onLabel(event.target.value)}
      />
      : <span>{label}</span>}
    <i />
  </div>;
}

type DragSource =
  | { kind: "layout"; id: string }
  | { kind: "library"; definitionId: string };

type TouchPending = {
  source: DragSource;
  definitionId: string;
  pointerId: number;
  x: number;
  y: number;
  target: HTMLElement;
};

type TouchDrag = {
  source: DragSource;
  definitionId: string;
  pointerId: number;
  x: number;
  y: number;
  dropIndex: number | null;
  overRemove: boolean;
};

type ResizeGesture = {
  id: string;
  pointerId: number;
  startX: number;
  startIndex: number;
  currentIndex: number;
  sizes: PanelItemDefinition["supportedSizes"];
  moved: boolean;
};

function insertionIndex(target: HTMLElement, itemIndex: number, x: number, y: number): number {
  const rect = target.getBoundingClientRect();
  const compactCell = rect.width < 180;
  const after = compactCell ? x >= rect.left + rect.width / 2 : y >= rect.top + rect.height / 2;
  return itemIndex + (after ? 1 : 0);
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
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [layout, setLayout] = useState(() => storedLayout(projectId, catalog, migrated));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [desktopDraggingId, setDesktopDraggingId] = useState<string | null>(null);
  const [desktopDefinitionId, setDesktopDefinitionId] = useState<string | null>(null);
  const [dragVisual, setDragVisual] = useState<TouchDrag | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchPending = useRef<TouchPending | null>(null);
  const touchDrag = useRef<TouchDrag | null>(null);
  const resizeGesture = useRef<ResizeGesture | null>(null);
  const suppressClick = useRef(false);
  const suppressResizeClick = useRef(false);

  const clearTouchTimer = () => {
    if (touchTimer.current) clearTimeout(touchTimer.current);
    touchTimer.current = null;
    touchPending.current = null;
  };

  const clearDrag = () => {
    clearTouchTimer();
    touchDrag.current = null;
    setDragVisual(null);
    setDropIndex(null);
    setDesktopDraggingId(null);
    setDesktopDefinitionId(null);
  };

  useEffect(() => {
    setLayout(storedLayout(projectId, catalog, migrated));
    setSelectedId(null);
    clearDrag();
  }, [projectId]);
  useEffect(() => {
    const onHydrated = (event: Event) => {
      if (projectPresentationEventProjectId(event) !== projectId) return;
      setLayout(storedLayout(projectId, catalog, migrated));
    };
    window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
    return () => window.removeEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
  }, [catalog, migrated, projectId]);
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
  const reorder = (id: string, index: number, withFeedback = false) => {
    const next = movePanelItem(layout, id, index);
    if (next === layout) return;
    commit(next, `Moved item to position ${index + 1}`);
    if (withFeedback) selectionFeedback();
  };
  const insertDefinition = (definition: PanelItemDefinition, index?: number) => {
    const added = addPanelItem(layout, definition);
    if (added === layout) return;
    const inserted = added.items.find((item) => !layout.items.some((existing) => existing.id === item.id));
    const next = inserted && index !== undefined ? movePanelItem(added, inserted.id, index) : added;
    commit(next, `${definition.title} added`);
    if (inserted) setSelectedId(inserted.id);
    successFeedback();
  };
  const finishEditing = () => {
    clearDrag();
    resizeGesture.current = null;
    setSelectedId(null);
    setLibraryOpen(false);
    setQuery("");
    setEditing(false);
  };
  const startEditing = () => {
    setSelectedId(null);
    setEditing(true);
  };

  const armTouchDrag = (event: PointerEvent<HTMLElement>, source: DragSource, definitionId: string) => {
    if (!editing || event.pointerType !== "touch") return;
    if ((event.target as Element).closest("[data-no-item-drag]")) return;
    clearTouchTimer();
    const target = event.currentTarget;
    touchPending.current = {
      source,
      definitionId,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      target,
    };
    touchTimer.current = setTimeout(() => {
      const pending = touchPending.current;
      if (!pending || pending.pointerId !== event.pointerId) return;
      touchPending.current = null;
      touchTimer.current = null;
      try { pending.target.setPointerCapture(pending.pointerId); } catch { /* pointer already ended */ }
      const initialIndex = pending.source.kind === "layout"
        ? layout.items.findIndex((item) => item.id === pending.source.id)
        : null;
      const active: TouchDrag = {
        source: pending.source,
        definitionId: pending.definitionId,
        pointerId: pending.pointerId,
        x: pending.x,
        y: pending.y,
        dropIndex: initialIndex !== null && initialIndex >= 0 ? initialIndex : null,
        overRemove: false,
      };
      touchDrag.current = active;
      setDragVisual(active);
      setDropIndex(active.dropIndex);
      suppressClick.current = true;
      if (pending.source.kind === "layout") setSelectedId(pending.source.id);
      selectionFeedback();
    }, 280);
  };

  const onTouchMove = (event: PointerEvent<HTMLElement>) => {
    const pending = touchPending.current;
    if (pending?.pointerId === event.pointerId
      && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 8) {
      clearTouchTimer();
    }
    const active = touchDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();

    const pointed = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const removeTarget = pointed?.closest<HTMLElement>("[data-workspace-remove]");
    let nextIndex = active.dropIndex;
    const overRemove = active.source.kind === "layout" && Boolean(removeTarget);

    if (!overRemove) {
      const target = pointed?.closest<HTMLElement>("[data-panel-instance]");
      if (target?.dataset.panelInstance) {
        const targetIndex = layout.items.findIndex((item) => item.id === target.dataset.panelInstance);
        if (targetIndex >= 0) {
          const rawIndex = insertionIndex(target, targetIndex, event.clientX, event.clientY);
          if (active.source.kind === "layout") {
            const currentIndex = layout.items.findIndex((item) => item.id === active.source.id);
            const normalized = currentIndex >= 0 && currentIndex < rawIndex ? rawIndex - 1 : rawIndex;
            nextIndex = Math.max(0, Math.min(normalized, layout.items.length - 1));
            if (currentIndex >= 0 && nextIndex !== currentIndex) reorder(active.source.id, nextIndex, true);
          } else {
            nextIndex = Math.max(0, Math.min(rawIndex, layout.items.length));
          }
        }
      } else if (pointed?.closest(".workspace-panel-items")) {
        if (active.source.kind === "layout" && layout.items.length > 0) {
          nextIndex = layout.items.length - 1;
          const currentIndex = layout.items.findIndex((item) => item.id === active.source.id);
          if (currentIndex >= 0 && nextIndex !== currentIndex) reorder(active.source.id, nextIndex, true);
        } else {
          nextIndex = layout.items.length;
        }
      }
    }

    const next: TouchDrag = {
      ...active,
      x: event.clientX,
      y: event.clientY,
      dropIndex: nextIndex,
      overRemove,
    };
    touchDrag.current = next;
    setDragVisual(next);
    setDropIndex(nextIndex);

    const scroller = event.currentTarget.closest<HTMLElement>(".sheet-body");
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      if (event.clientY < rect.top + 64) scroller.scrollBy({ top: -30, behavior: "auto" });
      else if (event.clientY > rect.bottom - 88) scroller.scrollBy({ top: 30, behavior: "auto" });
    }
  };

  const endTouch = (event: PointerEvent<HTMLElement>) => {
    clearTouchTimer();
    const active = touchDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;

    if (active.source.kind === "layout" && active.overRemove) {
      const item = layout.items.find((candidate) => candidate.id === active.source.id);
      const definition = item ? definitions.get(item.definitionId) : undefined;
      commit(removePanelItem(layout, active.source.id), `${definition?.title ?? "Item"} removed`);
      setSelectedId(null);
      successFeedback();
    } else if (active.source.kind === "library" && active.dropIndex !== null) {
      const definition = definitions.get(active.source.definitionId);
      if (definition) insertDefinition(definition, active.dropIndex);
    } else if (active.source.kind === "layout") {
      selectionFeedback();
    }

    touchDrag.current = null;
    setDragVisual(null);
    setDropIndex(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* no capture */ }
    setTimeout(() => { suppressClick.current = false; }, 0);
  };

  const onNativeDragStart = (event: DragEvent<HTMLElement>, id: string) => {
    setDesktopDraggingId(id);
    setDesktopDefinitionId(null);
    setSelectedId(id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-polyth-panel-item", id);
  };
  const onNativeLibraryDragStart = (event: DragEvent<HTMLElement>, definitionId: string) => {
    setDesktopDraggingId(null);
    setDesktopDefinitionId(definitionId);
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("application/x-polyth-panel-definition", definitionId);
  };
  const onNativeDragOver = (event: DragEvent<HTMLElement>, index: number) => {
    if (!editing) return;
    event.preventDefault();
    event.stopPropagation();
    if (desktopDefinitionId) setDropIndex(index);
  };
  const onNativeDrop = (event: DragEvent<HTMLElement>, index: number) => {
    if (!editing) return;
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData("application/x-polyth-panel-item") || desktopDraggingId;
    const definitionId = event.dataTransfer.getData("application/x-polyth-panel-definition") || desktopDefinitionId;
    if (id) reorder(id, index, true);
    else if (definitionId) {
      const definition = definitions.get(definitionId);
      if (definition) insertDefinition(definition, index);
    }
    setDropIndex(null);
    setDesktopDraggingId(null);
    setDesktopDefinitionId(null);
  };
  const onNativeRemove = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData("application/x-polyth-panel-item") || desktopDraggingId;
    if (!id) return;
    const item = layout.items.find((candidate) => candidate.id === id);
    const definition = item ? definitions.get(item.definitionId) : undefined;
    commit(removePanelItem(layout, id), `${definition?.title ?? "Item"} removed`);
    setSelectedId(null);
    setDesktopDraggingId(null);
    setDropIndex(null);
    successFeedback();
  };

  const onEditorItemClick = (id: string) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setSelectedId((current) => current === id ? null : id);
    selectionFeedback();
  };
  const onEditorItemKeyDown = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onEditorItemClick(id);
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>, item: PanelItemInstance, definition: PanelItemDefinition) => {
    event.stopPropagation();
    if (definition.supportedSizes.length < 2) return;
    const index = Math.max(0, definition.supportedSizes.indexOf(item.size));
    resizeGesture.current = {
      id: item.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startIndex: index,
      currentIndex: index,
      sizes: definition.supportedSizes,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveResize = (event: PointerEvent<HTMLButtonElement>) => {
    const gesture = resizeGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const steps = Math.round((event.clientX - gesture.startX) / 48);
    const index = Math.max(0, Math.min(gesture.startIndex + steps, gesture.sizes.length - 1));
    if (index === gesture.currentIndex) return;
    const size = gesture.sizes[index];
    if (!size) return;
    gesture.currentIndex = index;
    gesture.moved = true;
    commit(updatePanelItem(layout, gesture.id, { size }));
    selectionFeedback();
  };
  const endResize = (event: PointerEvent<HTMLButtonElement>) => {
    const gesture = resizeGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.stopPropagation();
    suppressResizeClick.current = gesture.moved;
    const size = gesture.sizes[gesture.currentIndex] ?? "compact";
    setAnnouncement(`Size changed to ${size}`);
    resizeGesture.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* no capture */ }
  };
  const cycleSize = (event: MouseEvent<HTMLButtonElement>, item: PanelItemInstance, definition: PanelItemDefinition) => {
    event.stopPropagation();
    if (suppressResizeClick.current) {
      suppressResizeClick.current = false;
      return;
    }
    const index = Math.max(0, definition.supportedSizes.indexOf(item.size));
    const size = definition.supportedSizes[(index + 1) % definition.supportedSizes.length];
    if (!size) return;
    commit(updatePanelItem(layout, item.id, { size }), `Size changed to ${size}`);
    selectionFeedback();
  };

  const selectedItem = selectedId ? layout.items.find((item) => item.id === selectedId) : undefined;
  const selectedDefinition = selectedItem ? definitions.get(selectedItem.definitionId) : undefined;
  const shown = catalog.filter((item) => `${item.title} ${item.description} ${item.sourcePackage}`.toLowerCase().includes(query.trim().toLowerCase()));
  const draggingLayoutId = dragVisual?.source.kind === "layout" ? dragVisual.source.id : desktopDraggingId;
  const draggingDefinition = dragVisual ? definitions.get(dragVisual.definitionId) : undefined;
  const DragPreviewIcon = draggingDefinition?.type === "launcher"
    ? railIconFor(draggingDefinition.capabilityId ?? draggingDefinition.sourcePackage)
    : draggingDefinition?.widgetId
      ? widgetIconFor(getWidget(draggingDefinition.widgetId) ?? { id: draggingDefinition.id, pluginId: draggingDefinition.sourcePackage })
      : null;

  return <Sheet
    title={editing ? "Customize workspace" : "Workspace"}
    size="tall"
    className={`mobile-tools-sheet workspace-panel-sheet${editing ? " is-editing" : ""}`}
    onClose={editing ? finishEditing : onClose}
    dismiss={editing ? "close" : "back"}
    action={{ label: editing ? "Done" : "Edit", pressed: editing, onClick: editing ? finishEditing : startEditing }}
  >
    <p className="workspace-panel-subtitle">
      {editing ? "Long-press and drag to reorder · Tap for options" : "Tools & widgets"}
    </p>
    <div
      className={`workspace-panel-items${editing ? " is-editing" : ""}`}
      aria-label="Configured workspace"
      aria-roledescription={editing ? "Editable workspace" : undefined}
      onDragOver={(event) => {
        if (!editing || (!desktopDraggingId && !desktopDefinitionId)) return;
        event.preventDefault();
        if (desktopDefinitionId) setDropIndex(layout.items.length);
      }}
      onDrop={(event) => onNativeDrop(event, layout.items.length)}
    >
      {layout.items.map((item, index) => {
        const definition = definitions.get(item.definitionId);
        if (!definition) return null;
        const widget = definition.widgetId ? getWidget(definition.widgetId) : undefined;
        const placement = definition.widgetId
          ? widgetLayout.widgets[Object.keys(widgetLayout.widgets).find((id) => widgetDefinitionId(widgetLayout, id) === definition.widgetId) ?? definition.widgetId]
          : undefined;
        const ItemIcon = definition.type === "launcher" ? railIconFor(definition.capabilityId ?? definition.sourcePackage) : widget ? widgetIconFor(widget) : null;
        const config = placement?.config ?? item.config;
        const updateConfig = (next: typeof item.config) => {
          if (widget && placement) {
            const instanceId = Object.keys(widgetLayout.widgets).find((id) => widgetDefinitionId(widgetLayout, id) === widget.id) ?? widget.id;
            updateWidgetLayout((current) => setWidgetConfig(current, instanceId, next));
          }
          commit(updatePanelItem(layout, item.id, { config: next }));
        };
        const dragging = draggingLayoutId === item.id;
        const selected = editing && selectedId === item.id;
        const dropTarget = editing
          && (desktopDefinitionId !== null || dragVisual?.source.kind === "library")
          && dropIndex === index;
        return <section
          key={item.id}
          data-panel-instance={item.id}
          data-panel-index={index}
          className={`workspace-panel-item workspace-panel-item--${definition.type} workspace-panel-item--${item.size}${dragging ? " dragging" : ""}${selected ? " selected" : ""}${dropTarget ? " drop-target" : ""}`}
          draggable={editing}
          role={editing ? "button" : undefined}
          tabIndex={editing ? 0 : undefined}
          aria-pressed={editing ? selected : undefined}
          aria-label={editing ? `Edit ${definition.title}` : undefined}
          onClick={editing ? () => onEditorItemClick(item.id) : undefined}
          onKeyDown={editing ? (event) => onEditorItemKeyDown(event, item.id) : undefined}
          onDragStart={editing ? (event) => onNativeDragStart(event, item.id) : undefined}
          onDragEnd={editing ? clearDrag : undefined}
          onDragOver={editing ? (event) => onNativeDragOver(event, index) : undefined}
          onDrop={editing ? (event) => onNativeDrop(event, index) : undefined}
          onPointerDown={editing ? (event) => armTouchDrag(event, { kind: "layout", id: item.id }, definition.id) : undefined}
          onPointerMove={editing ? onTouchMove : undefined}
          onPointerUp={editing ? endTouch : undefined}
          onPointerCancel={editing ? endTouch : undefined}
        >
          {editing ? definition.type === "launcher" ? <div className="workspace-panel-launcher workspace-panel-launcher--editor">
            <span className="workspace-panel-editor-grip" aria-hidden="true"><Icon icon={DragHandleIcon} size="sm" /></span>
            {ItemIcon && <ItemIcon />}
            <span>{definition.title}</span>
          </div> : definition.type === "widget" ? <div className="workspace-panel-editor-widget">
            <span className="workspace-panel-editor-grip" aria-hidden="true"><Icon icon={DragHandleIcon} size="sm" /></span>
            <span className="workspace-panel-editor-widget-icon" aria-hidden="true">{ItemIcon && <ItemIcon />}</span>
            <span className="workspace-panel-editor-copy">
              <strong>{definition.title}</strong>
              <small>{definition.description}</small>
            </span>
            {definition.supportedSizes.length > 1 ? <button
              type="button"
              data-no-item-drag
              className="workspace-panel-size-handle"
              aria-label={`Resize ${definition.title}. Current size ${item.size}`}
              title="Drag sideways to resize; tap to cycle size"
              onPointerDown={(event) => startResize(event, item, definition)}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              onClick={(event) => cycleSize(event, item, definition)}
            >
              <span>{item.size}</span><span aria-hidden="true">↔</span>
            </button> : <span className="workspace-panel-size-label">{item.size}</span>}
          </div> : <div className="workspace-panel-editor-layout">
            <span className="workspace-panel-editor-grip" aria-hidden="true"><Icon icon={DragHandleIcon} size="sm" /></span>
            <LayoutItem item={item} editing onLabel={(label) => commit(updatePanelItem(layout, item.id, { config: { ...item.config, label } }))} />
          </div> : definition.type === "launcher" ? <button className="workspace-panel-launcher" type="button" onClick={() => open(definition)}>
            {ItemIcon && <ItemIcon />}
            <span>{definition.title}</span>
          </button> : definition.type === "widget" && widget ? <>
            <button className="workspace-panel-widget-head" type="button" disabled={!definition.capabilityId} onClick={() => open(definition)}>
              {ItemIcon && <ItemIcon />}<strong>{definition.title}</strong>{definition.capabilityId && <ChevronRightIcon className="workspace-panel-disclosure" aria-hidden="true" />}
            </button>
            <div className="workspace-panel-widget-body">
              <ViewErrorBoundary inline resetKey={`${item.id}:${projectId ?? ""}:${sessionId ?? ""}`}>
                {widget.render({ projectId, sessionId, editing: false, instanceId: item.id, config, updateConfig })}
              </ViewErrorBoundary>
            </div>
          </> : <LayoutItem item={item} editing={false} onLabel={() => {}} />}
        </section>;
      })}
      {editing && (desktopDefinitionId || dragVisual?.source.kind === "library") && <div
        className={`workspace-panel-drop-marker${dropIndex === layout.items.length ? " visible" : ""}`}
        aria-hidden="true"
      />}
    </div>

    {editing && <>
      <button
        type="button"
        className="workspace-panel-add-items"
        aria-expanded={libraryOpen}
        aria-controls="workspace-panel-library"
        onClick={() => setLibraryOpen((value) => !value)}
      >
        <Icon icon={PlusIcon} size="lg" />
        <span>{libraryOpen ? "Hide items" : "Add items"}</span>
      </button>
      {libraryOpen && <section id="workspace-panel-library" className="workspace-panel-library" aria-labelledby="workspace-panel-library-title">
        <header><h3 id="workspace-panel-library-title">Available items</h3><p>Tap to add · Long-press and drag to place</p></header>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search items…" aria-label="Search available items" />
        <div className="workspace-panel-library-grid">
          {shown.map((definition) => {
            const used = definition.singleton && layout.items.some((item) => item.definitionId === definition.id);
            const LibraryIcon = definition.type === "launcher" ? railIconFor(definition.capabilityId ?? definition.sourcePackage) : definition.widgetId ? widgetIconFor(getWidget(definition.widgetId) ?? { id: definition.id, pluginId: definition.sourcePackage }) : null;
            return <button
              key={definition.id}
              type="button"
              disabled={used}
              draggable={!used}
              aria-label={used ? `${definition.title} already added` : `Add ${definition.title}`}
              onDragStart={(event) => onNativeLibraryDragStart(event, definition.id)}
              onDragEnd={clearDrag}
              onPointerDown={(event) => armTouchDrag(event, { kind: "library", definitionId: definition.id }, definition.id)}
              onPointerMove={onTouchMove}
              onPointerUp={endTouch}
              onPointerCancel={endTouch}
              onClick={() => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                if (!used) insertDefinition(definition);
              }}
            >
              {LibraryIcon ? <LibraryIcon /> : <span aria-hidden="true">{definition.type === "header" ? "H" : "—"}</span>}
              <span>{definition.title}</span>
              <span aria-hidden="true">{used ? "✓" : <PlusIcon />}</span>
            </button>;
          })}
        </div>
      </section>}
    </>}

    {editing && selectedItem && selectedDefinition && !dragVisual && !desktopDraggingId && <div className="workspace-panel-selection-bar" role="group" aria-label={`Options for ${selectedDefinition.title}`}>
      <button
        type="button"
        disabled={layout.items.findIndex((item) => item.id === selectedItem.id) <= 0}
        onClick={() => {
          const index = layout.items.findIndex((item) => item.id === selectedItem.id);
          reorder(selectedItem.id, index - 1, true);
        }}
      >Earlier</button>
      <button
        type="button"
        disabled={layout.items.findIndex((item) => item.id === selectedItem.id) >= layout.items.length - 1}
        onClick={() => {
          const index = layout.items.findIndex((item) => item.id === selectedItem.id);
          reorder(selectedItem.id, index + 1, true);
        }}
      >Later</button>
      {selectedDefinition.supportedSizes.length > 1 && <button
        type="button"
        onClick={(event) => cycleSize(event, selectedItem, selectedDefinition)}
      >Size: {selectedItem.size}</button>}
      <button
        type="button"
        className="danger"
        onClick={() => {
          commit(removePanelItem(layout, selectedItem.id), `${selectedDefinition.title} removed`);
          setSelectedId(null);
          successFeedback();
        }}
      >
        <Icon icon={DeleteIcon} size="sm" />
        <span>Remove</span>
      </button>
    </div>}

    {dragVisual && draggingDefinition && <div
      className={`workspace-panel-drag-preview workspace-panel-drag-preview--${draggingDefinition.type}`}
      style={{ left: dragVisual.x, top: dragVisual.y }}
      aria-hidden="true"
    >
      {DragPreviewIcon && <DragPreviewIcon />}
      <span>{draggingDefinition.title}</span>
    </div>}

    {editing && (dragVisual?.source.kind === "layout" || desktopDraggingId) && <div
      data-workspace-remove=""
      className={`workspace-panel-remove-zone${dragVisual?.overRemove ? " active" : ""}`}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
      onDrop={onNativeRemove}
    >
      <Icon icon={DeleteIcon} size="lg" />
      <span>Release here to remove</span>
    </div>}

    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </Sheet>;
}
