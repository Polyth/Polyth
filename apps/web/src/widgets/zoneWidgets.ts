import type { UiSlot } from "@polyth/contracts";
import type { WidgetDef } from "./catalog.ts";
import { getArea } from "./areas.ts";
import { supportedWidgetSlots } from "./widgetLibrary.ts";
import { widgetSlotOf, type WidgetLayout } from "./widgetLayout.ts";

/** A stacked, non-icon area (e.g. "Above the composer") can hold full
 *  widgets as well as mini-widgets; rows, rails and canvases cannot. */
function holdsFullWidgets(slots: readonly UiSlot[]): boolean {
  return slots.length > 0 && slots.every((slot) => {
    const area = getArea(slot);
    return area !== undefined && area.orientation === "column" && area.sizeHint !== "icon";
  });
}

export function widgetsForZone(
  widgets: readonly WidgetDef[], layout: WidgetLayout, slots: readonly UiSlot[],
): { active: WidgetDef[]; inactive: WidgetDef[] } {
  const fullWidgets = holdsFullWidgets(slots);
  const available = widgets.filter((widget) => (widget.kind === "mini-widget" || fullWidgets) && (
    supportedWidgetSlots(widget).some((slot) => slots.includes(slot))
    || slots.includes(widgetSlotOf(layout, widget.id) as UiSlot)
  ));
  const active = available.filter((widget) =>
    layout.widgets[widget.id]?.visible === true
    && slots.includes(widgetSlotOf(layout, widget.id) as UiSlot));
  const activeIds = new Set(active.map((widget) => widget.id));
  const byTitle = (a: WidgetDef, b: WidgetDef) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  return { active: active.sort(byTitle), inactive: available.filter((widget) => !activeIds.has(widget.id)).sort(byTitle) };
}
