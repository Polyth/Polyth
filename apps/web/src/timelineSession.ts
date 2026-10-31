// Which session a transcript subtree renders. The one live chat surface reads
// the active session; the split view's companion pane renders a second,
// background session through the same Timeline. Rows and their hooks ask this
// module instead of `activeSessionId`, so a companion transcript never shows
// the active chat's model, pins or project files. Presentation only: no event
// is appended and nothing here routes a mutation — a companion pane is focused
// (made active) before any of its controls act.
import { createContext, createElement, useContext, type ReactNode } from "react";
import { useStore } from "./store.ts";

export interface TimelineSessionScope {
  sessionId: string;
  /** True for a split view's companion pane: a view of a background session
   *  whose controls wait for the pane to be focused. */
  companion: boolean;
}

const TimelineSessionContext = createContext<TimelineSessionScope | null>(null);

export function TimelineSessionProvider({ sessionId, companion = false, children }: {
  sessionId: string;
  companion?: boolean;
  children?: ReactNode;
}) {
  return createElement(TimelineSessionContext.Provider, { value: { sessionId, companion } }, children);
}

/** The session this transcript renders: the scoped one, else the active chat. */
export function useTimelineSessionId(): string | null {
  const scope = useContext(TimelineSessionContext);
  const active = useStore((state) => state.activeSessionId);
  return scope ? scope.sessionId : active;
}

/** The project of the rendered session. A companion pane may show a chat of
 *  another project than the open workspace, so it reads the session's own. */
export function useTimelineProjectId(): string | null {
  const scope = useContext(TimelineSessionContext);
  return useStore((state) => {
    if (!scope) return state.activeProjectId;
    return state.sessions.find((session) => session.id === scope.sessionId)?.projectId ?? state.activeProjectId;
  });
}

/** True inside a split view's companion pane. */
export function useTimelineCompanion(): boolean {
  return useContext(TimelineSessionContext)?.companion === true;
}
