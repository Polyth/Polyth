// Ways for a new person to reach this server besides its web address
// (`settings.users.invite.methods`, described by `meta.inviteMethod`). The Add
// user flow lists them as choices beside the browser and asks the chosen one
// for the invitation; a package supplies data, the host draws the choice.
import type { InviteMethodContext, InviteMethodInvitation, InviteMethodInvitations, InviteMethodSlotMeta } from "@polyth/web-sdk";
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
  invitations?: () => Promise<InviteMethodInvitations>;
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
    ...(typeof meta.invitations === "function" ? { invitations: meta.invitations } : {}),
  };
}

export function listInviteMethods(): InviteMethod[] {
  return listSlots(INVITE_METHODS_SLOT)
    .map(inviteMethodContribution)
    .filter((entry): entry is InviteMethod => entry !== null);
}

/** Where each invited person stands, by account id: joined (and when) or
 *  still holding an unopened link (until when). Joining wins over a newer
 *  link, e.g. one for a second device. */
export type InviteStatus = { joined: number } | { until: number };

export async function inviteStatuses(methods: readonly InviteMethod[] = listInviteMethods()): Promise<Map<string, InviteStatus>> {
  const statuses = new Map<string, InviteStatus>();
  const answers = await Promise.all(methods.map((method) => method.invitations?.().catch(() => null)));
  for (const answer of answers) {
    for (const entry of Array.isArray(answer?.pending) ? answer.pending : []) {
      if (typeof entry?.accountId === "string" && Number.isFinite(entry.expiresAt) && !statuses.has(entry.accountId)) {
        statuses.set(entry.accountId, { until: entry.expiresAt });
      }
    }
  }
  for (const answer of answers) {
    for (const entry of Array.isArray(answer?.joined) ? answer.joined : []) {
      const known = statuses.get(entry?.accountId);
      if (typeof entry?.accountId !== "string" || !Number.isFinite(entry.at)) continue;
      if (!known || !("joined" in known) || known.joined < entry.at) statuses.set(entry.accountId, { joined: entry.at });
    }
  }
  return statuses;
}

/** Only a usable invitation: a link, a future expiry and a message. */
export function checkedInvitation(value: unknown): InviteMethodInvitation | null {
  if (!isRecord(value)) return null;
  const { url, expiresAt, message, note } = value;
  if (typeof url !== "string" || !url.trim() || typeof message !== "string" || !message.trim()) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  return { url: url.trim(), expiresAt, message, ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}) };
}
