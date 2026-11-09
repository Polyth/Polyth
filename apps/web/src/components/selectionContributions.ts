// Package actions on a transcript selection (`session.selection.actions`,
// described by `meta.selectionAction`). The floating toolbar and the touch dock
// list them beside their own actions and run them on the host's copy of the
// selection; the host owns both surfaces, so a package supplies data, not a view.
import type { SelectionActionContext, SelectionActionSlotMeta } from "@polyth/web-sdk";
import { listSlots, type SlotItem } from "../slots.ts";
import { useSlotVersion } from "./slots/SlotHost.ts";
import type { LucideIcon } from "./ui/index.ts";
import { PluginIcon } from "./ui/index.ts";

export const SELECTION_ACTIONS_SLOT = "session.selection.actions";

export interface SelectionActionContribution {
  id: string;
  label: string;
  title: string;
  icon: LucideIcon;
  available(context: SelectionActionContext): boolean;
  run(context: SelectionActionContext): void | Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolve = (value: unknown): string | undefined => {
  const text = typeof value === "function" ? (value as () => unknown)() : value;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
};

export function selectionActionContribution(item: SlotItem): SelectionActionContribution | null {
  const meta = isRecord(item.meta?.selectionAction) ? item.meta.selectionAction as Partial<SelectionActionSlotMeta> : null;
  const label = resolve(meta?.label);
  if (!meta || !label || typeof meta.run !== "function") return null;
  return {
    id: item.id,
    label,
    title: resolve(meta.title) ?? label,
    icon: (typeof meta.icon === "function" || isRecord(meta.icon) ? meta.icon : PluginIcon) as LucideIcon,
    available: typeof meta.available === "function" ? meta.available : () => true,
    run: meta.run,
  };
}

export function useSelectionActionContributions(): SelectionActionContribution[] {
  useSlotVersion();
  return listSlots(SELECTION_ACTIONS_SLOT)
    .map(selectionActionContribution)
    .filter((entry): entry is SelectionActionContribution => entry !== null);
}
