import { readErrorDiagnostics } from "@polyth/contracts";
import * as store from "./store.ts";
import { openSession, startIsolatedSession, type IsolatedSessionOptions } from "./init.ts";
import { friendlyError } from "./settings.ts";
import { tr } from "./i18n/index.ts";

export interface IsolatedSessionLaunch {
  projectId: string;
  /** Worktree the dialog was opened for; a retry reopens it there. */
  worktreePath?: string;
  options: Omit<IsolatedSessionOptions, "activate" | "precache">;
}

/** Start an isolated chat without holding its dialog open. The project's
 *  spawn surface ("Spawning agent…") shows at once and the new chat takes
 *  focus when it exists, unless the person has moved elsewhere meanwhile.
 *  The create request is sent exactly once; a failure returns to the chat
 *  that was open (when still on the spawn surface) and reports through the
 *  shared notice. Reopening the dialog is offered only when the server
 *  outcome is known — an uncertain create may already exist. */
export function launchIsolatedSession(
  launch: IsolatedSessionLaunch,
  start: typeof startIsolatedSession = startIsolatedSession,
): Promise<string | null> {
  const { projectId } = launch;
  const before = store.getState();
  const previousSessionId = before.activeSessionId;
  store.setOverlay(null);
  store.setSidebarOpen(false);
  if (store.getState().activeProjectId !== projectId) store.activateProject(projectId);
  if (store.getState().activeSessionId !== null) store.activateSession(null);
  store.showSessionChat();
  const spawn = store.beginSessionSpawn(projectId);
  const onSpawnSurface = () => {
    const now = store.getState();
    return now.sessionSpawn?.requestId === spawn
      && now.activeProjectId === projectId
      && now.activeSessionId === null;
  };
  return start(projectId, {
    ...launch.options,
    precache: true,
    activate: (sessionId) => {
      store.bindSessionSpawn(spawn, sessionId);
      return onSpawnSurface();
    },
  })
    .catch((error: unknown) => {
      if (onSpawnSurface() && previousSessionId
        && store.getState().sessions.some((session) => session.id === previousSessionId)) {
        if (before.activeProjectId !== projectId) store.activateProject(before.activeProjectId);
        store.activateSession(previousSessionId);
        void openSession(previousSessionId).catch(() => {});
      }
      const diagnostic = readErrorDiagnostics(error);
      const uncertain = diagnostic.mutationOutcome === "unknown" || diagnostic.code === "outcome-unknown";
      store.setUiError(
        friendlyError(tr("worktreesessiondialog.couldnTCreateTheWorktreeChat"), error),
        uncertain ? null : {
          label: tr("common.retry"),
          run: () => store.openWorktreeSessionDialog(projectId, launch.worktreePath),
        },
      );
      return null;
    })
    .finally(() => store.finishSessionSpawn(spawn));
}
