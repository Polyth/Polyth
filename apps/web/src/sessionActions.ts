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
    || session.status === "epoch-pending"
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
  if (session.pinned) {
    await api.organizeSession(session.id, { pinned: null });
    return;
  }
  const firstPosition = pinnedSessions.reduce(
    (min, item) => Math.min(min, item.pinned?.position ?? Number.POSITIVE_INFINITY),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(firstPosition)) {
    await api.organizeSession(session.id, { pinned: { position: 0 } });
    return;
  }
  if (firstPosition > 0) {
    await api.organizeSession(session.id, { pinned: { position: firstPosition - 1 } });
    return;
  }

  // The server accepts non-negative integer positions. When zero is occupied,
  // preserve the existing relative order at 1..N before claiming zero for the
  // new top pin. A failed shift aborts the final pin write.
  const ordered = pinnedSessions
    .filter((item) => item.pinned !== undefined && item.id !== session.id)
    .sort((a, b) => a.pinned!.position - b.pinned!.position || a.id.localeCompare(b.id));
  await Promise.all(ordered.map((item, index) =>
    item.pinned!.position === index + 1
      ? Promise.resolve()
      : api.organizeSession(item.id, { pinned: { position: index + 1 } }),
  ));
  await api.organizeSession(session.id, { pinned: { position: 0 } });
}
