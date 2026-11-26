// The navigator's Pinned group above the projects (`pinnedPlacement: "top"`,
// sidebarPrefs.ts): every chat the reader pinned, from every project of the
// Space, in one list. Each row carries its project's glyph in the state column
// so where the chat lives stays legible; the project lists leave these rows out
// (SessionList `pinnedAbove`).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionProjection, WorkspaceLabel } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { getState, overlaySessionProjection, setSidebarOpen, setUiError, useStore } from "../../store.ts";
import { openSession, refreshPinnedSessions } from "../../init.ts";
import { toggleSessionPin } from "../../sessionActions.ts";
import { friendlyError } from "../../settings.ts";
import { successFeedback } from "../../haptics.ts";
import { EMPTY_SESSION_DATE_FILTER, type SessionDateFilter } from "../../sessionDates.ts";
import { pinnedAboveSessions, sessionProjectMark } from "../../pinnedSessions.ts";
import { childrenByParent } from "../../sessionTree.ts";
import { sessionActivityState, subagentActivity } from "../../subagentActivity.ts";
import { useLaneSessions } from "../../workbench/profileNavigation.ts";
import { useShiftArmed } from "../../useShiftArmed.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { Icon } from "../../icons.tsx";
import { tr } from "../../i18n/index.ts";
import { SessionRow, useEventsTitles, type SubagentDisclosure } from "./SessionList.tsx";

export default function PinnedSessions({
  attentionOnly = false,
  dateFilter = EMPTY_SESSION_DATE_FILTER,
  selectMode = false,
  selectedSessionIds = new Set<string>(),
  onToggleSelected = () => {},
}: {
  attentionOnly?: boolean;
  dateFilter?: SessionDateFilter;
  selectMode?: boolean;
  selectedSessionIds?: ReadonlySet<string>;
  onToggleSelected?: (id: string) => void;
}) {
  const sessionsRaw = useStore((st) => st.sessions);
  const pendingSends = useStore((st) => st.pendingSends);
  const activeSessionId = useStore((st) => st.activeSessionId);
  const pageOpen = useStore((st) => st.activePage !== null);
  const currentSessionId = pageOpen ? null : activeSessionId;
  const openingSessionId = useStore((st) => st.openingSessionId);
  const projects = useStore((st) => st.projectRegistry.projects);
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const sessions = useMemo(
    () => sessionsRaw.map((session) => overlaySessionProjection(session, pendingSends) ?? session),
    [sessionsRaw, pendingSends, activeSessionId],
  );
  const laneSessions = useLaneSessions(sessions);
  const eventsTitles = useEventsTitles();
  const shellMode = useShellMode();
  const shiftQuick = useShiftArmed() && shellMode === "wide" && !selectMode;
  const [labels, setLabels] = useState<WorkspaceLabel[]>([]);
  const [expandedSubagents, setExpandedSubagents] = useState<ReadonlySet<string>>(new Set());

  // A project's own read covers only the lists that were opened: the group
  // reads every pinned chat of the Space once it shows.
  useEffect(() => {
    void refreshPinnedSessions();
    void api.listLabels().then(setLabels).catch(() => {});
  }, []);

  const live = useMemo(
    () => laneSessions.filter((session) => session.status !== "archived" && projectsById.has(session.projectId)),
    [laneSessions, projectsById],
  );
  const pinned = pinnedAboveSessions(live, projectsById, { attentionOnly, dateFilter });
  // A pinned chat's delegated children ride in its disclosure, as in its
  // project's list; a pinned child keeps a row of its own.
  const nestedChildren = useMemo(() => new Map([...childrenByParent(live)]
    .map(([parentId, children]) => [parentId, children.filter((child) => child.pinned === undefined)] as const)
    .filter(([, children]) => children.length > 0)), [live]);
  if (pinned.length === 0) return null;

  const onChanged = () => {
    void refreshPinnedSessions();
    void api.listLabels().then(setLabels).catch(() => {});
  };
  const unpin = async (session: SessionProjection) => {
    try {
      await toggleSessionPin(session, live.filter((candidate) =>
        candidate.projectId === session.projectId && candidate.pinned !== undefined));
      successFeedback();
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const row = (s: SessionProjection, subagents?: SubagentDisclosure) => {
    const mark = sessionProjectMark(projectsById, s);
    return (
      <SessionRow
        key={s.id}
        s={s}
        activeSessionId={currentSessionId}
        labels={labels}
        eventsTitle={eventsTitles.get(s.id)}
        opening={openingSessionId === s.id}
        selectMode={selectMode}
        selected={selectedSessionIds.has(s.id)}
        onToggleSelect={onToggleSelected}
        onChanged={onChanged}
        onOpen={(id) => void openSession(id).then(() => {
          if (getState().sidebarOpen) setSidebarOpen(false);
        })}
        onTogglePin={(session) => void unpin(session)}
        projectName={mark?.name}
        branch={s.branch}
        workspacePath={s.worktreePath ?? mark?.path}
        shiftQuick={shiftQuick}
        subagents={subagents}
        projectMark={s.pinned !== undefined && mark ? { project: mark.project, name: mark.name, monogram: mark.monogram } : undefined}
      />
    );
  };
  const renderNode = (item: SessionProjection, seen: ReadonlySet<string> = new Set()): ReactNode => {
    const children = (nestedChildren.get(item.id) ?? []).filter((child) => !seen.has(child.id));
    const expanded = expandedSubagents.has(item.id);
    const subagents = children.length > 0 ? {
      activity: subagentActivity(children, {
        idOf: (session) => session.id,
        childrenOf: (session) => nestedChildren.get(session.id) ?? [],
        stateOf: sessionActivityState,
      }),
      expanded,
      onToggle: () => setExpandedSubagents((previous) => {
        const next = new Set(previous);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      }),
    } : undefined;
    const path = new Set([...seen, item.id]);
    return (
      <div className="session-subagent-parent" key={item.id}>
        {row(item, subagents)}
        {expanded && children.length > 0 && (
          <div className="session-subagent-children">
            {children.map((child) => renderNode(child, path))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="session-org session-pinned session-pinned-above" aria-label={tr("sidebar.sessionlist.pinnedChats")}>
      {/* A section head like the server zone's, not a day divider: the group
          sits beside the projects, outside any one list. */}
      <div className="session-pinned-divider session-pinned-head" role="heading" aria-level={3}>
        <Icon.pin />
        <span>{tr("sidebar.sessionlist.pinnedChats")}</span>
      </div>
      {pinned.map((session) => renderNode(session))}
    </div>
  );
}
