import { useEffect, useState } from "react";
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
import { RESPONSE_ACTION_IDS, setUiSettings, useUiSettings, type ResponseActionId } from "../../uiPrefs.ts";

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
    title: "Top rail",
    description: "Centered workspace tools at the top. Drag to choose their order.",
  },
  {
    // "more" is the durable placement value used by ContextRail. Present it
    // as the physical destination users see, never as an ambiguous menu.
    id: "more",
    title: "Right rail",
    description: "Panel buttons along the right edge. Drag to choose their order.",
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
    title: "Composer actions",
    description: "Buttons beside the message composer.",
    slots: ["composer.leading", "composer.trailing"],
  },
  {
    id: "session-footer",
    title: "Session footer",
    description: "Widgets shown just above the message composer.",
    slots: ["session.footer"],
  },
  {
    id: "app-header",
    title: "Header actions",
    description: "Application and active-session actions at the end of the top rail.",
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
        ? <p>No more buttons are available for this place.</p>
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
  { id: "top-rail", label: "Top rail", description: "Centered workspace buttons at the top" },
  { id: "app-header", label: "Header actions", description: "At the end of the top rail" },
  { id: "right-rail", label: "Right rail", description: "Panel buttons on the right edge" },
  { id: "response-footer", label: "Response actions", description: "After each agent response" },
  { id: "composer", label: "Composer", description: "Beside your message" },
  { id: "session-footer", label: "Session footer", description: "Above the composer" },
];

