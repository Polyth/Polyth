import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import {
  getState, useStore, activateProject, openWorkspacePane, openWorktreeSessionDialog, setOverlay,
  setSidebarOpen, setUiError, startNewSession,
} from "../store.ts";
import {
  getSyncStatus, reconnectSync, refreshSessions, removeProject, renameProject, subscribeSyncStatus,
} from "../init.ts";
import { MOD } from "../format.ts";
import { friendlyError } from "../settings.ts";
import { Icon } from "../icons.tsx";
import SessionList from "./sidebar/SessionList.tsx";
import ImportSessionsDialog from "./ImportSessionsDialog.tsx";
import { useShellMode } from "../responsiveShell.ts";
import { useModalSurface } from "./a11y/Dialog.tsx";
import SlotHost from "./slots/SlotHost.ts";
import { useSidebarExpanded } from "../sidebarPresentation.ts";
import { useShiftArmed } from "../useShiftArmed.ts";
import { useSidebarViewMode } from "../sidebarPrefs.ts";
import EmptyState from "./EmptyState.tsx";
import {
  Button, CloseIcon, ComposeIcon, FilterIcon, IconButton, Menu, Popover, SidebarIcon,
  type MenuEntry,
} from "./ui/index.ts";
import {
  SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH,
  clampSidebarWidth, setSidebarLayout, useSidebarLayout,
} from "../sidebarLayout.ts";
import { api } from "@polyth/session/web-api";
import { announce } from "./a11y/live.tsx";
import ProjectAppearanceDialog from "./ProjectAppearanceDialog.tsx";
import { tr } from "../i18n/index.ts";
import { confirmAlert } from "../alerts.ts";
import { errorFeedback, tapFeedback } from "../haptics.ts";
import {
  PULL_REFRESH_DISTANCE, pullRefreshDistance, type GesturePoint,
} from "../mobileGestures.ts";

const EXPANDED_PROJECTS_KEY = "polyth.sidebar.expandedProjects";

function loadExpandedProjects(activeProjectId: string | null): ReadonlySet<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPANDED_PROJECTS_KEY) ?? "[]") as unknown;
    if (Array.isArray(raw)) {
      const ids = raw.filter((id): id is string => typeof id === "string");
      if (ids.length > 0) return new Set(ids);
    }
  } catch {
    // Corrupt or unavailable UI storage falls back to revealing the active project.
  }
  return new Set(activeProjectId ? [activeProjectId] : []);
}

/** Close the drawer only when it is actually open (avoids no-op re-renders
 *  in wide mode, where the sidebar is a plain inline column). */
function closeDrawer(): void {
  if (getState().sidebarOpen) setSidebarOpen(false);
}

