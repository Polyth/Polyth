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
}

export class SlotBoundary extends Component<SlotBoundaryProps, SlotBoundaryState> {
  state: SlotBoundaryState = { failed: false };

  static getDerivedStateFromError(): SlotBoundaryState {
    return { failed: true };
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

export interface SlotHostProps {
  slot: UiSlot;
  /** Host-owned bounded context passed to every contribution. */
  context?: SlotContext;
}

export default function SlotHost({ slot, context = {} }: SlotHostProps): ReactNode {
  useSlotVersion();
  const children = slotHostChildren(slot, context);
  if (children.length === 0) return null;
  return createElement(Fragment, null, children);
}
