import { useEffect, useState } from "react";
import type { UiSlot } from "@polyth/contracts";
import { useResolvedCapabilities } from "../../capabilities.ts";
import {
  setPlacementOverride,
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
  widgetSlotOf,
  type WidgetLayoutMutation,
} from "../../widgets/widgetLayout.ts";
import { supportedWidgetSlots } from "../../widgets/widgetLibrary.ts";
import "../../widgets/builtinWidgets.tsx";
import { PageHead } from "./parts.tsx";
import {
  HEADER_METRIC_IDS, RESPONSE_ACTION_IDS, setUiSettings, useUiSettings,
  type HeaderMetricId, type ResponseActionId,
} from "../../uiPrefs.ts";

type MiniPlaceId = "composer" | "session-header" | "session-footer" | "app-header";
type PlaceId = CapabilityTier | MiniPlaceId;

const CAPABILITY_PLACES: Array<{
  id: CapabilityTier;
  title: string;
  description: string;
}> = [
  {
    id: "primary",
    title: "Focus header",
    description: "Primary tools shown in the top strip while you work.",
  },
  {
    id: "more",
    title: "More tools / right rail",
    description: "Tools kept close by without filling the primary header.",
  },
  {
    id: "technical",
    title: "Technical menu",
    description: "Advanced tools available from the technical section.",
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
    description: "Buttons shown before or after the message composer.",
    slots: ["composer.leading", "composer.trailing"],
  },
  {
    id: "session-header",
    title: "Session header actions",
    description: "Toggle History, Goal, and Auto Approve in the top session strip.",
    slots: ["session.header.actions"],
  },
  {
    id: "session-footer",
    title: "Session footer",
    description: "Widgets shown just above the message composer.",
    slots: ["session.footer"],
  },
  {
    id: "app-header",
    title: "App header actions",
    description: "Application-wide actions, separate from Focus tools.",
    slots: ["app.header.actions"],
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

const HEADER_METRIC_LABELS: Record<HeaderMetricId, string> = {
  tokens: "Tokens", messages: "Messages", duration: "Duration", cost: "Cost",
};
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
  const [openPlace, setOpenPlace] = useState<PlaceId | null>(null);

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

  const removeCapability = (id: string, tier: CapabilityTier) => {
    placeCapability(id, tier === "technical" ? "more" : "technical");
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

  const resetAllPlacement = () => {
    if (!window.confirm("Reset button placement and canvas layout to their defaults?")) return;
    for (const capability of availableCapabilities) {
      setPlacementOverride(capability.descriptor.id, null);
    }
    resetWidgetLayout(widgets);
    setOpenPlace(null);
  };

  return (
    <>
      <PageHead title="Widgets & Layout" blurb="Choose where workspace and composer buttons appear." />

      <div className="widget-placement-toolbar">
        <span className={`widget-save-state ${storeStatus.saveStatus}`} role="status">
          {storeStatus.saveStatus === "saving"
            ? "Saving…"
            : storeStatus.saveStatus === "error"
              ? <>Couldn’t save <button type="button" onClick={retryWidgetSave}>Retry</button></>
              : "Changes saved automatically"}
        </span>
        <button type="button" onClick={undoWidgetLayout} disabled={!storeStatus.canUndo}>Undo</button>
        <button type="button" onClick={resetAllPlacement}>Reset layout</button>
      </div>

      <div className="widget-place-grid widget-inline-config">
        <section className="widget-place-card" data-settings-item="widgets.headerMetrics">
          <header><div><h3>Session header stats</h3><p>Show, hide, and drag every metric into position.</p></div></header>
          <OrderedToggleList
            all={HEADER_METRIC_IDS}
            selected={ui.headerMetrics}
            labels={HEADER_METRIC_LABELS}
            onChange={(headerMetrics) => setUiSettings({ headerMetrics })}
          />
        </section>
        <section className="widget-place-card" data-settings-item="widgets.responseActions">
          <header><div><h3>Response hover actions</h3><p>Choose and order the widgets shown in assistant response headers.</p></div></header>
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
                    title={`Move ${capability.descriptor.label} out of ${place.title}`}
                    aria-label={`Move ${capability.descriptor.label} out of ${place.title}`}
                    onClick={() => removeCapability(capability.descriptor.id, place.id)}
                  >
                    {capability.descriptor.label}<span aria-hidden="true">×</span>
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
