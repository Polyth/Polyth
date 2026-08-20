// EXTENSION-SEAMS slice 2: built-in workspace surfaces. Each main-area view
// registers into the workspace surface registry — Main.tsx composes the host
// and never enumerates feature views. Importing this module registers the
// built-ins once. Every built-in requires a project; the host renders the
// standard project empty state when none is open. None require an open
// session: the session surface shows its hero until one exists.
import Timeline from "../Timeline.tsx";
import Composer from "../Composer.tsx";
import AssistStrip from "../AssistStrip.tsx";
import PermissionBanner from "../PermissionBanner.tsx";
import QuestionCards from "../QuestionCards.tsx";
import { GoalStrip } from "../GoalStrip.tsx";
import WorkStatus, { TrackerPills } from "../WorkStatus.tsx";
import MultiRunView from "../MultiRunView.tsx";
import FusionView from "../FusionView.tsx";
import GoalsView from "../GoalsView.tsx";
import WalkthroughView from "../WalkthroughView.tsx";
import ScheduleView from "../ScheduleView.tsx";
import GithubView from "../GithubView.tsx";
import { useActiveModel, useStore } from "../../store.ts";
import { shortcutLabel } from "../../settings.ts";
import { registerWorkspaceSurface } from "../../workspace/surfaceRegistry.ts";

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

function SessionSurface() {
  const sessionId = useStore((s) => s.activeSessionId);
  const model = useActiveModel();

  // Fresh state: no session yet, or an open session with nothing sent.
  if (!sessionId || model.messages.length === 0) return <SessionHero />;

  const pendingPermissions = model.permissions.filter((p) => p.status === "pending");
  const pendingQuestions = model.questions.filter((q) => q.status === "pending");

  return (
    <>
      <div className="timeline-wrap">
        <GoalStrip />
        <WorkStatus model={model} />
        <Timeline model={model} />
        <AssistStrip />
      </div>
      {pendingQuestions.length > 0 && <QuestionCards questions={pendingQuestions} />}
      {pendingPermissions.length > 0 && <PermissionBanner permissions={pendingPermissions} />}
      <TrackerPills model={model} />
      <Composer />
    </>
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
registerWorkspaceSurface({ id: "fusion", title: "Fusion", order: 22, plugin: "fusion", requires: "project", component: FusionView });
registerWorkspaceSurface({ id: "walkthrough", title: "Walkthrough", order: 23, plugin: "walkthrough", requires: "project", component: WalkthroughView });
registerWorkspaceSurface({ id: "schedule", title: "Schedule", order: 24, plugin: "schedule", requires: "project", component: ScheduleView });
registerWorkspaceSurface({ id: "github", title: "GitHub", order: 25, plugin: "github", requires: "project", component: GithubView });
