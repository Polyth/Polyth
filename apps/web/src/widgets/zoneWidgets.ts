import type { UiSlot } from "@polyth/contracts";
import type { WidgetDef } from "./catalog.ts";
import { supportedWidgetSlots } from "./widgetLibrary.ts";
import { widgetSlotOf, type WidgetLayout } from "./widgetLayout.ts";

export function widgetsForZone(
  widgets: readonly WidgetDef[], layout: WidgetLayout, slots: readonly UiSlot[],
): { active: WidgetDef[]; inactive: WidgetDef[] } {
  const available = widgets.filter((widget) => widget.kind === "mini-widget" && (
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
