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

type MiniPlaceId = "composer" | "session-header" | "app-header";
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
    description: "Actions that belong to the current session.",
    slots: ["session.header.actions"],
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

export default function WidgetsPage() {
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
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
