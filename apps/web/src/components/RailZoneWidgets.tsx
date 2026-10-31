// The placed widgets of an icon rail (top rail, right rail, top-right header
// rail) as drag items of that rail. SlotHost draws a slot's widgets as one
// opaque block; a rail needs each one as its own `railDrag.ts` item so it can
// be reordered and carried to another rail like a built-in launcher. Legacy
// slot contributions render in place but do not move.
//
// Two drags, never both on one item: outside Shift-customize a placed widget
// moves with the rail's pointer drag (railDrag.ts). While Shift-customize is
// active it keeps SlotHost's HTML5 drag instead — the one that can carry it
// onto the Canvas, the status bar or any other widget area — and shows even
// when its availability check would hide it (e.g. a session control with no
// session). Alt+Arrow reorders in both modes.
import { createElement, type ReactNode } from "react";
import type { UiSlot } from "@polyth/contracts";
import { listSlots, type SlotItem } from "../slots.ts";
import { useWidgetCatalog } from "../widgets/catalog.ts";
import { useWidgetLayout } from "../widgets/widgetLayout.ts";
import { useCustomizeActive } from "../useShiftArmed.ts";
import { railItemIdOfInstance } from "../railPlacement.ts";
import type { RailDragZone } from "../railDrag.ts";
import {
  placedWidgetItems,
  SlotBoundary,
  useSlotVersion,
  type SlotContext,
} from "./slots/SlotHost.ts";

export interface RailWidgetItem {
  /** Drag id: a launcher's capability id, else `widget:<instanceId>`. */
  id: string;
  /** Placed widgets move; legacy slot contributions stay put. */
  draggable: boolean;
  /** Shift-customize: the item carries SlotHost's HTML5 drag, so the rail's
   *  pointer drag stays off it (a native drag start would cancel it). */
  nativeDrag: boolean;
  node: ReactNode;
}

const PLACED_PREFIX = "widget:";

/** Every item `slots` render, in rail order (each slot in turn, by order). */
export function useRailWidgetItems(slots: readonly UiSlot[], context: SlotContext = {}): RailWidgetItem[] {
  useSlotVersion();
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const editing = useCustomizeActive(true);
  const renderContext = { ...context, editing };
  return slots.flatMap((slot) => {
    const contributions = listSlots(slot).map((item) => ({ item, instanceId: null as string | null }));
    const placed = placedWidgetItems(slot, renderContext, widgets, layout)
      .map((item: SlotItem) => ({ item, instanceId: item.id.slice(PLACED_PREFIX.length) }));
    return [...contributions, ...placed]
      .sort((a, b) => a.item.order - b.item.order || a.item.id.localeCompare(b.item.id))
      .map(({ item, instanceId }) => ({
        id: instanceId === null ? `contribution:${slot}:${item.id}` : railItemIdOfInstance(layout, instanceId),
        draggable: instanceId !== null,
        nativeDrag: instanceId !== null && editing,
        node: createElement(SlotBoundary, { slot, item, context: renderContext }),
      }));
  });
}

/** Focus the control inside a moved item: Alt+Arrow re-renders the rail and
 *  the item wrapper itself is not focusable. */
function refocus(zone: HTMLElement | null, id: string): void {
  if (!zone) return;
  for (const element of zone.querySelectorAll<HTMLElement>("[data-rail-item]")) {
    if (element.dataset.railItem !== id) continue;
    element.querySelector<HTMLElement>("button, [href], input, [tabindex]:not([tabindex='-1'])")?.focus();
    return;
  }
}

/** One placed widget as an item of `drag`'s rail. */
export function RailWidgetItemView({ item, drag, className = "" }: {
  item: RailWidgetItem;
  drag: RailDragZone;
  className?: string;
}) {
  const props = drag.itemProps(item.id);
  return (
    <span
      className={`rail-widget-item${className ? ` ${className}` : ""}`}
      data-rail-item={props["data-rail-item"]}
      data-rail-drag-source={props["data-rail-drag-source"]}
      onPointerDown={item.nativeDrag ? undefined : props.onPointerDown}
      onKeyDown={props.onKeyDown && ((event) => {
        const zone = event.currentTarget.parentElement;
        props.onKeyDown!(event);
        if (event.defaultPrevented && typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => refocus(zone, item.id));
        }
      })}
    >
      {item.node}
    </span>
  );
}
