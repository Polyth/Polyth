// Reactive host for a named UiSlot (EXTENSION-SEAMS slice 1). Lists
// contributions in the registry's deterministic order, keys each one by its
// stable contribution id, supplies the host-owned bounded context, and wraps
// every renderer in its own error boundary so one failing contribution
// disappears alone instead of collapsing its host.
//
// Deliberately createElement-based (a .ts file, not .tsx): Node's type
// stripping cannot load JSX, and the DOM-free node:test suite must be able to
// import this file to test ordering, keying, and failure isolation.
import { Component, createElement, Fragment, useSyncExternalStore, type ReactNode } from "react";
import type { UiSlot } from "@polyth/contracts";
import { listSlots, slotVersion, subscribeSlots, type SlotItem } from "../../slots.ts";
import { getDragWidget, setDragWidget, WIDGET_MIME } from "../../dnd.ts";
import { tr } from "../../i18n/index.ts";
import { useWidgetCatalog, type WidgetDef } from "../../widgets/catalog.ts";
import {
  setWidgetConfig,
  moveWidgetToSlot,
  updateWidgetLayout,
  useWidgetLayout,
  widgetDefinitionId,
  type WidgetLayout,
} from "../../widgets/widgetLayout.ts";
import { useCustomizeActive } from "../../useShiftArmed.ts";

/** Re-render whenever any slot contribution registers, replaces, or disposes. */
export function useSlotVersion(): number {
  return useSyncExternalStore(subscribeSlots, slotVersion);
}

export type SlotContext = Record<string, unknown>;

interface SlotItemViewProps {
  item: SlotItem;
  context: SlotContext;
}

/** Invokes the contribution inside the boundary's subtree, so a renderer that
 *  throws is caught by SlotBoundary instead of propagating to the host. */
export function SlotItemView({ item, context }: SlotItemViewProps): ReactNode {
  return createElement(Fragment, null, item.render(context));
}

interface SlotBoundaryProps extends SlotItemViewProps {
  slot: UiSlot;
}

interface SlotBoundaryState {
  failed: boolean;
  /** The registration the failure belongs to. The host keys boundaries by the
   *  stable contribution id, so a same-id replacement reuses this instance;
   *  tracking the SlotItem lets a fixed/hot-reloaded contribution recover
   *  (EXT-SEAMS-V1) instead of inheriting the old registration's failure. */
  item: SlotItem | null;
}

export class SlotBoundary extends Component<SlotBoundaryProps, SlotBoundaryState> {
  state: SlotBoundaryState = { failed: false, item: null };

  static getDerivedStateFromError(): Partial<SlotBoundaryState> {
    return { failed: true };
  }

  /** A replaced registration (new SlotItem under the same id) resets the
   *  boundary; re-renders of the unchanged registration keep it failed closed. */
  static getDerivedStateFromProps(
    props: SlotBoundaryProps, state: SlotBoundaryState,
  ): Partial<SlotBoundaryState> | null {
    if (state.item !== props.item) return { failed: false, item: props.item };
    return null;
  }

  componentDidCatch(error: Error): void {
    console.error(
      `Slot contribution "${this.props.item.id}" in "${this.props.slot}" failed to render`,
      error,
    );
  }

  render(): ReactNode {
    // Fail closed: only this contribution disappears; siblings keep rendering.
    if (this.state.failed) return null;
    return createElement(SlotItemView, { item: this.props.item, context: this.props.context });
  }
}

/** Pure element list, keyed by contribution id — exported for DOM-free tests. */
export function slotHostChildren(slot: UiSlot, context: SlotContext): ReactNode[] {
  return listSlots(slot).map((item) =>
    createElement(SlotBoundary, { key: item.id, slot, item, context }),
  );
}

/** Resolve widget instances placed in a non-canvas UI slot. Full widgets and
 * mini-widgets use the same layout; kind only selects lightweight host chrome. */
export function placedWidgetItems(
  slot: UiSlot,
  context: SlotContext,
  widgets: readonly WidgetDef[],
  layout: WidgetLayout,
): SlotItem[] {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  return (layout.slotPlacements[slot] ?? []).flatMap((instanceId, index) => {
    const placement = layout.widgets[instanceId];
    const widget = byId.get(widgetDefinitionId(layout, instanceId));
    if (!placement || !widget || (!placement.visible && !widget.requiredVisible)) return [];
    if (!widget.requiredVisible && placement.showIn && !placement.showIn.includes(layout.audience)) return [];
    const updateConfig = (config: Parameters<typeof setWidgetConfig>[2]) => {
      updateWidgetLayout((current) => setWidgetConfig(current, instanceId, config));
    };
    const editable = context.editing === true;
    return [{
      id: `widget:${instanceId}`,
      // The persisted placement array is user ordered. Definition order only
      // seeds that array; it must not override later drag-and-drop changes.
      order: index,
      render: (hostContext: SlotContext) => createElement(
        widget.kind === "mini-widget" ? "span" : "div",
        {
          className: widget.kind === "mini-widget" ? "placed-mini-widget" : "placed-slot-widget",
          "data-widget-id": instanceId,
          ...(editable ? {
            draggable: true,
            "data-widget-editing": "true",
            title: tr("widgets.widgetcanvas.moveValue", { value: widget.title }),
            onDragStart: (event: DragEvent) => {
              if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
                setDragWidget(event.dataTransfer, instanceId);
              }
            },
            onDragOver: (event: DragEvent) => {
              if (event.dataTransfer?.types.includes(WIDGET_MIME)) event.preventDefault();
            },
            onDrop: (event: DragEvent) => {
              const draggedId = event.dataTransfer ? getDragWidget(event.dataTransfer) ?? "" : "";
              const targetIndex = layout.slotPlacements[slot]?.indexOf(instanceId) ?? -1;
              if (!draggedId || targetIndex < 0) return;
              event.preventDefault();
              updateWidgetLayout((current) => moveWidgetToSlot(current, draggedId, slot, targetIndex));
            },
          } : {}),
        },
        widget.render({
          ...hostContext,
          projectId: typeof hostContext.projectId === "string" ? hostContext.projectId : null,
          sessionId: typeof hostContext.sessionId === "string" ? hostContext.sessionId : null,
          editing: hostContext.editing === true,
          instanceId,
          config: placement.config ?? {},
          updateConfig,
        }),
      ),
    }];
  });
}

export function placeableSlotHostChildren(
  slot: UiSlot,
  context: SlotContext,
  widgets: readonly WidgetDef[],
  layout: WidgetLayout,
): ReactNode[] {
  const items = [...listSlots(slot), ...placedWidgetItems(slot, context, widgets, layout)]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return items.map((item) =>
    createElement(SlotBoundary, { key: item.id, slot, item, context }),
  );
}

export interface SlotHostProps {
  slot: UiSlot;
  /** Host-owned bounded context passed to every contribution. */
  context?: SlotContext;
  /** Enables Shift/edit-mode drag reordering for placed widgets. */
  customizable?: boolean;
}

export default function SlotHost({ slot, context = {}, customizable = false }: SlotHostProps): ReactNode {
  useSlotVersion();
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const customizeActive = useCustomizeActive(customizable);
  const hostContext = customizable ? { ...context, editing: customizeActive } : context;
  const children = placeableSlotHostChildren(slot, hostContext, widgets, layout);
  if (children.length === 0) return null;
  return createElement(Fragment, null, children);
}
