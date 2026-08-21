import Composer from "../components/Composer.tsx";
import EditorView from "../components/EditorView.tsx";
import FusionView from "../components/FusionView.tsx";
import GitView from "../components/GitView.tsx";
import GithubView from "../components/GithubView.tsx";
import GoalsView from "../components/GoalsView.tsx";
import KnowledgePanel from "../components/KnowledgePanel.tsx";
import MultiRunView from "../components/MultiRunView.tsx";
import PermissionBanner from "../components/PermissionBanner.tsx";
import PreviewView from "../components/PreviewView.tsx";
import QuestionCards from "../components/QuestionCards.tsx";
import ScheduleView from "../components/ScheduleView.tsx";
import TerminalView from "../components/TerminalView.tsx";
import Timeline from "../components/Timeline.tsx";
import WalkthroughView from "../components/WalkthroughView.tsx";
import WorkStatus from "../components/WorkStatus.tsx";
import { fmtCost, fmtTokens } from "../format.ts";
import { openSettingsPage, openWorkspacePane, setActiveView, useActiveModel, useStore } from "../store.ts";
import { registerWidget, type WidgetDef } from "./catalog.ts";

const NO_EVENTS: never[] = [];

function ChatWidget() {
  const session = useStore((state) => state.sessions.find((item) => item.id === state.activeSessionId) ?? null);
  const model = useActiveModel();
  if (!session) {
    return (
      <div className="widget-chat-empty">
        <p>Start a session in this project.</p>
        <Composer variant="hero" />
      </div>
    );
  }
  const questions = model.questions.filter((item) => item.status === "pending");
  const permissions = model.permissions.filter((item) => item.status === "pending");
  return (
    <div className="widget-chat">
      <Timeline model={model} />
      {questions.length > 0 && <QuestionCards questions={questions} />}
      {permissions.length > 0 && <PermissionBanner permissions={permissions} />}
      {session.status === "archived"
        ? <div className="archived-guard">This session is archived and read-only.</div>
        : <Composer />}
    </div>
  );
}

function QuickActionsWidget() {
  return (
    <div className="widget-quick-actions">
      <button onClick={() => openWorkspacePane("files")}>Open files</button>
      <button onClick={() => openWorkspacePane("terminal")}>Open terminal</button>
      <button onClick={() => openWorkspacePane("preview")}>Open preview</button>
      <button onClick={() => setActiveView("goals")}>Manage goals</button>
      <button onClick={() => openSettingsPage("widgets")}>Customize workspace</button>
    </div>
  );
}

function WorkStatusWidget() {
  return <WorkStatus model={useActiveModel()} />;
}

function ActivityWidget() {
  const events = useStore((state) =>
    (state.activeSessionId ? state.events[state.activeSessionId] : undefined) ?? NO_EVENTS);
  if (events.length === 0) return <div className="widget-empty">Session activity appears here.</div>;
  return (
    <div className="widget-activity">
      {[...events].slice(-24).reverse().map((event) => (
        <div className="widget-activity-row" key={event.id}>
          <span className="mono">#{event.seq}</span>
          <span>{event.type}</span>
          <time>{new Date(event.time).toLocaleTimeString()}</time>
        </div>
      ))}
    </div>
  );
}

function UsageWidget() {
  const model = useActiveModel();
  const total = model.totals.input + model.totals.output;
  return (
    <div className="widget-stat-grid">
      <div><span>Input</span><strong>{fmtTokens(model.totals.input)}</strong></div>
      <div><span>Output</span><strong>{fmtTokens(model.totals.output)}</strong></div>
      <div><span>Total</span><strong>{fmtTokens(total)}</strong></div>
      <div><span>Cost</span><strong>{model.totals.cost > 0 ? fmtCost(model.totals.cost) : "—"}</strong></div>
    </div>
  );
}

