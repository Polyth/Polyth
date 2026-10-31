// EXTENSION-SEAMS slice 2: built-in workspace surfaces. Each main-area view
// registers into the workspace surface registry — Main.tsx composes the host
// and never enumerates feature views. Importing this module registers the
// built-ins once. Every built-in requires a project; the host renders the
// standard project empty state when none is open. None require an open
// session: the session surface shows its hero until one exists.
import Badge from "../ui/Badge.tsx";
import { draftTitleSource, sessionDraftMark } from "../../sessionDraft.ts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Timeline from "../Timeline.tsx";
import Composer from "../Composer.tsx";
import { focusComposer, isActiveSessionSpawning, overlaySessionProjection, setOverlay, setUiError, useActiveModel, usePendingSends, useStore, workspaceProjectId } from "../../store.ts";
import { activateRuntime, openSession, prefetchSessionTail, restoreSession } from "../../init.ts";
import { friendlyError } from "../../settings.ts";
import { composerBlockedByArchive, sessionSurfaceKind, type SessionSurfaceKind } from "../../sessionSurface.ts";
import { advanceSessionLoad, IDLE_SESSION_LOAD, SESSION_FIRST_SEND_HOLD_MS, SESSION_PLACEHOLDER_FADE_MS, sessionRevealDuration, sessionRevealPhase, type SessionLoadState } from "../../sessionLoad.ts";
import { registerWorkspaceSurface } from "../../workspace/surfaceRegistry.ts";
import { companionSessionId, useSessionSplit } from "../../sessionSplit.ts";
import SessionSplitHost from "./SessionSplitView.tsx";
import { registerSlot } from "../../slots.ts";
import WidgetCanvas from "../../widgets/WidgetCanvas.tsx";
import { useWorkspaceContentMode } from "../../widgets/workspaceMode.ts";
import SlotHost from "../slots/SlotHost.ts";
import { Icon } from "../../icons.tsx";
import { resolveSessionActivity } from "../../sessionActivity.ts";
import StarterPicker, { StarterGlyph } from "../mobile/StarterPicker.tsx";
import { openPackageWindow, useWindowPackages } from "../../starterPackages.ts";
import { requestComposerInsert } from "../../composerInsert.ts";
import { useGitStatus } from "../../../../../packages/git/widgets/gitStatusStore.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { useSpaces } from "../../spaces.ts";
import { tapFeedback } from "../../haptics.ts";
import { dismissKeyboard } from "../../mobileViewport.ts";
import { HeroWidget, HeroWidgetHost, useHeroWidgetPrefs } from "../mobile/HeroWidgets.tsx";
import { HeroBoardItems } from "../mobile/HeroBoard.tsx";
import { HeroCustomizeButton } from "../mobile/HeroCustomize.tsx";
import { HeroEditToolbar, useHeroEditGesture } from "../mobile/HeroEditMode.tsx";
import { MobileStatusIcon } from "../mobile/MobileStatusIcon.tsx";
import { HeroAppsWidget } from "../mobile/HeroApps.tsx";
import { heroRecentIsNarrowed, heroRecentPageSize, heroRecentProjectIds, heroRecentSummaryQuery, selectHeroRecentSessions } from "../../heroRecent.ts";
import { useSessionSummaryPages } from "../../useSessionSummaryPages.ts";
import { ago, displaySessionTitle, isPlaceholderTitle } from "../../format.ts";
import { conversationUnread, unreadBadgeText } from "../../sessionPeople.ts";
import AgentLiveStatusDock from "../AgentLiveStatusDock.tsx";
import SubagentActivityDock, { SubagentBranchIsland, SubagentBranchScope } from "../SubagentActivityDock.tsx";
import CustomizeZoneButton from "../CustomizeZoneButton.tsx";
import { useWidgetCatalog } from "../../widgets/catalog.ts";
import { useWidgetLayout, widgetDefinitionId } from "../../widgets/widgetLayout.ts";
import {
  noteStarterUsed,
  starterContextFrom,
  starterSessionContext,
  useStarterPrefs,
  visibleStarters,
  type Starter,
  type StarterContext,
} from "../../starters.ts";
import { tr } from "../../i18n/index.ts";
import { projectGreetingParts } from "../../projectGreeting.ts";
import { isPersonalProject } from "../../personalProject.ts";
import { AgentStatusDock, Button, Icon as UiIcon, PeopleIcon, ShieldAlertIcon } from "../ui/index.ts";
import { resolveSessionStatus } from "../../sessionStatus.ts";
import ProviderLogo from "../../../../../packages/models/widgets/ProviderLogo.tsx";
import { resolveModelPresentation } from "@polyth/contracts/model-presentation";

