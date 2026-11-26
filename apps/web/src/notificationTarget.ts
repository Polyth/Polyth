// Where a notification leads. A notice from a Space joined on another server
// names that server's project and session, so opening it switches to the Space
// first and lands on the session's URL there.
import type { NotificationRecord } from "@polyth/contracts";
import { notificationCentre, type NotificationCentre } from "./notificationCentre.ts";
import { formatAppUrl } from "./router.ts";
import { getSpacesState, switchSpace } from "./spaces.ts";

type Target = Pick<NotificationRecord, "sessionId" | "projectId" | "joinedSpace">;

export function openNotificationRecord(record: Target, open: (sessionId: string) => Promise<void>): Promise<void> {
  const joined = record.joinedSpace;
  if (!joined || joined.id === getSpacesState().activeSpaceId) return open(record.sessionId);
  return switchSpace(joined.id, formatAppUrl(record.projectId, record.sessionId));
}

/** For an alert that carries only a session id (OS and push notifications):
 *  the inbox row of that session says where it lives. */
export function openNotifiedSession(
  sessionId: string,
  open: (sessionId: string) => Promise<void>,
  centre: NotificationCentre = notificationCentre,
): Promise<void> {
  const record = centre.getState().items.findLast((item) => item.sessionId === sessionId);
  return record ? openNotificationRecord(record, open) : open(sessionId);
}

/** "<Space> · <server>" of a joined Space's notice. */
export const notificationSource = (joined: NonNullable<NotificationRecord["joinedSpace"]>): string =>
  [joined.name, joined.serverLabel].filter(Boolean).join(" · ");
