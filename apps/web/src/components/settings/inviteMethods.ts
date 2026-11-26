// Ways for a new person to reach this server besides its web address
// (`settings.users.invite.methods`, described by `meta.inviteMethod`). The Add
// user flow lists them as choices beside the browser and asks the chosen one
// for the invitation; a package supplies data, the host draws the choice.
import type { InviteMethodContext, InviteMethodInvitation, InviteMethodSlotMeta } from "@polyth/web-sdk";
import { listSlots, type SlotItem } from "../../slots.ts";
import type { LucideIcon } from "../ui/index.ts";
import { PluginIcon } from "../ui/index.ts";
import { tr } from "../../i18n/index.ts";

export const INVITE_METHODS_SLOT = "settings.users.invite.methods";

export interface InviteMethod {
  id: string;
  label: string;
  detail: string;
  icon: LucideIcon;
  available(context: InviteMethodContext): Promise<true | string>;
  preferred(context: InviteMethodContext): boolean;
  issue: InviteMethodSlotMeta["issue"];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolve = (value: unknown): string | undefined => {
  const text = typeof value === "function" ? (value as () => unknown)() : value;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
};

export function inviteMethodContribution(item: SlotItem): InviteMethod | null {
  const meta = isRecord(item.meta?.inviteMethod) ? item.meta.inviteMethod as Partial<InviteMethodSlotMeta> : null;
  const label = resolve(meta?.label);
  if (!meta || !label || typeof meta.issue !== "function") return null;
  const available = meta.available;
  const preferred = meta.preferred;
  return {
    id: item.id,
    label,
    detail: resolve(meta.detail) ?? "",
    icon: (typeof meta.icon === "function" || isRecord(meta.icon) ? meta.icon : PluginIcon) as LucideIcon,
    available: async (context) => {
      if (typeof available !== "function") return true;
      try {
        const answer = await available(context);
        if (answer === true) return true;
        return typeof answer === "string" && answer.trim() ? answer.trim() : tr("settings.users.wizard.methodUnavailable");
      } catch {
        return tr("settings.users.wizard.methodUnavailable");
      }
    },
    preferred: (context) => {
      try { return typeof preferred === "function" && preferred(context) === true; } catch { return false; }
    },
    issue: meta.issue,
  };
}

export function listInviteMethods(): InviteMethod[] {
  return listSlots(INVITE_METHODS_SLOT)
    .map(inviteMethodContribution)
    .filter((entry): entry is InviteMethod => entry !== null);
}

/** Only a usable invitation: a link, a future expiry and a message. */
export function checkedInvitation(value: unknown): InviteMethodInvitation | null {
  if (!isRecord(value)) return null;
  const { url, expiresAt, message, note } = value;
  if (typeof url !== "string" || !url.trim() || typeof message !== "string" || !message.trim()) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  return { url: url.trim(), expiresAt, message, ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}) };
}
