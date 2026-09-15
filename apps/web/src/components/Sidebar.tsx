import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent,
} from "react";
import {
  getState, useStore, activateProject, openWorkspacePane, openWorktreeSessionDialog, setOverlay,
  setSidebarOpen, setUiError, startNewSession,
} from "../store.ts";
import {
  getSyncStatus, reconnectSync, refreshSessions, removeProject, renameProject, subscribeSyncStatus,
} from "../init.ts";
import { friendlyError } from "../settings.ts";
import { Icon } from "../icons.tsx";
import SessionList from "./sidebar/SessionList.tsx";
import SessionDateFilterControls from "./sidebar/SessionDateFilterControls.tsx";
import ImportSessionsDialog from "./ImportSessionsDialog.tsx";
import { useShellMode } from "../responsiveShell.ts";
import { useModalSurface } from "./a11y/Dialog.tsx";
import SlotHost from "./slots/SlotHost.ts";
import CustomizeZoneButton from "./CustomizeZoneButton.tsx";
import { useSidebarExpanded } from "../sidebarPresentation.ts";
import {
  applyManualProjectOrder, reorderManualProjects,
  setProjectOrder, setProjectSortMode, setSidebarViewMode,
  useProjectOrder, useProjectSortMode, useSidebarViewMode,
  type ProjectSortMode,
} from "../sidebarPrefs.ts";
import EmptyState from "./EmptyState.tsx";
import {
  Button, CloseIcon, ComposeIcon, FilterIcon, IconButton, Menu, Popover,
  SearchIcon, SidebarIcon, SortIcon, Switch,
  type MenuEntry,
} from "./ui/index.ts";
import {
  SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_RAIL_WIDTH,
  clampSidebarWidth, setSidebarLayout, useSidebarLayout,
} from "../sidebarLayout.ts";
import { useEscape } from "../useEscape.ts";
import { api } from "@polyth/session/web-api";
import { announce } from "./a11y/live.tsx";
import ProjectAppearanceDialog from "./ProjectAppearanceDialog.tsx";
import SpaceSwitcher from "./SpaceSwitcher.tsx";
import { tr } from "../i18n/index.ts";
import { confirmAlert } from "../alerts.ts";
import { errorFeedback, tapFeedback } from "../haptics.ts";
import { useInlineRename } from "./input/inlineRename.ts";
import {
  PULL_REFRESH_DISTANCE, pullRefreshDistance, type GesturePoint,
} from "../mobileGestures.ts";
import {
  EMPTY_SESSION_DATE_FILTER,
  sessionDateFilterActive,
  sessionMatchesDateFilter,
  type SessionDateFilter,
} from "../sessionDates.ts";
import type { Project, SessionProjection } from "@polyth/contracts";

const EXPANDED_PROJECTS_KEY = "polyth.sidebar.expandedProjects";
/** Grace period an untouched peek keeps after the pointer leaves the sidebar. */
export const PEEK_LEAVE_MS = 5000;

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

function ProjectGlyph({ project }: { project: Project }) {
  return (
    <span className="project-glyph" style={project.color ? { color: project.color } : undefined}>
      {project.icon
        ? project.icon.startsWith("/assets/project-icons/")
          ? <span className="project-glyph-mask" aria-hidden="true" style={{ WebkitMaskImage: `url("${project.icon}")`, maskImage: `url("${project.icon}")` }} />
          : project.icon.startsWith("data:image/")
            ? <img src={project.icon} alt="" />
            : <span aria-hidden="true">{project.icon}</span>
        : <Icon.files />}
      {project.remote && (
        <span
          className="project-remote-marker"
          role="img"
          aria-label={tr("ssh.sshprojectsource.remoteProject")}
          title={tr("ssh.sshprojectsource.remoteProject")}
        >
          <Icon.globe />
        </span>
      )}
    </span>
  );
}