const NOOP_STARTER = (_starter: Starter): void => {};

// The fresh-session screen is three zones — top navigation
// (Header), a calm centered empty state with quick starters, and ONE sticky
// interaction zone (project/branch context + composer) pinned above the
// keyboard. Project and branch never split the page between the headline and
// the composer any more.
function SessionHeroBody({ starterContext }: { starterContext: StarterContext }) {
  const projects = useStore((s) => s.projectRegistry.projects);
  const projectId = useStore(workspaceProjectId);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const name = project?.name || project?.path || tr("permissionbanner.thisProject");
  const greeting = projectGreetingParts(project?.greeting);
  const showGreeting = useHeroWidgetPrefs().chrome.greeting;

  // Quick starters (§3/§35): pinned first, then suggestions that follow the
  // real workspace state — a dirty worktree offers review/commit work, a clean
  // one offers exploration and planning. Pinned package windows join them.
  const shell = useShellMode();
  const starterPrefs = useStarterPrefs();
  const packages = useWindowPackages();
  const chips = useMemo(
    () => visibleStarters(starterPrefs, starterContext, shell === "phone" ? 2 : 3, { packages }),
    [starterPrefs, starterContext, shell, packages],
  );
  const runStarter = (starter: Starter) => {
    noteStarterUsed(starter.id);
    if (shell === "phone") tapFeedback();
    if (starter.capabilityId) {
      void dismissKeyboard();
      openPackageWindow(starter.capabilityId);
      return;
    }
    requestComposerInsert(starter.prompt);
  };

  const editGesture = useHeroEditGesture(projectId);

  return (
    <div className="hero-body customize-zone" {...editGesture}>
      {!showGreeting ? null : greeting === undefined && isPersonalProject(project)
        // The personal project is not a place the person chose; don't name it.
        ? <h2>{tr("personalproject.greeting")}</h2>
        : greeting === undefined
        ? <h2>{tr("workspace.builtinsurfaces.whatAreWeWorkingOnIn")}{" "}<span className="polyth-gradient">{name}</span>.</h2>
        : greeting && <h2>{greeting.map((part, index) => part.kind === "name"
          ? <span key={index} className="polyth-gradient">{name}</span>
          : part.text)}</h2>}
      <HeroWidgetHost projectId={projectId}>
        <SlotHost
          slot="session.empty.widgets"
          context={{
            projectId,
            chips,
            runStarter,
          }}
          customizable
          placed={false}
        />
        <HeroBoardItems projectId={projectId} />
      </HeroWidgetHost>
      <HeroEditToolbar />
      {/* The screen's Customize panel — greeting, widgets, Recent options and
          the composer's rows and buttons. A mouse reaches its pencil with
          Shift or the workspace Edit mode; touch with a long press on the
          screen, which works even when every piece is switched off. */}
      <HeroCustomizeButton />
    </div>
  );
}

/** The fresh-session surface: the hero body above the one sticky composer
 *  dock. Body and dock are split so the first-send handoff can fade the hero
 *  body before the transcript replaces the surface, leaving the composer in
 *  its resting place instead of duplicating it. */
function SessionHero({ starterContext, leaving = false }: { starterContext: StarterContext; leaving?: boolean }) {
  return (
    <div className="stage stage-new" data-leaving={leaving ? "true" : undefined}>
      <div className="hero">
        <SessionHeroBody starterContext={starterContext} />
        <div className="hero-dock">
          <Composer />
        </div>
      </div>
    </div>
  );
}

function HeroStartersWidget({
  chips,
  runStarter,
}: {
  chips: Starter[];
  runStarter: (starter: Starter) => void;
}) {
  return (
    <HeroWidget id="starters">
      <div className="hero-starters" aria-label={tr("workspace.builtinsurfaces.quickStarters")}>
        {chips.map((starter) => (
          <button
            key={starter.id}
            type="button"
            className="starter-chip"
            title={starter.description ?? starter.label}
            onClick={() => runStarter(starter)}
          >
            <span className="starter-chip-icon" aria-hidden="true"><StarterGlyph starter={starter} /></span>
            <span className="starter-chip-text">{starter.label}</span>
          </button>
        ))}
      </div>
    </HeroWidget>
  );
}

/** §50: recent work stays a light, bounded list — the new-chat screen is a
 *  starting point, never a dashboard. No heading, no cards, no metrics, no
 *  chrome: count, filter, project scope and text size live in the screen's
 *  Customize panel. */
