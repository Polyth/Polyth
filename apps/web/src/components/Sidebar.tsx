import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent, type ReactNode, type TouchEvent as ReactTouchEvent,
} from "react";
import {
  getState, useStore, activateProject, openWorkspacePane, openWorktreeSessionDialog, setOverlay,
  overlaySessionProjection, setSidebarOpen, setUiError, startFreshSession, workspaceProjectId,
} from "../store.ts";
import {
  refreshSessions, removeProject, renameProject,
} from "../init.ts";
import { friendlyError } from "../settings.ts";
import { useSessionSummaryPages } from "../useSessionSummaryPages.ts";
import { useElementWidth } from "../useElementWidth.ts";
import { Icon } from "../icons.tsx";
import SessionList from "./sidebar/SessionList.tsx";
import SessionDateFilterControls from "./sidebar/SessionDateFilterControls.tsx";
import SessionSelectionBar from "./sidebar/SessionSelectionBar.tsx";
import { useSessionArrangementEntries } from "./sidebar/sessionArrangementEntries.ts";
import { useShellMode } from "../responsiveShell.ts";
import { useLaneSessions, useWorkbenchShellPresentation } from "../workbench/profileNavigation.ts";
import { useModalSurface } from "./a11y/Dialog.tsx";
import { isImeComposing } from "./input/editorCore.ts";
import SlotHost from "./slots/SlotHost.ts";
import CustomizeZoneButton from "./CustomizeZoneButton.tsx";
import { ShellColumnAccount, ShellColumnFoot, ShellColumnHead, ShellDock } from "./ShellDock.tsx";
import { ProjectRailTools } from "./sidebar/ProjectRailTools.tsx";
import { SIDEBAR_RAIL_SLOT } from "../railPlacement.ts";
import { useSidebarExpanded } from "../sidebarPresentation.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { attachSwipeSurface } from "../swipeSurface.ts";
import { swipeZoneInHost } from "../shellSwipe.ts";
import { guardedProjectAddAllowed, limitedProjectAddAllowed, useAccountLimits, useGuardrails } from "../guardrails.ts";
import { EXPANDED_PROJECTS_KEY, readNavigatorState, writeNavigatorState } from "../navigatorState.ts";
import {
  permuteManualProjects,
  setProjectOrder, setProjectSortMode,
  setSidebarViewMode, useOrderedProjects, useProjectSortMode,
  useSidebarViewMode, type SidebarViewMode,
  type ProjectSortMode,
} from "../sidebarPrefs.ts";
import EmptyState from "./EmptyState.tsx";
import {
  CloseIcon, ComposeIcon, FilterIcon, IconButton, Menu,
  SearchIcon, SelectIcon, SidebarCollapseIcon, SidebarExpandIcon, SortIcon, Tooltip,
  type MenuEntry,
} from "./ui/index.ts";
import {
  SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_RAIL_WIDTH,
  clampSidebarWidth, isAutomaticSidebarRailApplied, releaseAutomaticSidebarRail, setSidebarLayout,
  useAutomaticSidebarRail, useSidebarLayout,
} from "../sidebarLayout.ts";
import { useEscape } from "../useEscape.ts";
import { announce } from "./a11y/live.tsx";
import ProjectAppearanceDialog from "./ProjectAppearanceDialog.tsx";
import ConversationCreateDialog from "./ConversationCreateDialog.tsx";
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
import { projectIsolationLevel, type Project, type SessionProjection } from "@polyth/contracts";
import ProjectGlyph from "./ProjectGlyph.tsx";
import { soloPersonalProject } from "../personalProject.ts";
import { useShellDirection } from "../shellDirection.ts";
import { listProjectSettings, subscribeProjectSettingsNavigation } from "../projectSettings.ts";
import { ARRANGE_LIST_LIFT_MS, useArrange, type ArrangeItem } from "../workspaceArrange.ts";

/** Grace period an untouched peek keeps after the pointer leaves the sidebar. */
export const PEEK_LEAVE_MS = 5000;

/**
 * Clicking the focused project icon collapses the sessions column. Waiting out
 * the double-click window lets its second click cancel that collapse instead.
 */
export const RAIL_COLLAPSE_CLICK_DELAY_MS = 300;

/**
 * Narrowest sessions column that still fits the full "Search sessions…"
 * placeholder beside the toolbar's three 36px actions.
 *
 * Measured, not guessed: the placeholder renders 116.84px wide in Inter at the
 * 13.02px UI size, and the toolbar spends 16px on padding, 108px on the three
 * actions, 6px on the gaps and 30px on the field's own inline padding. That is
 * 160px of chrome, so the full label needs a 277px column. The default sidebar
 * leaves 281px, which is why the full label shows by default and only a
 * narrower column swaps to the short one. Below the threshold the toolbar
 * keeps one row and shortens the label instead of clipping it.
 */
export const SEARCH_FULL_LABEL_MIN_WIDTH = 277;

