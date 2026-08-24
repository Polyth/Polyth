// EXTENSION-SEAMS slice 2: built-in workspace surfaces. Each main-area view
// registers into the workspace surface registry — Main.tsx composes the host
// and never enumerates feature views. Importing this module registers the
// built-ins once. Every built-in requires a project; the host renders the
// standard project empty state when none is open. None require an open
// session: the session surface shows its hero until one exists.
import { useEffect, useMemo, useState } from "react";
import Timeline from "../Timeline.tsx";
import Composer, { type NewSessionTarget } from "../Composer.tsx";
import PermissionBanner from "../PermissionBanner.tsx";
import QuestionCards from "../QuestionCards.tsx";
import SecureSafeCard from "../SecureSafeCard.tsx";
import MultiRunView from "../MultiRunView.tsx";
import WorkflowView from "../WorkflowView.tsx";
import FusionView from "../FusionView.tsx";
import GoalsView from "../GoalsView.tsx";
import WalkthroughView from "../WalkthroughView.tsx";
import ScheduleView from "../ScheduleView.tsx";
import GithubView from "../GithubView.tsx";
import { activateProject, setUiError, useActiveModel, useStore } from "../../store.ts";
import { openSession, restoreSession } from "../../init.ts";
import { friendlyError } from "../../settings.ts";
import { composerBlockedByArchive, sessionSurfaceKind } from "../../sessionSurface.ts";
import { registerWorkspaceSurface } from "../../workspace/surfaceRegistry.ts";
import WidgetCanvas from "../../widgets/WidgetCanvas.tsx";
import { useWorkspaceMode } from "../../widgets/workspaceMode.ts";
import SlotHost from "../slots/SlotHost.ts";
import { api, type GitBranches, type Worktree } from "../../api.ts";
import { Icon } from "../../icons.tsx";
import SessionContextBar, { type ContextChoice } from "../mobile/SessionContextBar.tsx";
import StarterPicker, { StarterIcon } from "../mobile/StarterPicker.tsx";
import { requestComposerInsert } from "../../composerInsert.ts";
import { useGitStatus } from "../../gitStatusStore.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { tapFeedback } from "../../haptics.ts";
import { ago, displaySessionTitle } from "../../format.ts";
import {
  noteStarterUsed,
  starterContextFrom,
  useStarterPrefs,
  visibleStarters,
} from "../../starters.ts";

