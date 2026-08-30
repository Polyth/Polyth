// Widget-areas (WA1): the reactive registry of placement areas. An "area" is a
// named shell region — a header row, a sidebar toolbar, the right rail, a
// canvas zone, a composer strip — that the widget layout engine can host
// widgets in. Every area id is a `UiSlot`, so areas share the slot vocabulary
// rather than inventing a parallel one.
//
// Placement is never restricted by this registry: `recommends` and
// `preferredKind` only influence ordering and the "fit" hint shown in the
// Widget Library. Any widget can be assigned to any area.
//
// Kept dependency-light on purpose (react + contracts only): `widgetLayout.ts`
// imports this module, so this module must not import `widgetLayout.ts`,
// `catalog.ts`, or anything else under `widgets/`.
import { useSyncExternalStore } from "react";
import type { UiSlot, WidgetKind } from "@polyth/contracts";

export type WidgetAreaGroup = "shell" | "sidebar" | "workspace" | "session" | "composer";
export type WidgetAreaOrientation = "row" | "column" | "canvas";
/** Rough content budget an area is shaped for — drives the fit hint only. */
export type WidgetAreaSizeHint = "icon" | "compact" | "panel" | "flexible";

export interface WidgetArea {
  /** Placement target; also the `UiSlot` a `<SlotHost>` renders. */
  id: UiSlot;
  label: string;
  description: string;
  group: WidgetAreaGroup;
  orientation: WidgetAreaOrientation;
  sizeHint: WidgetAreaSizeHint;
  /** Widget definition ids this area surfaces first. Soft — never a filter. */
  recommends: readonly string[];
  /** Kind the area is shaped for; informs the fit hint, never blocks. */
  preferredKind?: WidgetKind;
  order: number;
}

const registry = new Map<UiSlot, WidgetArea>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

/** Register (or replace by id). Returns an unregister that only removes its
 * own registration — a superseded off() is a no-op. */
export function registerArea(area: WidgetArea): () => void {
  registry.set(area.id, area);
  bump();
  return () => {
    if (registry.get(area.id) === area) {
      registry.delete(area.id);
      bump();
    }
  };
}

export function registerAreas(areas: readonly WidgetArea[]): () => void {
  const offs = areas.map(registerArea);
  return () => {
    for (let index = offs.length - 1; index >= 0; index--) offs[index]!();
  };
}

/** Deterministic listing: `order` then `id`, independent of registration time. */
export function listAreas(): WidgetArea[] {
  return [...registry.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function getArea(id: UiSlot): WidgetArea | undefined {
  return registry.get(id);
}

export function areaRecommends(id: UiSlot, widgetId: string): boolean {
  return registry.get(id)?.recommends.includes(widgetId) ?? false;
}

/** Every area (in listing order) that lists this widget id as recommended. */
export function areasRecommending(widgetId: string): WidgetArea[] {
  return listAreas().filter((area) => area.recommends.includes(widgetId));
}

export function areasByGroup(): Map<WidgetAreaGroup, WidgetArea[]> {
  const groups = new Map<WidgetAreaGroup, WidgetArea[]>();
  for (const area of listAreas()) {
    groups.set(area.group, [...(groups.get(area.group) ?? []), area]);
  }
  return groups;
}

export function areaVersion(): number {
  return version;
}

export function subscribeAreas(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Re-render whenever any area registers, replaces, or disposes. */
export function useAreas(): WidgetArea[] {
  useSyncExternalStore(subscribeAreas, areaVersion);
  return listAreas();
}

export interface PolythAreasApi {
  registerArea: typeof registerArea;
  listAreas: typeof listAreas;
}

declare global {
  interface Window {
    __polythAreas?: PolythAreasApi;
  }
}

export function exposeAreas(): void {
  if (typeof window !== "undefined") {
    window.__polythAreas = { registerArea, listAreas };
  }
}
