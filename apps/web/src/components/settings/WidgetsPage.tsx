import { useEffect, useRef, useState } from "react";
import type { UiSlot } from "@polyth/contracts";
import { listCapabilities, useResolvedCapabilities } from "../../capabilities.ts";
import { activateProject, useStore } from "../../store.ts";
import { confirmAlert } from "../../alerts.ts";
import {
  capabilityLayoutStorageKey, getCapabilityPlacements, setPlacementOverride,
  type CapabilityTier,
} from "../../capabilityLayout.ts";
import { useWidgetCatalog, type WidgetDef } from "../../widgets/catalog.ts";
import {
  applyWidgetLayoutMutations,
  ensureWidgets,
  resetWidgetLayout,
  retryWidgetSave,
  undoWidgetLayout,
  updateWidgetLayout,
  useWidgetLayout,
  useWidgetStoreStatus,
  serializeWidgetLayout, widgetLayoutStorageKey, widgetSlotOf,
  type WidgetLayoutMutation,
} from "../../widgets/widgetLayout.ts";
import { supportedWidgetSlots } from "../../widgets/widgetLibrary.ts";
import "../../widgets/builtinWidgets.tsx";
import { PageHead } from "./parts.tsx";
import {
  MOBILE_SHORTCUT_IDS, RESPONSE_ACTION_IDS, setUiSettings, useUiSettings,
  type MobileShortcutId, type RailIconSize, type ResponseActionId,
} from "../../uiPrefs.ts";
import { tr } from "../../i18n/index.ts";

type MiniPlaceId = "composer" | "session-footer" | "app-header";
type InterfaceSurfaceId = "top-rail" | "right-rail" | "response-footer" | MiniPlaceId;
type PlaceId = CapabilityTier | MiniPlaceId;

const CAPABILITY_PLACES: Array<{
  id: CapabilityTier;
  title: string;
  description: string;
}> = [
  {
    id: "primary",
    title: tr("settings.widgetspage.topRail"),
    description: tr("settings.widgetspage.centeredWorkspaceToolsAtThe"),
  },
  {
    // "more" is the durable placement value used by ContextRail. Present it
    // as the physical destination users see, never as an ambiguous menu.
    id: "more",
    title: tr("settings.widgetspage.rightRail"),
    description: tr("settings.widgetspage.panelButtonsAlongTheRightEdgeDrag"),
  },
];

const MINI_PLACES: Array<{
  id: MiniPlaceId;
  title: string;
  description: string;
  slots: readonly UiSlot[];
}> = [
  {
    id: "composer",
    title: tr("settings.widgetspage.composerActions"),
    description: tr("settings.widgetspage.buttonsBesideTheMessageComposer"),
    slots: ["composer.leading", "composer.trailing"],
  },
  {
    id: "session-footer",
    title: tr("settings.widgetspage.sessionFooter"),
    description: tr("settings.widgetspage.widgetsShownJustAboveTheMessageComposer"),
    slots: ["session.footer"],
  },
  {
    id: "app-header",
    title: tr("settings.widgetspage.headerActions"),
    description: tr("settings.widgetspage.applicationAndActiveSessionActionsAtThe"),
    slots: ["session.header.actions", "app.header.actions"],
  },
];

function MiniWidgetPicker({
  widgets,
  onPick,
}: {
  widgets: WidgetDef[];
  onPick: (widget: WidgetDef) => void;
}) {
  return (
    <div className="widget-place-picker" role="menu">
      {widgets.length === 0
        ? <p>{tr("settings.widgetspage.noMoreButtonsAreAvailableForThis")}</p>
        : widgets.map((widget) => (
            <button type="button" role="menuitem" key={widget.id} onClick={() => onPick(widget)}>
              <strong>{widget.title}</strong>
              <small>{widget.description}</small>
            </button>
          ))}
    </div>
  );
}

const INTERFACE_SURFACES: Array<{
  id: InterfaceSurfaceId;
  label: string;
  description: string;
}> = [
  { id: "top-rail", label: tr("settings.widgetspage.topRail"), description: tr("settings.widgetspage.centeredWorkspaceButtonsAtThe") },
  { id: "app-header", label: tr("settings.widgetspage.headerActions"), description: tr("settings.widgetspage.atTheEndOfTheTopRail") },
  { id: "right-rail", label: tr("settings.widgetspage.rightRail"), description: tr("settings.widgetspage.panelButtonsOnTheRightEdge") },
  { id: "response-footer", label: tr("settings.widgetspage.responseActions"), description: tr("settings.widgetspage.afterEachAgentResponse") },
  { id: "composer", label: tr("settings.widgetspage.composer"), description: tr("settings.widgetspage.besideYourMessage") },
  { id: "session-footer", label: tr("settings.widgetspage.sessionFooter"), description: tr("settings.widgetspage.aboveTheComposer") },
];