function loadExpandedProjects(activeProjectId: string | null): ReadonlySet<string> {
  try {
    const raw = JSON.parse(readNavigatorState(EXPANDED_PROJECTS_KEY) ?? "[]") as unknown;
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
  const accountLimits = useAccountLimits();
  const canAddProject = guardedProjectAddAllowed(useGuardrails()) && limitedProjectAddAllowed(accountLimits);
  // Canonical registry truth: `projects` has one owner; loading and failure
  // never claim there are no projects.
  const registry = useStore((s) => s.projectRegistry);
  const projects = registry.projects;
  // Only the personal project: chats list flat, with no project row or rail
  // icon, until the person adds a real project.
  const soloPersonal = registry.status === "ready" ? soloPersonalProject(projects) : null;
  const activeProjectId = useStore(workspaceProjectId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const sessionsRaw = useStore((s) => s.sessions);
  const pendingSends = useStore((s) => s.pendingSends);
  const laneSessions = useLaneSessions(sessionsRaw);
  const sessions = useMemo(
    () => laneSessions.map((session) => overlaySessionProjection(session, pendingSends) ?? session),
    // The overlay derives attention from cached events only for the open session.
    [laneSessions, pendingSends, activeSessionId],
  );
  const drawerOpen = useStore((s) => s.sidebarOpen);
  // Honest presentation state for app.nav contributions: on desktop the
  // sidebar is always expanded regardless of the mobile drawer flag.
  const expanded = useSidebarExpanded(drawerOpen);
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  // Compact drawer and desktop project rail: the search field is behind a
  // button and only mounts once the user asks for it. The tree keeps the
  // always-on field.
  const [searchOpen, setSearchOpen] = useState(false);
  const sort = useProjectSortMode();
  const setSort = (mode: ProjectSortMode) => setProjectSortMode(mode);
  const arrangementEntries = useSessionArrangementEntries();
  const [projectMenuOpenId, setProjectMenuOpenId] = useState<string | null>(null);
  const [projectMenuSource, setProjectMenuSource] = useState<"card" | "rail" | null>(null);
  const [appearanceProjectId, setAppearanceProjectId] = useState<string | null>(null);
  const [conversationProjectId, setConversationProjectId] = useState<string | null>(null);
  const [projectSettingsPage, setProjectSettingsPage] = useState<"menu" | `contribution:${string}`>("menu");
  useEffect(() => subscribeProjectSettingsNavigation(({ projectId, contributionId }) => {
    if (!getState().projectRegistry.projects.some((candidate) => candidate.id === projectId)) return;
    const page = contributionId && listProjectSettings(projectId).some((item) => item.id === contributionId)
      ? `contribution:${contributionId}` as const : "menu";
    setProjectSettingsPage(page);
    setAppearanceProjectId(projectId);
  }), []);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [dateFilter, setDateFilter] = useState<SessionDateFilter>(EMPTY_SESSION_DATE_FILTER);
  // Newest session activity per project, for the shared "recent" ordering.
  const latestProjectActivity = useCallback((projectId: string) => sessions.reduce(
    (value, session) => session.projectId === projectId
      && sessionMatchesDateFilter(session, dateFilter)
      ? Math.max(value, session.lastTurnAt ?? session.createdAt)
      : value,
    0,
  ), [dateFilter, sessions]);
  const queryFrom = dateFilter.mode === "date" ? dateFilter.date : dateFilter.from;
  const queryTo = dateFilter.mode === "date" ? dateFilter.date : dateFilter.to;
  const searchPages = useSessionSummaryPages({ query, attentionOnly,
    ...(queryFrom ? { fromTime: new Date(`${queryFrom}T00:00:00`).getTime() } : {}),
    ...(queryTo ? { toTime: new Date(`${queryTo}T23:59:59.999`).getTime() } : {}),
  }, Boolean(query || attentionOnly || sessionDateFilterActive(dateFilter)));
  const [pullDistance, setPullDistance] = useState(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);

  // Persisted desktop presentation: nested tree or a compact project rail
  // beside the browsed project's sessions. Expansion is per-project UI state.
  const viewMode = useSidebarViewMode();
  const [railProjectId, setRailProjectId] = useState(activeProjectId);
  useEffect(() => { setRailProjectId(activeProjectId); }, [activeProjectId]);
  const [expandedTrees, setExpandedTrees] = useState<ReadonlySet<string>>(
    () => loadExpandedProjects(activeProjectId),
  );
  useEffect(() => {
    writeNavigatorState(EXPANDED_PROJECTS_KEY, JSON.stringify([...expandedTrees]));
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
  const orderedProjects = useOrderedProjects(projects, latestProjectActivity);
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
  // Below the compact seam (COMPACT_MAX_WIDTH) the sidebar is a modal
  // drawer — every portrait tablet and small window included. It never opens by
  // itself when the viewport shrinks — wide visibility is not a persisted
  // drawer-open preference.
  const mode = useShellMode();
  const compact = mode !== "wide";
  // Flyouts open toward the content: the shell's inline end, which a
  // mirrored profile or an RTL locale puts on the left.
  const shellDirection = useShellDirection();
  const projectRailTooltipSide = shellDirection.towardEnd;
  // Focused profiles force the compact project switcher and initially reveal
  // the selected project's worktrees/sessions without needing a hover peek.
  const shellPresentation = useWorkbenchShellPresentation();
  const projectsOnly = shellPresentation.projectsOnly;
  // The desktop collapse of Tree temporarily uses the narrow Project rail;
  // keep the saved view mode as Tree so expanding returns to the project tree.
  const layout = useSidebarLayout();
  // A focused profile's `sidebarRailBelow` collapses to the project rail
  // without touching `layout` (sidebarLayout.ts); expanding releases it.
  const automatic = useAutomaticSidebarRail();
  const automaticRail = isAutomaticSidebarRailApplied(automatic);
  // The automatic rail arrives with a profile switch or a window resize, not a
  // gesture: that change lands without the width transition (no per-frame
  // reflow under the focused split's cross-fade). Manual toggles still animate.
  const automaticActiveRef = useRef(automatic.active);
  const automaticChanged = automaticActiveRef.current !== automatic.active;
  useEffect(() => { automaticActiveRef.current = automatic.active; });
  const collapsed = !compact && !projectsOnly && (layout.collapsed || automaticRail);
  const expandCollapsed = () => {
    if (layout.collapsed) setSidebarLayout({ collapsed: false });
    else releaseAutomaticSidebarRail();
  };
  // The persisted project tree/rail presentation applies to every shell. The
  // compact drawer renders the same project rail beside the browsed project's
  // sessions; only the desktop-only collapse geometry below stays wide-only.
  const effectiveViewMode = projectsOnly
    ? "rail" as const
    : collapsed && viewMode === "tree"
      ? "rail" as const
      : viewMode;
  // Rail view collapses only the sessions column — the project icon rail keeps its
  // width. Every other presentation still collapses to the thin rail.
  const railView = effectiveViewMode === "rail";
  const railCollapsed = collapsed && railView;
  const fullyCollapsed = collapsed && !railView;
  const railSessionsLabel = `${tr("sidebar.projectsAndSessions")} (${tr("sidebar.projectRail")})`;
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? layout.width;
  // The project icon column is the left rail. Its track renders from
  // `--rail-scale-left`; JS mirrors that math so the sessions column and the
  // fully-collapsed rail stay flush with it.
  const leftRailScale = useUiSettings().leftRailSize / 100;
  const railTrackWidth = SIDEBAR_RAIL_WIDTH * leftRailScale;
  const collapsedTrackWidth = SIDEBAR_COLLAPSED_WIDTH * leftRailScale;
  const navRef = useRef<HTMLElement>(null);
  const sidebarMainRef = useRef<HTMLDivElement>(null);
  // An unmeasured first frame keeps the full label, so the toolbar never
  // flashes the short one while the column width is still unknown.
  const sidebarMainWidth = useElementWidth(sidebarMainRef);
  const searchFitsFullLabel =
    sidebarMainWidth === null || sidebarMainWidth >= SEARCH_FULL_LABEL_MIN_WIDTH;
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
  const railCollapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopLeave = () => {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };
  // A press anywhere in the sidebar cancels this pending collapse: it must not
  // fire under the person's next action (see the nav pointerdown capture).
  const cancelRailCollapse = () => {
    if (railCollapseTimer.current !== null) clearTimeout(railCollapseTimer.current);
    railCollapseTimer.current = null;
  };
  const closePeek = () => { stopLeave(); setPeek(null); };
  useEffect(() => () => { stopLeave(); cancelRailCollapse(); }, []);
  useEffect(() => { if (!railCollapsed) closePeek(); }, [railCollapsed]);
  // The sessions column leaves (or returns) with the navigator's width
  // transition: for its length the column keeps its own width in flow and the
  // navigator clips it at the moving edge, so the list neither reflows nor
  // jumps out beside the still-wide navigator as the peek (styles.css,
  // `.sidebar--rail-motion`). The transition's end hands it to the peek.
  const animateWidth = railView && !compact && dragWidth === null && !automaticChanged;
  const [railMotion, setRailMotion] = useState<"closing" | "opening" | null>(null);
  const [railMotionFrom, setRailMotionFrom] = useState(railCollapsed);
  if (railMotionFrom !== railCollapsed) {
    setRailMotionFrom(railCollapsed);
    setRailMotion(animateWidth ? (railCollapsed ? "closing" : "opening") : null);
  }
  // A transition that never runs (reduced motion, a hidden tab) still ends.
  useEffect(() => {
    if (railMotion === null) return;
    const timer = setTimeout(() => setRailMotion(null), 600);
    return () => clearTimeout(timer);
  }, [railMotion]);
  // A peek opened mid-collapse takes the column over at once.
  const sessionsLeaving = railMotion === "closing" && peek === null;
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
  const focusProjectId = soloPersonal?.id ?? (railCollapsed ? peek?.projectId : null) ?? railProjectId;
  const toggleRailProject = (projectId: string, clickCount: number) => {
    cancelRailCollapse();
    // A double-click's second click only cancels the pending collapse.
    if (clickCount > 1) return;
    if (railCollapsed) {
      stopLeave();
      setRailProjectId(projectId);
      setPeek((current) => current?.projectId === projectId && current.pinned
        ? null
        : { projectId, pinned: true });
    } else if (railProjectId === projectId) {
      if (!compact && !projectsOnly) {
        const collapse = () => setSidebarLayout({ collapsed: true, restoreViewMode: "rail" });
        // Keyboard activation (detail 0) cannot be part of a double-click.
        if (clickCount === 0) collapse();
        else railCollapseTimer.current = setTimeout(() => {
          railCollapseTimer.current = null;
          collapse();
        }, RAIL_COLLAPSE_CLICK_DELAY_MS);
      } else setRailProjectId(null);
    } else {
      setRailProjectId(projectId);
    }
  };
  const focusedProject = effectiveViewMode === "rail" && query.trim() === ""
    ? visibleProjects.find((candidate) => candidate.id === focusProjectId) ?? null
    : null;
  const project = focusedProject ?? projects.find((p) => p.id === activeProjectId) ?? null;
  // Desktop project rail: the focused project's row is the column's only
  // header row. Search, new chat and the list options sit beside its ⋮, and
  // the search field takes that row only while it is open or holds a query.
  // When no project row is shown (a filter hides it) the toolbar row stays.
  const railHeader = railView && !compact;
  const railSearchOpen = railHeader && (searchOpen || query !== "");
  const showFocusedProject = focusedProject !== null && !railSearchOpen && !soloPersonal;
  const showServiceBar = !railHeader || !showFocusedProject;
  // Closing the field from the keyboard or its × hands focus back to the
  // header's search button, which mounts again in the same render.
  const restoreRailSearchFocus = useRef(false);
  const closeRailSearch = () => {
    setQuery("");
    setSearchOpen(false);
    restoreRailSearchFocus.current = true;
  };
  useLayoutEffect(() => {
    if (!restoreRailSearchFocus.current) return;
    restoreRailSearchFocus.current = false;
    (navRef.current?.querySelector<HTMLElement>(".sidebar-header-search")
      ?? navRef.current?.querySelector<HTMLElement>(".sidebar-service-bar .sidebar-search input"))?.focus();
  });
  // The layout and sort choices share this menu but narrow nothing, so only a
  // filter lights the button (the rail is the default layout, not a filter).
  const listFiltered = attentionOnly || sessionDateFilterActive(dateFilter);
  useModalSurface({
    enabled: compact,
    open: compact && drawerOpen,
    onClose: () => setSidebarOpen(false),
    containerRef: navRef,
  });

  // Tablet drawer (the compact shell; phones have the Navigator): it follows
  // the finger the way the Navigator does. A swipe toward the inline end pulls
  // it in from the inline-start edge, one toward the inline start puts it
  // away, and a release hands its position to the drawer's own transition for
  // the rest of the travel, or springs it back. Same setting, same engine
  // (swipeSurface.ts), measured against the drawer's width.
  const swipeZone = swipeZoneInHost(useUiSettings().swipeNavigation);
  const swipeZoneRef = useRef(swipeZone);
  swipeZoneRef.current = swipeZone;
  const tabletSwipes = mode === "compact" && swipeZone !== null;
  useEffect(() => {
    if (!tabletSwipes) return;
    const width = () => navRef.current?.getBoundingClientRect().width || 320;
    const zone = () => swipeZoneRef.current ?? "edge";
    /** Anything else open (a menu, popover, dialog or sheet) keeps its own gestures. */
    const othersOpen = (): boolean => {
      for (const el of document.querySelectorAll<HTMLElement>('[aria-modal="true"], [role="menu"], .ui-popover')) {
        if (el === navRef.current || el.closest("[inert], [hidden]")) continue;
        if (el.getClientRects().length > 0) return true;
      }
      return false;
    };
    const follow = (nav: HTMLElement, x: number): void => {
      nav.style.transition = "none";
      nav.style.visibility = "visible";
      nav.style.transform = `translate3d(${x}px, 0, 0)`;
    };
    const restore = (nav: HTMLElement): void => {
      nav.style.removeProperty("transition");
      nav.style.removeProperty("transform");
      nav.style.removeProperty("visibility");
    };
    // The class change that follows animates from the finger's position.
    const handOff = (nav: HTMLElement, settleMs: number): void => {
      nav.style.transition = settleMs > 0
        ? `transform ${settleMs}ms var(--motion-stack-ease), visibility ${settleMs}ms`
        : "none";
      nav.style.removeProperty("transform");
      nav.style.removeProperty("visibility");
      window.setTimeout(() => nav.style.removeProperty("transition"), settleMs + 80);
    };
    const detachOpen = attachSwipeSurface({
      surface: () => document.querySelector<HTMLElement>(".app"),
      direction: "toward-end",
      zone,
      extent: width,
      enabled: () => swipeZoneRef.current !== null && !getState().sidebarOpen && getState().overlay === null && !othersOpen(),
      motion: "--motion-stack",
      begin: ({ rtl, width: w }) => {
        const nav = navRef.current;
        if (!nav) return null;
        const sign = rtl ? -1 : 1;
        return {
          paint(travel) { follow(nav, sign * (travel - w)); },
          cancel() { restore(nav); },
          commit({ settleMs }) {
            handOff(nav, settleMs);
            setSidebarOpen(true);
          },
        };
      },
    });
    const detachClose = attachSwipeSurface({
      surface: () => navRef.current,
      direction: "toward-start",
      zone,
      extent: width,
      enabled: () => swipeZoneRef.current !== null && getState().sidebarOpen && !othersOpen()
        && navRef.current?.dataset.arrangeDragging !== "true",
      motion: "--motion-stack",
      begin: ({ rtl }) => {
        const nav = navRef.current;
        if (!nav) return null;
        const sign = rtl ? -1 : 1;
        return {
          paint(travel) { follow(nav, -sign * travel); },
          cancel() { restore(nav); },
          commit({ settleMs }) {
            handOff(nav, settleMs);
            setSidebarOpen(false);
          },
        };
      },
    });
    return () => {
      detachOpen();
      detachClose();
    };
  }, [tabletSwipes]);
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
    // A still press that lifted a project is moving it, not pulling the list.
    if (navRef.current?.dataset.arrangeDragging === "true") {
      pullStartRef.current = null;
      if (pullDistanceRef.current > 0) setPull(0);
      return;
    }
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
  const endSelection = () => {
    setSelectedSessionIds(new Set());
    setSelectMode(false);
  };
  useEscape(selectMode, endSelection);
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

  // Projects move by direct manipulation (workspaceArrange.ts, shared with the
  // phone Navigator): a press lifts a project (a mouse once it moves, a touch
  // after a still moment), the copy follows the pointer while the others glide
  // aside, the list scrolls near its edges, and the order is saved once, on
  // landing. The tree moves the projects it shows, the rail all of them; the
  // saved order keeps every known project, so filtered-out ones hold their
  // slot. Any sort allows it: a move made under "Recent activity" or "Project
  // name" keeps that order and switches to the custom one.
  const reorderable = query.trim() === "";
  const railArrange = effectiveViewMode === "rail";
  const arrangeProjects = railArrange ? orderedProjects : visibleProjects;
  const saveProjectMove = (shown: readonly string[]) => {
    const custom = sort === "manual";
    setProjectOrder(permuteManualProjects(orderedProjects.map((p) => p.id), shown));
    if (!custom) setProjectSortMode("manual");
    announce(tr(custom ? "sidebar.projectsReordered" : "sidebar.projectsReorderedCustom"));
  };
  const arrangeItems = useMemo<ArrangeItem[]>(
    () => arrangeProjects.map((p) => ({ id: p.id, shape: "row" })),
    [arrangeProjects],
  );
  const railListRef = useRef<HTMLDivElement>(null);
  const arrangeList = () => (railArrange ? railListRef.current : sideScrollRef.current);
  const arrange = useArrange({
    items: arrangeItems,
    enabled: reorderable && (!compact || drawerOpen),
    touchLiftMs: ARRANGE_LIST_LIFT_MS,
    scroller: arrangeList,
    ghostHost: () => navRef.current,
    // A tree project lifts its row; its sessions fold while it is up.
    ghostSource: (item) => item.querySelector<HTMLElement>(":scope > .project-card-shell"),
    onCommit: (next) => saveProjectMove(next),
  });
  useLayoutEffect(() => { arrange.engine.listRef(arrangeList()); });
  /** `list` as drawn: the held project at its hole while a drag is on. */
  const arrangedOrder = <T extends Project>(list: readonly T[]): readonly T[] => {
    if (!arrange.draggingId) return list;
    const byId = new Map(list.map((p) => [p.id, p]));
    return arrange.order.flatMap((id) => byId.get(id) ?? []);
  };
  const moveProjectBy = (id: string, delta: -1 | 1) => {
    const shown = arrangeProjects.map((p) => p.id);
    const index = shown.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= shown.length) return;
    [shown[index], shown[target]] = [shown[target]!, shown[index]!];
    arrange.engine.animateNextLayout();
    saveProjectMove(shown);
  };
  /** True while a project is up: other gestures on the sidebar stand down. */
  const arranging = () => navRef.current?.dataset.arrangeDragging === "true";
  const chooseSidebarViewMode = (nextMode: SidebarViewMode) => {
    setSidebarViewMode(nextMode);
    if (nextMode === "tree" && collapsed) {
      expandCollapsed();
    } else if (layout.collapsed && nextMode === "rail") {
      setSidebarLayout({ restoreViewMode: "rail" });
    }
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
      onSelect: () => chooseSidebarViewMode("tree"),
    },
    {
      id: "layout-rail",
      label: tr("sidebar.projectRail"),
      kind: "radio",
      checked: viewMode === "rail",
      onSelect: () => chooseSidebarViewMode("rail"),
    },
  ];
  const filterEntries: MenuEntry[] = [
    { heading: tr("sidebarprefs.sessions") },
    {
      id: "attention",
      label: tr("sidebar.needsAttention"),
      kind: "checkbox",
      checked: attentionOnly,
      onSelect: () => setAttentionOnly((value) => !value),
    },
    ...arrangementEntries,
  ];
  /** Desktop list options (layout, sort, filters), in the toolbar row or the
   *  rail header row. */
  const renderListOptions = (buttonClass: string) => (
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
            className={`${buttonClass}${listFiltered ? " active" : ""}`}
            {...trigger}
          />
        )}
      </Menu>
    </div>
  );
  /** The rail header row's list tools, beside the focused project's ⋮. Toolbar
   *  widgets (`sidebar.toolbar`) come along: this row is that toolbar now. */
  const renderRailHeaderTools = (p: Project) => (
    <span className="sidebar-header-tools customize-zone">
      <SlotHost
        slot="sidebar.toolbar"
        context={{ projectId: p.id, query, attentionOnly, compact }}
        customizable
      />
      <IconButton
        icon={SearchIcon}
        label={tr("sidebar.searchProjectsWorktreesAndSessions")}
        className="sidebar-header-tool sidebar-header-search"
        onClick={() => setSearchOpen(true)}
      />
      <IconButton
        icon={ComposeIcon}
        label={tr("sidebar.newChatInValue", { value: p.name || p.path })}
        className="sidebar-header-tool sidebar-header-compose"
        onClick={() => {
          startFreshSession(p.id);
          closeDrawer();
        }}
      />
      {renderListOptions("sidebar-header-tool")}
      <CustomizeZoneButton slot="sidebar.toolbar" className="sidebar-header-tool" />
    </span>
  );

  // Mouse-drag resize: transient width during the drag, one persisted write
  // on release (drag state stays local; the pref module owns durability).
  // The handle sits on the sidebar's trailing physical edge unless a profile
  // moved the sidebar to the end of the shell (or RTL); dragging toward the
  // content always widens it.
  const resizeSign = (handle: HTMLElement): 1 | -1 => {
    const rect = handle.closest(".sidebar")?.getBoundingClientRect();
    const handleRect = handle.getBoundingClientRect();
    return !rect || handleRect.left + handleRect.width / 2 >= rect.left + rect.width / 2 ? 1 : -1;
  };

  const startResize = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    const sign = resizeSign(event.currentTarget);
    const startX = event.clientX;
    const startWidth = width;
    let next = startWidth;
    const onMove = (ev: MouseEvent) => {
      next = clampSidebarWidth(startWidth + sign * (ev.clientX - startX));
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

  const onResizeKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const sign = resizeSign(event.currentTarget);
    setSidebarLayout({ width: width + sign * (event.key === "ArrowRight" ? 16 : -16) });
  };

  const openProjectMenu = (id: string, target: HTMLElement, source: "card" | "rail") => {
    projectMenuReturnRef.current = target;
    setProjectMenuOpenId(id);
    setProjectMenuSource(source);
  };
  const onProjectContextMenu = (event: ReactMouseEvent<HTMLElement>, id: string, source: "card" | "rail") => {
    event.preventDefault();
    event.stopPropagation();
    // Android's long-press fires this while the press is already a move.
    if (arranging()) return;
    openProjectMenu(id, event.currentTarget, source);
  };
  const onProjectMenuKeyDown = (event: ReactKeyboardEvent<HTMLElement>, id: string, source: "card" | "rail") => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    openProjectMenu(id, event.currentTarget, source);
  };

  const projectMenuEntries = (p: Project): MenuEntry[] => [
    {
      id: "conversation",
      label: tr("conversation.new"),
      onSelect: () => setConversationProjectId(p.id),
    },
    {
      id: "select",
      label: selectMode ? tr("sidebar.cancelSessionSelection") : tr("sidebar.selectSessions"),
      onSelect: toggleSelectMode,
    },
    ...(projectIsolationLevel(p.defaults) !== "off" ? [{
      id: "worktree",
      label: tr("sidebar.newSessionInWorktree"),
      onSelect: () => openWorktreeSessionDialog(p.id),
    }] : []),
    {
      id: "rename",
      label: tr("sidebar.renameProject"),
      onSelect: () => { setRenamingProject(p.id); setProjectName(p.name); },
    },
    {
      id: "appearance",
      label: tr("sidebar.projectSettings"),
      onSelect: () => { setProjectSettingsPage("menu"); setAppearanceProjectId(p.id); },
    },
    {
      id: "repositories",
      label: tr("sidebar.repositories"),
      onSelect: () => { setProjectSettingsPage("contribution:files.repositories"); setAppearanceProjectId(p.id); },
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
        ).then((ok) => { if (ok) void removeProject(p.id).catch((e) => setUiError(friendlyError(tr("common.error"), e))); });
      },
    },
  ];

  const renderProjectCard = (p: Project, tools?: ReactNode) => {
    if (renamingProject === p.id) {
      return (
        <div className="project-card project-rename">
          <input
            autoFocus
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            {...projectRenameKeys}
          />
        </div>
      );
    }
    return (
      <div className="project-card-shell">
        <button
          className={`project-card ${p.id === activeProjectId ? "active" : ""}`}
          aria-current={p.id === activeProjectId ? "true" : undefined}
          aria-expanded={effectiveViewMode === "tree" ? expandedTrees.has(p.id) : !railCollapsed || peek !== null}
          aria-keyshortcuts={reorderable ? "Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined}
          onContextMenu={(event) => onProjectContextMenu(event, p.id, "card")}
          onClick={(event) => {
            if (effectiveViewMode === "tree") toggleTree(p.id);
            else if (railCollapsed) closePeek();
            else toggleRailProject(p.id, event.detail);
          }}
          onKeyDown={(event) => {
            onProjectMenuKeyDown(event, p.id, "card");
            if (event.defaultPrevented || !reorderable || !event.altKey || !event.shiftKey) return;
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
              <span className="project-name" title={p.personal ? p.name : p.path}>{p.name || p.path}</span>
              {(p.repositories?.length ?? 0) > 1 && <span className="project-repository-count" title={p.repositories!.map((row) => `${row.alias} · ${row.path}`).join("\n")}>{tr("sidebar.repositoryCount", { count: p.repositories!.length })}</span>}
            </span>
            {/* A personal project's folder is server storage, not a place the
                person picked; its path would only be noise. */}
            {!p.personal && <span className="project-path">{p.path}</span>}
          </span>
        </button>
        <span className="project-actions" data-arrange-control="">
          <button
            className="project-new-session"
            title={tr("sidebar.newChatInValue", { value: p.name || p.path })}
            aria-label={tr("sidebar.newChatInValue", { value: p.name || p.path })}
            onClick={(event) => {
              event.stopPropagation();
              startFreshSession(p.id);
              closeDrawer();
            }}
          ><Icon.plus /></button>
          {tools}
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
        className={`sidebar ${drawerOpen ? "open" : ""}${fullyCollapsed ? " collapsed" : ""}${railCollapsed ? " sidebar--rail-collapsed" : ""}${railView && compact ? " sidebar--compact-rail" : ""}${animateWidth ? " sidebar--animate-width" : ""}${railMotion === "opening" || sessionsLeaving ? " sidebar--rail-motion" : ""}`}
        style={!compact
          ? (() => {
              const navWidth = fullyCollapsed ? collapsedTrackWidth : railCollapsed ? railTrackWidth : width;
              return { width: navWidth, minWidth: navWidth };
            })()
          : undefined}
        {...(compact ? { role: "dialog", "aria-modal": true, "aria-label": tr("sidebar.projectsAndSessions") } : {})}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "width") setRailMotion(null);
        }}
        onPointerDownCapture={() => cancelRailCollapse()}
        {...(railCollapsed ? { onPointerEnter: stopLeave, onPointerLeave: schedulePeekClose } : {})}
      >
        <h2 className="sr-only">{tr("sidebar.projectsAndSessions")}</h2>
        {fullyCollapsed && (
          <div className="sidebar-collapsed-rail">
            <IconButton
              icon={SidebarExpandIcon}
              className="sidebar-expand"
              label={tr("sidebar.expandProjectsAndSessions")}
              aria-expanded="false"
              onClick={expandCollapsed}
            />
            <ShellDock column="start" group="tools" />
            <ShellDock column="start" group="actions" />
            <ShellColumnAccount />
          </div>
        )}
        {!fullyCollapsed && (
        <div className={`sidebar-expanded-shell${effectiveViewMode === "rail" ? " sidebar-expanded-shell--project-rail" : ""}`}>
        {effectiveViewMode === "rail" && (
          <div className="sidebar-project-rail" data-rail-region aria-label={tr("commandpalette.projects")}>
            {/* The sessions-only collapse and its hover peek need the desktop
                geometry; compact drawers show the rail and sessions together. */}
            {!compact && !projectsOnly && (
            <span className="sidebar-rail-switch">
              <IconButton
                icon={collapsed ? SidebarExpandIcon : SidebarCollapseIcon}
                className="sidebar-rail-toggle"
                label={collapsed
                  ? tr("sidebar.expandProjectsAndSessions")
                  : tr("contextrail.collapseValue", { value: railSessionsLabel })}
                aria-expanded={!collapsed}
                onClick={() => {
                  cancelRailCollapse();
                  closePeek();
                  if (collapsed && !layout.collapsed) {
                    releaseAutomaticSidebarRail();
                  } else if (collapsed) {
                    // Old builds switched Tree to rail before saving collapse,
                    // so an unmarked persisted rail returns to Tree once.
                    const restoreViewMode = layout.restoreViewMode
                      ?? (viewMode === "rail" ? "tree" : viewMode);
                    if (restoreViewMode !== viewMode) setSidebarViewMode(restoreViewMode);
                    setSidebarLayout({ collapsed: false });
                  } else {
                    setSidebarLayout({ collapsed: true, restoreViewMode: "rail" });
                  }
                }}
              />
            </span>
            )}
            {!compact && <ShellDock column="start" group="tools" />}
            <div
              ref={railListRef}
              className="sidebar-project-rail-list"
              data-arranging={railArrange && arrange.draggingId ? "" : undefined}
            >
              {(soloPersonal ? [] : arrangedOrder(orderedProjects)).map((candidate) => {
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
                      <Tooltip
                        side={projectRailTooltipSide}
                        delayMs={120}
                        // The open peek's header already names the project
                        // and the bubble would sit right on top of it.
                        disabled={railCollapsed && peek !== null}
                        className="sidebar-project-rail-tooltip"
                        content={(
                          <span className="sidebar-project-rail-tooltip-content">
                            <span className="sidebar-project-rail-tooltip-icon"><ProjectGlyph project={candidate} /></span>
                            <span className="sidebar-project-rail-tooltip-copy">
                              <strong>{candidate.name || candidate.path}</strong>
                              {candidate.name && candidate.path !== candidate.name && !candidate.personal && <span>{candidate.path}</span>}
                            </span>
                          </span>
                        )}
                      >
                        <button
                          {...trigger}
                          type="button"
                          className={`sidebar-project-rail-item${candidate.id === activeProjectId ? " active" : ""}${reorderable ? " is-reorderable" : ""}${arrange.draggingId === candidate.id ? " is-arrange-held" : ""}`}
                          aria-current={candidate.id === activeProjectId ? "true" : undefined}
                          aria-expanded={candidate.id === focusProjectId && (!railCollapsed || peek !== null)}
                          aria-keyshortcuts={reorderable ? "Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined}
                          aria-label={candidate.name || candidate.path}
                          title=""
                          data-arrange-id={reorderable ? candidate.id : undefined}
                          onPointerDown={reorderable ? arrange.engine.itemProps(candidate.id).onPointerDown : undefined}
                          onClick={(event) => toggleRailProject(candidate.id, event.detail)}
                          onPointerEnter={(event) => {
                            if (event.pointerType === "mouse") openPeek(candidate.id);
                          }}
                          onContextMenu={(event) => onProjectContextMenu(event, candidate.id, "rail")}
                          onKeyDown={(event) => {
                            onProjectMenuKeyDown(event, candidate.id, "rail");
                            if (event.defaultPrevented || !reorderable || !event.altKey || !event.shiftKey) return;
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
                      </Tooltip>
                    )}
                  </Menu>
                );
              })}
            </div>
            <ProjectRailTools projectId={activeProjectId ?? null} sessionId={activeSessionId} />
            {!compact && <ShellDock column="start" group="actions" />}
            <div className="sidebar-project-rail-actions customize-zone">
              {/* The rail's pencil edits the rail itself (`sidebar.rail`); the
                  sessions column's toolbar row has its own. Add project and
                  Settings are rail items (`shell.add-project`,
                  `shell.settings`), never fixed buttons here: a fixed copy
                  could not be moved or hidden and doubled the placed one. */}
              <CustomizeZoneButton
                slot={SIDEBAR_RAIL_SLOT}
                side={projectRailTooltipSide}
                align="end"
                className="sidebar-service-btn sidebar-project-rail-tool"
                liveRegion=".sidebar-project-rail"
              />
            </div>
            {!compact && <ShellColumnAccount />}
          </div>
        )}
        <div
          className={`sidebar-main${sessionsLeaving ? " sidebar-main--leaving" : railCollapsed ? ` sidebar-sessions-peek${peek ? " open" : ""}` : ""}`}
          ref={sidebarMainRef}
          // The peek keeps the sessions column exactly as wide as it is when
          // the switch is on, so toggling never resizes the list; so does the
          // column while it leaves or returns with the navigator's width.
          style={railCollapsed || railMotion !== null ? { width: width - railTrackWidth, minWidth: width - railTrackWidth } : undefined}
          onPointerDownCapture={railCollapsed
            ? () => { stopLeave(); setPeek((current) => current && !current.pinned ? { ...current, pinned: true } : current); }
            : undefined}
        >
        {/* The sessions column is a frame (the rail-collapsed peek opens from
            it); only its content takes the document direction back when the
            shell is mirrored. `display: contents`, so layout is unchanged. */}
        <div className="sidebar-main-content" dir={shellDirection.contentDir}>
        {!compact && !railView && <ShellColumnHead />}
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
                    if (isImeComposing(event)) return;
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
                    label={soloPersonal ? tr("sidebar.newChat") : tr("sidebar.newChatInValue", { value: project.name || project.path })}
                    className="sidebar-drawer-tool sidebar-drawer-tool-compose"
                    onClick={() => { startFreshSession(project.id); closeDrawer(); }}
                  />
                )}
                <Menu
                  label={tr("sidebar.moreSidebarActions")}
                  title={tr("sidebar.moreSidebarActions")}
                  align="start"
                  entries={[...layoutEntries, "separator", ...sortEntries]}
                >
                  {(trigger) => (
                    <IconButton
                      icon={SortIcon}
                      label={tr("sidebar.moreSidebarActions")}
                      className={`sidebar-drawer-tool${sort !== "recent" ? " active" : ""}`}
                      {...trigger}
                    />
                  )}
                </Menu>
                <Menu
                  label={tr("sidebar.listOptions")}
                  title={tr("sidebar.listOptions")}
                  align="start"
                  entries={filterEntries}
                  className="session-filter-menu"
                  footer={<SessionDateFilterControls value={dateFilter} onChange={setDateFilter} />}
                >
                  {(trigger) => (
                    <IconButton
                      icon={FilterIcon}
                      label={tr("sidebar.listOptions")}
                      className={`sidebar-drawer-tool${listFiltered ? " active" : ""}`}
                      {...trigger}
                    />
                  )}
                </Menu>
                <IconButton
                  icon={SelectIcon}
                  label={selectMode ? tr("sidebar.cancelSessionSelection") : tr("sidebar.selectSessions")}
                  className={`sidebar-drawer-tool sidebar-select-toggle${selectMode ? " active" : ""}`}
                  aria-pressed={selectMode}
                  onClick={toggleSelectMode}
                />
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
        {showFocusedProject && focusedProject && (
          <div
            className="sidebar-focused-project"
            data-project-id={focusedProject.id}
            data-tools={railHeader ? "" : undefined}
          >
            {renderProjectCard(focusedProject, railHeader ? renderRailHeaderTools(focusedProject) : undefined)}
          </div>
        )}
        {showServiceBar && (
        <div className="sidebar-service-bar customize-zone" data-rail={railHeader ? "" : undefined}>
          {searchPages.hasMore && <button className="show-more-sessions" disabled={searchPages.busy} onClick={() => void searchPages.more()}>{tr("sidebar.sessionlist.showMoreSessions")}</button>}
          {!compact && (
            <IconButton
              icon={SidebarCollapseIcon}
              className="sidebar-collapse"
              label={tr("contextrail.collapseValue", { value: tr("sidebar.projectsAndSessions") })}
              aria-expanded="true"
              onClick={() => setSidebarLayout({ collapsed: true, restoreViewMode: "tree" })}
            />
          )}
          {/* The rail selects from the project's ⋮ menu instead. */}
          {!railHeader && (
            <IconButton
              icon={SelectIcon}
              label={selectMode ? tr("sidebar.cancelSessionSelection") : tr("sidebar.selectSessions")}
              className={`sidebar-list-options sidebar-select-toggle${selectMode ? " active" : ""}`}
              aria-pressed={selectMode}
              onClick={toggleSelectMode}
            />
          )}
          <div className="sidebar-search">
            <Icon.search />
            <input
              type="search"
              value={query}
              autoFocus={railHeader && searchOpen}
              placeholder={tr(searchFitsFullLabel ? "sidebar.searchSessions" : "sidebar.searchSessionsShort")}
              aria-label={tr("sidebar.searchProjectsWorktreesAndSessions")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={railHeader ? (event) => {
                if (isImeComposing(event)) return;
                if (event.key === "Escape" && railSearchOpen) closeRailSearch();
              } : undefined}
              // An empty field gives the row back once focus moves on to
              // something outside the toolbar (a chat, the composer).
              onBlur={railHeader ? (event) => {
                const next = event.relatedTarget as Node | null;
                if (query === "" && next && !event.currentTarget.closest(".sidebar-service-bar")?.contains(next)) {
                  setSearchOpen(false);
                }
              } : undefined}
            />
            {(query || railSearchOpen) && (
              <button
                className="sidebar-search-clear"
                aria-label={tr("sidebar.clearSessionSearch")}
                title={tr("sidebar.clearSearch")}
                onClick={railHeader ? closeRailSearch : () => setQuery("")}
              >{tr("sidebar.message")}</button>
            )}
          </div>
          {project && (
            <IconButton
              icon={ComposeIcon}
              label={soloPersonal ? tr("sidebar.newChat") : tr("sidebar.newChatInValue", { value: project.name || project.path })}
              className="sidebar-new-session"
              onClick={() => {
                startFreshSession(project.id);
                closeDrawer();
              }}
            />
          )}
          {renderListOptions("sidebar-list-options")}
          {/* Widget-areas (WA4): optional search/filter controls belong beside
              the built-in sidebar controls rather than in a second toolbar. */}
          <SlotHost
            slot="sidebar.toolbar"
            context={{ projectId: project?.id, query, attentionOnly, compact }}
            customizable
          />
          {effectiveViewMode !== "rail" && (
            <CustomizeZoneButton slot="sidebar.toolbar" className="sidebar-service-btn" />
          )}
        </div>
        )}
        <div
          ref={sideScrollRef}
          className={`side-scroll${pullDistance > 0 || pullRefreshing ? " pulling" : ""}`}
          data-arranging={!railArrange && arrange.draggingId ? "" : undefined}
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
            <SessionSelectionBar selectedIds={selectedSessionIds} onDone={endSelection} />
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
            : arrangedOrder(visibleProjects)).map((p) => {
            if (effectiveViewMode === "rail") {
              return (
                <div key={p.id} data-project-id={p.id} className="sidebar-focused-sessions">
                  <SessionList
                    projectId={p.id}
                    attentionOnly={attentionOnly}
                    dateFilter={dateFilter}
                    selectMode={selectMode}
                    selectedSessionIds={selectedSessionIds}
                    onToggleSelected={toggleSelectedSession}
                  />
                </div>
              );
            }
            if (soloPersonal) {
              return (
                <div key={p.id} data-project-id={p.id} className="sidebar-focused-sessions">
                  <SessionList
                    projectId={p.id}
                    attentionOnly={attentionOnly}
                    dateFilter={dateFilter}
                    selectMode={selectMode}
                    selectedSessionIds={selectedSessionIds}
                    onToggleSelected={toggleSelectedSession}
                  />
                </div>
              );
            }
            const projectQuery = query.trim()
              && `${p.name} ${p.path}`.toLowerCase().includes(query.trim().toLowerCase())
              ? ""
              : query;
            const card = renderProjectCard(p);
            return (
              <div
                key={p.id}
                data-project-id={p.id}
                className={`project-tree-node${reorderable ? " is-reorderable" : ""}${arrange.draggingId === p.id ? " is-arrange-held" : ""}`}
                // The project's row lifts it; its sessions keep their own gestures.
                {...(reorderable ? arrange.engine.itemProps(p.id) : {})}
              >
                {card}
                {expandedTrees.has(p.id) && (
                  <div className="project-tree-sessions" data-arrange-control="">
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
          {canAddProject && registry.status === "ready" && projects.length > 0 && query.trim() === "" && effectiveViewMode !== "rail" && (
            <button className="sidebar-add-project" onClick={() => setOverlay("project-picker")}>
              <Icon.plus />
              <span>{tr("sidebar.addProject")}</span>
            </button>
          )}
        </div>
        {/* Footer widgets render only when placed; no reserved empty bar. */}
        <SlotHost
          slot="sidebar.footer"
          context={{ projectId: activeProjectId, sessionId: activeSessionId, expanded }}
          customizable
        />
        {!compact && !railView && <ShellColumnFoot />}
        </div>
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
      {appearanceProjectId && (() => {
        const target = projects.find((candidate) => candidate.id === appearanceProjectId);
        return target ? <ProjectAppearanceDialog key={`${target.id}:${projectSettingsPage}`} project={target} initialPage={projectSettingsPage} onClose={() => setAppearanceProjectId(null)} /> : null;
      })()}
      {conversationProjectId && (
        <ConversationCreateDialog
          open
          projectId={conversationProjectId}
          onClose={() => setConversationProjectId(null)}
        />
      )}
    </>
  );
}
