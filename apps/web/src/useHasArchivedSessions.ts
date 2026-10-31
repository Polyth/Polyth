import { useEffect, useState } from "react";
import { api } from "@polyth/session/web-api";
import { useStore } from "./store.ts";

/** Whether a project has any archived session, for the navigator's archive
 * entry. A loaded archived row answers locally; otherwise one bounded summary
 * read probes the server, again whenever the archive view closes. A failed
 * probe keeps the entry visible rather than hiding a real archive. */
export function useHasArchivedSessions(projectId: string, enabled = true): boolean {
  const loadedArchived = useStore((state) => state.sessions.some((session) =>
    session.projectId === projectId && session.status === "archived"));
  const archiveOpen = useStore((state) => state.overlay === "archived-sessions");
  const [probed, setProbed] = useState(false);
  useEffect(() => {
    if (!enabled || loadedArchived || archiveOpen) return;
    const controller = new AbortController();
    void api.listSessionSummaries({ projectId, archived: true, limit: 1 }, controller.signal)
      .then((page) => { if (!controller.signal.aborted) setProbed(page.sessions.length > 0); })
      .catch(() => { if (!controller.signal.aborted) setProbed(true); });
    return () => controller.abort();
  }, [projectId, enabled, loadedArchived, archiveOpen]);
  return enabled && (loadedArchived || probed);
}
