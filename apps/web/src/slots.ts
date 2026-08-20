// Tiny slot registry mirroring contracts UiSlot. Built-in components register
// into it (proving extensibility); plugins can reach it via window.__polythSlots.
import type { ReactNode } from "react";
import type { UiSlot } from "@polyth/contracts";

export type SlotRender = (props: Record<string, unknown>) => ReactNode;

export interface SlotItem {
  id: string;
  order: number;
  render: SlotRender;
  /** Optional descriptor payload (e.g. settingsItems for item-level search). */
  meta?: Record<string, unknown>;
}

const registry = new Map<UiSlot, SlotItem[]>();

export function registerSlot(
  slot: UiSlot, id: string, render: SlotRender, order = 0, meta?: Record<string, unknown>,
): () => void {
  const item: SlotItem = { id, order, render, ...(meta ? { meta } : {}) };
  const list = registry.get(slot) ?? [];
  registry.set(slot, [...list, item]);
  return () => {
    const cur = registry.get(slot);
    if (cur) registry.set(slot, cur.filter((x) => x !== item));
  };
}

export function listSlots(slot: UiSlot): SlotItem[] {
  return [...(registry.get(slot) ?? [])].sort((a, b) => a.order - b.order);
}

export function renderSlot(slot: UiSlot, props: Record<string, unknown>): ReactNode[] {
  return listSlots(slot).map((item) => item.render(props));
}

export interface PolythSlotsApi {
  registerSlot: typeof registerSlot;
  listSlots: typeof listSlots;
  renderSlot: typeof renderSlot;
}

declare global {
  interface Window {
    __polythSlots?: PolythSlotsApi;
  }
}

export function exposeSlots(): void {
  if (typeof window !== "undefined") {
    window.__polythSlots = { registerSlot, listSlots, renderSlot };
  }
}