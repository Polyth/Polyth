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
import { addProject, createProject, createSession } from "../init.ts";

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

  if (!sessionId) {
    return (
      <main className="main">
        {projectId && <Header />}
        <div className="center-empty">
          <div className="welcome">
            <span className="welcome-mark">p</span>
            <h1>{projectId ? "Start a focused session" : "Open a project"}</h1>
            <p>{projectId ? "Create a session to explore, build, or review." : "Open an existing folder, or create one for a new project."}</p>
            {projectId ? (
              <button className="primary-btn welcome-action" onClick={() => void createSession(projectId)}>New session</button>
            ) : (
              <ProjectForm onSubmit={async (path, name, create) => {
                if (create) await createProject(path, name || undefined);
                else await addProject(path, name || undefined);
              }} />
            )}
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
