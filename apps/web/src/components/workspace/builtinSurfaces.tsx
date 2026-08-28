// EXTENSION-SEAMS slice 2: built-in workspace surfaces. Each main-area view
// registers into the workspace surface registry — Main.tsx composes the host
// and never enumerates feature views. Importing this module registers the
// built-ins once. Every built-in requires a project; the host renders the
// standard project empty state when none is open. None require an open
// session: the session surface shows its hero until one exists.
import { useEffect, useMemo, useState } from "react";
import Timeline from "../Timeline.tsx";
import Composer from "../Composer.tsx";
import QuestionCards from "../QuestionCards.tsx";
import { setUiError, useActiveModel, useStore } from "../../store.ts";
import { openSession, restoreSession } from "../../init.ts";
import { friendlyError } from "../../settings.ts";
import { composerBlockedByArchive, sessionSurfaceKind } from "../../sessionSurface.ts";
import { registerWorkspaceSurface } from "../../workspace/surfaceRegistry.ts";
import { registerSlot } from "../../slots.ts";
import WidgetCanvas from "../../widgets/WidgetCanvas.tsx";
import { useWorkspaceMode } from "../../widgets/workspaceMode.ts";
import SlotHost from "../slots/SlotHost.ts";
import { Icon } from "../../icons.tsx";
import StarterPicker, { StarterIcon } from "../mobile/StarterPicker.tsx";
import { requestComposerInsert } from "../../composerInsert.ts";
import { useGitStatus } from "../../../../../packages/git/widgets/gitStatusStore.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { tapFeedback } from "../../haptics.ts";
import { dismissKeyboard } from "../../mobileViewport.ts";
import { nextWorkingActivity, useUiSettings } from "../../uiPrefs.ts";
import { useSheetTrigger } from "../mobile/sheetTrigger.ts";
import { HeroWidget, HeroWidgetSettings } from "../mobile/HeroWidgets.tsx";
import { ago, displaySessionTitle } from "../../format.ts";
import {
  noteStarterUsed,
  starterContextFrom,
  useStarterPrefs,
  visibleStarters,
  type Starter,
} from "../../starters.ts";
import { tr } from "../../i18n/index.ts";
import { Button } from "../ui/index.ts";
import { resolveSessionStatus } from "../../sessionStatus.ts";

const NOOP_STARTER = (_prompt: string, _id?: string): void => {};

// UX-MOBILE-01 §2: the fresh-session screen is three zones — top navigation
// (Header), a calm centered empty state with quick starters, and ONE sticky
// interaction zone (project/branch context + composer) pinned above the
// keyboard. Project and branch never split the page between the headline and
// the composer any more.
function SessionHero() {
  const projects = useStore((s) => s.projectRegistry.projects);
  const projectId = useStore((s) => s.activeProjectId);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const name = project?.name || project?.path || tr("permissionbanner.thisProject");

  // Quick starters (§3/§35): pinned first, then suggestions that follow the
  // real workspace state — a dirty worktree offers review/commit work, a clean
  // one offers exploration and planning.
  const shell = useShellMode();
  const gitStatus = useGitStatus(projectId, false);
  const starterPrefs = useStarterPrefs();
  const [starterPickerOpen, setStarterPickerOpen] = useState(false);
  const [heroWidgetsOpen, setHeroWidgetsOpen] = useState(false);
  // §22: pointer-down activation, like every other sheet trigger.
  const starterPickerTrigger = useSheetTrigger(shell === "phone", () => {
    setStarterPickerOpen(true);
    void dismissKeyboard();
  });
  const heroWidgetsTrigger = useSheetTrigger(shell === "phone", () => setHeroWidgetsOpen(true));
  const starterContext = useMemo(
    () => starterContextFrom(gitStatus, { hasHistory: false, lastTurnFinished: false }),
    [gitStatus],
  );
  const chips = useMemo(
    () => visibleStarters(starterPrefs, starterContext, shell === "phone" ? 2 : 3),
    [starterPrefs, starterContext, shell],
  );
  const runStarter = (prompt: string, id?: string) => {
    if (id) noteStarterUsed(id);
    if (shell === "phone") tapFeedback();
    requestComposerInsert(prompt);
  };

  return (
    <div className="stage stage-new">
      <div className="hero">
        <div className="hero-body">
          <h2>{tr("workspace.builtinsurfaces.whatAreWeWorkingOnIn")}{" "}<span className="polyth-gradient">{name}</span>?</h2>
          <p className="hero-sub">{tr("workspace.builtinsurfaces.startATaskOrContinueWhereYou")}</p>
          <div className="hero-widget-host">
            <SlotHost
              slot="session.empty.widgets"
              context={{
                projectId,
                chips,
                runStarter,
                starterPickerTrigger,
              }}
            />
          </div>
          <button
            type="button"
            className="hero-widget-settings"
            aria-label={tr("workspace.builtinsurfaces.customizeNewChatWidgets")}
            title={tr("workspace.builtinsurfaces.customizeNewChatWidgets")}
            {...heroWidgetsTrigger}
          ><Icon.sliders /></button>
        </div>
        <div className="hero-dock">
          <Composer />
        </div>
      </div>
      {starterPickerOpen && (
        <StarterPicker
          context={starterContext}
          onPick={(starter) => runStarter(starter.prompt)}
          onClose={() => setStarterPickerOpen(false)}
        />
      )}
      {heroWidgetsOpen && <HeroWidgetSettings onClose={() => setHeroWidgetsOpen(false)} />}
    </div>
  );
}

