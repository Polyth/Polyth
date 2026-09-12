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
import { resolveSessionStatus } from "../../sessionStatus.ts";
import { ago } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { tr } from "../../i18n/index.ts";
import { friendlyError } from "../../settings.ts";
import { confirmAlert } from "../../alerts.ts";
import {
  archiveSessionWithPolicy,
  renameSessionTitle,
  toggleSessionPin,
} from "../../sessionActions.ts";
import { tapFeedback } from "../../haptics.ts";
import { useModalSurface } from "../a11y/Dialog.tsx";
import { Menu, type MenuEntry } from "../ui/index.ts";
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

function smartSessionSort(a: SessionProjection, b: SessionProjection): number {
  return statusPriority(a) - statusPriority(b)
    || (b.lastTurnAt ?? b.updatedAt ?? b.createdAt) - (a.lastTurnAt ?? a.updatedAt ?? a.createdAt);
}

function activityLabel(session: SessionProjection, now: number): string {
  const timestamp = session.lastTurnAt ?? session.updatedAt ?? session.createdAt;
  return timestamp ? ago(timestamp, now) : "";
}

function workingDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
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
      return <span className="mobile-nav-session-state is-attention" aria-label={status.label}>↩</span>;
    case "needs-approval":
      return <span className="mobile-nav-session-state is-attention is-approval" aria-label={status.label}>◇</span>;
    case "failed":
      return <span className="mobile-nav-session-state is-failed" aria-label={status.label}>!</span>;
    case "epoch-pending":
    case "reconciling":
    case "unknown":
      return <span className="mobile-nav-session-state is-attention" aria-label={status.label}>{status.glyph}</span>;
    default:
      return <span className="mobile-nav-session-time">{activityLabel(session, now)}</span>;
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
      setSwipeX(0);
      onChanged();
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
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
      id: "pin",
      label: session.pinned ? tr("sidebar.sessionlist.unpin") : tr("sidebar.sessionlist.pin"),
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
          {session.pinned ? tr("sidebar.sessionlist.unpin") : tr("sidebar.sessionlist.pin")}
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
        className={`mobile-nav-session-row${active ? " is-active" : ""}${unread ? " is-unread" : ""}${rowStatus.kind === "failed" ? " is-failed" : ""}`}
        style={{ transform: `translateX(${swipeX}px)` }}
      >
        {renaming ? (
          <input
            className="mobile-nav-inline-rename"
            value={title}
            aria-label={tr("sidebar.sessionlist.renameSession")}
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
            <span className="mobile-nav-session-title">{session.title || tr("sidebar.sessionlist.untitledSession")}</span>
            <span className="mobile-nav-session-trailing">
              {statusNode(session, now)}
              {unread && <span className="mobile-nav-unread-dot" aria-label={tr("sidebar.sessionlist.unread")} />}
            </span>
          </button>
        )}
        <Menu
          label={tr("sidebar.sessionlist.actionsForValue", { value: session.title || tr("sidebar.sessionlist.session") })}
          entries={entries}
          align="end"
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
  const projects = registry.projects;
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
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
    for (const list of result.values()) list.sort(smartSessionSort);
    return result;
  }, [sessions]);

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = projects.filter((project) => {
      const list = projectSessions.get(project.id) ?? [];
      const hasAttention = list.some((session) => statusPriority(session) <= 1 || (session.attention?.unread ?? 0) > 0);
      if (attentionOnly && !hasAttention) return false;
      if (!needle) return true;
      if (`${project.name} ${project.path}`.toLocaleLowerCase().includes(needle)) return true;
      return list.some((session) => `${session.title} ${session.branch ?? ""} ${session.worktreePath ?? ""}`.toLocaleLowerCase().includes(needle));
    });
    return filtered.sort((a, b) => {
      if (sort === "name") return (a.name || a.path).localeCompare(b.name || b.path);
      const score = (id: string) => {
        const list = projectSessions.get(id) ?? [];
        const bestPriority = list.reduce((best, session) => Math.min(best, statusPriority(session)), 4);
        const latest = list.reduce((value, session) => Math.max(value, session.lastTurnAt ?? session.updatedAt ?? session.createdAt), 0);
        return { bestPriority, latest };
      };
      const left = score(a.id);
      const right = score(b.id);
      return left.bestPriority - right.bestPriority || right.latest - left.latest;
    });
  }, [attentionOnly, projectSessions, projects, query, sort]);

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
    { heading: tr("sidebar.sortSessions") },
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
            {query && (
              <button className="mobile-nav-search-clear" aria-label={tr("sidebar.clearSearch")} onClick={() => setQuery("")}>
                <Icon.close />
              </button>
            )}
            {!searchMode && (
              <Menu label={tr("sidebar.listOptions")} title={tr("sidebar.listOptions")} align="end" entries={filterEntries}>
                {(trigger) => (
                  <button
                    className={`mobile-nav-filter${attentionOnly || sort !== "recent" ? " is-active" : ""}`}
                    aria-label={tr("sidebar.listOptions")}
                    {...trigger}
                  >
                    <Icon.sliders />
                    {(attentionOnly || sort !== "recent") && <span className="mobile-nav-filter-dot" />}
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
            <div className="mobile-nav-empty">{tr("sidebar.noSessionsMatchSearch")}</div>
          )}
          {visibleProjects.map((project) => {
            const all = projectSessions.get(project.id) ?? [];
            const needle = query.trim().toLocaleLowerCase();
            const matching = needle
              ? all.filter((session) => `${session.title} ${session.branch ?? ""} ${session.worktreePath ?? ""}`.toLocaleLowerCase().includes(needle))
              : all;
            const normal = matching.filter((session) => !isIsolated(session));
            const isolated = matching.filter(isIsolated);
            const expanded = searchMode || expandedProjects.has(project.id);
            const showAll = searchMode || showAllProjects.has(project.id);
            const visibleNormal = showAll ? normal : normal.slice(0, INITIAL_VISIBLE_SESSIONS);
            const hiddenCount = Math.max(0, normal.length - visibleNormal.length);
            const activeCount = all.filter((session) => resolveSessionStatus(session, now).kind === "working").length;
            const waitingCount = all.filter((session) => {
              const kind = resolveSessionStatus(session, now).kind;
              return kind === "needs-reply" || kind === "needs-approval";
            }).length;
            const metadata = [
              `${all.length} ${all.length === 1 ? "session" : "sessions"}`,
              activeCount > 0 ? `${activeCount} active` : "",
              waitingCount > 0 ? `${waitingCount} waiting` : "",
            ].filter(Boolean).join(" · ");
            const pinnedSessions = all.filter((session) => !!session.pinned);
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
                label: tr("sidebar.copyPath"),
                onSelect: () => { void navigator.clipboard?.writeText(project.path); },
              },
              "separator",
              {
                id: "remove",
                label: tr("sidebar.removeProject"),
                danger: true,
                onSelect: () => {
                  void confirmAlert(tr("sidebar.removeProjectValue", { value: project.name || project.path }), {
                    title: tr("sidebar.removeProject"),
                    confirmLabel: tr("common.remove"),
                  }).then((ok) => { if (ok) void removeProject(project.id); });
                },
              },
            ];

            return (
              <section className={`mobile-nav-project${project.id === activeProjectId ? " is-current" : ""}`} key={project.id}>
                <div className="mobile-nav-project-head">
                  <button
                    className="mobile-nav-disclosure"
                    aria-label={expanded ? tr("sidebar.collapseProject") : tr("sidebar.expandProject")}
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
                      <span className="mobile-nav-project-meta">{metadata}</span>
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
                    <Menu label={tr("sidebar.projectActionsForValue", { value: project.name || project.path })} align="end" entries={projectEntries}>
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
                    {visibleNormal.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={session.id === activeSessionId}
                        now={now}
                        pinnedSessions={pinnedSessions}
                        onChanged={() => refreshProject(project.id)}
                      />
                    ))}
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
                            {isolated.map((session) => (
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
