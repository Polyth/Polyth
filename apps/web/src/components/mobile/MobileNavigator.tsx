import {
  useEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { SessionProjection } from "@polyth/contracts";
import {
  activateProject,
  openWorktreeSessionDialog,
  setOverlay,
  setSidebarOpen,
  setUiError,
  startNewSession,
  useStore,
} from "../../store.ts";
import {
  deleteSession,
  openSession,
  refreshSessions,
  removeProject,
  renameProject,
} from "../../init.ts";
import { resolveSessionStatus, type SessionRowStatus } from "../../sessionStatus.ts";
import { Icon } from "../../icons.tsx";
import { getLocale, tr } from "../../i18n/index.ts";
import { friendlyError } from "../../settings.ts";
import { confirmAlert } from "../../alerts.ts";
import {
  archiveSessionWithPolicy,
  renameSessionTitle,
  toggleSessionPin,
} from "../../sessionActions.ts";
import { successFeedback, tapFeedback } from "../../haptics.ts";
import { copyText } from "../../utils.ts";
import { announce } from "../a11y/live.tsx";
import { useModalSurface } from "../a11y/Dialog.tsx";
import UiIcon from "../ui/Icon.tsx";
import {
  ErrorIcon,
  HelpIcon,
  LoaderIcon,
  RefreshIcon,
  ShieldIcon,
  SuccessIcon,
  WarningIcon,
} from "../ui/icons.ts";
import { Menu, type MenuEntry } from "../ui/index.ts";
import SessionDateFilterControls from "../sidebar/SessionDateFilterControls.tsx";
import {
  compareSessionNavigation,
  EMPTY_SESSION_DATE_FILTER,
  groupSessionsByActivityDate,
  sessionDateFilterActive,
  sessionDateGroupLabel,
  sessionMatchesDateFilter,
  type SessionDateFilter,
} from "../../sessionDates.ts";
import "./MobileNavigator.css";

const EXPANDED_PROJECTS_KEY = "polyth.sidebar.expandedProjects";
const INITIAL_VISIBLE_SESSIONS = 8;
const LONG_PRESS_MS = 550;
const SWIPE_WIDTH = 82;
const SWIPE_THRESHOLD = 38;

type ProjectSort = "recent" | "name";

function loadExpanded(activeProjectId: string | null): ReadonlySet<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPANDED_PROJECTS_KEY) ?? "[]") as unknown;
    if (Array.isArray(raw)) {
      const ids = raw.filter((value): value is string => typeof value === "string");
      if (ids.length > 0) return new Set(ids);
    }
  } catch {
    // Best-effort UI persistence only.
  }
  return new Set(activeProjectId ? [activeProjectId] : []);
}

function isIsolated(session: SessionProjection): boolean {
  return session.isolation?.kind === "git-worktree"
    || (session.branch ?? "").startsWith("polyth/isolate/");
}

function statusPriority(session: SessionProjection): number {
  const status = resolveSessionStatus(session);
  if (status.kind === "working") return 0;
  if (
    status.kind === "needs-approval"
    || status.kind === "needs-reply"
    || status.kind === "failed"
    || status.kind === "epoch-pending"
    || status.kind === "reconciling"
    || status.kind === "unknown"
  ) return 1;
  if ((session.attention?.unread ?? 0) > 0) return 2;
  return 3;
}

function workingDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

type MobileStatusKind = SessionRowStatus["kind"] | "waiting" | "complete";

/** Mobile status marks stay icon-based so platform fonts cannot turn a text
 * glyph into an emoji or give the same state different shapes per device. */