// UX-MOBILE-01 §2: the fresh-session screen is three zones — top navigation
// (Header), a calm centered empty state with quick starters, and ONE sticky
// interaction zone (project/branch context + composer) pinned above the
// keyboard. Project and branch never split the page between the headline and
// the composer any more.
function SessionHero() {
  const projects = useStore((s) => s.projectRegistry.projects);
  const projectId = useStore((s) => s.activeProjectId);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const newSessionIntent = useStore((s) => s.newSessionIntent);
  const branch = useStore((s) => s.gitBranch);
  const name = project?.name || project?.path || "this project";
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [branches, setBranches] = useState<GitBranches>({ current: "", branches: [] });
  const [branchLoading, setBranchLoading] = useState(false);
  const [selectedBranchId, setSelectedBranchId] = useState("main");

  useEffect(() => {
    let active = true;
    setSelectedBranchId("main");
    if (!projectId) {
      setWorktrees([]);
      setBranches({ current: "", branches: [] });
      return () => { active = false; };
    }
    setBranchLoading(true);
    void Promise.all([api.listWorktrees(projectId), api.gitBranches(projectId)])
      .then(([nextWorktrees, nextBranches]) => {
        if (!active) return;
        setWorktrees(nextWorktrees);
        setBranches(nextBranches);
        const requestedWorktree = newSessionIntent?.projectId === projectId
          ? nextWorktrees.find((worktree) => worktree.path === newSessionIntent.worktreePath)
          : undefined;
        const currentWorktree = requestedWorktree ?? nextWorktrees.find((worktree) =>
          worktree.branch === (nextBranches.current || branch));
        setSelectedBranchId(currentWorktree?.isMain
          ? "main"
          : currentWorktree
            ? `worktree:${currentWorktree.path}`
            : "main");
      })
      .finally(() => {
        if (active) setBranchLoading(false);
      });
    return () => { active = false; };
  }, [projectId, newSessionIntent?.worktreePath]);

  const branchChoices = useMemo(() => {
    const linkedBranches = new Set(worktrees.map((worktree) => worktree.branch).filter(Boolean));
    const main = worktrees.find((worktree) => worktree.isMain);
    const choices: Array<{ id: string; label: string; detail: string; target: NewSessionTarget }> = [{
      id: "main",
      label: main?.branch || branches.current || branch || "Main workspace",
      detail: "Main workspace",
      target: { kind: "main" },
    }];
    for (const worktree of worktrees.filter((candidate) => !candidate.isMain)) {
      choices.push({
        id: `worktree:${worktree.path}`,
        label: worktree.branch || worktree.path.split("/").pop() || "Worktree",
        detail: "Existing worktree",
        target: { kind: "worktree", path: worktree.path },
      });
    }
    for (const candidate of branches.branches) {
      if (candidate.remote || linkedBranches.has(candidate.name)) continue;
      choices.push({
        id: `branch:${candidate.name}`,
        label: candidate.name,
        detail: "Open in a new worktree",
        target: { kind: "branch", branch: candidate.name },
      });
    }
    return choices;
  }, [worktrees, branches, branch]);
  const selectedTarget = branchChoices.find((choice) => choice.id === selectedBranchId)?.target
    ?? { kind: "main" as const };
  const currentBranchLabel = branchChoices.find((choice) => choice.id === selectedBranchId)?.label
    ?? branches.current
    ?? branch
    ?? "main";

  // Quick starters (§3/§35): pinned first, then suggestions that follow the
  // real workspace state — a dirty worktree offers review/commit work, a clean
  // one offers exploration and planning.
  const shell = useShellMode();
  const gitStatus = useGitStatus(projectId, false);
  const starterPrefs = useStarterPrefs();
  const [starterPickerOpen, setStarterPickerOpen] = useState(false);
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

  const projectChoices: ContextChoice[] = projects.map((candidate) => ({
    id: candidate.id,
    label: candidate.name || candidate.path,
    detail: candidate.name ? candidate.path : "",
  }));

  return (
    <div className="stage stage-new">
      <div className="hero">
        <div className="hero-body">
          <h2>What are we working on in <span className="polyth-gradient">{name}</span>?</h2>
          <p className="hero-sub">Start a task or continue where you left off.</p>
          <div className="hero-starters" aria-label="Quick starters">
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
              aria-label="Add a starter"
              title="Add a starter"
              onClick={() => setStarterPickerOpen(true)}
            >
              <Icon.plus />
            </button>
          </div>
          <RecentSessions projectId={projectId} />
        </div>
        <div className="hero-dock">
          <SessionContextBar
            projectName={name}
            projects={projectChoices}
            onPickProject={(id) => activateProject(id || null)}
            branchName={currentBranchLabel}
            branches={branchChoices.map((choice) => ({ id: choice.id, label: choice.label, detail: choice.detail }))}
            {...(branchLoading ? { branchLoading: true } : {})}
            onPickBranch={setSelectedBranchId}
          />
          <Composer variant="hero" newSessionTarget={selectedTarget} />
        </div>
      </div>
      {starterPickerOpen && (
        <StarterPicker
          context={starterContext}
          onPick={(starter) => runStarter(starter.prompt)}
          onClose={() => setStarterPickerOpen(false)}
        />
      )}
    </div>
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
    <div className="hero-recent">
      <h3 className="hero-recent-head">Recent</h3>
      <ul>
        {recent.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              className="hero-recent-row"
              onClick={() => void openSession(session.id).catch((error) =>
                setUiError(friendlyError("Couldn’t open the session", error)))}
            >
              <span className="hero-recent-title">{displaySessionTitle(session.title, session.id)}</span>
              <span className="hero-recent-time">{ago(session.lastTurnAt ?? session.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
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
        <span>Loading session…</span>
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
        This session is archived and read-only. Restore it to continue the conversation.
      </span>
      <button
        className="primary-btn archived-restore-btn"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void restoreSession(sessionId)
            .catch((e) => setUiError(friendlyError("Couldn’t restore the session", e)))
            .finally(() => setBusy(false));
        }}
      >
        Restore and continue
      </button>
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

  return (
    <div className="focus-conversation">
      <div className="timeline-wrap">
        <Timeline model={model} />
      </div>
      {model.turn?.status === "working" && (
        <div className="focus-working" role="status">
          <span className="focus-working-spinner" aria-hidden="true" />
          <span>Working…</span>
        </div>
      )}
      {pendingQuestions.length > 0 && <QuestionCards questions={pendingQuestions} />}
      {pendingSecrets.length > 0 && <SecureSafeCard secrets={pendingSecrets} />}
      {pendingPermissions.length > 0 && <PermissionBanner permissions={pendingPermissions} />}
      <SlotHost
        slot="session.composer.before"
        context={{ projectId, sessionId, editing: false }}
      />
      <SlotHost
        slot="session.footer"
        context={{ projectId, sessionId, editing: false }}
      />
      {archived && sessionId ? <ArchivedComposerGuard sessionId={sessionId} /> : <Composer />}
    </div>
  );
}

// Ids stay the built-in AppView names this slice; store.ts keeps persisting
// the union. Orders mirror the header's view groups: chat, then workflows.
// UX-PANE-MODEL: Files, Git, Terminal, and Preview are NOT primary surfaces —
// they are canonical workspace panes registered in railSurfaces.tsx and
// opened through openWorkspacePane() beside a still-mounted Chat.
registerWorkspaceSurface({ id: "session", title: "Session", order: 0, plugin: "session", requires: "project", component: SessionSurface });
registerWorkspaceSurface({ id: "goals", title: "Goals", order: 20, plugin: "goals", requires: "project", component: GoalsView });
registerWorkspaceSurface({ id: "multirun", title: "Multi-Run", order: 21, plugin: "multirun", requires: "project", component: MultiRunView });
registerWorkspaceSurface({ id: "workflow", title: "Workflows", order: 22, plugin: "workflow", requires: "project", component: WorkflowView });
registerWorkspaceSurface({ id: "fusion", title: "Fusion", order: 23, plugin: "fusion", requires: "project", component: FusionView });
registerWorkspaceSurface({ id: "walkthrough", title: "Walkthrough", order: 24, plugin: "walkthrough", requires: "project", component: WalkthroughView });
registerWorkspaceSurface({ id: "schedule", title: "Schedule", order: 25, plugin: "schedule", requires: "project", component: ScheduleView });
registerWorkspaceSurface({ id: "github", title: "GitHub", order: 26, plugin: "github", requires: "project", component: GithubView });