function HeroStartersWidget({
  chips,
  runStarter,
  starterPickerTrigger,
}: {
  chips: Starter[];
  runStarter: (prompt: string, id?: string) => void;
  starterPickerTrigger: Record<string, unknown>;
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
            onClick={() => runStarter(starter.prompt, starter.id)}
          >
            <span className="starter-chip-icon" aria-hidden="true"><StarterIcon id={starter.icon} /></span>
            <span className="starter-chip-text">{starter.label}</span>
          </button>
        ))}
        <button
          type="button"
          className="starter-chip starter-chip-add"
          aria-label={tr("workspace.builtinsurfaces.addAStarter")}
          title={tr("workspace.builtinsurfaces.addAStarter")}
          {...starterPickerTrigger}
        >
          <Icon.plus />
        </button>
      </div>
    </HeroWidget>
  );
}

/** §50: recent work stays a light, bounded list — the new-chat screen is a
 *  starting point, never a dashboard. Three rows, no cards, no metrics. */
function RecentSessions({ projectId }: { projectId: string | null }) {
  const sessions = useStore((s) => s.sessions);
  const recent = useMemo(() => sessions
    .filter((session) => session.projectId === projectId && session.status !== "archived")
    .sort((a, b) => (b.lastTurnAt ?? b.updatedAt) - (a.lastTurnAt ?? a.updatedAt))
    .slice(0, 3), [sessions, projectId]);
  if (recent.length === 0) return null;
  return (
    <HeroWidget id="recent"><div className="hero-recent">
      <h3 className="hero-recent-head">{tr("workspace.builtinsurfaces.recent")}</h3>
      <ul>
        {recent.map((session) => {
          const status = resolveSessionStatus(session);
          return (
            <li key={session.id}>
              <button
                type="button"
                className="hero-recent-row"
                onClick={() => void openSession(session.id).catch((error) =>
                  setUiError(friendlyError(tr("common.error"), error)))}
              >
                <span
                  className={`hero-recent-status ${status.kind}`}
                  title={status.label}
                  aria-label={status.label}
                >
                  <span aria-hidden>{status.glyph}</span>
                </span>
                <span className="hero-recent-title">{displaySessionTitle(session.title, session.id)}</span>
                <span className="hero-recent-time">{ago(session.lastTurnAt ?? session.updatedAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div></HeroWidget>
  );
}

// UX-TIMELINE-LAYOUT-01 §8 initial replay: an unresolved canonical event load
// is represented as loading — never as the fresh-session hero and never as a
// phantom empty timeline. The row is honest, bounded, and appends no event.
function SessionLoading() {
  return (
    <div className="stage">
      <div className="session-loading" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>{tr("workspace.builtinsurfaces.loadingSession")}</span>
      </div>
    </div>
  );
}

/** Archived sessions are read-only: one explicit, atomic restore-and-continue
 *  action replaces the composer (UX-FIXTURE-VISUAL P1). */
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

function SessionSurface() {
  const workspaceMode = useWorkspaceMode();
  const projectId = useStore((s) => s.activeProjectId);
  const sessionId = useStore((s) => s.activeSessionId);
  const openingSessionId = useStore((s) => s.openingSessionId);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const model = useActiveModel();
  const [latestRevealAnchor, setLatestRevealAnchor] = useState<HTMLDivElement | null>(null);

  if (workspaceMode !== "chat") return <WidgetCanvas />;

  // Fresh state yields to pending prompts and permissions; an in-flight
  // canonical replay yields to the loading row (never a false fresh hero).
  // Archived sessions remain visible but replace the composer with the
  // atomic restore action.
  const kind = sessionSurfaceKind(sessionId, openingSessionId, model, session);
  if (kind === "loading") return <SessionLoading />;
  if (kind === "hero") return <SessionHero />;

  const pendingPermissions = model.permissions.filter((p) => p.status === "pending");
  const pendingQuestions = model.questions.filter((q) => q.status === "pending");
  const pendingSecrets = model.secrets.filter((secret) => secret.status === "pending");
  const archived = composerBlockedByArchive(session);
  const hasPrimaryProgress = model.messages.some((message) =>
    (message.kind === "tool" && (message.status === "pending" || message.status === "running"))
    || (message.kind === "assistant" && !message.finalized))
    || model.tasks?.items.some((item) => item.status === "active")
    || model.subagents?.agents.some((agent) => agent.status === "running");
  const showFallbackWorking = model.turn?.status === "working"
    && !hasPrimaryProgress
    && pendingQuestions.length === 0
    && pendingSecrets.length === 0
    && pendingPermissions.length === 0;

  return (
    <div className="focus-conversation">
      <div className="timeline-wrap">
        <Timeline model={model} latestRevealTarget={latestRevealAnchor} />
      </div>
      {showFallbackWorking && <WorkingIndicator />}
      {pendingQuestions.length > 0 && <QuestionCards questions={pendingQuestions} />}
      <SlotHost
        slot="session.timeline.after"
        context={{ projectId, sessionId, permissions: pendingPermissions, secrets: pendingSecrets }}
      />
      <SlotHost
        slot="session.composer.before"
        context={{ projectId, sessionId, editing: false }}
      />
      <SlotHost
        slot="session.footer"
        context={{ projectId, sessionId, editing: false }}
      />
      <div ref={setLatestRevealAnchor} className="timeline-latest-reveal-anchor" />
      {archived && sessionId ? <ArchivedComposerGuard sessionId={sessionId} /> : <Composer />}
    </div>
  );
}

function WorkingIndicator() {
  const { workingIndicator } = useUiSettings();
  const [activityStep, setActivityStep] = useState(0);
  const activityLabels = tr("workspace.builtinsurfaces.activityItems").split("|");
  useEffect(() => {
    if (workingIndicator !== "activity") return;
    setActivityStep((step) => nextWorkingActivity(step, activityLabels.length));
    const timer = window.setInterval(
      () => setActivityStep((step) => nextWorkingActivity(step, activityLabels.length)),
      2400,
    );
    return () => window.clearInterval(timer);
  }, [activityLabels.length, workingIndicator]);
  const activityLabel = activityLabels[activityStep] ?? tr("workspace.builtinsurfaces.working");
  return (
    <div className={`focus-working focus-working--${workingIndicator}`} role="status">
      {workingIndicator === "pulse" && <span className="focus-working-spinner" aria-hidden="true" />}
      {workingIndicator === "cursor" && <span className="focus-working-cursor" aria-hidden="true" />}
      {workingIndicator === "cat" && (
        <svg className="focus-working-cat" viewBox="0 0 32 16" aria-hidden="true">
          <path d="M4 10V5l3 2 3-3 3 3 4 1c3 0 5 2 5 4v1H7c-2 0-3-1-3-3Z" />
          <path d="M22 9c4-4 6 1 3 3M9 13v2M17 13v2" />
          <circle cx="11" cy="9" r=".7" fill="currentColor" stroke="none" />
        </svg>
      )}
      {workingIndicator === "activity" && <span className="focus-working-activity" aria-hidden="true"><i /><i /><i /></span>}
      <span>{workingIndicator === "activity" ? activityLabel : tr("workspace.builtinsurfaces.working")}</span>
    </div>
  );
}

// Fresh-session widgets are slot contributions, not SessionHero internals.
// Plugins can register another `session.empty.widgets` contribution (a
// project briefing, a rotating prompt rail, etc.) without editing this view;
// built-ins remain locally hideable/reorderable through HeroWidgetSettings.
registerSlot("session.empty.widgets", "builtin.hero-starters", (context) => (
  <HeroStartersWidget
    chips={(context.chips as Starter[] | undefined) ?? []}
    runStarter={(context.runStarter as ((prompt: string, id?: string) => void)) ?? NOOP_STARTER}
    starterPickerTrigger={(context.starterPickerTrigger as Record<string, unknown> | undefined) ?? {}}
  />
), 10);
registerSlot("session.empty.widgets", "builtin.hero-recent", (context) => (
  <RecentSessions projectId={(context.projectId as string | null | undefined) ?? null} />
), 20);

// Ids stay the built-in AppView names this slice; store.ts keeps persisting
// the union. Orders mirror the header's view groups: chat, then workflows.
// UX-PANE-MODEL: Files, Git, Terminal, and Preview are NOT primary surfaces —
// they are canonical workspace panes registered in railSurfaces.tsx and
// opened through openWorkspacePane() beside a still-mounted Chat.
registerWorkspaceSurface({ id: "session", title: tr("workspace.builtinsurfaces.session"), order: 0, plugin: "session", requires: "project", component: SessionSurface });