function statusIcon(kind: MobileStatusKind) {
  switch (kind) {
    case "working":
      return <UiIcon icon={LoaderIcon} size="sm" className="mobile-nav-state-icon" />;
    case "needs-reply":
    case "waiting":
    case "unknown":
      return <UiIcon icon={HelpIcon} size="sm" className="mobile-nav-state-icon" />;
    case "needs-approval":
      return <UiIcon icon={ShieldIcon} size="sm" className="mobile-nav-state-icon" />;
    case "unread":
    case "complete":
      return <UiIcon icon={SuccessIcon} size="sm" className="mobile-nav-state-icon" />;
    case "failed":
      return <UiIcon icon={ErrorIcon} size="sm" className="mobile-nav-state-icon" />;
    case "epoch-pending":
      return <UiIcon icon={WarningIcon} size="sm" className="mobile-nav-state-icon" />;
    case "reconciling":
      return <UiIcon icon={RefreshIcon} size="sm" className="mobile-nav-state-icon" />;
    case "regular":
      return null;
  }
}

function statusNode(session: SessionProjection, now: number) {
  const status = resolveSessionStatus(session, now);
  switch (status.kind) {
    case "working":
      return (
        <span className="mobile-nav-session-state is-running" aria-label={status.label}>
          <span className="mobile-nav-running-ring" aria-hidden="true" />
          <span className="mobile-nav-duration">{workingDuration(status.elapsedMs)}</span>
        </span>
      );
    case "needs-reply":
      return <span className="mobile-nav-session-state is-attention" aria-label={status.label}>{statusIcon(status.kind)}</span>;
    case "needs-approval":
      return <span className="mobile-nav-session-state is-attention is-approval" aria-label={status.label}>{statusIcon(status.kind)}</span>;
    case "failed":
      return <span className="mobile-nav-session-state is-failed" aria-label={status.label}>{statusIcon(status.kind)}</span>;
    case "epoch-pending":
    case "reconciling":
    case "unknown":
      return <span className="mobile-nav-session-state is-attention" aria-label={status.label}>{statusIcon(status.kind)}</span>;
    default:
      return null;
  }
}

