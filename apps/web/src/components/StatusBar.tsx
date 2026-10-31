import { Fragment, createElement, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { UiSlot } from "@polyth/contracts";
import { setUiSettings, useUiSettings } from "../uiPrefs.ts";
import { tr } from "../i18n/index.ts";
import { getDragWidget, WIDGET_MIME } from "../dnd.ts";
import {
  moveWidgetToSlot,
  setWidgetConfig,
  updateWidgetLayout,
  useWidgetLayout,
  widgetDefinitionId,
  type WidgetLayout,
} from "../widgets/widgetLayout.ts";
import { useStore } from "../store.ts";
import { useWidgetCatalog, widgetIsAvailable, type WidgetDef } from "../widgets/catalog.ts";
import { StatusbarModelContext } from "../statusbar/model.ts";
import { useSegmentFit } from "../statusbar/fitSegments.ts";
import { useStatusbarData } from "../statusbar/useStatusbarData.ts";
import SlotHost from "./slots/SlotHost.ts";
import CustomizeZoneButton, { type ZoneAction } from "./CustomizeZoneButton.tsx";
import { HideIcon } from "./ui/index.ts";
import "./StatusBar.css";

const LEADING: UiSlot = "app.statusbar.leading";
const TRAILING: UiSlot = "app.statusbar.trailing";

/** A widget returns to the end it was designed for; anything else (a launcher,
 *  a header action) joins the trailing end. */
function endFor(widget: WidgetDef): UiSlot {
  return widget.defaultSlot === LEADING ? LEADING : TRAILING;
}

/** Turning the bar off is offered where it is being looked at, beside the
 *  segments, in the footer of the bar's own Customize editor. */
const hideAction = (): ZoneAction => ({
  id: "statusbar:hide",
  label: tr("statusbar.hide"),
  icon: HideIcon,
  onSelect: () => setUiSettings({ statusBar: "off" }),
});

/**
 * The optional bar under the workspace (Settings → Appearance → Status bar).
 * Off renders nothing and runs nothing; `workflows` shows only a slim activity
 * strip while a contributing widget has something to say; `always` is the full
 * bar whose two ends are widget areas. The segments themselves live in
 * `widgets/statusbarWidgets.tsx`; the workflow chip comes from its own package.
 */
export default function StatusBar() {
  const mode = useUiSettings().statusBar;
  if (mode === "off") return null;
  return mode === "workflows" ? <StatusbarStrip /> : <StatusbarFull />;
}

/** Widgets marked `statusbarStrip` render bare in the strip: they own the bar
 *  frame (there is no cluster or placement wrapper) and return nothing when
 *  they have no live content, which takes the whole strip with them. The host
 *  names no package here. */
function statusbarStripNodes(
  widgets: readonly WidgetDef[],
  layout: WidgetLayout,
  projectId: string | null,
  sessionId: string | null,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  for (const slot of [LEADING, TRAILING] as const) {
    for (const instanceId of layout.slotPlacements[slot] ?? []) {
      const placement = layout.widgets[instanceId];
      if (!placement) continue;
      const definition = widgets.find((widget) => widget.id === widgetDefinitionId(layout, instanceId));
      if (!definition) continue;
      if ((definition as WidgetDef & { statusbarStrip?: boolean }).statusbarStrip !== true) continue;
      if (!placement.visible && !definition.requiredVisible) continue;
      if (!definition.requiredVisible && placement.showIn && !placement.showIn.includes(layout.audience)) continue;
      const config = placement.config ?? {};
      if (!widgetIsAvailable(definition, { projectId, sessionId, config })) continue;
      nodes.push(
        createElement(
          Fragment,
          { key: instanceId },
          definition.render({
            projectId,
            sessionId,
            editing: false,
            strip: true,
            instanceId,
            config,
            updateConfig: (next) => {
              updateWidgetLayout((current) => setWidgetConfig(current, instanceId, next));
            },
          }),
        ),
      );
    }
  }
  return nodes;
}

/** The minimal strip: no Git scan, no cluster chrome. */
function StatusbarStrip() {
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const nodes = statusbarStripNodes(widgets, layout, projectId, sessionId);
  if (nodes.length === 0) return null;
  return <Fragment>{nodes}</Fragment>;
}

function StatusbarFull() {
  // One probe set for the whole bar: a serial Git scan of the repositories in
  // scope. Package segments (the workflow chip) fetch their own data.
  const model = useStatusbarData({ git: true });
  const context = { projectId: model.projectId, sessionId: model.sessionId };
  return (
    <StatusbarModelContext.Provider value={model}>
      <div className="statusbar customize-zone" data-statusbar="always" role="group" aria-label={tr("statusbar.label")}>
        <Cluster slot={LEADING} context={context} />
        <Cluster slot={TRAILING} context={context} />
        <CustomizeZoneButton slot={TRAILING} slots={[LEADING, TRAILING]} placeIn={endFor} actions={[hideAction()]} />
      </div>
    </StatusbarModelContext.Provider>
  );
}

/** One end of the bar. Besides rendering its placed widgets it is a drop
 *  target of its own, so a dragged segment can be moved into an empty end or
 *  appended after the last one; dropping on a segment still reorders there. */
function Cluster({ slot, context }: { slot: UiSlot; context: Record<string, unknown> }) {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Whole segments or none: what does not fit leaves the layout, last first.
  useSegmentFit(ref);
  const carriesWidget = (event: DragEvent) => event.dataTransfer.types.includes(WIDGET_MIME);
  return (
    <div
      ref={ref}
      className="statusbar-cluster"
      data-end={slot === LEADING ? "leading" : "trailing"}
      data-drop-target={over || undefined}
      onDragOver={(event) => {
        if (!carriesWidget(event)) return;
        // A segment under the pointer has already claimed the event.
        if (event.defaultPrevented) { setOver(false); return; }
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        setOver(false);
        if (event.defaultPrevented) return;
        const id = getDragWidget(event.dataTransfer);
        if (!id) return;
        event.preventDefault();
        updateWidgetLayout((current) => moveWidgetToSlot(current, id, slot));
      }}
    >
      <SlotHost slot={slot} context={context} customizable />
    </div>
  );
}
