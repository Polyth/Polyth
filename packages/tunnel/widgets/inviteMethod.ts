// Settings → Users → Add user: "the Polyth app" as a way in. The owner gets one
// link (https://polyth.app/join#…) that joins the new person's Polyth app to
// their own account over Polyth Link, so a server without a public address can
// still take a teammate. The host draws the choice; this module supplies the
// data for `settings.users.invite.methods` (InviteMethodSlotMeta).
import type { TunnelStatusDto } from "@polyth/contracts";
import { ApiError, type InviteMethodSlotMeta } from "@polyth/web-sdk";
import type { TunnelServerNameDto } from "../src/serverName.ts";
import type { Translate } from "./i18n.ts";

export interface TunnelInvitationDto {
  id: string;
  forUserId: string;
  profile: string;
  /** https://polyth.app/join#v=1&t=… — the link to send. */
  url: string;
  /** polyth://pair?v=1&t=… — the same ticket for a field that takes it. */
  link: string;
  expiresAt: number;
}

interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name.trim();

/** The date in the app's language, not the browser's. */
const day = (at: number, locale?: string): string => new Date(at).toLocaleDateString(locale, { day: "numeric", month: "long" });

/** Our address is not one people elsewhere can open: Link is the way in. */
export const linkPreferred = (address: string | null): boolean => !address || !address.startsWith("https:");

export function tunnelInviteMethod(
  api: Api,
  t: Translate,
  icon?: InviteMethodSlotMeta["icon"],
  locale: () => string | undefined = () => undefined,
): InviteMethodSlotMeta {
  return {
    label: () => t("tunnel.invite.label"),
    detail: () => t("tunnel.invite.detail"),
    ...(icon ? { icon } : {}),
    available: async ({ member }) => {
      if (!member) return t("tunnel.invite.notMember");
      let status: TunnelStatusDto;
      try {
        status = await api.get<TunnelStatusDto>("/api/tunnel/status");
      } catch {
        return t("tunnel.invite.unavailable");
      }
      if (!status.pairingAvailable) return t("tunnel.invite.unavailable");
      try {
        await api.get("/api/tunnel/invitations");
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 403) return t("tunnel.invite.ownerOnly");
        return t("tunnel.invite.unavailable");
      }
      return true;
    },
    preferred: ({ shareableAddress }) => linkPreferred(shareableAddress),
    issue: async ({ accountId, name }) => {
      const issued = await api.post<TunnelInvitationDto>("/api/tunnel/invitations", { forUserId: accountId });
      let server = "";
      try {
        server = (await api.get<TunnelServerNameDto>("/api/tunnel/server-name")).name.trim();
      } catch { /* the message reads fine without it */ }
      const values = { name: firstName(name), url: issued.url, date: day(issued.expiresAt, locale()), server };
      return {
        url: issued.url,
        expiresAt: issued.expiresAt,
        message: t(server ? "tunnel.invite.messageNamed" : "tunnel.invite.message", values),
        note: t("tunnel.invite.note", values),
      };
    },
  };
}