function SessionRow({
  session,
  active,
  now,
  pinnedSessions,
  onChanged,
}: {
  session: SessionProjection;
  active: boolean;
  now: number;
  pinnedSessions: SessionProjection[];
  onChanged: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [swipeX, setSwipeX] = useState(0);
  const rowButtonRef = useRef<HTMLButtonElement>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const unread = (session.attention?.unread ?? 0) > 0;
  const rowStatus = resolveSessionStatus(session, now);

  useEffect(() => setTitle(session.title), [session.title]);
  useEffect(() => () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
  }, []);

  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  const openCurrent = async () => {
    try {
      await openSession(session.id);
      setSidebarOpen(false);
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const commitRename = async () => {
    setRenaming(false);
    try {
      const renamed = await renameSessionTitle(session.id, session.title, title);
      if (renamed) onChanged();
      else setTitle(session.title);
    } catch (error) {
      setTitle(session.title);
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const archive = async () => {
    try {
      if (await archiveSessionWithPolicy(session)) onChanged();
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const remove = async () => {
    if (session.isolation) return;
    const label = session.title || tr("sidebar.sessionlist.session");
    if (!await confirmAlert(
      tr("sidebar.sessionlist.deleteValueValueThisPermanentlyRemovesThe", { label, activity: "" }),
      { title: tr("sidebar.sessionlist.deleteSession"), confirmLabel: tr("common.delete") },
    )) return;
    try {
      await deleteSession(session.id);
      onChanged();
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const togglePin = async () => {
    try {
      await toggleSessionPin(session, pinnedSessions);
      successFeedback();
      setSwipeX(0);
      onChanged();
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const copySessionId = async () => {
    if (await copyText(session.id)) {
      successFeedback();
      announce(tr("sidebar.sessionlist.sessionIdCopied"));
    } else {
      setUiError(tr("questioncards.copyFailedClipboardUnavailable"));
    }
  };

  const entries: MenuEntry[] = [
    {
      id: "rename",
      label: tr("common.rename"),
      onSelect: () => {
        setTitle(session.title);
        setRenaming(true);
        requestAnimationFrame(() => rowButtonRef.current?.parentElement?.querySelector<HTMLInputElement>("input")?.focus());
      },
    },
    {
      id: "copy-id",
      label: tr("sidebar.sessionlist.copySessionId"),
      onSelect: () => void copySessionId(),
    },
    {
      id: "pin",
      label: session.pinned ? tr("sidebar.sessionlist.unpin") : tr("sidebar.sessionlist.pinToTop"),
      onSelect: () => void togglePin(),
    },
    "separator",
    {
      id: "archive",
      label: tr("common.archive"),
      onSelect: () => void archive(),
    },
    ...(!session.isolation ? [{
      id: "delete",
      label: tr("common.delete"),
      danger: true,
      onSelect: () => void remove(),
    } satisfies MenuEntry] : []),
  ];

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || renaming) return;
    pointerStart.current = { x: event.clientX, y: event.clientY };
    clearPress();
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      tapFeedback();
      setMenuOpen(true);
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pointerStart.current;
    if (!start || event.pointerType !== "touch") return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
    clearPress();
    if (Math.abs(dx) <= Math.abs(dy)) return;
    setSwipeX(Math.max(-SWIPE_WIDTH, Math.min(SWIPE_WIDTH, dx)));
  };

  const onPointerEnd = () => {
    clearPress();
    pointerStart.current = null;
    setSwipeX((current) => current > SWIPE_THRESHOLD ? SWIPE_WIDTH : current < -SWIPE_THRESHOLD ? -SWIPE_WIDTH : 0);
  };

  return (
    <div
      className={`mobile-nav-session-swipe${swipeX !== 0 ? " is-swiped" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={() => { clearPress(); pointerStart.current = null; setSwipeX(0); }}
    >
      <div className="mobile-nav-session-underlay" aria-hidden={swipeX === 0 || undefined}>
        <button
          className="mobile-nav-swipe-action is-leading"
          tabIndex={swipeX > 0 ? 0 : -1}
          onClick={() => void togglePin()}
        >
          {session.pinned ? tr("sidebar.sessionlist.unpin") : tr("sidebar.sessionlist.pinToTop")}
        </button>
        <button
          className="mobile-nav-swipe-action is-trailing"
          tabIndex={swipeX < 0 ? 0 : -1}
          onClick={() => void archive()}
        >
          {tr("common.archive")}
        </button>
      </div>
      <div
        className={`mobile-nav-session-row${active ? " is-active" : ""}${session.pinned ? " is-pinned" : ""}${unread ? " is-unread" : ""}${rowStatus.kind === "failed" ? " is-failed" : ""}`}
        style={{ transform: `translateX(${swipeX}px)` }}
      >
        {renaming ? (
          <input
            className="mobile-nav-inline-rename"
            value={title}
            aria-label={tr("common.rename")}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(event) => {
              if (event.key === "Enter") void commitRename();
              if (event.key === "Escape") { setTitle(session.title); setRenaming(false); }
            }}
          />
        ) : (
          <button
            ref={rowButtonRef}
            className="mobile-nav-session-main"
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (Math.abs(swipeX) > 0) { setSwipeX(0); return; }
              void openCurrent();
            }}
          >
            {session.pinned && (
              <span
                className="mobile-nav-pin-icon"
                aria-label={tr("sidebar.sessionlist.pinnedChats")}
                title={tr("sidebar.sessionlist.pinnedChats")}
              ><Icon.pin /></span>
            )}
            <span className="mobile-nav-session-title">{session.title || tr("sidebar.sessionlist.newSession")}</span>
            <span className="mobile-nav-session-trailing">
              {statusNode(session, now)}
              {unread && <span className="mobile-nav-unread-dot" aria-label={tr("sidebar.sessionlist.unreadActivity")} />}
            </span>
          </button>
        )}
        <Menu
          label={tr("sidebar.sessionlist.actionsForValue", { value: session.title || tr("sidebar.sessionlist.session") })}
          entries={entries}
          align="end"
          phonePresentation="popover"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          returnFocusRef={rowButtonRef}
        >
          {(trigger) => (
            <button className="mobile-nav-more" aria-label={tr("common.more")} {...trigger}>
              <Icon.more />
            </button>
          )}
        </Menu>
      </div>
    </div>
  );
}

export default function MobileNavigator() {
  const drawerOpen = useStore((state) => state.sidebarOpen);
  const registry = useStore((state) => state.projectRegistry);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const activeSessionId = useStore((state) => state.activeSessionId);
  const sessions = useStore((state) => state.sessions);
  const relativeTime = useStore((state) => state.settings.relativeTime);
  const projects = registry.projects;
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [dateFilter, setDateFilter] = useState<SessionDateFilter>(EMPTY_SESSION_DATE_FILTER);
  const [sort, setSort] = useState<ProjectSort>("recent");
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => loadExpanded(activeProjectId));
  const [showAllProjects, setShowAllProjects] = useState<ReadonlySet<string>>(new Set());
  const [expandedIsolation, setExpandedIsolation] = useState<ReadonlySet<string>>(new Set());
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [now, setNow] = useState(Date.now());
  const navRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useModalSurface({
    enabled: true,
    open: drawerOpen,
    onClose: () => setSidebarOpen(false),
    containerRef: navRef,
    // The drawer itself takes focus: it must open silently, without raising
    // the keyboard through an autofocused search input (same contract as
    // Sheet's data-sheet-focus).
    initialFocus: "[data-drawer-focus]",
  });

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify([...expandedProjects]));
    } catch {
      // Best-effort UI persistence only.
    }
  }, [expandedProjects]);

  useEffect(() => {
    if (!drawerOpen || !activeProjectId) return;
    void refreshSessions(activeProjectId);
  }, [drawerOpen, activeProjectId]);

  useEffect(() => {
    if (!drawerOpen) return;
    const hasWorking = sessions.some((session) => session.status === "working");
    if (!hasWorking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [drawerOpen, sessions]);

  useEffect(() => {
    if (drawerOpen) setNow(Date.now());
    else {
      setQuery("");
      setSearchMode(false);
    }
  }, [drawerOpen]);

  const projectSessions = useMemo(() => {
    const result = new Map<string, SessionProjection[]>();
    for (const session of sessions) {
      if (session.status === "archived") continue;
      const list = result.get(session.projectId) ?? [];
      list.push(session);
      result.set(session.projectId, list);
    }
    for (const list of result.values()) list.sort(compareSessionNavigation);
    return result;
  }, [sessions]);

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = projects.filter((project) => {
      const list = projectSessions.get(project.id) ?? [];
      const dated = list.filter((session) => sessionMatchesDateFilter(session, dateFilter));
      if (sessionDateFilterActive(dateFilter) && dated.length === 0) return false;
      const hasAttention = dated.some((session) => statusPriority(session) <= 1 || (session.attention?.unread ?? 0) > 0);
      if (attentionOnly && !hasAttention) return false;
      if (!needle) return true;
      if (`${project.name} ${project.path}`.toLocaleLowerCase().includes(needle)) return true;
      return dated.some((session) => `${session.title} ${session.branch ?? ""} ${session.worktreePath ?? ""}`.toLocaleLowerCase().includes(needle));
    });
    return filtered.sort((a, b) => {
      if (sort === "name") return (a.name || a.path).localeCompare(b.name || b.path);
      const score = (id: string) => {
        const list = (projectSessions.get(id) ?? []).filter((session) => sessionMatchesDateFilter(session, dateFilter));
        const bestPriority = list.reduce((best, session) => Math.min(best, statusPriority(session)), 4);
        const latest = list.reduce((value, session) => Math.max(value, session.lastTurnAt ?? session.updatedAt ?? session.createdAt), 0);
        return { bestPriority, latest };
      };
      const left = score(a.id);
      const right = score(b.id);
      return left.bestPriority - right.bestPriority || right.latest - left.latest;
    });
  }, [attentionOnly, dateFilter, projectSessions, projects, query, sort]);

  if (!drawerOpen) return null;

  const toggleProject = (projectId: string) => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    void refreshSessions(projectId);
  };

  const refreshProject = (projectId: string) => {
    void refreshSessions(projectId).catch((error) => setUiError(friendlyError(tr("common.error"), error)));
  };

  const saveProjectName = async (projectId: string) => {
    const next = projectName.trim();
    const current = projects.find((project) => project.id === projectId);
    setRenamingProjectId(null);
    if (!current || !next || next === current.name) return;
    try {
      await renameProject(projectId, next);
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const filterEntries: MenuEntry[] = [
    { heading: tr("sidebar.sortProjects") },
    {
      id: "recent",
      label: tr("sidebar.recentActivity"),
      kind: "radio",
      checked: sort === "recent",
      onSelect: () => setSort("recent"),
    },
    {
      id: "name",
      label: tr("sidebar.projectName"),
      kind: "radio",
      checked: sort === "name",
      onSelect: () => setSort("name"),
    },
    "separator",
    { heading: tr("sidebar.filterSessions") },
    {
      id: "attention",
      label: tr("sidebar.needsAttention"),
      kind: "checkbox",
      checked: attentionOnly,
      onSelect: () => setAttentionOnly((value) => !value),
    },
  ];

  return (
    <>
      <div className="mobile-nav-backdrop" aria-hidden="true" />
      <nav
        ref={navRef}
        id="polyth-session-drawer"
        className="mobile-navigator"
        role="dialog"
        aria-modal="true"
        aria-label={tr("sidebar.projectsAndSessions")}
        tabIndex={-1}
        data-drawer-focus=""
      >
        <h2 className="sr-only">{tr("sidebar.projectsAndSessions")}</h2>
        <div className={`mobile-nav-toolbar${searchMode ? " is-searching" : ""}`}>
          {searchMode && (
            <button
              className="mobile-nav-tool"
              aria-label={tr("common.back")}
              onClick={() => { setSearchMode(false); setQuery(""); searchRef.current?.blur(); }}
            >
              <Icon.back />
            </button>
          )}
          <div className="mobile-nav-search">
            <Icon.search />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder={tr("sidebar.searchSessions")}
              aria-label={tr("sidebar.searchProjectsWorktreesAndSessions")}
              onFocus={() => setSearchMode(true)}
              onChange={(event) => setQuery(event.target.value)}
            />
            {searchMode && (
              <button
                className="mobile-nav-search-clear"
                aria-label={query ? tr("sidebar.clearSearch") : tr("common.close")}
                onClick={() => {
                  if (query) setQuery("");
                  else { setSearchMode(false); searchRef.current?.blur(); }
                }}
              >
                <Icon.close />
              </button>
            )}
            {!searchMode && (
              <Menu
                label={tr("sidebar.listOptions")}
                title={tr("sidebar.listOptions")}
                align="end"
                entries={filterEntries}
                className="session-filter-menu"
                footer={<SessionDateFilterControls value={dateFilter} onChange={setDateFilter} />}
              >
                {(trigger) => (
                  <button
                    className={`mobile-nav-filter${attentionOnly || sort !== "recent" || sessionDateFilterActive(dateFilter) ? " is-active" : ""}`}
                    aria-label={tr("sidebar.listOptions")}
                    {...trigger}
                  >
                    <Icon.sliders />
                    {(attentionOnly || sort !== "recent" || sessionDateFilterActive(dateFilter)) && <span className="mobile-nav-filter-dot" />}
                  </button>
                )}
              </Menu>
            )}
          </div>
          {!searchMode && (
            <>
              <button
                className="mobile-nav-tool"
                aria-label={tr("sidebar.addProject")}
                onClick={() => { setSidebarOpen(false); setOverlay("project-picker"); }}
              >
                <Icon.plus />
              </button>
              <button
                className="mobile-nav-tool"
                aria-label={tr("common.settings")}
                onClick={() => { setSidebarOpen(false); setOverlay("settings"); }}
              >
                <Icon.gear />
              </button>
              <button
                className="mobile-nav-tool"
                aria-label={tr("sidebar.closeProjectsAndSessions")}
                onClick={() => setSidebarOpen(false)}
              >
                <Icon.close />
              </button>
            </>
          )}
        </div>

        <div className="mobile-nav-scroll">
          {visibleProjects.length === 0 && (
            <div className="mobile-nav-empty">{tr("sidebar.noMatchingSessions")}</div>
          )}
          {visibleProjects.map((project) => {
            const all = projectSessions.get(project.id) ?? [];
            const needle = query.trim().toLocaleLowerCase();
            const dated = all.filter((session) => sessionMatchesDateFilter(session, dateFilter));
            const projectMatches = `${project.name} ${project.path}`.toLocaleLowerCase().includes(needle);
            const matching = needle && !projectMatches
              ? dated.filter((session) => `${session.title} ${session.branch ?? ""} ${session.worktreePath ?? ""}`.toLocaleLowerCase().includes(needle))
              : dated;
            const pinned = matching.filter((session) => session.pinned !== undefined);
            const normal = matching.filter((session) => session.pinned === undefined && !isIsolated(session));
            const isolated = matching.filter((session) => session.pinned === undefined && isIsolated(session));
            const expanded = searchMode || expandedProjects.has(project.id);
            const showAll = searchMode || showAllProjects.has(project.id);
            const visibleNormal = showAll
              ? normal
              : normal.slice(0, Math.max(0, INITIAL_VISIBLE_SESSIONS - pinned.length));
            const hiddenCount = Math.max(0, normal.length - visibleNormal.length);
            const activeCount = matching.filter((session) => resolveSessionStatus(session, now).kind === "working").length;
            const waitingCount = matching.filter((session) => {
              const kind = resolveSessionStatus(session, now).kind;
              return kind === "needs-reply" || kind === "needs-approval";
            }).length;
            const completedCount = matching.filter((session) => resolveSessionStatus(session, now).kind === "unread").length;
            const failedCount = matching.filter((session) => resolveSessionStatus(session, now).kind === "failed").length;
            const collapsedStatusLabel = [
              activeCount > 0 ? `${activeCount} ${tr("common.running")}` : "",
              waitingCount > 0 ? `${waitingCount} ${tr("sidebar.needsAttention")}` : "",
              completedCount > 0 ? `${completedCount} ${tr("sidebar.sessionlist.unreadActivity")}` : "",
              failedCount > 0 ? `${failedCount} ${tr("common.error")}` : "",
            ].filter(Boolean).join(", ");
            const metadata = [
              tr("sidebar.sessionlist.valueSessions", { length: matching.length }),
              activeCount > 0 ? `${activeCount} active` : "",
              waitingCount > 0 ? `${waitingCount} waiting` : "",
            ].filter(Boolean).join(" · ");
            const pinnedSessions = all.filter((session) => !!session.pinned);
            const normalDateGroups = groupSessionsByActivityDate(visibleNormal);
            const isolatedDateGroups = groupSessionsByActivityDate(isolated);
            const isolationExpanded = searchMode || expandedIsolation.has(project.id)
              || isolated.some((session) => session.id === activeSessionId);

            const projectEntries: MenuEntry[] = [
              {
                id: "rename",
                label: tr("common.rename"),
                onSelect: () => { setProjectName(project.name || project.path); setRenamingProjectId(project.id); },
              },
              {
                id: "copy-path",
                label: tr("editor.filepane.copyPath"),
                onSelect: () => { void navigator.clipboard?.writeText(project.path); },
              },
              "separator",
              {
                id: "remove",
                label: tr("sidebar.closeProject"),
                danger: true,
                onSelect: () => {
                  void confirmAlert(tr("sidebar.closeValueThisRemovesItFrom", { name: project.name || project.path }), {
                    title: tr("sidebar.closeProject"),
                    confirmLabel: tr("sidebar.closeProject"),
                  }).then((ok) => { if (ok) void removeProject(project.id); });
                },
              },
            ];

            return (
              <section className={`mobile-nav-project${project.id === activeProjectId ? " is-current" : ""}`} key={project.id}>
                <div className="mobile-nav-project-head">
                  <button
                    className="mobile-nav-disclosure"
                    aria-label={expanded ? tr("sidebar.sessionlist.collapse") : tr("sidebar.sessionlist.expand")}
                    aria-expanded={expanded}
                    onClick={() => toggleProject(project.id)}
                  >
                    {expanded ? <Icon.chevronDown /> : <Icon.chevronRight />}
                  </button>
                  <span className="mobile-nav-project-icon" aria-hidden="true"><Icon.files /></span>
                  {renamingProjectId === project.id ? (
                    <input
                      className="mobile-nav-project-rename"
                      autoFocus
                      value={projectName}
                      onChange={(event) => setProjectName(event.target.value)}
                      onBlur={() => void saveProjectName(project.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveProjectName(project.id);
                        if (event.key === "Escape") setRenamingProjectId(null);
                      }}
                    />
                  ) : (
                    <button
                      className="mobile-nav-project-main"
                      onClick={() => { activateProject(project.id); setSidebarOpen(false); }}
                    >
                      <span className="mobile-nav-project-name">{project.name || project.path}</span>
                      <span className="mobile-nav-project-meta">
                        <span className="mobile-nav-project-meta-copy">
                          {expanded ? metadata : tr("sidebar.sessionlist.valueSessions", { length: matching.length })}
                        </span>
                        {!expanded && collapsedStatusLabel && (
                          <span className="mobile-nav-project-statuses" aria-label={collapsedStatusLabel}>
                            {activeCount > 0 && (
                              <span className="mobile-nav-project-status is-running" title={`${activeCount} ${tr("common.running")}`}>
                                {statusIcon("working")}
                                <span>{activeCount}</span>
                              </span>
                            )}
                            {waitingCount > 0 && (
                              <span className="mobile-nav-project-status is-waiting" title={`${waitingCount} ${tr("sidebar.needsAttention")}`}>
                                {statusIcon("waiting")}
                                <span>{waitingCount}</span>
                              </span>
                            )}
                            {completedCount > 0 && (
                              <span className="mobile-nav-project-status is-complete" title={`${completedCount} ${tr("sidebar.sessionlist.unreadActivity")}`}>
                                {statusIcon("complete")}
                                <span>{completedCount}</span>
                              </span>
                            )}
                            {failedCount > 0 && (
                              <span className="mobile-nav-project-status is-failed" title={`${failedCount} ${tr("common.error")}`}>
                                {statusIcon("failed")}
                                <span>{failedCount}</span>
                              </span>
                            )}
                          </span>
                        )}
                      </span>
                    </button>
                  )}
                  <div className="mobile-nav-project-actions">
                    <button
                      className="mobile-nav-project-action is-isolated"
                      aria-label={tr("isolation.workInIsolation")}
                      onClick={() => openWorktreeSessionDialog(project.id)}
                    >
                      <span className="mobile-nav-isolated-glyph"><Icon.package /><Icon.plus /></span>
                    </button>
                    <button
                      className="mobile-nav-project-action"
                      aria-label={tr("sidebar.newChatInValue", { value: project.name || project.path })}
                      onClick={() => { startNewSession(project.id); setSidebarOpen(false); }}
                    >
                      <Icon.plus />
                    </button>
                    <Menu label={tr("sidebar.actionsForValue", { value: project.name || project.path })} align="end" entries={projectEntries}>
                      {(trigger) => (
                        <button className="mobile-nav-project-action" aria-label={tr("common.more")} {...trigger}>
                          <Icon.more />
                        </button>
                      )}
                    </Menu>
                  </div>
                </div>

                {expanded && (
                  <div className="mobile-nav-project-body">
                    {pinned.length > 0 && (
                      <div className="mobile-nav-pinned" aria-label={tr("sidebar.sessionlist.pinnedChats")}>
                        <div className="mobile-nav-date-divider is-pinned" role="separator">
                          <span><Icon.pin />{tr("sidebar.sessionlist.pinnedChats")}</span>
                        </div>
                        {pinned.map((session) => (
                          <SessionRow
                            key={session.id}
                            session={session}
                            active={session.id === activeSessionId}
                            now={now}
                            pinnedSessions={pinnedSessions}
                            onChanged={() => refreshProject(project.id)}
                          />
                        ))}
                      </div>
                    )}
                    {normalDateGroups.map((group) => {
                      const label = sessionDateGroupLabel(group.timestamp, relativeTime, getLocale(), now);
                      return (
                        <div className="mobile-nav-date-group" key={group.key}>
                          <div className="mobile-nav-date-divider" role="separator" aria-label={label}><span>{label}</span></div>
                          {group.sessions.map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              active={session.id === activeSessionId}
                              now={now}
                              pinnedSessions={pinnedSessions}
                              onChanged={() => refreshProject(project.id)}
                            />
                          ))}
                        </div>
                      );
                    })}
                    {hiddenCount > 0 && (
                      <button
                        className="mobile-nav-more-sessions"
                        onClick={() => setShowAllProjects((current) => new Set(current).add(project.id))}
                      >
                        <span>{hiddenCount} more sessions</span>
                        <Icon.chevronRight />
                      </button>
                    )}

                    {isolated.length > 0 && (
                      <div className="mobile-nav-isolated-section">
                        <div className="mobile-nav-isolated-head">
                          <button
                            className="mobile-nav-isolated-toggle"
                            aria-expanded={isolationExpanded}
                            onClick={() => setExpandedIsolation((current) => {
                              const next = new Set(current);
                              if (next.has(project.id)) next.delete(project.id);
                              else next.add(project.id);
                              return next;
                            })}
                          >
                            <span>Isolated · {isolated.length}</span>
                            {isolationExpanded ? <Icon.chevronDown /> : <Icon.chevronRight />}
                          </button>
                          <button
                            className="mobile-nav-isolated-add"
                            aria-label={tr("isolation.workInIsolation")}
                            onClick={() => openWorktreeSessionDialog(project.id)}
                          ><Icon.plus /></button>
                        </div>
                        {isolationExpanded && (
                          <div className="mobile-nav-isolated-list">
                            {isolatedDateGroups.map((group) => {
                              const label = sessionDateGroupLabel(group.timestamp, relativeTime, getLocale(), now);
                              return (
                                <div className="mobile-nav-date-group" key={group.key}>
                                  <div className="mobile-nav-date-divider" role="separator" aria-label={label}><span>{label}</span></div>
                                  {group.sessions.map((session) => (
                                    <div className="mobile-nav-isolated-item" key={session.id}>
                                      <span className="mobile-nav-worktree-icon" aria-hidden="true"><Icon.branch /></span>
                                      <SessionRow
                                        session={session}
                                        active={session.id === activeSessionId}
                                        now={now}
                                        pinnedSessions={pinnedSessions}
                                        onChanged={() => refreshProject(project.id)}
                                      />
                                    </div>
                                  ))}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </nav>
    </>
  );
}