const BUILTINS: WidgetDef[] = [
  {
    id: "core.chat", pluginId: "session", title: "Chat & composer",
    description: "The active conversation timeline and lightweight composer.",
    zone: "main", defaultSize: { w: 12, h: 8 }, audience: "simple",
    render: () => <ChatWidget />,
  },
  {
    id: "core.quick-actions", pluginId: "commands", title: "Quick actions",
    description: "Open frequently used workspace tools.", zone: "top",
    defaultSize: { w: 6, h: 2 }, audience: "simple", render: () => <QuickActionsWidget />,
  },
  {
    id: "goals.current", pluginId: "goals", title: "Current task & goals",
    description: "Track the active objective and its progress.", zone: "top",
    defaultSize: { w: 6, h: 4 }, audience: "simple", render: () => <GoalsView />,
  },
  {
    id: "files.explorer", pluginId: "files", title: "Files",
    description: "Browse and edit project files.", zone: "left",
    defaultSize: { w: 6, h: 7 }, audience: "standard", render: () => <EditorView />,
  },
  {
    id: "git.recent", pluginId: "git", title: "Recent changes",
    description: "Review source-control status, diffs, and commits.", zone: "right",
    defaultSize: { w: 6, h: 6 }, audience: "standard", render: () => <GitView />,
  },
  {
    id: "terminal.shell", pluginId: "terminal", title: "Terminal",
    description: "Run project-scoped shell sessions.", zone: "bottom",
    defaultSize: { w: 12, h: 5 }, audience: "standard", render: () => <TerminalView />,
  },
  {
    id: "knowledge.notes", pluginId: "knowledge", title: "Notes & knowledge",
    description: "Keep project notes, plans, and durable knowledge.", zone: "left",
    defaultSize: { w: 6, h: 5 }, audience: "standard", render: () => <KnowledgePanel />,
  },
  {
    id: "session.work-status", pluginId: "session", title: "Agent actions & work status",
    description: "Live task, delegated-agent, and usage status.", zone: "right",
    defaultSize: { w: 6, h: 4 }, audience: "standard", render: () => <WorkStatusWidget />,
  },
  {
    id: "session.activity", pluginId: "session", title: "Activity",
    description: "Recent durable events from the active session.", zone: "right",
    defaultSize: { w: 6, h: 4 }, audience: "power", render: () => <ActivityWidget />,
  },
  {
    id: "preview.app", pluginId: "preview", title: "Preview",
    description: "Start and view the project preview.", zone: "bottom",
    defaultSize: { w: 12, h: 6 }, audience: "standard", render: () => <PreviewView />,
  },
  {
    id: "github.overview", pluginId: "github", title: "GitHub",
    description: "Repository, issues, pull requests, and checks.", zone: "right",
    defaultSize: { w: 6, h: 6 }, audience: "standard", render: () => <GithubView />,
  },
  {
    id: "schedule.tasks", pluginId: "schedule", title: "Schedule",
    description: "Scheduled prompts and recurring automation.", zone: "right",
    defaultSize: { w: 6, h: 5 }, audience: "standard", render: () => <ScheduleView />,
  },
  {
    id: "multirun.runs", pluginId: "multirun", title: "Multi-run",
    description: "Compare parallel model runs.", zone: "main",
    defaultSize: { w: 12, h: 6 }, audience: "power", render: () => <MultiRunView />,
  },
  {
    id: "fusion.answers", pluginId: "fusion", title: "Fusion",
    description: "Combine and weigh multiple model answers.", zone: "main",
    defaultSize: { w: 12, h: 6 }, audience: "power", render: () => <FusionView />,
  },
  {
    id: "walkthrough.review", pluginId: "walkthrough", title: "Walkthrough",
    description: "Review changed files in guided stages.", zone: "main",
    defaultSize: { w: 12, h: 6 }, audience: "standard", render: () => <WalkthroughView />,
  },
  {
    id: "usage.session", pluginId: "usage", title: "Usage",
    description: "Token and cost totals for the active session.", zone: "right",
    defaultSize: { w: 4, h: 3 }, audience: "standard", render: () => <UsageWidget />,
  },
];

for (const widget of BUILTINS) registerWidget(widget);
