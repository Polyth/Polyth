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
import { focusComposer, isActiveSessionSpawning, overlaySessionProjection, setOverlay, setUiError, useActiveModel, usePendingSends, useStore, workspaceProjectId } from "../../store.ts";
import { openSession, prefetchSessionTail, restoreSession } from "../../init.ts";
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
import { useSpaces } from "../../spaces.ts";
import { tapFeedback } from "../../haptics.ts";
import { dismissKeyboard } from "../../mobileViewport.ts";
import { useSheetTrigger } from "../mobile/sheetTrigger.ts";
import { HeroWidget, HeroWidgetMenu } from "../mobile/HeroWidgets.tsx";
import { ago, displaySessionTitle, fmtDuration, isPlaceholderTitle } from "../../format.ts";
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
import { AgentStatusDock, Button } from "../ui/index.ts";
import { resolveSessionStatus } from "../../sessionStatus.ts";
import ProviderLogo from "../../../../../packages/models/widgets/ProviderLogo.tsx";
import { resolveModelPresentation } from "@polyth/contracts/model-presentation";
import { toggleSessionStatusPopover } from "../../sessionStatusPopover.ts";

const NOOP_STARTER = (_prompt: string, _id?: string): void => {};

// UX-MOBILE-01 §2: the fresh-session screen is three zones — top navigation
// (Header), a calm centered empty state with quick starters, and ONE sticky
// interaction zone (project/branch context + composer) pinned above the
// keyboard. Project and branch never split the page between the headline and
// the composer any more.
function SessionHero({ starterContext }: { starterContext: StarterContext }) {
  const projects = useStore((s) => s.projectRegistry.projects);
  const projectId = useStore(workspaceProjectId);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const name = project?.name || project?.path || tr("permissionbanner.thisProject");

  // Quick starters (§3/§35): pinned first, then suggestions that follow the
  // real workspace state — a dirty worktree offers review/commit work, a clean
  // one offers exploration and planning.
  const shell = useShellMode();
  const starterPrefs = useStarterPrefs();
  // §22: pointer-down activation, like every other sheet trigger.
  const starterPickerTrigger = useSheetTrigger(shell === "phone", () => {
    setOverlay("starter-picker");
    void dismissKeyboard();
  });
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
        <div className="hero-body customize-zone">
          <h2>{tr("workspace.builtinsurfaces.whatAreWeWorkingOnIn")}{" "}<span className="polyth-gradient">{name}</span>.</h2>
          <div className="hero-widget-host">
            <SlotHost
              slot="session.empty.widgets"
              context={{
                projectId,
                chips,
                runStarter,
                starterPickerTrigger,
              }}
              customizable
            />
          </div>
          {/* Shift-key customization mode: on desktop the customize entry
              stays hidden until Shift is held (hover reveals nothing else).
              Compact shells keep the always-visible sheet trigger. */}
          <HeroWidgetMenu />
        </div>
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
  // Subscribes only to the session list. The prompt-derived title is persisted
  // into the session record on the first user message (store.applyEvents), so
  // this panel doesn't need the whole events map — and won't re-render on every
  // streamed chunk of any session.
  const sessions = useStore((s) => s.sessions);
  const recent = useMemo(() => sessions
    .filter((session) => session.projectId === projectId && session.status !== "archived")
    .sort((a, b) => (b.lastTurnAt ?? b.createdAt) - (a.lastTurnAt ?? a.createdAt))
    .slice(0, 3), [sessions, projectId]);
  useEffect(() => {
    for (const session of recent) {
      if (isPlaceholderTitle(session.title, session.id)) {
        prefetchSessionTail(session.id);
      }
    }
  }, [recent]);
  if (recent.length === 0) return null;
  return (
    <HeroWidget id="recent"><div className="hero-recent">
      <h3 className="hero-recent-head">{tr("workspace.builtinsurfaces.recent")}</h3>
      <ul>
        {recent.map((session) => {
          const status = resolveSessionStatus(session);
          const done = session.status === "finished";
          const unread = (session.attention?.unread ?? 0) > 0;
          const statusLabel = done ? tr("notificationcentre.completed") : status.label;
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
                  title={statusLabel}
                  aria-label={statusLabel}
                >
                  {status.kind === "working" ? (
                    <span className="ui-spinner ui-spinner--sm" aria-hidden />
                  ) : done ? (
                    <span className="hero-recent-check" aria-hidden>✓</span>
                  ) : (
                    <span aria-hidden>{status.glyph}</span>
                  )}
                </span>
                <span className={`hero-recent-title${done && unread ? " hero-recent-title--unread" : ""}`}>
                  {displaySessionTitle(session.title, session.id)}
                </span>
                <span className="hero-recent-time">{ago(session.lastTurnAt ?? session.createdAt)}</span>
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
        <span className="ui-spinner ui-spinner--sm" aria-hidden="true" />
        <span>{tr("workspace.builtinsurfaces.loadingSession")}</span>
      </div>
    </div>
  );
}

/** One owner for the complete above-composer activity lifecycle.
 * Pending/creation startup, canonical session work, and the live turn all
 * render through this component. Git contributes edited-file state only; it
 * must never own the agent activity surface. */
function SessionActivityStatus({ spawning }: { spawning: boolean }) {
  const sessionRecord = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const pendingSends = usePendingSends(sessionRecord?.id ?? null);
  const pendingSend = pendingSends[pendingSends.length - 1];
  const spawn = useStore((state) => state.sessionSpawn);
  const model = useActiveModel();
  const models = useStore((state) => state.models);
  const working = model.turn?.status === "working" || sessionRecord?.status === "working";
  const awaitingTurn = pendingSends.length > 0 && !working;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [working, model.turn?.startedAt]);

  if (!working) {
    if (!spawning && !awaitingTurn) return null;
    const status = spawning
      ? tr("workspace.builtinsurfaces.spawningAgent")
      : tr("workspace.builtinsurfaces.startingTurn");
    const harnessId = (spawning ? spawn?.harnessId : undefined) ?? sessionRecord?.resolvedHarnessId;
    const harnessName = (spawning ? spawn?.harnessName?.trim() : undefined) || harnessId
      ?.split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(" ")
      || tr("timeline.agent");
    const pendingModel = pendingSend?.model;
    const pendingLabel = pendingModel
      ? models.find((item) => item.providerID === pendingModel.providerID && item.modelID === pendingModel.modelID)?.name
        ?? `${pendingModel.providerID}/${pendingModel.modelID}`
      : undefined;
    const harnessLabel = pendingLabel ?? `${harnessName} harness`;
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

  const replacingTurn = pendingSend?.delivery === "interrupt";
  const modelRef = pendingSend?.model ?? model.turn?.model ?? sessionRecord?.model;
  const runtimeHarnessId = model.turn?.harnessId ?? sessionRecord?.resolvedHarnessId;
  const presentation = modelRef
    ? resolveModelPresentation(modelRef, models, runtimeHarnessId)
    : { descriptor: undefined, name: tr("composer.auto") };
  const descriptor = presentation.descriptor;
  const activeTask = model.tasks?.items.find((item) => item.status === "active");
  const activeSubagent = model.subagents?.agents.find((agent) => /^(?:working|running|active)$/i.test(agent.status));
  const activeTool = [...model.messages].reverse().find((message) =>
    message.kind === "tool" && (message.status === "pending" || message.status === "running"));
  const latestAssistant = [...model.messages].reverse().find((message) => message.kind === "assistant");
  const activityLabels = tr("workspace.builtinsurfaces.activityItems").split("|");
  const toolDetail = activeTool?.kind === "tool"
    ? ["description", "command", "filePath", "path", "query", "pattern", "url"]
        .map((key) => activeTool.input[key])
        .find((value): value is string => typeof value === "string" && value.trim() !== "")
    : undefined;
  const conciseToolDetail = toolDetail && /[\\/]/.test(toolDetail)
    ? toolDetail.replaceAll("\\", "/").split("/").filter(Boolean).at(-1)
    : toolDetail;
  const toolName = activeTool?.kind === "tool"
    ? activeTool.title ?? activeTool.tool.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
    : undefined;
  const action = replacingTurn
    ? tr("workspace.builtinsurfaces.startingTurn")
    : activeTask?.text
      ?? activeSubagent?.currentTask
      ?? (toolName
        ? `${toolName}${conciseToolDetail ? ` · ${conciseToolDetail}` : ""}`
        : latestAssistant?.kind === "assistant" && latestAssistant.reasoning && !latestAssistant.text
          ? tr("timeline.thinking")
          : activityLabels[latestAssistant?.kind === "assistant" && latestAssistant.text ? 2 : 0]
            ?? tr("workspace.builtinsurfaces.working"));
  const elapsed = replacingTurn || model.turn?.startedAt === undefined
    ? null
    : fmtDuration(now - model.turn.startedAt);

  return (
    <AgentStatusDock
      icon={<ProviderLogo
        providerID={descriptor?.providerID ?? modelRef?.providerID}
        providerName={descriptor?.providerName}
        harnessId={descriptor?.harnessId ?? runtimeHarnessId}
        size="regular"
      />}
      model={presentation.name}
      status={action}
      elapsed={elapsed}
      label={action}
      onClick={() => toggleSessionStatusPopover()}
    />
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
  const spaceId = useSpaces().activeSpaceId ?? undefined;
  const projectId = useStore(workspaceProjectId);
  const sessionId = useStore((s) => s.activeSessionId);
  const openingSessionId = useStore((s) => s.openingSessionId);
  const spawning = useStore(isActiveSessionSpawning);
  const sessionRecord = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const pendingSends = usePendingSends(sessionId);
  const session = overlaySessionProjection(sessionRecord, pendingSends) ?? null;
  const starterPickerOpen = useStore((s) => s.overlay === "starter-picker");
  const model = useActiveModel();
  // A submitted prompt with no turn behind it yet still owns the activity zone.
  // Once the runtime reports work, the canonical turn rows take it over.
  const working = model.turn?.status === "working" || sessionRecord?.status === "working";
  const awaitingTurn = pendingSends.length > 0 && !working;
  const gitStatus = useGitStatus(projectId, false);
  const starterContext = useMemo(
    () => starterContextFrom(gitStatus, starterSessionContext(model)),
    [gitStatus, model],
  );
  const [latestRevealAnchor, setLatestRevealAnchor] = useState<HTMLDivElement | null>(null);

  if (workspaceMode !== "chat") return <WidgetCanvas />;

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
  const picker = starterPickerOpen ? (
    <StarterPicker
      context={starterContext}
      onPick={(starter) => requestComposerInsert(starter.prompt)}
      onClose={() => {
        setOverlay(null);
        focusComposer();
      }}
    />
  ) : null;
  if (kind === "loading") return <><SessionLoading />{picker}</>;
  if (kind === "hero") return <><SessionHero starterContext={starterContext} />{picker}</>;

  const pendingQuestions = model.questions.filter((q) => q.status === "pending");
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

  return (
    <>
    <div className="focus-conversation">
      <div className="timeline-wrap">
        <Timeline model={model} latestRevealTarget={latestRevealAnchor} />
      </div>
      {pendingQuestions.length > 0 && <QuestionCards questions={pendingQuestions} />}
       {archived && sessionId
        ? <>
            <SlotHost slot="session.composer.before" context={composerBeforeContext} customizable />
            <div ref={setLatestRevealAnchor} className="timeline-latest-reveal-anchor" />
            <SlotHost slot="session.footer" context={{ projectId, sessionId, editing: false }} customizable />
            <ArchivedComposerGuard sessionId={sessionId} />
          </>
        : <div className="conversation-composer-dock">
            <SlotHost slot="session.composer.before" context={composerBeforeContext} customizable />
            <div ref={setLatestRevealAnchor} className="timeline-latest-reveal-anchor" />
            <SlotHost slot="session.footer" context={{ projectId, sessionId, editing: false }} customizable />
            {(spawning || awaitingTurn || working) && (
              <SessionActivityStatus spawning={spawning} />
            )}
            <Composer />
          </div>}
    </div>
    {picker}
    </>
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
