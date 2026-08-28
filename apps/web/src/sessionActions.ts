import { api } from "@polyth/session/web-api";
import { archiveSession } from "./init.ts";
import { confirmAlert } from "./alerts.ts";
import { getUiSettings } from "./uiPrefs.ts";
import { tr } from "./i18n/index.ts";

export interface SessionActionTarget {
  id: string;
  title: string;
  status?: string;
  pinned?: { position: number } | null;
  attention?: { questions?: number; permissions?: number };
}

/** Shared archive guard for sidebar and palette session verbs. */
export function needsDestructiveConfirm(session: SessionActionTarget): boolean {
  return session.status === "working" || session.status === "waiting"
    || session.status === "reconciling" || session.status === "unknown"
    || (session.attention?.questions ?? 0) > 0
    || (session.attention?.permissions ?? 0) > 0;
}

/** Archive through the canonical session action after applying the same user
 * confirmation policy everywhere the verb is exposed. */
export async function archiveSessionWithPolicy(
  session: SessionActionTarget,
): Promise<boolean> {
  const label = session.title || tr("sidebar.sessionlist.session");
  if (
    needsDestructiveConfirm(session)
    && !await confirmAlert(
      tr("sidebar.sessionlist.archiveValueTheAgentIsStillRunning", { label }),
      {
        title: tr("sidebar.sessionlist.archiveActiveSession"),
        confirmLabel: tr("common.archive"),
      },
    )
  ) return false;
  if (
    !needsDestructiveConfirm(session)
    && getUiSettings().confirmSessionArchive
    && !await confirmAlert(
      tr("sidebar.sessionlist.archiveValue", { label }),
      {
        title: tr("sidebar.sessionlist.archiveSession"),
        confirmLabel: tr("common.archive"),
      },
    )
  ) return false;
  await archiveSession(session.id);
  return true;
}

/** Rename via the one REST handler. Empty and unchanged titles are no-ops. */
export async function renameSessionTitle(
  sessionId: string,
  currentTitle: string,
  nextTitle: string,
): Promise<string | null> {
  const title = nextTitle.trim();
  if (!title || title === currentTitle) return null;
  await api.renameSession(sessionId, title);
  return title;
}

/** Pin/unpin via the projection-only organization route. */
export async function toggleSessionPin(
  session: SessionActionTarget,
  pinnedSessions: readonly SessionActionTarget[],
): Promise<void> {
  const position = pinnedSessions.reduce(
    (max, item) => Math.max(max, item.pinned?.position ?? -1),
    -1,
  ) + 1;
  await api.organizeSession(session.id, {
    pinned: session.pinned ? null : { position },
  });
}