function RecentSessions({ projectId }: { projectId: string | null }) {
  // Subscribes only to the session list. The prompt-derived title is persisted
  // into the session record on the first user message (store.applyEvents), so
  // this panel doesn't need the whole events map — and won't re-render on every
  // streamed chunk of any session.
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projectRegistry.projects);
  const prefs = useHeroWidgetPrefs().recent;
  // The list keeps its `prefs.limit`-row footprint and scrolls: one page more
  // than fits is rendered, each time the end comes into view another page is
  // revealed, and once the cached sessions run out older ones are fetched
  // through the shared summary pager (which upserts them into the store).
  const step = heroRecentPageSize(prefs);
  const [visibleCount, setVisibleCount] = useState(prefs.limit + step);
  const [remoteWanted, setRemoteWanted] = useState(false);
  const prefsKey = JSON.stringify(prefs);
  useEffect(() => {
    setVisibleCount(prefs.limit + step);
    setRemoteWanted(false);
  }, [prefsKey, projectId]);
  const matching = useMemo(
    () => selectHeroRecentSessions(sessions, prefs, projectId, Date.now(), Number.POSITIVE_INFINITY),
    [sessions, prefs, projectId],
  );
  const recent = useMemo(() => matching.slice(0, visibleCount), [matching, visibleCount]);
  const scopedProjects = heroRecentProjectIds(prefs, projectId);
  const pagingEnabled = remoteWanted && (scopedProjects === null || scopedProjects.size > 0);
  const summaryQuery = useMemo(() => heroRecentSummaryQuery(prefs, projectId), [prefs, projectId]);
  const pages = useSessionSummaryPages(summaryQuery, pagingEnabled);
  const localMore = matching.length > visibleCount;
  const canGrow = localMore || !remoteWanted || (pagingEnabled && pages.hasMore);
  // Not needed until the cache can no longer fill the next page: most opens
  // never scroll, and the active project's first page is already cached.
  useEffect(() => {
    if (!remoteWanted && matching.length < visibleCount) setRemoteWanted(true);
  }, [remoteWanted, matching.length, visibleCount]);
  const listRef = useRef<HTMLUListElement | null>(null);
  const sentinelRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !canGrow || pages.busy || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((records) => {
      if (!records.some((record) => record.isIntersecting)) return;
      if (localMore) setVisibleCount((count) => count + step);
      else if (pagingEnabled) {
        setVisibleCount((count) => count + step);
        void pages.more();
      }
    }, { root: listRef.current, rootMargin: "0px 0px 120px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [canGrow, localMore, pagingEnabled, pages.busy, step, recent.length]);
  // Rows name their project only when the list can span several.
  const projectNames = useMemo(() => {
    const scoped = heroRecentProjectIds(prefs, projectId);
    if (scoped && scoped.size <= 1) return null;
    return new Map(projects.map((project) => [project.id, project.name || project.path]));
  }, [prefs, projectId, projects]);
  useEffect(() => {
    for (const session of recent) {
      if (isPlaceholderTitle(session.title, session.id)) {
        prefetchSessionTail(session.id);
      }
    }
  }, [recent]);
  if (recent.length === 0 && !heroRecentIsNarrowed(prefs)) return null;
  return (
    <HeroWidget id="recent"><div className="hero-recent" data-size={prefs.size}>
      {recent.length === 0 ? <p className="hero-recent-empty">{tr("workspace.herorecent.empty")}</p> : (
      <ul
        ref={listRef}
        aria-label={tr("mobile.herowidgets.recentSessions")}
        aria-busy={pages.busy || undefined}
        style={{ "--hero-recent-rows": prefs.limit } as CSSProperties}
      >
        {recent.map((session) => {
          const status = resolveSessionStatus(session);
          const done = session.status === "finished";
          const unread = (session.attention?.unread ?? 0) > 0;
          const conversation = session.purpose === "conversation";
          const unreadMessages = conversationUnread(session);
          const statusLabel = conversation ? tr("conversation.kind") : done ? tr("notificationcentre.completed") : status.label;
          return (
            <li key={session.id}>
              <button
                type="button"
                className="hero-recent-row"
                onClick={() => void openSession(session.id).catch((error) =>
                  setUiError(friendlyError(tr("common.error"), error)))}
              >
                <span
                  className={`hero-recent-status ${conversation ? "conversation" : status.kind}`}
                  title={statusLabel}
                  aria-label={statusLabel}
                >
                  {conversation ? (
                    // People talk here; there is no agent state to show.
                    <UiIcon icon={PeopleIcon} size="sm" />
                  ) : status.kind === "working" ? (
                    <span className="ui-spinner ui-spinner--sm" aria-hidden />
                  ) : done ? (
                    <span className="hero-recent-check" aria-hidden>✓</span>
                  ) : status.kind === "rate-limited" ? (
                    <span className="hero-recent-icon" aria-hidden><MobileStatusIcon kind="rate-limited" /></span>
                  ) : status.kind === "needs-approval" ? (
                    // Not a check: that mark already means a finished chat here.
                    <UiIcon icon={ShieldAlertIcon} size="sm" />
                  ) : (
                    <span aria-hidden>{status.glyph}</span>
                  )}
                </span>
                <span className={`hero-recent-title${(done || conversation) && unread ? " hero-recent-title--unread" : ""}`}>
                  {displaySessionTitle(session.title, session.id, draftTitleSource(session))}
                </span>
                {projectNames && session.projectId !== projectId && (
                  <span className="hero-recent-project">{projectNames.get(session.projectId)}</span>
                )}
                {sessionDraftMark(session, false) && (
                  <Badge tone="accent" className="session-draft-mark">{tr("sidebar.sessionlist.draft")}</Badge>
                )}
                {unreadMessages > 0 && (
                  <span
                    className="session-unread-count"
                    role="img"
                    aria-label={tr("sidebar.sessionlist.unreadMessages", { count: unreadMessages })}
                  >{unreadBadgeText(unreadMessages)}</span>
                )}
                {/* A conversation has no turns: its last message moved it last. */}
                <span className="hero-recent-time">{ago(conversation ? session.updatedAt : session.lastTurnAt ?? session.createdAt)}</span>
              </button>
            </li>
          );
        })}
        {canGrow && (
          <li ref={sentinelRef} className="hero-recent-more" aria-hidden>
            {pages.busy && <span className="ui-spinner ui-spinner--sm" />}
          </li>
        )}
      </ul>
      )}
    </div></HeroWidget>
  );
}

// UX-TIMELINE-LAYOUT-01 §8 initial replay: an unresolved canonical event load
// is represented as loading — never as the fresh-session hero and never as a
// phantom empty timeline. The row is honest, bounded, and appends no event.
//
// Packet C: it is a *layer over the transcript area*, not the whole surface, so
// the composer dock below it never unmounts, and it only appears after the
// delay (sessionLoad.ts) with a cross-fade out under the revealed content.
function sessionMotionDisabled(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.dataset.reduceAnimations === "true") return true;
  if (document.body?.dataset.desktopLowResource === "true") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Placeholder + reveal state for the session surface (machine in sessionLoad.ts). */
function useSessionLoad(loading: boolean): { placeholder: boolean; leaving: boolean; everShown: boolean } {
  const [state, setState] = useState<SessionLoadState>(IDLE_SESSION_LOAD);
  useEffect(() => {
    setState((current) => advanceSessionLoad(current, { loading, now: Date.now() }));
  }, [loading]);
  useEffect(() => {
    if (state.nextChangeAt === null) return;
    const timer = setTimeout(() => {
      setState((current) => advanceSessionLoad(current, { loading, now: Date.now() }));
    }, Math.max(0, state.nextChangeAt - Date.now()));
    return () => clearTimeout(timer);
  }, [state.nextChangeAt, loading]);
  return { placeholder: state.shown, leaving: state.leaving, everShown: state.everShown };
}

/**
 * The one reveal of a session surface. `entering` is returned for the commit in
 * which a session's transcript lands (so the first painted frame of that commit
 * is already in its final position, only transparent), and the next frame flips
 * the attribute so CSS transitions it into place exactly once. Session-id
 * changes only: mounting the view must not replay a reveal.
 */
function useSessionReveal(sessionId: string | null, durationMs: number, suppress = false): "entering" | "idle" {
  const revealed = useRef<string | null>(sessionId);
  const frame = useRef<number | null>(null);
  const [state, setState] = useState<{ sessionId: string | null; phase: "entering" | "idle" }>({ sessionId, phase: "idle" });
  const changed = revealed.current !== sessionId;
  useLayoutEffect(() => {
    // Keyed on the session id, not on `changed`: the setState below re-renders
    // this hook synchronously, and a `changed` dependency would tear this
    // effect down in that commit — React would run the cleanup and cancel the
    // frame before it fires, stranding the phase at `entering`, which
    // sessionLoad.css renders as `.timeline-wrap { opacity: 0 }` (blank chat).
    if (revealed.current === sessionId) return;
    revealed.current = sessionId;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    // A first-send id lands on a surface that is already on screen: the
    // arriving transcript is the hero handoff, not a fresh open, so it must
    // not replay the reveal in the middle of that choreography.
    if (suppress || sessionMotionDisabled() || typeof requestAnimationFrame !== "function") {
      setState({ sessionId, phase: "idle" });
      return;
    }
    setState({ sessionId, phase: "entering" });
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setState((current) => (current.sessionId === sessionId ? { sessionId, phase: "idle" } : current));
    });
    // Deliberately no cleanup here: it would cancel the frame above on the
    // hook's own re-render.
  }, [sessionId, suppress]);
  // Cancel only a frame still in flight when the surface unmounts; a later
  // session change supersedes the previous frame through the ref above.
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);
  const phase = sessionRevealPhase(changed, suppress, state.phase);
  // Host signal for the arrival observer: while a session surface is settling,
  // its history rows get no per-row entrance (packet A consumes this in
  // chatMotion). `entering` lasts one frame, the reveal itself `durationMs`.
  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (phase === "entering") {
      root.dataset.sessionReveal = "active";
      return;
    }
    const timer = setTimeout(() => {
      if (root.dataset.sessionReveal === "active") delete root.dataset.sessionReveal;
    }, durationMs);
    return () => clearTimeout(timer);
  }, [phase, durationMs]);
  return phase;
}