function sessionsNeedAttention(candidates: readonly SessionProjection[]): boolean {
  return candidates.some((session) => session.status !== "archived"
    && (session.status === "working"
      || session.status === "waiting"
      || session.status === "reconciling"
      || session.status === "unknown"
      || (session.attention?.questions ?? 0) > 0
      || (session.attention?.permissions ?? 0) > 0));
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
  // Compact drawer: the search field is behind a toolbar button and only
  // mounts once the user asks for it. Desktop keeps the always-on field.
  const [searchOpen, setSearchOpen] = useState(false);
  const sort = useProjectSortMode();
  const setSort = (mode: ProjectSortMode) => setProjectSortMode(mode);
  const projectOrder = useProjectOrder();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [projectMenuOpenId, setProjectMenuOpenId] = useState<string | null>(null);
  const [projectMenuSource, setProjectMenuSource] = useState<"card" | "rail" | null>(null);
  const [appearanceProjectId, setAppearanceProjectId] = useState<string | null>(null);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [dateFilter, setDateFilter] = useState<SessionDateFilter>(EMPTY_SESSION_DATE_FILTER);
  const [pullDistance, setPullDistance] = useState(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const syncStatus = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, () => "disconnected");
  const host = typeof location === "undefined" ? tr("sidebar.localServer") : location.host;

  // Persisted desktop presentation: nested tree or a compact project rail
  // beside the active project's sessions. Expansion is per-project UI state.
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
  const orderedProjects = useMemo(() => {
    if (sort === "manual") return applyManualProjectOrder(projects, projectOrder);
    return [...projects].sort((a, b) => {
      if (sort === "name") return (a.name || a.path).localeCompare(b.name || b.path);
      const latest = (projectId: string) => sessions.reduce(
        (value, session) => session.projectId === projectId
          && sessionMatchesDateFilter(session, dateFilter)
          ? Math.max(value, session.lastTurnAt ?? session.createdAt)
          : value,
        0,
      );
      return latest(b.id) - latest(a.id) || (a.name || a.path).localeCompare(b.name || b.path);
    });
  }, [dateFilter, projectOrder, projects, sessions, sort]);
  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return orderedProjects.filter((candidate) => {
      const candidates = sessions.filter((session) =>
        session.projectId === candidate.id && sessionMatchesDateFilter(session, dateFilter));
      if (sessionDateFilterActive(dateFilter) && candidates.length === 0) return false;
      if (attentionOnly && !sessionsNeedAttention(candidates)) return false;
      if (!needle) return true;
      if (`${candidate.name} ${candidate.path}`.toLowerCase().includes(needle)) return true;
      return candidates.some((session) =>
        `${session.title} ${session.branch ?? ""} ${session.worktreePath ?? ""}`.toLowerCase().includes(needle));
    });
  }, [attentionOnly, dateFilter, orderedProjects, query, sessions]);
  // UX-A390: below the compact seam (COMPACT_MAX_WIDTH) the sidebar is a modal
  // drawer — every portrait tablet and small window included. It never opens by
  // itself when the viewport shrinks — wide visibility is not a persisted
  // drawer-open preference.
  const mode = useShellMode();
  const compact = mode !== "wide";
  // Compact navigation is always the complete project → worktree → session
  // tree. Desktop keeps the user's optional presentation preference.
  const effectiveViewMode = compact ? "tree" : viewMode;
  // Finding 2: wide-mode width + collapse persist across reloads; the compact
  // drawer keeps its own responsive geometry and ignores both.
  const layout = useSidebarLayout();
  const collapsed = !compact && layout.collapsed;
  // Rail view collapses only the sessions column — the project icon rail keeps
  // its width. Every other presentation still collapses to the thin rail.
  const railView = effectiveViewMode === "rail";
  const railCollapsed = collapsed && railView;
  const fullyCollapsed = collapsed && !railView;
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? layout.width;
  const navRef = useRef<HTMLElement>(null);
  const connectionTriggerRef = useRef<HTMLButtonElement>(null);
  const projectMenuReturnRef = useRef<HTMLElement | null>(null);
  const sideScrollRef = useRef<HTMLDivElement>(null);
  const pullStartRef = useRef<GesturePoint | null>(null);
  const pullDistanceRef = useRef(0);
  const pullArmedRef = useRef(false);
  const prevCompact = useRef(compact);
  useEffect(() => {
    if (!prevCompact.current && compact) closeDrawer();
    prevCompact.current = compact;
  }, [compact]);

  // Sessions peek while the rail switch is off: hovering a project slides the
  // sessions out over the workspace. A click inside pins it until a click
  // outside; an untouched peek closes PEEK_LEAVE_MS after the pointer leaves
  // both the rail and the peek.
  const [peek, setPeek] = useState<{ projectId: string; pinned: boolean } | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopLeave = () => {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };
  const closePeek = () => { stopLeave(); setPeek(null); };
  useEffect(() => () => { stopLeave(); }, []);
  useEffect(() => { if (!railCollapsed) closePeek(); }, [railCollapsed]);
  const openPeek = (projectId: string) => {
    if (!railCollapsed) return;
    stopLeave();
    // Moving across the rail re-targets an open peek without losing its pin.
    setPeek((current) => current?.projectId === projectId
      ? current
      : { projectId, pinned: current?.pinned === true });
  };
  const schedulePeekClose = () => {
    if (!peek || peek.pinned) return;
    stopLeave();
    leaveTimer.current = setTimeout(() => setPeek(null), PEEK_LEAVE_MS);
  };
  useEffect(() => {
    if (!peek || !railCollapsed) return;
    const onOutside = (event: Event) => {
      const target = event.target as Element | null;
      if (target && navRef.current?.contains(target)) return;
      // Menus, popovers and dialogs portal to document.body but belong to the
      // peek that opened them.
      if (target?.closest?.(".ui-popover, .ui-popover-backdrop, [role='dialog']")) return;
      closePeek();
    };
    document.addEventListener("pointerdown", onOutside, true);
    return () => document.removeEventListener("pointerdown", onOutside, true);
  }, [peek, railCollapsed]);
  useEscape(peek !== null && railCollapsed, closePeek);
  // The peek previews the hovered project without stealing the active one.
  const focusProjectId = (railCollapsed ? peek?.projectId : null) ?? activeProjectId;
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

  // One rename field is open at a time, so one handler pair serves every row.
  const projectRenameKeys = useInlineRename({
    editing: renamingProject,
    commit: () => { if (renamingProject) void saveProjectName(renamingProject); },
    cancel: () => setRenamingProject(null),
  });

  // The persisted list keeps every known project so filtered-out ones hold
  // their slot; only the visible order is what the user rearranges.
  const manualReorder = sort === "manual" && query.trim() === "";
  const [draggedProject, setDraggedProject] = useState<string | null>(null);
  const [dragOverProject, setDragOverProject] = useState<string | null>(null);
  const fullProjectOrder = () => applyManualProjectOrder(projects, projectOrder).map((p) => p.id);
  const commitReorder = (draggedId: string, targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    setProjectOrder(reorderManualProjects(fullProjectOrder(), draggedId, targetId));
    tapFeedback();
    announce(tr("sidebar.projectsReordered"));
  };
  const moveProjectBy = (id: string, delta: -1 | 1) => {
    const ids = fullProjectOrder();
    const index = ids.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    setProjectOrder(ids);
    announce(tr("sidebar.projectsReordered"));
  };
  const clearProjectDrag = () => {
    setDraggedProject(null);
    setDragOverProject(null);
  };
  const startProjectDrag = (event: ReactDragEvent<HTMLElement>, id: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
    setDraggedProject(id);
    setDragOverProject(id);
  };
  const dropProject = (event: ReactDragEvent<HTMLElement>, targetId: string) => {
    if (!draggedProject) return;
    event.preventDefault();
    commitReorder(draggedProject, targetId);
    clearProjectDrag();
  };

  const sortEntries: MenuEntry[] = [
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
    {
      id: "manual",
      label: tr("sidebar.manualOrder"),
      kind: "radio",
      checked: sort === "manual",
      onSelect: () => setSort("manual"),
    },
  ];
  const layoutEntries: MenuEntry[] = [
    { heading: tr("shell.sidebar") },
    {
      id: "layout-tree",
      label: tr("sidebar.layoutTree"),
      kind: "radio",
      checked: viewMode === "tree",
      onSelect: () => setSidebarViewMode("tree"),
    },
    {
      id: "layout-rail",
      label: tr("sidebar.projectRail"),
      kind: "radio",
      checked: viewMode === "rail",
      onSelect: () => setSidebarViewMode("rail"),
    },
  ];
  const filterEntries: MenuEntry[] = [
    { heading: tr("sidebar.filterSessions") },
    {
      id: "attention",
      label: tr("sidebar.needsAttention"),
      kind: "checkbox",
      checked: attentionOnly,
      onSelect: () => setAttentionOnly((value) => !value),
    },
  ];

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

  const openProjectMenu = (id: string, target: HTMLElement, source: "card" | "rail") => {
    projectMenuReturnRef.current = target;
    setProjectMenuOpenId(id);
    setProjectMenuSource(source);
  };
  const onProjectContextMenu = (event: ReactMouseEvent<HTMLElement>, id: string, source: "card" | "rail") => {
    event.preventDefault();
    event.stopPropagation();
    openProjectMenu(id, event.currentTarget, source);
  };
  const onProjectMenuKeyDown = (event: ReactKeyboardEvent<HTMLElement>, id: string, source: "card" | "rail") => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    openProjectMenu(id, event.currentTarget, source);
  };

  const projectMenuEntries = (p: Project): MenuEntry[] => [
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
  ];

  const connectionControl = (buttonClass: string) => (
    <div className="sidebar-popover-anchor">
      <button
        ref={connectionTriggerRef}
        className={`${buttonClass} sidebar-connection-dot ${syncStatus}`}
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
        align={effectiveViewMode === "rail" ? "start" : "end"}
        ariaLabel={tr("sidebar.serverConnectionDetails")}
        className="sidebar-connection-popover"
      >
        <strong>{syncStatus === "connected" ? tr("sidebar.connected") : syncStatus === "connecting" ? tr("sidebar.connecting") : tr("sidebar.connectionProblem")}</strong>
        <span>{host}</span>
        <Button size="sm" className="sidebar-reconnect" onClick={() => { reconnectSync(); setConnectionOpen(false); }}>{tr("sidebar.reconnect")}</Button>
      </Popover>
    </div>
  );

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
        className={`sidebar ${drawerOpen ? "open" : ""}${fullyCollapsed ? " collapsed" : ""}${railCollapsed ? " sidebar--rail-collapsed" : ""}${railView && !compact && dragWidth === null ? " sidebar--animate-width" : ""}`}
        style={!compact
          ? (() => {
              const navWidth = fullyCollapsed ? SIDEBAR_COLLAPSED_WIDTH : railCollapsed ? SIDEBAR_RAIL_WIDTH : width;
              return { width: navWidth, minWidth: navWidth };
            })()
          : undefined}
        {...(compact ? { role: "dialog", "aria-modal": true, "aria-label": tr("sidebar.projectsAndSessions") } : {})}
        {...(railCollapsed ? { onPointerEnter: stopLeave, onPointerLeave: schedulePeekClose } : {})}
      >
        <h2 className="sr-only">{tr("sidebar.projectsAndSessions")}</h2>
        {fullyCollapsed && (
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
        {!fullyCollapsed && (
        <div className={`sidebar-expanded-shell${effectiveViewMode === "rail" ? " sidebar-expanded-shell--project-rail" : ""}`}>
        {effectiveViewMode === "rail" && (
          <div className="sidebar-project-rail" aria-label={tr("commandpalette.projects")}>
            <span
              className="sidebar-rail-switch"
              title={collapsed
                ? tr("sidebar.expandProjectsAndSessions")
                : tr("contextrail.collapseValue", { value: tr("sidebar.projectsAndSessions") })}
            >
              <Switch
                className="sidebar-rail-toggle"
                checked={!collapsed}
                label={collapsed
                  ? tr("sidebar.expandProjectsAndSessions")
                  : tr("contextrail.collapseValue", { value: tr("sidebar.projectsAndSessions") })}
                onChange={(next) => { closePeek(); setSidebarLayout({ collapsed: !next }); }}
              />
            </span>
            <div className="sidebar-project-rail-list">
              {orderedProjects.map((candidate) => {
                const candidateSessions = sessions.filter((session) => session.projectId === candidate.id);
                const attention = candidateSessions.some((session) => session.status === "waiting"
                  || session.status === "reconciling"
                  || session.status === "unknown"
                  || (session.attention?.questions ?? 0) > 0
                  || (session.attention?.permissions ?? 0) > 0);
                const working = candidateSessions.some((session) => session.status === "working");
                return (
                  <Menu
                    key={candidate.id}
                    label={tr("sidebar.actionsForValue", { value: candidate.name || candidate.path })}
                    title={candidate.name || candidate.path}
                    align="start"
                    open={projectMenuOpenId === candidate.id && projectMenuSource === "rail"}
                    onOpenChange={(open) => {
                      setProjectMenuOpenId(open ? candidate.id : null);
                      setProjectMenuSource(open ? "rail" : null);
                    }}
                    returnFocusRef={projectMenuReturnRef}
                    entries={projectMenuEntries(candidate)}
                    footer={<SlotHost slot="sidebar.project.actions" context={{ projectId: candidate.id }} />}
                  >
                    {(trigger) => (
                      <button
                        {...trigger}
                        type="button"
                        className={`sidebar-project-rail-item${candidate.id === activeProjectId ? " active" : ""}${draggedProject === candidate.id ? " dragging" : ""}${dragOverProject === candidate.id ? " drag-over" : ""}`}
                        aria-current={candidate.id === activeProjectId ? "true" : undefined}
                        aria-keyshortcuts={manualReorder ? "Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined}
                        aria-label={candidate.name || candidate.path}
                        title={candidate.name || candidate.path}
                        draggable={manualReorder}
                        onClick={() => { activateProject(candidate.id); openPeek(candidate.id); }}
                        onPointerEnter={(event) => {
                          if (event.pointerType === "mouse") openPeek(candidate.id);
                        }}
                        onContextMenu={(event) => onProjectContextMenu(event, candidate.id, "rail")}
                        onDragStart={(event) => startProjectDrag(event, candidate.id)}
                        onDragOver={(event) => {
                          if (!draggedProject) return;
                          event.preventDefault();
                          setDragOverProject(candidate.id);
                        }}
                        onDragEnd={clearProjectDrag}
                        onDrop={(event) => dropProject(event, candidate.id)}
                        onKeyDown={(event) => {
                          onProjectMenuKeyDown(event, candidate.id, "rail");
                          if (event.defaultPrevented || !manualReorder || !event.altKey || !event.shiftKey) return;
                          if (event.key === "ArrowUp") {
                            event.preventDefault();
                            moveProjectBy(candidate.id, -1);
                          } else if (event.key === "ArrowDown") {
                            event.preventDefault();
                            moveProjectBy(candidate.id, 1);
                          }
                        }}
                      >
                        <ProjectGlyph project={candidate} />
                        {(attention || working) && (
                          <span className={`sidebar-project-rail-status${attention ? " attention" : " working"}`} aria-hidden="true" />
                        )}
                      </button>
                    )}
                  </Menu>
                );
              })}
            </div>
            <button
              type="button"
              className="sidebar-project-rail-add"
              aria-label={tr("sidebar.addProject")}
              title={tr("sidebar.addProject")}
              onClick={() => setOverlay("project-picker")}
            ><Icon.plus /></button>
            <span className="sidebar-project-rail-divider" aria-hidden="true" />
            {connectionControl("sidebar-service-btn sidebar-project-rail-tool")}
            <CustomizeZoneButton slot="sidebar.toolbar" className="sidebar-service-btn sidebar-project-rail-tool" />
          </div>
        )}
        <div
          className={`sidebar-main${railCollapsed ? ` sidebar-sessions-peek${peek ? " open" : ""}` : ""}`}
          // The peek keeps the sessions column exactly as wide as it is when
          // the switch is on, so toggling never resizes the list.
          style={railCollapsed ? { width: width - SIDEBAR_RAIL_WIDTH, minWidth: width - SIDEBAR_RAIL_WIDTH } : undefined}
          onPointerDownCapture={railCollapsed
            ? () => { stopLeave(); setPeek((current) => current && !current.pinned ? { ...current, pinned: true } : current); }
            : undefined}
        >
        {compact && (
          <div className="sidebar-drawer-header">
            {searchOpen ? (
              <div className="sidebar-search sidebar-search-inline">
                <Icon.search />
                <input
                  type="search"
                  autoFocus
                  value={query}
                  placeholder={tr("sidebar.searchSessions")}
                  aria-label={tr("sidebar.searchProjectsWorktreesAndSessions")}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") { setQuery(""); setSearchOpen(false); }
                  }}
                />
                <button
                  className="sidebar-search-clear"
                  aria-label={tr("sidebar.clearSessionSearch")}
                  title={tr("sidebar.clearSearch")}
                  onClick={() => { setQuery(""); setSearchOpen(false); }}
                >{tr("sidebar.message")}</button>
              </div>
            ) : (
              <div className="sidebar-drawer-tools" role="toolbar" aria-label={tr("sidebar.listOptions")}>
                {/* Phone entry point: the header collapses on phones, so the
                    drawer carries the Space switcher instead. */}
                <SpaceSwitcher />
                <IconButton
                  icon={SearchIcon}
                  label={tr("sidebar.searchProjectsWorktreesAndSessions")}
                  className={`sidebar-drawer-tool${query ? " active" : ""}`}
                  onClick={() => setSearchOpen(true)}
                />
                {project && (
                  <IconButton
                    icon={ComposeIcon}
                    label={tr("sidebar.newChatInValue", { value: project.name || project.path })}
                    className="sidebar-drawer-tool sidebar-drawer-tool-compose"
                    onClick={() => { startNewSession(project.id); closeDrawer(); }}
                  />
                )}
                <Menu
                  label={tr("sidebar.sortProjects")}
                  title={tr("sidebar.sortProjects")}
                  align="start"
                  entries={sortEntries}
                >
                  {(trigger) => (
                    <IconButton
                      icon={SortIcon}
                      label={tr("sidebar.sortProjects")}
                      className={`sidebar-drawer-tool${sort !== "recent" ? " active" : ""}`}
                      {...trigger}
                    />
                  )}
                </Menu>
                <Menu
                  label={tr("sidebar.filterSessions")}
                  title={tr("sidebar.filterSessions")}
                  align="start"
                  entries={filterEntries}
                  className="session-filter-menu"
                  footer={<SessionDateFilterControls value={dateFilter} onChange={setDateFilter} />}
                >
                  {(trigger) => (
                    <IconButton
                      icon={FilterIcon}
                      label={tr("sidebar.filterSessions")}
                      className={`sidebar-drawer-tool${attentionOnly || sessionDateFilterActive(dateFilter) ? " active" : ""}`}
                      {...trigger}
                    />
                  )}
                </Menu>
                <span className="header-spacer" />
              </div>
            )}
            <IconButton
              icon={CloseIcon}
              label={tr("sidebar.closeProjectsAndSessions")}
              size="lg"
              className="drawer-close"
              onClick={() => setSidebarOpen(false)}
            />
          </div>
        )}
        <div className="sidebar-service-bar customize-zone">
          {!compact && (
            <IconButton
              icon={SidebarIcon}
              className="sidebar-collapse"
              label={tr("contextrail.collapseValue", { value: tr("sidebar.projectsAndSessions") })}
              onClick={() => setSidebarLayout({ collapsed: true })}
            />
          )}
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
              label={tr("sidebar.sortProjectsCurrentlyValue", {
                value: sort === "name"
                  ? tr("sidebar.projectName")
                  : sort === "manual"
                    ? tr("sidebar.manualOrder")
                    : tr("sidebar.recentActivity"),
              })}
              title={tr("sidebar.moreSidebarActions")}
              align="end"
              entries={[...layoutEntries, "separator", ...sortEntries, "separator", ...filterEntries]}
              className="session-filter-menu"
              footer={<SessionDateFilterControls value={dateFilter} onChange={setDateFilter} />}
            >
              {(trigger) => (
                <IconButton
                  icon={FilterIcon}
                  label={tr("sidebar.moreSidebarActions")}
                  className={`sidebar-list-options${viewMode !== "tree" || attentionOnly || sessionDateFilterActive(dateFilter) ? " active" : ""}`}
                  {...trigger}
                />
              )}
            </Menu>
          </div>
          {/* Widget-areas (WA4): optional search/filter controls belong beside
              the built-in sidebar controls rather than in a second toolbar. */}
          <SlotHost
            slot="sidebar.toolbar"
            context={{ projectId: project?.id, query, attentionOnly, compact }}
            customizable
          />
          {effectiveViewMode !== "rail" && connectionControl("sidebar-service-btn")}
          {effectiveViewMode !== "rail" && <CustomizeZoneButton slot="sidebar.toolbar" className="sidebar-service-btn" />}
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
              <span className="ui-spinner ui-spinner--sm" aria-hidden="true" />
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
                    dateFilter={dateFilter}
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
          {query.trim() === "" && (effectiveViewMode === "rail"
            ? visibleProjects.filter((candidate) => candidate.id === focusProjectId)
            : visibleProjects).map((p) => {
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
                  {...projectRenameKeys}
                />
              </div>
            ) : (
              <div className="project-card-shell">
                <button
                  className={`project-card ${p.id === activeProjectId ? "active" : ""}`}
                  aria-current={p.id === activeProjectId ? "true" : undefined}
                  aria-expanded={effectiveViewMode === "tree" ? expandedTrees.has(p.id) : undefined}
                  aria-keyshortcuts={manualReorder ? "Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined}
                  onContextMenu={(event) => onProjectContextMenu(event, p.id, "card")}
                  onClick={() => {
                    if (p.id !== activeProjectId) activateProject(p.id);
                    if (effectiveViewMode === "tree") toggleTree(p.id);
                    else closeDrawer();
                  }}
                  onKeyDown={(event) => {
                    onProjectMenuKeyDown(event, p.id, "card");
                    if (event.defaultPrevented || !manualReorder || !event.altKey || !event.shiftKey) return;
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      moveProjectBy(p.id, -1);
                    } else if (event.key === "ArrowDown") {
                      event.preventDefault();
                      moveProjectBy(p.id, 1);
                    }
                  }}
                  onDoubleClick={() => { setRenamingProject(p.id); setProjectName(p.name); }}
                >
                  <ProjectGlyph project={p} />
                  <span className="project-meta">
                    <span className="project-name-line">
                      <span className="project-name" title={p.path}>{p.name || p.path}</span>
                    </span>
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
                    open={projectMenuOpenId === p.id && projectMenuSource === "card"}
                    onOpenChange={(open) => {
                      setProjectMenuOpenId(open ? p.id : null);
                      setProjectMenuSource(open ? "card" : null);
                    }}
                    returnFocusRef={projectMenuReturnRef}
                    entries={projectMenuEntries(p)}
                    footer={<SlotHost slot="sidebar.project.actions" context={{ projectId: p.id }} />}
                  >
                    {(trigger) => (
                      <button
                        {...trigger}
                        className="project-menu-btn"
                        title={tr("sidebar.actionsForValue", { value: p.name || p.path })}
                        aria-label={tr("sidebar.actionsForValue", { value: p.name || p.path })}
                        onClick={(event) => {
                          projectMenuReturnRef.current = event.currentTarget;
                          trigger.onClick();
                        }}
                      ><Icon.more /></button>
                    )}
                  </Menu>
                </span>
              </div>
            );
            const reorderClass = `${manualReorder ? " reorderable" : ""}${draggedProject === p.id ? " dragging" : ""}${dragOverProject === p.id ? " drag-over" : ""}`;
            const dragProps = manualReorder ? {
              draggable: true,
              onDragStart: (event: ReactDragEvent<HTMLDivElement>) => {
                if ((event.target as HTMLElement).closest(".session-row")) return;
                startProjectDrag(event, p.id);
              },
              onDragOver: (event: ReactDragEvent<HTMLDivElement>) => {
                if (!draggedProject) return;
                event.preventDefault();
                setDragOverProject(p.id);
              },
              onDragEnd: clearProjectDrag,
              onDrop: (event: ReactDragEvent<HTMLDivElement>) => dropProject(event, p.id),
            } : {};
            if (effectiveViewMode === "rail") {
              return (
                <div key={p.id} data-project-id={p.id} className="sidebar-focused-project">
                  {card}
                  <div className="sidebar-focused-sessions">
                    <SessionList
                      projectId={p.id}
                      attentionOnly={attentionOnly}
                      dateFilter={dateFilter}
                      selectMode={selectMode}
                      selectedSessionIds={selectedSessionIds}
                      onToggleSelected={toggleSelectedSession}
                    />
                  </div>
                </div>
              );
            }
            return (
              <div key={p.id} data-project-id={p.id} className={`project-tree-node${reorderClass}`} {...dragProps}>
                {card}
                {expandedTrees.has(p.id) && (
                  <div className="project-tree-sessions">
                    <SessionList
                      projectId={p.id}
                      query={projectQuery}
                      attentionOnly={attentionOnly}
                      dateFilter={dateFilter}
                      selectMode={selectMode}
                      selectedSessionIds={selectedSessionIds}
                      onToggleSelected={toggleSelectedSession}
                    />
                  </div>
                )}
              </div>
            );
          })}
          {/* Contributed navigation belongs with the workspaces it sits beside,
              not underneath the "add project" affordance. A package workspace
              (Personal Coach) is a peer of a project here, never a project. */}
          <SlotHost
            slot="app.nav"
            context={{ projectId: activeProjectId, sessionId: activeSessionId, expanded }}
          />
          {registry.status === "ready" && projects.length > 0 && query.trim() === "" && effectiveViewMode !== "rail" && (
            <button className="sidebar-add-project" onClick={() => setOverlay("project-picker")}>
              <Icon.plus />
              <span>{tr("sidebar.addProject")}</span>
            </button>
          )}
        </div>
        <SlotHost
          slot="sidebar.footer"
          context={{ projectId: activeProjectId, sessionId: activeSessionId, expanded }}
          customizable
        />
        {!compact && (!collapsed || peek) && (
          <div
            className={`sidebar-resize${railCollapsed ? " sidebar-resize--peek" : ""}`}
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
        </div>
        </div>)}
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
