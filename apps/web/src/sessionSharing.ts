// Session sharing (Spaces §14.3): typed calls for the per-chat sharing and
// Space policy routes, plus the access rules the shell applies to what it
// shows. The server is the authority; these only decide what to offer.
// A projection without `sharing` comes from a legacy single-user install:
// every rule then answers as the owner and no sharing UI appears.
import {
  sessionAccessAtLeast,
  type SessionAccessLevel,
  type SessionProjection,
  type SessionSharingDto,
  type SessionSharingUpdate,
  type SessionSharingView,
  type SpaceSharingPolicy,
  type SpaceSharingPolicyDto,
} from "@polyth/contracts";
import { sessionFetch } from "@polyth/session/web-api";
import { tr } from "./i18n/index.ts";

const sharingPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/sharing`;
const put = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const loadSessionSharing = (sessionId: string): Promise<SessionSharingDto> =>
  sessionFetch<SessionSharingDto>(sharingPath(sessionId));

export const saveSessionSharing = (sessionId: string, update: SessionSharingUpdate): Promise<SessionSharingDto> =>
  sessionFetch<SessionSharingDto>(sharingPath(sessionId), put(update));

export const loadSharingPolicy = (): Promise<SpaceSharingPolicyDto> =>
  sessionFetch<SpaceSharingPolicyDto>("/api/sharing/policy");

export const saveSharingPolicy = (
  patch: Partial<SpaceSharingPolicy> & { expectedRevision?: number },
): Promise<SpaceSharingPolicyDto> => sessionFetch<SpaceSharingPolicyDto>("/api/sharing/policy", put(patch));

type Shareable = Pick<SessionProjection, "sharing">;

/** Rename, archive, delete and sharing changes. */
export const canManageSession = (session: Shareable): boolean =>
  !session.sharing || sessionAccessAtLeast(session.sharing.access, "manage");

/** Sending, steering, queueing and answering the agent's requests. */
export const canCollaborateSession = (session: Shareable): boolean =>
  !session.sharing || sessionAccessAtLeast(session.sharing.access, "collaborate");

export const ownerName = (owner: { name?: string } | undefined): string =>
  owner?.name?.trim() || tr("sharing.someone");

/** The navigator marker's accessible label; null when no marker shows. */
export function sharingMarkerLabel(sharing: SessionSharingView | undefined): string | null {
  if (!sharing?.shared) return null;
  if (sharing.owner) return tr("sharing.sharedBy", { name: ownerName(sharing.owner) });
  return sharing.visibility === "space" ? tr("sharing.sharedWithSpace") : tr("sharing.sharedWithPeople");
}

export const accessLabel = (access: SessionAccessLevel): string => ({
  view: tr("sharing.canView"),
  collaborate: tr("sharing.canCollaborate"),
  manage: tr("sharing.canManage"),
})[access];