function SessionLoadingLayer({ state }: { state: "visible" | "leaving" | "idle" }) {
  return (
    <div
      className="session-load-layer"
      data-state={state}
      aria-hidden={state === "visible" ? undefined : true}
    >
      <div className="stage">
        <div className="session-load-skeleton" aria-hidden="true">
          <span /><span /><span />
        </div>
        <div className="session-loading" role="status">
          <span className="ui-spinner ui-spinner--sm" aria-hidden="true" />
          <span>{tr("workspace.builtinsurfaces.loadingSession")}</span>
        </div>
      </div>
    </div>
  );
}

/** First-send/runtime startup belongs in the same above-composer activity
 * zone as an active run. It owns only the pre-working handoff; as soon as the
 * session becomes working, the git widget live agent-status dock takes over
 * and this transient surface disappears even if spawn bookkeeping lags. */
function SessionSpawnStatus({ spawning, resolvedHarnessId, pendingModel }: {
  spawning: boolean;
  resolvedHarnessId?: string;
  pendingModel?: { providerID: string; modelID: string };
}) {
  const spawn = useStore((state) => state.sessionSpawn);
  const models = useStore((state) => state.models);
  const status = spawning
    ? tr("workspace.builtinsurfaces.spawningAgent")
    : tr("workspace.builtinsurfaces.startingTurn");
  const harnessId = (spawning ? spawn?.harnessId : undefined) ?? resolvedHarnessId;
  const harnessName = (spawning ? spawn?.harnessName?.trim() : undefined) || harnessId
    ?.split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ")
    || tr("timeline.agent");
  const effectiveModel = (spawning ? spawn?.model : undefined) ?? pendingModel;
  const pendingLabel = effectiveModel
    ? resolveModelPresentation(effectiveModel, models, resolvedHarnessId).name
    : undefined;
  const harnessLabel = pendingLabel ?? harnessName;
  return (
    <AgentStatusDock
      icon={harnessId
        ? <ProviderLogo providerID={harnessId} providerName={harnessName} size="regular" />
        : <Icon.session />}
      model={harnessLabel}
      status={status}
      label={`${harnessLabel}: ${status}`}
    />
  );
}

