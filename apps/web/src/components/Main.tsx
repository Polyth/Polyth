import Header from "./Header.tsx";
import Timeline from "./Timeline.tsx";
import Composer from "./Composer.tsx";
import PermissionBanner from "./PermissionBanner.tsx";
import QuestionCards from "./QuestionCards.tsx";
import { GoalStrip } from "./GoalStrip.tsx";
import ProjectForm from "./ProjectForm.tsx";
import MultiRunView from "./MultiRunView.tsx";
import FusionView from "./FusionView.tsx";
import PreviewView from "./PreviewView.tsx";
import GitView from "./GitView.tsx";
import GoalsView from "./GoalsView.tsx";
import WalkthroughView from "./WalkthroughView.tsx";
import TerminalView from "./TerminalView.tsx";
import { useActiveModel, useStore } from "../store.ts";
import { addProject, createProject } from "../init.ts";
import { shortcutLabel } from "../settings.ts";

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

export default function Main() {
  const sessionId = useStore((s) => s.activeSessionId);
  const projectId = useStore((s) => s.activeProjectId);
  const view = useStore((s) => s.activeView);
  const model = useActiveModel();

  // Project-level views work without an open session.
  if (!sessionId && (view === "preview" || view === "git" || view === "terminal")) {
    return (
      <main className="main">
        <Header />
        {view === "preview" && <PreviewView />}
        {view === "git" && <GitView />}
        {view === "terminal" && <TerminalView />}
      </main>
    );
  }

  if (!projectId) {
    return (
      <main className="main">
        <div className="stage">
          <div className="hero">
            <div className="hero-mark">p</div>
            <h2>Open a project</h2>
            <p className="hero-sub">Point Polyth at a folder, or create a new one.</p>
            <div className="hero-project-form">
              <ProjectForm onSubmit={async (path, name, create) => {
                if (create) await createProject(path, name || undefined);
                else await addProject(path, name || undefined);
              }} />
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (view === "goals") return <main className="main"><Header /><GoalsView /></main>;
  if (view === "multirun") return <main className="main"><Header /><MultiRunView /></main>;
  if (view === "fusion") return <main className="main"><Header /><FusionView /></main>;
  if (view === "walkthrough") return <main className="main"><Header /><WalkthroughView /></main>;
  if (view === "preview") return <main className="main"><Header /><PreviewView /></main>;
  if (view === "git") return <main className="main"><Header /><GitView /></main>;
  if (view === "terminal") return <main className="main"><Header /><TerminalView /></main>;

  // Fresh state: no session yet, or an open session with nothing sent.
  if (!sessionId || model.messages.length === 0) {
    return (
      <main className="main">
        <Header />
        <SessionHero />
      </main>
    );
  }

  const pendingPermissions = model.permissions.filter((p) => p.status === "pending");
  const pendingQuestions = model.questions.filter((q) => q.status === "pending");

  return (
    <main className="main">
      <Header />
      <div className="timeline-wrap">
        <GoalStrip />
        <Timeline model={model} />
      </div>
      {pendingQuestions.length > 0 && <QuestionCards questions={pendingQuestions} />}
      {pendingPermissions.length > 0 && <PermissionBanner permissions={pendingPermissions} />}
      <Composer />
    </main>
  );
}