const RESPONSE_ACTION_LABELS: Record<ResponseActionId, string> = {
  copy: "Copy answer",
  image: "Save as image",
  plan: "Save as plan",
  pin: "Pin into context",
  session: "New session from answer",
  multirun: "New multi-run from answer",
};

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
  const ordered = [...selected, ...all.filter((id) => !selected.includes(id))];
  const move = (target: T) => {
    if (!dragged || dragged === target) return;
    const visible = selected.filter((id) => id !== dragged);
    if (!selected.includes(dragged) || !selected.includes(target)) return;
    visible.splice(visible.indexOf(target), 0, dragged);
    onChange(visible);
  };
  return (
    <div className="widget-order-list">
      {ordered.map((id) => {
        const visible = selected.includes(id);
        return (
          <label
            key={id}
            className={`widget-order-chip${visible ? "" : " hidden"}`}
            draggable={visible}
            onDragStart={() => setDragged(id)}
            onDragEnd={() => setDragged(null)}
            onDragOver={(event) => { if (visible) event.preventDefault(); }}
            onDrop={() => move(id)}
          >
            <span className="widget-drag-handle" aria-hidden="true">⋮⋮</span>
            <input
              type="checkbox"
              checked={visible}
              onChange={(event) => onChange(event.target.checked
                ? [...selected, id]
                : selected.filter((candidate) => candidate !== id))}
            />
            <span>{labels[id]}</span>
          </label>
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
    if (!await confirmAlert("Reset button placement and canvas layout to their defaults?", { title: "Reset layout", confirmLabel: "Reset" })) return;
    for (const capability of listCapabilities()) {
      setPlacementOverride(capability.id, null);
    }
    resetWidgetLayout(widgets);
    setOpenPlace(null);
    setNotice("Layout reset for this project.");
  };

  const applyToAllProjects = async () => {
    if (!activeProjectId || !await confirmAlert("Apply this project’s widget and tool layout to every project?", { title: "Apply layout to projects", confirmLabel: "Apply", destructive: false })) return;
    // Use the in-memory layout, rather than a possibly stale debounced storage
    // value. This makes Apply work immediately after dragging or adding a tool.
    const widgetLayout = serializeWidgetLayout(layout);
    const capabilityLayout = JSON.stringify({ version: 1, placements: getCapabilityPlacements() });
    for (const project of projects) {
      if (project.id === activeProjectId) continue;
      localStorage.setItem(widgetLayoutStorageKey(project.id), widgetLayout);
      localStorage.setItem(capabilityLayoutStorageKey(project.id), capabilityLayout);
    }
    setNotice(`Applied to ${projects.length - 1} other project${projects.length === 2 ? "" : "s"}.`);
  };

  const showSurface = (surface: InterfaceSurfaceId) => {
    const target = document.querySelector<HTMLElement>(`[data-widget-surface="${surface}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.classList.add("widget-surface-flash");
    window.setTimeout(() => target?.classList.remove("widget-surface-flash"), 1400);
  };

  return (
    <>
      <PageHead title="Widgets & Layout" />

      <div className="widget-placement-toolbar">
        <label className="widget-project-scope">
          <span>Layout for</span>
          <select aria-label="Project layout" value={activeProjectId ?? ""} onChange={(event) => activateProject(event.target.value || null)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name || project.path}</option>)}
          </select>
        </label>
        {(storeStatus.saveStatus !== "saved" || notice !== "") && (
          <span className={`widget-save-state ${storeStatus.saveStatus}`} role="status">
            {storeStatus.saveStatus === "saving"
              ? "Saving…"
              : storeStatus.saveStatus === "error"
                ? <>Couldn’t save <button type="button" onClick={retryWidgetSave}>Retry</button></>
                : notice}
          </span>
        )}
        <div className="widget-toolbar-actions">
          <button type="button" onClick={undoWidgetLayout} disabled={!storeStatus.canUndo}>Undo</button>
          <button type="button" onClick={applyToAllProjects} disabled={!activeProjectId || projects.length < 2}>Apply to all projects</button>
          <button type="button" className="widget-reset-button" onClick={resetAllPlacement}>Reset layout</button>
        </div>
      </div>

      <section className="widget-interface-map" aria-labelledby="widget-interface-map-title">
        <div>
          <h3 id="widget-interface-map-title">Where buttons appear</h3>
          <p>Choose a part of the interface to jump to its controls. Response actions sit after an agent’s answer.</p>
        </div>
        <div className="widget-interface-diagram" aria-label="Interface placement map">
          {INTERFACE_SURFACES.map((surface) => (
            <button type="button" key={surface.id} className={`widget-map-target map-${surface.id}`} onClick={() => showSurface(surface.id)}>
              <strong>{surface.label}</strong>
              <small>{surface.description}</small>
            </button>
          ))}
        </div>
      </section>

      <div className="widget-place-grid widget-inline-config">
        <section className="widget-place-card" data-widget-surface="response-footer" data-settings-item="widgets.responseActions">
          <header><div><h3>Response actions</h3><p>Choose and order actions shown after a completed agent response.</p></div></header>
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
                  aria-label={`Add a button to ${place.title}`}
                  aria-expanded={openPlace === place.id}
                  onClick={() => setOpenPlace(openPlace === place.id ? null : place.id)}
                >＋</button>
              </header>
              {place.id === "primary" && (
                <label className="widget-top-rail-position">
                  <span>Position</span>
                  <select
                    aria-label="Chat top rail position"
                    value={ui.topRailAlignment}
                    onChange={(event) => setUiSettings({
                      topRailAlignment: event.target.value === "left" ? "left" : "center",
                    })}
                  >
                    <option value="center">Centered</option>
                    <option value="left">Left of center</option>
                  </select>
                </label>
              )}
              <div className="widget-place-chips">
                {placed.length === 0 && <span className="widget-place-empty">No buttons placed</span>}
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
                    title={`Drag to reorder ${capability.descriptor.label} in the ${place.title.toLowerCase()}`}
                    aria-label={`${place.title} tool: ${capability.descriptor.label}. Drag to reorder.`}
                    onClick={() => moveCapabilityToOtherRail(capability.descriptor.id, place.id)}
                  >
                    {capability.descriptor.label}<span aria-hidden="true">↔</span>
                  </button>
                ))}
              </div>
              {openPlace === place.id && (
                <div className="widget-place-picker" role="menu">
                  {candidates.length === 0
                    ? <p>All available tools are already here.</p>
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
                  aria-label={`Add a button to ${place.title}`}
                  aria-expanded={openPlace === place.id}
                  onClick={() => setOpenPlace(openPlace === place.id ? null : place.id)}
                >＋</button>
              </header>
              <div className="widget-place-chips">
                {placed.length === 0 && <span className="widget-place-empty">No buttons placed</span>}
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
                    aria-label={`Hide ${widget.title} from ${place.title}`}
                    title={`Hide ${widget.title} from ${place.title}`}
                    onClick={() => mutate({ type: "visibility", id: widget.id, visible: false })}
                  >
                    {widget.title}<span aria-hidden="true">×</span>
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