/** Archived sessions are read-only: one explicit, atomic restore-and-continue
 *  action replaces the composer. */
function ArchivedComposerGuard({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="archived-guard" role="status">
      <span className="archived-guard-text">
        {tr("workspace.builtinsurfaces.thisSessionIsArchivedAndReadOnly")}</span>
      <Button
        variant="primary"
        className="archived-restore-btn"
        busy={busy}
        onClick={() => {
          setBusy(true);
          void restoreSession(sessionId)
            .catch((e) => setUiError(friendlyError(tr("common.error"), e)))
            .finally(() => setBusy(false));
        }}
      >
        {tr("workspace.builtinsurfaces.restoreAndContinue")}</Button>
    </div>
  );
}

/** How long the startup dock may bridge admission → live turn. */
const STARTUP_DOCK_HOLD_MS = 900;

interface StartupDock {
  spawning: boolean;
  harnessId?: string;
  model?: { providerID: string; modelID: string };
}

/**
 * Admission retires the prompt echo a moment before the live turn reports
 * itself (`turn/started` or the working projection). Without a bridge, neither
 * dock shows for that moment and the composer drops and rises by one dock
 * height. Hold the last startup dock across that gap — never over the live
 * dock, never past a short bound, and never into another session.
 */
function useStartupDock(sessionId: string | null, wanted: StartupDock | null, working: boolean): StartupDock | null {
  const [held, setHeld] = useState<{ sessionId: string | null; dock: StartupDock } | null>(null);
  const current = wanted ? { sessionId, dock: wanted } : null;
  const currentKey = current ? JSON.stringify(current) : null;
  useEffect(() => {
    // The live dock owns the zone the moment a turn is running. Release the
    // held startup dock here instead of on a timer: a short turn (or a fast
    // admission) would otherwise resurrect "Spawning agent…" after the live
    // dock had already shown — a visible blink back to the startup state.
    if (working) {
      setHeld(null);
      return;
    }
    if (current) {
      setHeld((previous) => (previous && JSON.stringify(previous) === currentKey ? previous : current));
      return;
    }
    const timer = setTimeout(() => setHeld(null), STARTUP_DOCK_HOLD_MS);
    return () => clearTimeout(timer);
    // `current` is represented by its serialized key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, working]);
  if (working) return null;
  if (wanted) return wanted;
  return held?.sessionId === sessionId ? held.dock : null;
}

// The Canvas/chat switch lives in its own component: the chat surface runs a
// fixed hook list, and returning the canvas part-way through it made React
// abort with "rendered fewer hooks than expected" (#300) on every switch.
// The split host always wraps the chat surface (SessionSplitView.tsx): the
// split opens and closes around it without a remount.
function SessionSurface() {
  return useWorkspaceContentMode() === "chat" ? <SessionSplitHost focused={<ChatSessionSurface />} /> : <WidgetCanvas />;
}

function ChatSessionSurface() {
  const spaceId = useSpaces().activeSpaceId ?? undefined;
  const projectId = useStore(workspaceProjectId);
  const sessionId = useStore((s) => s.activeSessionId);
  const openingSessionId = useStore((s) => s.openingSessionId);
  const spawning = useStore(isActiveSessionSpawning);
  const sessionSpawn = useStore((s) => s.sessionSpawn);
  const sessionRecord = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const pendingSends = usePendingSends(sessionId);
  const session = overlaySessionProjection(sessionRecord, pendingSends) ?? null;
  const starterPickerOpen = useStore((s) => s.overlay === "starter-picker");
  const model = useActiveModel();
  // Both the startup dock and the package live dock consume one resolver so a
  // stale turn during a harness epoch handoff cannot make two status surfaces
  // visible or re-display the previous runtime's model.
  const activity = resolveSessionActivity(sessionRecord, model.turn, pendingSends);
  const working = activity.working;
  const awaitingTurn = activity.awaitingTurn;
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const hasLiveFooterDock = (layout.slotPlacements["session.footer"] ?? []).some((instanceId) => {
    const defId = widgetDefinitionId(layout, instanceId);
    const placement = layout.widgets[instanceId];
    const widget = widgets.find((w) => w.id === defId);
    return defId === "git.pending-changes" && widget !== undefined && (placement?.visible || widget.requiredVisible);
  });
  const gitStatus = useGitStatus(projectId, false);
  // The project's directions pick which built-in starter group applies.
  const projectDirections = useStore((s) =>
    s.projectRegistry.projects.find((candidate) => candidate.id === projectId)?.composition?.directions);
  const personalProject = useStore((s) =>
    isPersonalProject(s.projectRegistry.projects.find((candidate) => candidate.id === projectId)));
  const starterContext = useMemo(
    () => ({
      ...starterContextFrom(gitStatus, starterSessionContext(model)),
      ...(projectDirections?.length ? { directions: projectDirections } : {}),
      ...(personalProject ? { personal: true } : {}),
    }),
    [gitStatus, model, projectDirections, personalProject],
  );
  const [latestRevealAnchor, setLatestRevealAnchor] = useState<HTMLDivElement | null>(null);
  // The startup dock owns only the pre-working handoff. Once the live activity
  // dock has taken the zone for this spawn, a brief non-working frame (a fast
  // turn finishing before the spawn record clears) must not bring
  // "Spawning agent…" back over it.
  const liveDockSeen = useRef(false);
  if (sessionSpawn === null) liveDockSeen.current = false;
  if (working) liveDockSeen.current = true;
  const startupModel = activity.pendingSend?.model ?? activity.model ?? sessionRecord?.model;
  const startupDock = useStartupDock(
    sessionId,
    !working && !liveDockSeen.current && (spawning || awaitingTurn)
      ? {
          spawning,
          ...(activity.harnessId ? { harnessId: activity.harnessId } : {}),
          ...(startupModel ? { model: startupModel } : {}),
        }
      : null,
    working,
  );

  // Fresh state yields to pending prompts and permissions; an in-flight
  // canonical replay yields to the loading row (never a false fresh hero).
  // Archived sessions remain visible but replace the composer with the
  // atomic restore action. A first-send echo keeps the timeline surface so
  // the composer is not remounted back onto the hero with the sent draft.
  const kind = sessionSurfaceKind(
    sessionId,
    openingSessionId,
    model,
    session,
    spawning || pendingSends.length > 0,
  );
  // A first-send handoff is the spawn that actually replaced this component's
  // hero, not merely any spawn in the same project. Latch its request through
  // the brief id-bind gap and its resulting session through delivery; clear it
  // on the next session switch so suppression never leaks to another chat.
  const previousRawKindRef = useRef<SessionSurfaceKind | null>(null);
  const firstSendRequest = useRef<number | null>(null);
  const firstSendSession = useRef<string | null>(null);
  const spawnMatchesProject = sessionSpawn !== null && sessionSpawn.projectId === projectId;
  const firstSendTransition = previousRawKindRef.current === "hero"
    && kind === "session"
    && spawnMatchesProject;
  if (firstSendTransition) firstSendRequest.current = sessionSpawn!.requestId;
  const firstSendHandoff = spawnMatchesProject && firstSendRequest.current === sessionSpawn?.requestId;
  if (firstSendHandoff && sessionId !== null) firstSendSession.current = sessionId;
  if (kind === "hero") {
    firstSendRequest.current = null;
    firstSendSession.current = null;
  } else if (firstSendSession.current !== null && firstSendSession.current !== sessionId) {
    firstSendRequest.current = null;
    firstSendSession.current = null;
  }
  const firstSendSuppressed = firstSendHandoff
    || (firstSendSession.current !== null && firstSendSession.current === sessionId);
  // ---- opening an existing chat: brief hold, placeholder, reveal (packet C) --
  // While a canonical window for a not-yet-visible session is in flight the area
  // keeps whatever it showed last — the previous transcript or the fresh hero —
  // only through the placeholder delay, which also covers the mobile
  // navigator's close. A slower open then shows the loading layer: holding the
  // previous transcript for the whole load read as the tap bouncing back.
  const heldSurface = useRef<ReactNode>(null);
  const loading = kind === "loading" || (openingSessionId !== null && openingSessionId !== sessionId);
  const load = useSessionLoad(loading);
  const revealMs = sessionRevealDuration(load.everShown);
  // Focusing the other chat of a split shows a transcript already on screen
  // in that place: it must not fade in again.
  const companion = companionSessionId(useSessionSplit());
  const previousCompanion = useRef<string | null>(null);
  const splitFocus = sessionId !== null && previousCompanion.current === sessionId;
  previousCompanion.current = companion;
  const reveal = useSessionReveal(sessionId, revealMs, firstSendHandoff || splitFocus);
  const revealStyle = {
    "--session-reveal-ms": `${revealMs}ms`,
    "--session-load-fade-ms": `${SESSION_PLACEHOLDER_FADE_MS}ms`,
  } as CSSProperties;
  // ---- first-send handoff: dissolve the hero before the transcript ---------
  // A first send replaces the fresh-session hero with the transcript in one
  // commit. Without a bridge the hero cuts away while the incoming transcript
  // fades up from nothing, which reads as a blink. Hold the hero on screen for
  // one motion beat, fading its body, then swap in the transcript while the
  // prompt takes its flight out of the composer. Deriving the hold during the
  // send render keeps the hero on screen for the very first painted frame.
  const [heroHold, setHeroHold] = useState(false);
  if (
    firstSendTransition
    && !heroHold
    && !sessionMotionDisabled()
  ) {
    setHeroHold(true);
  }
  previousRawKindRef.current = kind;
  useLayoutEffect(() => {
    if (!heroHold) return;
    const timer = setTimeout(() => setHeroHold(false), SESSION_FIRST_SEND_HOLD_MS);
    return () => clearTimeout(timer);
  }, [heroHold]);
  const effectiveKind: SessionSurfaceKind = heroHold ? "hero" : kind;
  const picker = starterPickerOpen ? (
    <StarterPicker
      context={starterContext}
      onPick={(starter) => requestComposerInsert(starter.prompt)}
      onOpenPackage={(starter) => {
        // The window takes focus: close the picker without handing it back to
        // the composer (that would raise the phone keyboard over the window).
        setOverlay(null);
        if (starter.capabilityId) openPackageWindow(starter.capabilityId);
      }}
      onClose={() => {
        setOverlay(null);
        focusComposer();
      }}
    />
  ) : null;
  if (loading && load.placeholder) {
    return <><div className="focus-conversation" data-session-reveal={reveal} style={revealStyle}>
      <SessionLoadingLayer key="session-load" state="visible" />
    </div>{picker}</>;
  }
  if (kind === "loading") return <>{heldSurface.current}{picker}</>;
  if (effectiveKind === "hero") {
    const hero = <SessionHero starterContext={starterContext} leaving={heroHold} />;
    heldSurface.current = hero;
    return <>{hero}{picker}</>;
  }

  const archived = composerBlockedByArchive(session);
  // Recovery notices live above the composer, so this slot carries the harness
  // identity the composer's own execution rail used to be the only source of.
  const composerBeforeContext = {
    projectId,
    sessionId,
    editing: false,
    spaceId,
    harnessSelection: session?.harness,
    resolvedHarnessId: session?.resolvedHarnessId,
    harnessTransition: session?.harnessTransition,
    pendingHarnessSelection: session?.harness,
  };

  const conversation = (
    <div
      className="focus-conversation"
      data-session-reveal={reveal}
      data-first-send={firstSendSuppressed ? "" : undefined}
      style={revealStyle}
    >
      {/* Always the first child: the layer's index must not shift, or React
          would remount the timeline-wrap under it. `idle` is display:none. */}
      <SessionLoadingLayer key="session-load" state={load.leaving ? "leaving" : "idle"} />
      <div className="timeline-wrap">
        {session?.historyImport && session.historyImport.state !== "complete" && (
          <div className="session-import-status" role="status">
            <span>{session.historyImport.state === "failed" ? tr("sessionimport.failed", { count: 1 }) : tr("importsessionsdialog.importing")}</span>
            {session.historyImport.state === "failed" && sessionId && <Button size="sm" onClick={() => activateRuntime(sessionId)}>{tr("common.retry")}</Button>}
          </div>
        )}
        <Timeline model={model} latestRevealTarget={latestRevealAnchor} />
      </div>
       {archived && sessionId
        ? <>
            <SlotHost slot="session.composer.before" context={composerBeforeContext} customizable />
            <div ref={setLatestRevealAnchor} className="timeline-latest-reveal-anchor" />
            <SlotHost slot="session.footer" context={{ projectId, sessionId, editing: false }} customizable />
            <ArchivedComposerGuard sessionId={sessionId} />
          </>
        : <div className="conversation-composer-dock">
            <SlotHost slot="session.composer.before" context={composerBeforeContext} customizable />
            {/* The area renders nothing while empty, so its pencil lives in a
                zero-height zone that only takes space in edit mode. */}
            <div className="composer-before-zone customize-zone">
              <CustomizeZoneButton slot="session.composer.before" align="center" side="up" />
            </div>
            <div ref={setLatestRevealAnchor} className="timeline-latest-reveal-anchor" />
            {/* The status zone. Delegated work outlives the agent's own turn:
                its active subagents hang from whichever status line shows (the
                git package's live dock, the startup dock or the live dock
                here), and from an idle line of their own once it ends. */}
            <SubagentBranchScope sessionId={sessionId} model={model}>
              <SlotHost slot="session.footer" context={{ projectId, sessionId, editing: false }} customizable />
              {startupDock && (
                <SubagentBranchIsland>
                  <SessionSpawnStatus
                    spawning={startupDock.spawning}
                    {...(startupDock.harnessId ? { resolvedHarnessId: startupDock.harnessId } : {})}
                    {...(startupDock.model ? { pendingModel: startupDock.model } : {})}
                  />
                </SubagentBranchIsland>
              )}
              {working && !hasLiveFooterDock && <AgentLiveStatusDock activity={activity} model={model} />}
              {!working && !startupDock && <SubagentActivityDock />}
            </SubagentBranchScope>
            <Composer />
          </div>}
    </div>
  );
  heldSurface.current = conversation;
  return <>{conversation}{picker}</>;
}

// Fresh-session widgets are slot contributions, not SessionHero internals.
// Plugins can register another `session.empty.widgets` contribution (a
// project briefing, a rotating prompt rail, etc.) without editing this view;
// built-ins remain locally hideable/reorderable through HeroCustomize. Catalog
// widgets that list the slot are added to the account's board instead
// (HeroBoard.tsx), not placed in the project's widget layout.
registerSlot("session.empty.widgets", "builtin.hero-starters", (context) => (
  <HeroStartersWidget
    chips={(context.chips as Starter[] | undefined) ?? []}
    runStarter={(context.runStarter as ((starter: Starter) => void)) ?? NOOP_STARTER}
  />
), 10);
registerSlot("session.empty.widgets", "builtin.hero-recent", (context) => (
  <RecentSessions projectId={(context.projectId as string | null | undefined) ?? null} />
), 20);
registerSlot("session.empty.widgets", "builtin.hero-apps", () => <HeroAppsWidget />, 30);

// Ids stay the built-in AppView names this slice; store.ts keeps persisting
// the union. Orders mirror the header's view groups: chat, then workflows.
// Files, Git, Terminal, and Preview are NOT primary surfaces —
// they are canonical workspace panes registered in railSurfaces.tsx and
// opened through openWorkspacePane() beside a still-mounted Chat.
registerWorkspaceSurface({ id: "session", title: tr("workspace.builtinsurfaces.session"), order: 0, plugin: "session", requires: "project", component: SessionSurface });
