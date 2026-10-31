// Reactive slot registry mirroring contracts UiSlot (EXTENSION-SEAMS slice 1).
// Built-in components register into it (proving extensibility); plugins can
// reach it via window.__polythSlots. Hosts subscribe through subscribeSlots /
// slotVersion (components/slots/SlotHost.ts) so registration after the initial
// React mount, replacement, and disposal all re-render without editing hosts.
import type { ReactNode } from "react";
import type { UiSlot } from "@polyth/contracts";
import type { ProjectAffinity } from "@polyth/contracts/project-composition";
import { assertOwnerCanReplace } from "./packages/ownership.ts";
import { isProjectContributionRelevant, subscribeProjectRelevance } from "./packages/projectRelevance.ts";

export type SlotRender = (props: Record<string, unknown>) => ReactNode;

export interface SlotItem {
  id: string;
  order: number;
  render: SlotRender;
  /** Optional descriptor payload (e.g. settingsItems for item-level search). */
  meta?: Record<string, unknown>;
  ownerPackageId?: string;
  projectAffinity?: ProjectAffinity;
}

const registry = new Map<UiSlot, Map<string, SlotItem>>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of [...listeners]) l();
}

subscribeProjectRelevance(bump);

/** Register (or same-owner replace by id within the slot). Cross-owner
 *  collisions throw. Returns an unregister that removes only its own
 *  registration — a superseded off() is a no-op. */
export function registerSlot(
  slot: UiSlot, id: string, render: SlotRender, order = 0, meta?: Record<string, unknown>,
  ownerPackageId?: string,
  projectAffinity?: ProjectAffinity,
): () => void {
  const items = registry.get(slot) ?? new Map<string, SlotItem>();
  const existing = items.get(id);
  if (existing) {
    assertOwnerCanReplace({
      registry: `slot ${slot}`,
      id,
      existingOwner: existing.ownerPackageId,
      nextOwner: ownerPackageId,
    });
  }
  const resolvedAffinity = projectAffinity
    ?? (meta?.projectAffinity && typeof meta.projectAffinity === "object"
      ? meta.projectAffinity as ProjectAffinity
      : undefined);
  const item: SlotItem = {
    id,
    order,
    render,
    ...(meta ? { meta } : {}),
    ...(ownerPackageId ? { ownerPackageId } : {}),
    ...(resolvedAffinity ? { projectAffinity: resolvedAffinity } : {}),
  };
  items.set(id, item);
  registry.set(slot, items);
  bump();
  return () => {
    const cur = registry.get(slot);
    if (cur?.get(id) === item) {
      cur.delete(id);
      bump();
    }
  };
}

/** Raw registration probe. Unlike listSlots(), this intentionally ignores
 * project relevance so lifecycle code can distinguish an irrelevant mounted
 * contribution from a package that simply has not registered yet. */
export function hasSlotRegistration(slot: UiSlot, id: string): boolean {
  return registry.get(slot)?.has(id) === true;
}

/** Deterministic listing: `order` then `id`, independent of registration time. */
export function listSlots(slot: UiSlot): SlotItem[] {
  return [...(registry.get(slot)?.values() ?? [])]
    .filter((item) => isProjectContributionRelevant(item.ownerPackageId, item.projectAffinity))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Notifies on every registration/replacement/disposal (useSlotVersion). */
export function subscribeSlots(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function slotVersion(): number {
  return version;
}

/** Legacy raw render kept for the window API — hosts mount SlotHost instead,
 *  which adds stable keys, reactivity, and per-contribution error isolation. */
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