const RESPONSE_ACTION_LABELS: Record<ResponseActionId, string> = {
  copy: tr("settings.widgetspage.copyAnswer"),
  image: tr("settings.widgetspage.saveAsImage"),
  plan: tr("settings.widgetspage.saveAsPlan"),
  pin: tr("settings.widgetspage.pinIntoContext"),
  session: tr("settings.widgetspage.newSessionFromAnswer"),
  multirun: tr("settings.widgetspage.newMultiRunFromAnswer"),
};

const RAIL_ICON_SIZE_OPTIONS: Array<{ value: RailIconSize; label: string }> = [
  { value: "sm", label: tr("settings.widgetspage.small") },
  { value: "md", label: tr("settings.widgetspage.medium") },
  { value: "lg", label: tr("settings.widgetspage.large") },
];

export function moveOrderedSelection<T extends string>(
  selected: readonly T[],
  item: T,
  target: T,
): T[] {
  if (item === target || !selected.includes(item) || !selected.includes(target)) return [...selected];
  const reordered = selected.filter((id) => id !== item);
  reordered.splice(reordered.indexOf(target), 0, item);
  return reordered;
}

const LONG_PRESS_MS = 350;

function OrderedToggleList<T extends string>({
  all,
  selected,
  labels,
  onChange,
}: {
  all: readonly T[];
  selected: readonly T[];
  labels: Record<T, string>;
  onChange: (ids: T[]) => void;
}) {
  const [dragged, setDragged] = useState<T | null>(null);
  const [dragOver, setDragOver] = useState<T | null>(null);
  const pointerDrag = useRef<{ id: T; pointerId: number; active: boolean; target: T } | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ordered = [...selected, ...all.filter((id) => !selected.includes(id))];
  const clearPointerDrag = () => {
    if (longPressTimer.current !== null) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    pointerDrag.current = null;
    setDragged(null);
    setDragOver(null);
  };
  useEffect(() => () => {
    if (longPressTimer.current !== null) clearTimeout(longPressTimer.current);
  }, []);

  const move = (item: T, target: T) => {
    const next = moveOrderedSelection(selected, item, target);
    if (next.some((id, index) => id !== selected[index])) onChange(next);
  };
  const moveBy = (item: T, delta: -1 | 1) => {
    const index = selected.indexOf(item);
    const targetIndex = index + delta;
    if (index < 0 || targetIndex < 0 || targetIndex >= selected.length) return;
    const next = [...selected];
    [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
    onChange(next);
  };
  const finishPointerDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    cancelled = false,
  ) => {
    const current = pointerDrag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.active) {
      event.preventDefault();
      if (!cancelled) move(current.id, current.target);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearPointerDrag();
  };
  return (
    <div className="widget-order-list">
      {ordered.map((id) => {
        const visible = selected.includes(id);
        const index = selected.indexOf(id);
        return (
          <div
            key={id}
            className={`widget-order-chip${visible ? "" : " hidden"}${dragged === id ? " dragging" : ""}${dragOver === id ? " drag-over" : ""}`}
            data-widget-order-id={id}
            draggable={visible}
            onDragStart={(event) => {
              setDragged(id);
              event.dataTransfer.setData("text/polyth-order-item", id);
            }}
            onDragEnd={() => {
              setDragged(null);
              setDragOver(null);
            }}
            onDragOver={(event) => { if (visible) event.preventDefault(); }}
            onDragEnter={() => { if (visible && dragged !== id) setDragOver(id); }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragged) move(dragged, id);
              setDragged(null);
              setDragOver(null);
            }}
          >
            <button
              type="button"
              className="widget-drag-handle"
              aria-label={`Reorder ${labels[id]}. Long press and drag, or use arrow keys.`}
              disabled={!visible}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveBy(id, -1);
                } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  moveBy(id, 1);
                }
              }}
              onPointerDown={(event) => {
                if (!visible || !event.isPrimary) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                pointerDrag.current = { id, pointerId: event.pointerId, active: false, target: id };
                longPressTimer.current = setTimeout(() => {
                  if (!pointerDrag.current || pointerDrag.current.pointerId !== event.pointerId) return;
                  pointerDrag.current.active = true;
                  setDragged(id);
                  setDragOver(id);
                }, LONG_PRESS_MS);
              }}
              onPointerMove={(event) => {
                const current = pointerDrag.current;
                if (!current || current.pointerId !== event.pointerId || !current.active) return;
                event.preventDefault();
                const target = document.elementFromPoint(event.clientX, event.clientY)
                  ?.closest<HTMLElement>("[data-widget-order-id]")
                  ?.dataset.widgetOrderId as T | undefined;
                if (target && selected.includes(target)) {
                  current.target = target;
                  setDragOver(target);
                }
              }}
              onPointerUp={(event) => finishPointerDrag(event)}
              onPointerCancel={(event) => finishPointerDrag(event, true)}
            >
              <span aria-hidden="true">⋮⋮</span>
            </button>
            <input
              type="checkbox"
              aria-label={`${visible ? "Hide" : "Show"} ${labels[id]}`}
              checked={visible}
              onChange={(event) => onChange(event.target.checked
                ? [...selected, id]
                : selected.filter((candidate) => candidate !== id))}
            />
            <span className="widget-order-label">{labels[id]}</span>
            {visible && (
              <span className="widget-order-controls">
                <button
                  type="button"
                  aria-label={`Move ${labels[id]} earlier`}
                  disabled={index <= 0}
                  onClick={() => moveBy(id, -1)}
                >←</button>
                <button
                  type="button"
                  aria-label={`Move ${labels[id]} later`}
                  disabled={index < 0 || index >= selected.length - 1}
                  onClick={() => moveBy(id, 1)}
                >→</button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function WidgetsPage() {
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const ui = useUiSettings();
  const storeStatus = useWidgetStoreStatus();
  const capabilities = useResolvedCapabilities();
  const projects = useStore((state) => state.projectRegistry.projects);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const [openPlace, setOpenPlace] = useState<PlaceId | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    ensureWidgets(widgets);
  }, [widgets]);

  const mutate = (...mutations: WidgetLayoutMutation[]) => {
    updateWidgetLayout((current) => applyWidgetLayoutMutations(current, mutations, widgets));
  };

  const miniWidgets = widgets.filter((widget) => widget.kind === "mini-widget");
  const availableCapabilities = capabilities.filter(
    (capability) => capability.descriptor.id !== "session" && capability.descriptor.available(),
  );
  const mobileShortcutOptions = MOBILE_SHORTCUT_IDS.filter((id) =>
    id === "notification-centre"
    || id === "settings"
    || capabilities.some((capability) =>
      capability.descriptor.id === id && capability.descriptor.available()));
  const mobileShortcutLabels = Object.fromEntries(mobileShortcutOptions.map((id) => {
    if (id === "notification-centre") return [id, tr("notificationcentre.notifications")];
    if (id === "settings") return [id, tr("common.settings")];
    return [
      id,
      capabilities.find((capability) => capability.descriptor.id === id)?.descriptor.label ?? id,
    ];
  })) as Record<MobileShortcutId, string>;

  const placeCapability = (id: string, tier: CapabilityTier) => {
    const rank = Math.max(
      -1,
      ...capabilities.filter((capability) => capability.tier === tier).map((capability) => capability.rank),
    ) + 1;
    setPlacementOverride(id, { tier, rank });
  };

  const reorderCapabilities = (
    placed: typeof availableCapabilities,
    draggedId: string,
    targetId: string,
    tier: CapabilityTier,
  ) => {
    if (draggedId === targetId) return;
    const ids = placed.map((item) => item.descriptor.id).filter((id) => id !== draggedId);
    ids.splice(ids.indexOf(targetId), 0, draggedId);
    ids.forEach((id, rank) => setPlacementOverride(id, { tier, rank }));
  };

  const moveCapabilityToOtherRail = (id: string, tier: CapabilityTier) => {
    placeCapability(id, tier === "primary" ? "more" : "primary");
  };

  const miniWidgetsFor = (slots: readonly UiSlot[]): WidgetDef[] => miniWidgets.filter((widget) => {
    const placement = layout.widgets[widget.id];
    const slot = widgetSlotOf(layout, widget.id) ?? widget.defaultSlot;
    return placement?.visible === true && slot !== undefined && slots.includes(slot);
  });

  const miniWidgetCandidates = (slots: readonly UiSlot[]): WidgetDef[] => miniWidgets.filter((widget) => {
    if (!supportedWidgetSlots(widget).some((slot) => slots.includes(slot))) return false;
    return !miniWidgetsFor(slots).some((placed) => placed.id === widget.id);
  });

  const placeMiniWidget = (widget: WidgetDef, slots: readonly UiSlot[]) => {
    const supported = supportedWidgetSlots(widget);
    const current = widgetSlotOf(layout, widget.id) ?? widget.defaultSlot;
    const target = current && slots.includes(current) && supported.includes(current)
      ? current
      : slots.find((slot) => supported.includes(slot));
    if (!target) return;
    mutate(
      { type: "visibility", id: widget.id, visible: true },
      { type: "place", id: widget.id, slot: target },
    );
    setOpenPlace(null);
  };

  const resetAllPlacement = async () => {
    if (!await confirmAlert(tr("settings.widgetspage.resetButtonPlacementAndCanvasLayoutTo"), { title: tr("settings.widgetspage.resetLayout"), confirmLabel: tr("settings.widgetspage.reset") })) return;
    for (const capability of listCapabilities()) {
      setPlacementOverride(capability.id, null);
    }
    resetWidgetLayout(widgets);
    setOpenPlace(null);
    setNotice(tr("settings.widgetspage.layoutResetForThisProject"));
  };

  const applyToAllProjects = async () => {
    if (!activeProjectId || !await confirmAlert(tr("settings.widgetspage.applyThisProjectSWidgetAndTool"), { title: tr("settings.widgetspage.applyLayoutToProjects"), confirmLabel: tr("common.apply"), destructive: false })) return;
    // Use the in-memory layout, rather than a possibly stale debounced storage
    // value. This makes Apply work immediately after dragging or adding a tool.
    const widgetLayout = serializeWidgetLayout(layout);
    const capabilityLayout = JSON.stringify({ version: 1, placements: getCapabilityPlacements() });
    for (const project of projects) {
      if (project.id === activeProjectId) continue;
      localStorage.setItem(widgetLayoutStorageKey(project.id), widgetLayout);
      localStorage.setItem(capabilityLayoutStorageKey(project.id), capabilityLayout);
    }
    const count = projects.length - 1;
    setNotice(count === 1
      ? tr("settings.widgetspage.appliedToOneOtherProject")
      : tr("settings.widgetspage.appliedToValueOtherProjects", { count }));
  };

  const showSurface = (surface: InterfaceSurfaceId) => {
    const target = document.querySelector<HTMLElement>(`[data-widget-surface="${surface}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.classList.add("widget-surface-flash");
    window.setTimeout(() => target?.classList.remove("widget-surface-flash"), 1400);
  };

  return (
    <>
      <PageHead
        title={tr("settings.widgetspage.widgetsLayout")}
        blurb={tr("settings.widgetspage.canvasAvailableTabletDesktop")}
      />

      <div className="widget-placement-toolbar">
        <label className="widget-project-scope">
          <span>{tr("settings.widgetspage.layoutFor")}</span>
          <select aria-label={tr("settings.widgetspage.projectLayout")} value={activeProjectId ?? ""} onChange={(event) => activateProject(event.target.value || null)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name || project.path}</option>)}
          </select>
        </label>
        {(storeStatus.saveStatus !== "saved" || notice !== "") && (
          <span className={`widget-save-state ${storeStatus.saveStatus}`} role="status">
            {storeStatus.saveStatus === "saving"
              ? tr("common.saving")
              : storeStatus.saveStatus === "error"
                ? <>{tr("settings.widgetspage.couldnTSave")}{" "}<button type="button" onClick={retryWidgetSave}>{tr("common.retry")}</button></>
                : notice}
          </span>
        )}
        <div className="widget-toolbar-actions">
          <button type="button" onClick={undoWidgetLayout} disabled={!storeStatus.canUndo}>{tr("settings.widgetspage.undo")}</button>
          <button type="button" onClick={applyToAllProjects} disabled={!activeProjectId || projects.length < 2}>{tr("settings.widgetspage.applyToAllProjects")}</button>
          <button type="button" className="widget-reset-button" onClick={resetAllPlacement}>{tr("settings.widgetspage.resetLayout")}</button>
        </div>
      </div>

      <section className="widget-interface-map" aria-labelledby="widget-interface-map-title">
        <div>
          <h3 id="widget-interface-map-title">{tr("settings.widgetspage.whereButtonsAppear")}</h3>
          <p>{tr("settings.widgetspage.chooseAPartOfTheInterfaceTo")}</p>
        </div>
        <div className="widget-interface-diagram" aria-label={tr("settings.widgetspage.interfacePlacementMap")}>
          {INTERFACE_SURFACES.map((surface) => (
            <button type="button" key={surface.id} className={`widget-map-target map-${surface.id}`} onClick={() => showSurface(surface.id)}>
              <strong>{surface.label}</strong>
              <small>{surface.description}</small>
            </button>
          ))}
        </div>
      </section>

      <div className="widget-place-grid widget-inline-config">
        <section className="widget-place-card" data-widget-surface="top-rail" data-settings-item="widgets.mobileShortcuts">
          <header>
            <div>
              <h3>Mobile shortcut rail</h3>
              <p>Choose and order the icons in the swipeable top rail on phones and tablets.</p>
            </div>
          </header>
          <OrderedToggleList
            all={mobileShortcutOptions}
            selected={ui.mobileShortcuts}
            labels={mobileShortcutLabels}
            onChange={(mobileShortcuts) => setUiSettings({ mobileShortcuts })}
          />
        </section>
        <section className="widget-place-card" data-widget-surface="response-footer" data-settings-item="widgets.responseActions">
          <header><div><h3>{tr("settings.widgetspage.responseActions")}</h3><p>{tr("settings.widgetspage.chooseAndOrderActionsShownAfterA")}</p></div></header>
          <OrderedToggleList
            all={RESPONSE_ACTION_IDS}
            selected={ui.responseActions}
            labels={RESPONSE_ACTION_LABELS}
            onChange={(responseActions) => setUiSettings({ responseActions })}
          />
        </section>
      </div>

      <div className="widget-place-grid">
        {CAPABILITY_PLACES.map((place, index) => {
          const placed = availableCapabilities.filter((capability) => capability.tier === place.id);
          const candidates = availableCapabilities.filter((capability) => capability.tier !== place.id);
          return (
            <section
              className="widget-place-card"
              data-widget-surface={place.id === "more" ? "right-rail" : "top-rail"}
              data-settings-item={index === 0 ? "widgets.capabilities" : undefined}
              key={place.id}
            >
              <header>
                <div>
                  <h3>{place.title}</h3>
                  <p>{place.description}</p>
                </div>
                <button
                  type="button"
                  className="widget-place-add"
                  aria-label={tr("settings.widgetspage.addAButtonToValue", { title: place.title })}
                  aria-expanded={openPlace === place.id}
                  onClick={() => setOpenPlace(openPlace === place.id ? null : place.id)}
                >＋</button>
              </header>
              <div className="widget-rail-controls">
                {place.id === "primary" && (
                  <label className="widget-rail-control">
                    <span>{tr("settings.widgetspage.position")}</span>
                    <select
                      aria-label={tr("settings.widgetspage.chatTopRailPosition")}
                      value={ui.topRailAlignment}
                      onChange={(event) => setUiSettings({
                        topRailAlignment: event.target.value === "left" ? "left" : "center",
                      })}
                    >
                      <option value="center">{tr("settings.widgetspage.centered")}</option>
                      <option value="left">{tr("settings.widgetspage.leftOfCenter")}</option>
                    </select>
                  </label>
                )}
                <label className="widget-rail-control">
                  <span>{tr("settings.widgetspage.iconSize")}</span>
                  <select
                    aria-label={place.id === "primary"
                      ? tr("settings.widgetspage.topRailIconSize")
                      : tr("settings.widgetspage.rightRailIconSize")}
                    value={place.id === "primary" ? ui.topRailIconSize : ui.rightRailIconSize}
                    onChange={(event) => {
                      const size = event.target.value;
                      if (size !== "sm" && size !== "md" && size !== "lg") return;
                      if (place.id === "primary") setUiSettings({ topRailIconSize: size });
                      else setUiSettings({ rightRailIconSize: size });
                    }}
                  >
                    {RAIL_ICON_SIZE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="widget-place-chips">
                {placed.length === 0 && <span className="widget-place-empty">{tr("settings.widgetspage.noButtonsPlaced")}</span>}
                {placed.map((capability) => (
                  <button
                    type="button"
                    className="widget-place-chip"
                    key={capability.descriptor.id}
                    draggable
                    onDragStart={(event) => event.dataTransfer.setData("text/polyth-capability", capability.descriptor.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const draggedId = event.dataTransfer.getData("text/polyth-capability");
                      if (placed.some((item) => item.descriptor.id === draggedId)) {
                        reorderCapabilities(placed, draggedId, capability.descriptor.id, place.id);
                      }
                    }}
                    title={tr("settings.widgetspage.dragToReorderValueInTheValue", { label: capability.descriptor.label, value: place.title.toLowerCase() })}
                    aria-label={tr("settings.widgetspage.valueToolValueDragToReorder", { title: place.title, label: capability.descriptor.label })}
                    onClick={() => moveCapabilityToOtherRail(capability.descriptor.id, place.id)}
                  >
                    {capability.descriptor.label}<span aria-hidden="true">↔</span>
                  </button>
                ))}
              </div>
              {openPlace === place.id && (
                <div className="widget-place-picker" role="menu">
                  {candidates.length === 0
                    ? <p>{tr("settings.widgetspage.allAvailableToolsAreAlreadyHere")}</p>
                    : candidates.map((capability) => (
                        <button
                          type="button"
                          role="menuitem"
                          key={capability.descriptor.id}
                          onClick={() => {
                            placeCapability(capability.descriptor.id, place.id);
                            setOpenPlace(null);
                          }}
                        >
                          <strong>{capability.descriptor.label}</strong>
                          <small>{capability.descriptor.plainDescription}</small>
                        </button>
                      ))}
                </div>
              )}
            </section>
          );
        })}

        {MINI_PLACES.map((place, index) => {
          const placed = miniWidgetsFor(place.slots);
          const candidates = miniWidgetCandidates(place.slots);
          return (
            <section
              className="widget-place-card"
              data-widget-surface={place.id}
              data-settings-item={index === 0 ? "widgets.actions" : undefined}
              key={place.id}
            >
              <header>
                <div>
                  <h3>{place.title}</h3>
                  <p>{place.description}</p>
                </div>
                <button
                  type="button"
                  className="widget-place-add"
                  aria-label={tr("settings.widgetspage.addAButtonToValue", { title: place.title })}
                  aria-expanded={openPlace === place.id}
                  onClick={() => setOpenPlace(openPlace === place.id ? null : place.id)}
                >＋</button>
              </header>
              <div className="widget-place-chips">
                {placed.length === 0 && <span className="widget-place-empty">{tr("settings.widgetspage.noButtonsPlaced")}</span>}
                {placed.map((widget) => (
                  <button
                    type="button"
                    className="widget-place-chip"
                    key={widget.id}
                    draggable
                    onDragStart={(event) => event.dataTransfer.setData("text/polyth-widget", widget.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const draggedId = event.dataTransfer.getData("text/polyth-widget");
                      const index = placed.findIndex((candidate) => candidate.id === widget.id);
                      if (placed.some((candidate) => candidate.id === draggedId) && index >= 0) {
                        const slot = widgetSlotOf(layout, widget.id);
                        if (slot) mutate({ type: "place", id: draggedId, slot, index });
                      }
                    }}
                    aria-label={widget.requiredVisible
                      ? `${widget.title} is required in ${place.title}`
                      : tr("settings.widgetspage.hideValueFromValue", { title: widget.title, title2: place.title })}
                    title={widget.requiredVisible
                      ? `${widget.title} is required while its package is enabled`
                      : tr("settings.widgetspage.hideValueFromValue", { title: widget.title, title2: place.title })}
                    aria-disabled={widget.requiredVisible || undefined}
                    onClick={() => {
                      if (!widget.requiredVisible) mutate({ type: "visibility", id: widget.id, visible: false });
                    }}
                  >
                    {widget.title}<span aria-hidden="true">{widget.requiredVisible ? "Required" : "×"}</span>
                  </button>
                ))}
              </div>
              {openPlace === place.id && (
                <MiniWidgetPicker
                  widgets={candidates}
                  onPick={(widget) => placeMiniWidget(widget, place.slots)}
                />
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
