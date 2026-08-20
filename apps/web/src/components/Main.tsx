import Header from "./Header.tsx";
import Timeline from "./Timeline.tsx";
import Composer from "./Composer.tsx";
import AssistStrip from "./AssistStrip.tsx";
import PermissionBanner from "./PermissionBanner.tsx";
import QuestionCards from "./QuestionCards.tsx";
import { GoalStrip } from "./GoalStrip.tsx";
import WorkStatus, { TrackerPills } from "./WorkStatus.tsx";
import MultiRunView from "./MultiRunView.tsx";
import FusionView from "./FusionView.tsx";
import PreviewView from "./PreviewView.tsx";
import GitView from "./GitView.tsx";
import GoalsView from "./GoalsView.tsx";
import WalkthroughView from "./WalkthroughView.tsx";
import TerminalView from "./TerminalView.tsx";
import EditorView from "./EditorView.tsx";
import ScheduleView from "./ScheduleView.tsx";
import GithubView from "./GithubView.tsx";
import { setOverlay, setUiError, useActiveModel, useStore } from "../store.ts";
import { restoreSession } from "../init.ts";
import { friendlyError, shortcutLabel } from "../settings.ts";
import { composerBlockedByArchive, showSessionHero } from "../sessionSurface.ts";
import { useState } from "react";

// Large polyth-style hero for a fresh session (or no session yet):
// centered headline, the composer as an elevated card, and suggestion chips.
function SessionHero() {
  const project = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
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

export default function Main() {
  const sessionId = useStore((s) => s.activeSessionId);
  const projectId = useStore((s) => s.activeProjectId);
  const view = useStore((s) => s.activeView);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const model = useActiveModel();

  // Project-level views work without an open session.
  if (!sessionId && (view === "files" || view === "preview" || view === "git" || view === "terminal" || view === "schedule" || view === "github")) {
    return (
      <main className="main">
        <Header />
        {view === "files" && <EditorView />}
        {view === "preview" && <PreviewView />}
        {view === "git" && <GitView />}
        {view === "terminal" && <TerminalView />}
        {view === "schedule" && <ScheduleView />}
        {view === "github" && <GithubView />}
      </main>
    );
  }

  if (!projectId) {
    return (
      <main className="main">
        <div className="stage">
          <div className="hero">
            <div className="hero-mark">p</div>
            <h2>Bring your work into focus.</h2>
            <p className="hero-sub">Open a local project to start a session with its files, history, and tools.</p>
            <button className="primary-btn hero-open-project" onClick={() => setOverlay("project-picker")}>
              Choose a folder…
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (view === "goals") return <main className="main"><Header /><GoalsView /></main>;
  if (view === "multirun") return <main className="main"><Header /><MultiRunView /></main>;
  if (view === "fusion") return <main className="main"><Header /><FusionView /></main>;
  if (view === "walkthrough") return <main className="main"><Header /><WalkthroughView /></main>;
  if (view === "files") return <main className="main"><Header /><EditorView /></main>;
  if (view === "preview") return <main className="main"><Header /><PreviewView /></main>;
  if (view === "git") return <main className="main"><Header /><GitView /></main>;
  if (view === "terminal") return <main className="main"><Header /><TerminalView /></main>;
  if (view === "schedule") return <main className="main"><Header /><ScheduleView /></main>;
  if (view === "github") return <main className="main"><Header /><GithubView /></main>;

  // Fresh state: no session yet, or an open session with nothing to act on.
  // Pending question/permission surfaces take precedence over the hero, and
  // archived sessions render the read-only guard instead (UX-FIXTURE-VISUAL).
  if (showSessionHero(sessionId, model, session)) {
    return (
      <main className="main">
        <Header />
        <SessionHero />
      </main>
    );
  }

  const pendingPermissions = model.permissions.filter((p) => p.status === "pending");
  const pendingQuestions = model.questions.filter((q) => q.status === "pending");
  const archived = composerBlockedByArchive(session);

  return (
    <main className="main">
      <Header />
      <div className="timeline-wrap">
        <GoalStrip />
        <WorkStatus model={model} />
        <Timeline model={model} />
        <AssistStrip />
      </div>
      {pendingQuestions.length > 0 && <QuestionCards questions={pendingQuestions} />}
      {pendingPermissions.length > 0 && <PermissionBanner permissions={pendingPermissions} />}
      <TrackerPills model={model} />
      {archived && sessionId ? <ArchivedComposerGuard sessionId={sessionId} /> : <Composer />}
    </main>
  );
}
