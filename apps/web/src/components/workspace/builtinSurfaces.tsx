// EXTENSION-SEAMS slice 2: built-in workspace surfaces. Each main-area view
// registers into the workspace surface registry — Main.tsx composes the host
// and never enumerates feature views. Importing this module registers the
// built-ins once. Every built-in requires a project; the host renders the
// standard project empty state when none is open. None require an open
// session: the session surface shows its hero until one exists.
import { useState } from "react";
import Timeline from "../Timeline.tsx";
import Composer from "../Composer.tsx";
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
import { setUiError, useActiveModel, useStore } from "../../store.ts";
import { restoreSession } from "../../init.ts";
import { friendlyError, shortcutLabel } from "../../settings.ts";
import { composerBlockedByArchive, sessionSurfaceKind } from "../../sessionSurface.ts";
import { registerWorkspaceSurface } from "../../workspace/surfaceRegistry.ts";
import WidgetCanvas from "../../widgets/WidgetCanvas.tsx";
import { useWorkspaceMode } from "../../widgets/workspaceMode.ts";

// Large polyth-style hero for a fresh session (or no session yet):
// centered headline, the composer as an elevated card, and suggestion chips.
function SessionHero() {
  const project = useStore((s) => s.projectRegistry.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const branch = useStore((s) => s.gitBranch);
  const name = project?.name || project?.path || "this project";
  return (
    <div className="stage">
      <div className="hero">
        <div className="hero-mark">p</div>
        <h2>What are we working on in {name}?</h2>
        <p className="hero-sub">
          Polyth is attached to <b>{name}</b>
          {branch ? <> on <span className="mono">{branch}</span></> : null}.
          {" "}Describe a task, or start from one of the suggestions below.
        </p>
        <Composer variant="hero" />
        <div className="hero-foot">
          <span className="kbd">{shortcutLabel("K")}</span> commands
          <span className="hero-sep">·</span>
          <span className="kbd">{shortcutLabel("N")}</span> new session
          <span className="hero-sep">·</span>
          <span className="kbd">{shortcutLabel(",")}</span> settings
        </div>
      </div>
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
          <span>
            <strong>Scanning repositories and indexing…</strong>
            <small>This usually takes a few seconds.</small>
          </span>
        </div>
      )}
      {pendingQuestions.length > 0 && <QuestionCards questions={pendingQuestions} />}
      {pendingSecrets.length > 0 && <SecureSafeCard secrets={pendingSecrets} />}
      {pendingPermissions.length > 0 && <PermissionBanner permissions={pendingPermissions} />}
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
