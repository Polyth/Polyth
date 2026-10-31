// Package buttons under a message (`session.message.actions` contributions) as
// entries of the quick-action layout. The bar and the Settings editor read the
// same list, so a package button is named, ordered and placed like a built-in
// one. A contribution describes itself with `meta.messageAction`
// (MessageActionSlotMeta in @polyth/web-sdk); one without it is still listed,
// by its id, as a bar-only button so it can at least be moved or turned off.
import type { MessageActionSlotMeta } from "@polyth/web-sdk";
import {
  packageMessageActionId,
  type MessageActionRole,
  type PackageMessageActionSlot,
} from "../messageActionLayout.ts";
import { listSlots, type SlotItem } from "../slots.ts";
import { useSlotVersion } from "./slots/SlotHost.ts";
import { PluginIcon, type LucideIcon } from "./ui/index.ts";

export const MESSAGE_ACTIONS_SLOT = "session.message.actions";

export interface MessageActionContribution extends PackageMessageActionSlot {
  item: SlotItem;
  label: string;
  description?: string;
  icon: LucideIcon;
  /** Whether this message can offer the action (menu entries only: a bar
   *  contribution decides for itself by rendering nothing). */
  available: (context: Readonly<Record<string, unknown>>) => boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => {
  const resolved = typeof value === "function" ? (value as () => unknown)() : value;
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined;
};

function humanize(id: string): string {
  const words = id.split(/[._:-]+/).filter(Boolean).join(" ");
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}

export function messageActionContribution(item: SlotItem, role: MessageActionRole): MessageActionContribution | null {
  const meta = isRecord(item.meta?.messageAction) ? item.meta.messageAction as Partial<MessageActionSlotMeta> : null;
  const roles = Array.isArray(meta?.roles) ? meta.roles : null;
  if (roles && !roles.includes(role)) return null;
  const description = text(meta?.description) ?? text(item.meta?.description);
  return {
    id: packageMessageActionId(item.id),
    item,
    label: text(meta?.label) ?? text(item.meta?.label) ?? text(item.meta?.title) ?? humanize(item.id),
    ...(description ? { description } : {}),
    icon: (typeof meta?.icon === "function" || isRecord(meta?.icon) ? meta.icon : PluginIcon) as LucideIcon,
    menu: meta?.menu === true,
    ...(meta?.defaultPlacement === "bar" || meta?.defaultPlacement === "menu" || meta?.defaultPlacement === "off"
      ? { defaultPlacement: meta.defaultPlacement }
      : {}),
    ...(Array.isArray(meta?.replaces) ? { replaces: meta.replaces.filter((id): id is string => typeof id === "string") } : {}),
    available: typeof meta?.available === "function" ? meta.available : () => true,
  };
}

export function listMessageActionContributions(role: MessageActionRole): MessageActionContribution[] {
  return listSlots(MESSAGE_ACTIONS_SLOT)
    .map((item) => messageActionContribution(item, role))
    .filter((entry): entry is MessageActionContribution => entry !== null);
}

/** Reactive list: re-reads when a package registers, replaces or disposes. */
export function useMessageActionContributions(role: MessageActionRole): MessageActionContribution[] {
  useSlotVersion();
  return listMessageActionContributions(role);
}