export default function Sidebar() {
  // Canonical registry truth: `projects` has one owner; loading and failure
  // never claim there are no projects (UX-ONBOARDING).
  const registry = useStore((s) => s.projectRegistry);
  const projects = registry.projects;
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const drawerOpen = useStore((s) => s.sidebarOpen);
  // Honest presentation state for app.nav contributions: on desktop the
  // sidebar is always expanded regardless of the mobile drawer flag.
  const expanded = useSidebarExpanded(drawerOpen);
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [importingProject, setImportingProject] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [connectionOpen, setConnectionOpen] = useState(false);
  const shiftHeld = useShiftArmed();
  const [appearanceProjectId, setAppearanceProjectId] = useState<string | null>(null);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const syncStatus = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, () => "disconnected");
  const host = typeof location === "undefined" ? tr("sidebar.localServer") : location.host;

  // Persisted view mode: list shows the active project; tree expands projects
  // into worktrees and sessions. Expansion is per-project UI state.
  const viewMode = useSidebarViewMode();
  const [expandedTrees, setExpandedTrees] = useState<ReadonlySet<string>>(
    () => loadExpandedProjects(activeProjectId),
  );
  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify([...expandedTrees]));
    } catch {
      // UI expansion persistence is best effort.
    }
  }, [expandedTrees]);
  useEffect(() => {
    // The active project always reveals its worktree/session branch.
    if (!activeProjectId) return;
    setExpandedTrees((prev) => (prev.has(activeProjectId) ? prev : new Set(prev).add(activeProjectId)));
  }, [activeProjectId, viewMode]);
  const toggleTree = (id: string) => {
    setExpandedTrees((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        void refreshSessions(id); // nested lists need this project's sessions
      }
      return next;
    });
  };
  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matchesAttention = (projectId: string) => sessions.some((session) =>
      session.projectId === projectId
      && session.status !== "archived"
      && (session.status === "working"
        || session.status === "waiting"
        || session.status === "reconciling"
        || session.status === "unknown"
        || (session.attention?.questions ?? 0) > 0
        || (session.attention?.permissions ?? 0) > 0));
    const filtered = projects.filter((candidate) => {
      if (attentionOnly && !matchesAttention(candidate.id)) return false;
      if (!needle) return true;
      if (`${candidate.name} ${candidate.path}`.toLowerCase().includes(needle)) return true;
      return sessions.some((session) =>
        session.projectId === candidate.id
        && `${session.title} ${session.branch ?? ""} ${session.worktreePath ?? ""}`.toLowerCase().includes(needle));
    });
    return filtered.sort((a, b) => {
      if (sort === "name") return (a.name || a.path).localeCompare(b.name || b.path);
      const latest = (projectId: string) => sessions.reduce(
        (value, session) => session.projectId === projectId ? Math.max(value, session.updatedAt) : value,
        0,
      );
      return latest(b.id) - latest(a.id) || (a.name || a.path).localeCompare(b.name || b.path);
    });
  }, [attentionOnly, projects, query, sessions, sort]);
  // UX-A390: below 821px the sidebar is a modal drawer. It never opens by
  // itself when the viewport shrinks — wide visibility is not a persisted
  // drawer-open preference.
  const mode = useShellMode();
  const compact = mode !== "wide";
  // Compact navigation is always the complete project → worktree → session
  // tree. Desktop keeps the user's optional list-mode preference.
  const effectiveViewMode = compact ? "tree" : viewMode;
  // Finding 2: wide-mode width + collapse persist across reloads; the compact
  // drawer keeps its own responsive geometry and ignores both.
  const layout = useSidebarLayout();
  const collapsed = !compact && layout.collapsed;
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? layout.width;
  const navRef = useRef<HTMLElement>(null);
  const connectionTriggerRef = useRef<HTMLButtonElement>(null);
  const sideScrollRef = useRef<HTMLDivElement>(null);
  const pullStartRef = useRef<GesturePoint | null>(null);
  const pullDistanceRef = useRef(0);
  const pullArmedRef = useRef(false);
  const prevCompact = useRef(compact);
  useEffect(() => {
    if (!prevCompact.current && compact) closeDrawer();
    prevCompact.current = compact;
  }, [compact]);
  useModalSurface({
    enabled: compact,
    open: compact && drawerOpen,
    onClose: () => setSidebarOpen(false),
    containerRef: navRef,
  });
  const setPull = (distance: number) => {
    pullDistanceRef.current = distance;
    setPullDistance(distance);
    const armed = distance >= PULL_REFRESH_DISTANCE;
    if (armed && !pullArmedRef.current) tapFeedback();
    pullArmedRef.current = armed;
  };
  const startPull = (event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!compact || pullRefreshing || !touch || (sideScrollRef.current?.scrollTop ?? 0) > 0) return;
    pullStartRef.current = { x: touch.clientX, y: touch.clientY };
  };
  const movePull = (event: ReactTouchEvent<HTMLDivElement>) => {
    const start = pullStartRef.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    setPull(pullRefreshDistance(
      start,
      { x: touch.clientX, y: touch.clientY },
      sideScrollRef.current?.scrollTop ?? 0,
    ));
  };
  const refreshFromPull = async () => {
    setPullRefreshing(true);
    setPull(PULL_REFRESH_DISTANCE);
    try {
      await Promise.all(projects.map((candidate) => refreshSessions(candidate.id)));
    } catch (error) {
      errorFeedback();
      setUiError(friendlyError(tr("common.error"), error));
    } finally {
      setPullRefreshing(false);
      setPull(0);
    }
  };
  const finishPull = () => {
    pullStartRef.current = null;
    if (pullDistanceRef.current >= PULL_REFRESH_DISTANCE) {
      void refreshFromPull();
      return;
    }
    setPull(0);
  };
  const toggleSelectMode = () => {
    setSelectMode((current) => {
      if (current) setSelectedSessionIds(new Set());
      return !current;
    });
  };
  const toggleSelectedSession = (id: string) => {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const runBulk = async (op: "archive" | "restore") => {
    const ids = [...selectedSessionIds];
    if (ids.length === 0) return;
    const affectedProjects = new Set(
      sessions.filter((session) => selectedSessionIds.has(session.id)).map((session) => session.projectId),
    );
    try {
      const result = await api.bulkSessions(op, ids);
      const failNote = result.failed.length
        ? tr("sidebar.failedCountValue", {
            count: result.failed.length,
            codes: result.failed.map((failure) => failure.code).join(", "),
          })
        : "";
      const operation = op === "archive"
        ? tr("sidebar.sessionlist.archived")
        : tr("common.restore");
      announce(result.succeeded.length === 1
        ? tr("sidebar.valueOneSessionValue", { operation, failNote })
        : tr("sidebar.valueSessionsValue", {
            operation,
            count: result.succeeded.length,
            failNote,
          }));
      if (result.failed.length > 0) {
        setUiError(tr("sidebar.bulkSessionOperationFailed", {
          operation: op === "archive" ? tr("common.archive") : tr("common.restore"),
          failures: result.failed.map((failure) => `${failure.id.slice(0, 8)}:${failure.code}`).join(", "),
        }));
      }
      setSelectedSessionIds(new Set());
      setSelectMode(false);
      await Promise.all([...affectedProjects].map((projectId) => refreshSessions(projectId)));
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };
  const saveProjectName = async (id: string) => {
    const name = projectName.trim();
    setRenamingProject(null);
    const current = projects.find((p) => p.id === id);
    if (!name || !current || name === current.name) return;
    try {
      // Registry action: the server-returned project is upserted in place —
      // no component-owned `setProjects(await listProjects())` write.
      await renameProject(id, name);
    } catch (e) {
      setUiError(friendlyError(tr("common.error"), e));
    }
  };

  // Mouse-drag resize: transient width during the drag, one persisted write
  // on release (drag state stays local; the pref module owns durability).
  const startResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let next = startWidth;
    const onMove = (ev: MouseEvent) => {
      next = clampSidebarWidth(startWidth + (ev.clientX - startX));
      setDragWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setSidebarLayout({ width: next });
      setDragWidth(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onResizeKey = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setSidebarLayout({ width: width + (event.key === "ArrowRight" ? 16 : -16) });
  };

  return (
    <>
      {compact && drawerOpen && (
        <div
          className="menu-backdrop sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <nav
        ref={navRef}
        id="polyth-session-drawer"
        className={`sidebar ${drawerOpen ? "open" : ""}${collapsed ? " collapsed" : ""}`}
        style={!compact ? { width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : width, minWidth: collapsed ? SIDEBAR_COLLAPSED_WIDTH : width } : undefined}
        {...(compact ? { role: "dialog", "aria-modal": true, "aria-label": tr("sidebar.projectsAndSessions") } : {})}
      >
        <h2 className="sr-only">{tr("sidebar.projectsAndSessions")}</h2>
        {collapsed && (
          <div className="sidebar-collapsed-rail">
            <IconButton
              icon={SidebarIcon}
              className="sidebar-expand"
              label={tr("sidebar.expandProjectsAndSessions")}
              aria-expanded="false"
              onClick={() => setSidebarLayout({ collapsed: false })}
            />
          </div>
        )}
        {!collapsed && (<>
        {compact && (
          <div className="sidebar-drawer-header">
            <div className="sidebar-drawer-identity">
              <span className="sidebar-drawer-mark" aria-hidden="true">{tr("header.p")}</span>
              <span className="sidebar-drawer-copy">
                <strong>{tr("sidebar.projectsAndSessions")}</strong>
                <small title={project?.path}>{project?.name || project?.path || tr("header.polyth")}</small>
              </span>
            </div>
            <IconButton
              icon={CloseIcon}
              label={tr("sidebar.closeProjectsAndSessions")}
              size="lg"
              className="drawer-close"
              onClick={() => setSidebarOpen(false)}
            />
          </div>
        )}
        <div className="sidebar-service-bar">
          <div className="sidebar-search">
            <Icon.search />
            <input
              type="search"
              value={query}
              placeholder={tr("sidebar.searchSessions")}
              aria-label={tr("sidebar.searchProjectsWorktreesAndSessions")}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                className="sidebar-search-clear"
                aria-label={tr("sidebar.clearSessionSearch")}
                title={tr("sidebar.clearSearch")}
                onClick={() => setQuery("")}
              >{tr("sidebar.message")}</button>
            )}
          </div>
          {project && (
            <IconButton
              icon={ComposeIcon}
              label={tr("sidebar.newChatInValue", { value: project.name || project.path })}
              className="sidebar-new-session"
              onClick={() => {
                startNewSession(project.id);
                closeDrawer();
              }}
            />
          )}
          <div className="sidebar-filter">
            <Menu
              label={tr("sidebar.sortSessionsCurrentlyValue", {
                value: sort === "recent" ? tr("sidebar.recentActivity") : tr("sidebar.projectName"),
              })}
              title={tr("sidebar.listOptions")}
              align="end"
              entries={[
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
              ]}
            >
              {(trigger) => (
                <IconButton
                  icon={FilterIcon}
                  label={tr("sidebar.listOptions")}
                  className={`sidebar-list-options${attentionOnly ? " active" : ""}`}
                  {...trigger}
                />
              )}
            </Menu>
          </div>
          <div className="sidebar-popover-anchor">
            <button
              ref={connectionTriggerRef}
              className={`sidebar-service-btn sidebar-connection-dot ${syncStatus}`}
              aria-label={tr("sidebar.serverConnectionValue", { syncStatus: syncStatus })}
              title={tr("sidebar.serverConnectionValue", { syncStatus: syncStatus })}
              aria-haspopup="dialog"
              aria-expanded={connectionOpen}
              onClick={() => setConnectionOpen((open) => !open)}
            ><span aria-hidden="true" /></button>
            <Popover
              open={connectionOpen}
              onClose={() => setConnectionOpen(false)}
              anchorRef={connectionTriggerRef}
              align="end"
              ariaLabel={tr("sidebar.serverConnectionDetails")}
              className="sidebar-connection-popover"
            >
              <strong>{syncStatus === "connected" ? tr("sidebar.connected") : syncStatus === "connecting" ? tr("sidebar.connecting") : tr("sidebar.connectionProblem")}</strong>
              <span>{host}</span>
              <Button size="sm" className="sidebar-reconnect" onClick={() => { reconnectSync(); setConnectionOpen(false); }}>{tr("sidebar.reconnect")}</Button>
            </Popover>
          </div>
          {shiftHeld && (
            <button
              className="sidebar-service-btn"
              aria-label={tr("common.settings")}
              title={tr("sidebar.settingsValue", { MOD: MOD })}
              onClick={() => setOverlay("settings")}
            ><Icon.gear /></button>
          )}
        </div>
        <div
          ref={sideScrollRef}
          className={`side-scroll${pullDistance > 0 || pullRefreshing ? " pulling" : ""}`}
          aria-busy={pullRefreshing || undefined}
          onTouchStart={startPull}
          onTouchMove={movePull}
          onTouchEnd={finishPull}
          onTouchCancel={() => { pullStartRef.current = null; setPull(0); }}
          onScroll={(event) => {
            if (event.currentTarget.scrollTop > 0 && pullDistanceRef.current > 0) setPull(0);
          }}
        >
          {(pullDistance > 0 || pullRefreshing) && (
            <div
              className={`pull-refresh${pullDistance >= PULL_REFRESH_DISTANCE ? " armed" : ""}`}
              style={{ height: pullRefreshing ? PULL_REFRESH_DISTANCE : pullDistance }}
              role="status"
              aria-live="polite"
            >
              <span className="spinner" aria-hidden="true" />
              <span>{pullRefreshing ? tr("common.loading") : tr("common.refresh")}</span>
            </div>
          )}
          {selectMode && (
            <div className="session-bulk-actions" aria-label={tr("sidebar.selectedSessionActions")}>
              <span>{selectedSessionIds.size === 0 ? tr("sidebar.selectSessions") : tr("sidebar.valueSelected", { size: selectedSessionIds.size })}</span>
              <Button size="sm" disabled={selectedSessionIds.size === 0} onClick={() => void runBulk("archive")}>{tr("common.archive")}</Button>
              <Button size="sm" disabled={selectedSessionIds.size === 0} onClick={() => void runBulk("restore")}>{tr("common.restore")}</Button>
            </div>
          )}
          {registry.status === "loading" && (
            <div className="empty side-projects-status" role="status">{tr("sidebar.loadingProjects")}</div>
          )}
          {registry.status === "failed" && (
            <div className="empty side-projects-status" role="status">{tr("sidebar.couldnTLoadProjects")}</div>
          )}
          {registry.status === "ready" && projects.length === 0 && (
            <EmptyState
              variant="panel"
              title={tr("sidebar.noProjectsYet")}
              description={tr("sidebar.chooseAProjectPathToStart")}
              actionLabel={tr("projectfolderdialog.openProject")}
              onAction={() => setOverlay("project-picker")}
            />
          )}
          {registry.status === "ready" && projects.length > 0 && visibleProjects.length === 0 && (
            <div className="empty side-projects-status" role="status">{tr("sidebar.noMatchingSessions")}</div>
          )}
          {query.trim() !== "" && (
            <div className="sidebar-search-results" aria-label={tr("sidebar.sessionSearchResults")}>
              {visibleProjects.map((p) => {
                const projectMatches = `${p.name} ${p.path}`.toLowerCase().includes(query.trim().toLowerCase());
                return (
                  <SessionList
                    key={p.id}
                    projectId={p.id}
                    query={projectMatches ? "" : query}
                    attentionOnly={attentionOnly}
                    selectMode={selectMode}
                    selectedSessionIds={selectedSessionIds}
                    onToggleSelected={toggleSelectedSession}
                    searchMode
                    searchProjectName={p.name || p.path}
                  />
                );
              })}
            </div>
          )}
          {query.trim() === "" && visibleProjects.map((p) => {
            const projectQuery = query.trim()
              && `${p.name} ${p.path}`.toLowerCase().includes(query.trim().toLowerCase())
              ? ""
              : query;
            const card = renamingProject === p.id ? (
              <div className="project-card project-rename">
                <input
                  autoFocus
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  onBlur={() => void saveProjectName(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveProjectName(p.id);
                    else if (e.key === "Escape") setRenamingProject(null);
                  }}
                />
              </div>
            ) : (
              <div className="project-card-shell">
                <button
                  className={`project-card ${p.id === activeProjectId ? "active" : ""}`}
                  aria-current={p.id === activeProjectId ? "true" : undefined}
                  aria-expanded={effectiveViewMode === "tree" ? expandedTrees.has(p.id) : undefined}
                  onClick={() => {
                    if (p.id !== activeProjectId) activateProject(p.id);
                    if (effectiveViewMode === "tree") toggleTree(p.id);
                    else closeDrawer();
                  }}
                  onDoubleClick={() => { setRenamingProject(p.id); setProjectName(p.name); }}
                >
                  <span className="project-glyph" style={p.color ? { color: p.color } : undefined}>
                    {p.icon
                      ? p.icon.startsWith("/assets/project-icons/")
                        ? <span className="project-glyph-mask" aria-hidden="true" style={{ WebkitMaskImage: `url("${p.icon}")`, maskImage: `url("${p.icon}")` }} />
                        : p.icon.startsWith("data:image/")
                          ? <img src={p.icon} alt="" />
                        : <span aria-hidden="true">{p.icon}</span>
                      : <Icon.files />}
                  </span>
                  <span className="project-meta">
                    <span className="project-name" title={p.path}>{p.name || p.path}</span>
                    <span className="project-path">{p.path}</span>
                  </span>
                </button>
                <span className="project-actions">
                  <button
                    className="project-new-session"
                    title={tr("sidebar.newChatInValue", { value: p.name || p.path })}
                    aria-label={tr("sidebar.newChatInValue", { value: p.name || p.path })}
                    onClick={(event) => {
                      event.stopPropagation();
                      startNewSession(p.id);
                      closeDrawer();
                    }}
                  ><Icon.plus /></button>
                  <Menu
                    label={tr("sidebar.actionsForValue", { value: p.name || p.path })}
                    title={p.name || p.path}
                    align="end"
                    entries={[
                      {
                        id: "select",
                        label: selectMode ? tr("sidebar.cancelSessionSelection") : tr("sidebar.selectSessions"),
                        onSelect: toggleSelectMode,
                      },
                      {
                        id: "worktree",
                        label: tr("sidebar.newSessionInWorktree"),
                        onSelect: () => openWorktreeSessionDialog(p.id),
                      },
                      {
                        id: "import",
                        label: tr("sidebar.importSessions"),
                        onSelect: () => setImportingProject(p.id),
                      },
                      {
                        id: "rename",
                        label: tr("sidebar.renameProject"),
                        onSelect: () => { setRenamingProject(p.id); setProjectName(p.name); },
                      },
                      {
                        id: "appearance",
                        label: tr("sidebar.projectAppearance"),
                        onSelect: () => setAppearanceProjectId(p.id),
                      },
                      {
                        id: "git",
                        label: tr("sidebar.sourceControlGitAmpWorktrees"),
                        onSelect: () => {
                          if (p.id !== activeProjectId) activateProject(p.id);
                          openWorkspacePane("git");
                        },
                      },
                      "separator",
                      {
                        id: "close",
                        label: tr("sidebar.closeProject"),
                        danger: true,
                        onSelect: () => {
                          void confirmAlert(
                            tr("sidebar.closeValueThisRemovesItFrom", { name: p.name || p.path }),
                            { title: tr("sidebar.closeProject"), confirmLabel: tr("sidebar.closeProject") },
                          ).then((ok) => { if (ok) void removeProject(p.id); });
                        },
                      },
                    ] satisfies MenuEntry[]}
                    footer={<SlotHost slot="sidebar.project.actions" context={{ projectId: p.id }} />}
                  >
                    {(trigger) => (
                      <button
                        {...trigger}
                        className="project-menu-btn"
                        title={tr("sidebar.actionsForValue", { value: p.name || p.path })}
                        aria-label={tr("sidebar.actionsForValue", { value: p.name || p.path })}
                      ><Icon.more /></button>
                    )}
                  </Menu>
                </span>
              </div>
            );
            if (effectiveViewMode !== "tree") return <div key={p.id} className="project-entry">{card}</div>;
            return (
              <div key={p.id} className="project-tree-node">
                {card}
                {expandedTrees.has(p.id) && (
                  <div className="project-tree-sessions">
                    <SessionList
                      projectId={p.id}
                      query={projectQuery}
                      attentionOnly={attentionOnly}
                      selectMode={selectMode}
                      selectedSessionIds={selectedSessionIds}
                      onToggleSelected={toggleSelectedSession}
                    />
                  </div>
                )}
              </div>
            );
          })}
          {query.trim() === "" && effectiveViewMode === "list" && project && (
            <div className="session-list">
              <SessionList
                projectId={project.id}
                query={
                  query.trim()
                  && `${project.name} ${project.path}`.toLowerCase().includes(query.trim().toLowerCase())
                    ? ""
                    : query
                }
                attentionOnly={attentionOnly}
                selectMode={selectMode}
                selectedSessionIds={selectedSessionIds}
                onToggleSelected={toggleSelectedSession}
              />
            </div>
          )}
          {registry.status === "ready" && projects.length > 0 && query.trim() === "" && (
            <button className="sidebar-add-project" onClick={() => setOverlay("project-picker")}>
              <Icon.plus />
              <span>{tr("sidebar.addProject")}</span>
            </button>
          )}
          <SlotHost
            slot="app.nav"
            context={{ projectId: activeProjectId, sessionId: activeSessionId, expanded }}
          />
        </div>
        <SlotHost
          slot="sidebar.footer"
          context={{ projectId: activeProjectId, sessionId: activeSessionId, expanded }}
        />
        </>)}
        {!compact && !collapsed && (
          <div
            className="sidebar-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={tr("sidebar.resizeSidebar")}
            aria-valuenow={width}
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={SIDEBAR_MAX_WIDTH}
            tabIndex={0}
            onMouseDown={startResize}
            onKeyDown={onResizeKey}
          />
        )}
      </nav>
      {importingProject && (
        <ImportSessionsDialog projectId={importingProject} onClose={() => setImportingProject(null)} />
      )}
      {appearanceProjectId && (() => {
        const target = projects.find((candidate) => candidate.id === appearanceProjectId);
        return target ? <ProjectAppearanceDialog project={target} onClose={() => setAppearanceProjectId(null)} /> : null;
      })()}
    </>
  );
}
