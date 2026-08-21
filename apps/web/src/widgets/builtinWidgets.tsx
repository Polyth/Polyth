import { useEffect, useState } from "react";
import Composer from "../components/Composer.tsx";
import EditorView from "../components/EditorView.tsx";
import FusionView from "../components/FusionView.tsx";
import GithubView from "../components/GithubView.tsx";
import KnowledgePanel from "../components/KnowledgePanel.tsx";
import MultiRunView from "../components/MultiRunView.tsx";
import PermissionBanner from "../components/PermissionBanner.tsx";
import PreviewView from "../components/PreviewView.tsx";
import QuestionCards from "../components/QuestionCards.tsx";
import ScheduleView from "../components/ScheduleView.tsx";
import TerminalView from "../components/TerminalView.tsx";
import Timeline from "../components/Timeline.tsx";
import WalkthroughView from "../components/WalkthroughView.tsx";
import { fmtCost, fmtTokens } from "../format.ts";
import { openWorkspacePane, useActiveModel, useStore } from "../store.ts";
import { registerWidget, type WidgetDef } from "./catalog.ts";
import { api, type FileEntry, type GitFileEntry } from "../api.ts";
import { useGitStatus } from "../gitStatusStore.ts";
import { requestComposerReplace } from "../composerInsert.ts";
import { Icon } from "../icons.tsx";

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
  const actions = [
    ["Code review", "Review the recent changes for correctness, security, and maintainability.", "⌘"],
    ["Refactor", "Refactor the current code for clarity without changing behavior.", "◇"],
    ["Debug", "Debug the current issue using runtime evidence and explain the root cause.", "◎"],
  ] as const;
  return (
    <div className="widget-quick-actions">
      {actions.map(([label, prompt, glyph]) => (
        <button key={label} onClick={() => requestComposerReplace(prompt)}>
          <span aria-hidden="true">{glyph}</span>
          <strong>{label}</strong>
          <small>Fill composer</small>
        </button>
      ))}
    </div>
  );
}

function TaskPlanWidget() {
  const model = useActiveModel();
  const tasks = model.tasks?.items ?? [];
  const display = tasks.length > 0 ? tasks : [
    { id: "discover", text: "Understand the task and project context", status: "done" as const },
    { id: "implement", text: "Implement the requested changes", status: "active" as const },
    { id: "verify", text: "Run checks and review the result", status: "pending" as const },
    { id: "deliver", text: "Summarize and deliver the work", status: "pending" as const },
  ];
  const done = display.filter((task) => task.status === "done").length;
  const progress = Math.round((done / display.length) * 100);
  return (
    <div className="widget-task-plan">
      <div className="widget-plan-progress">
        <span>{done} of {display.length} complete</span><strong>{progress}%</strong>
      </div>
      <div className="widget-plan-track"><i style={{ width: `${progress}%` }} /></div>
      <ol>
        {display.map((task) => (
          <li key={task.id} className={task.status}>
            <span>{task.status === "done" ? "✓" : task.status === "active" ? "●" : ""}</span>
            <p>{task.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ProjectMapWidget() {
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  useEffect(() => {
    if (!projectId) {
      setEntries([]);
      return;
    }
    void api.filesTree(projectId, undefined, false, sessionId ?? undefined)
      .then((items) => setEntries(items.filter((item) => item.dir).slice(0, 8)))
      .catch(() => setEntries([]));
  }, [projectId, sessionId]);
  const nodes = entries.length > 0 ? entries : [
    { name: "apps", path: "apps", dir: true },
    { name: "packages", path: "packages", dir: true },
    { name: "docs", path: "docs", dir: true },
  ];
  return (
    <div className="widget-project-map">
      <button className="project-map-root" onClick={() => openWorkspacePane("files")}>
        <Icon.files /><span>project</span>
      </button>
      <div className="project-map-line" />
      <div className="project-map-nodes">
        {nodes.map((entry) => (
          <button key={entry.path} onClick={() => openWorkspacePane("files")}>
            <Icon.files /><span>{entry.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RecentChangesWidget() {
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const status = useGitStatus(projectId, false, sessionId);
  const changes: GitFileEntry[] = status
    ? [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked]
    : [];
  return (
    <div className="widget-recent-changes">
      <div className="widget-change-summary">
        <span>{status?.branch || "Working tree"}</span>
        <button onClick={() => openWorkspacePane("git")}>View all</button>
      </div>
      {(changes.length > 0 ? changes.slice(0, 7) : [
        { path: "No uncommitted changes", status: "clean", staged: false },
      ]).map((entry) => (
        <button key={`${entry.path}:${entry.staged}`} onClick={() => openWorkspacePane("git")}>
          <span className={`change-status ${entry.status === "clean" ? "clean" : ""}`}>{entry.status === "clean" ? "✓" : entry.status.slice(0, 1) || "M"}</span>
          <span>{entry.path}</span>
          <small>{entry.status === "clean" ? "clean" : entry.staged ? "+ staged" : "+1 −1"}</small>
        </button>
      ))}
    </div>
  );
}

function AgentActionsWidget() {
  const model = useActiveModel();
  const actions = model.messages.filter((message) => message.kind === "tool" || message.kind === "task").slice(-8).reverse();
  return (
    <div className="widget-agent-actions">
      {actions.length === 0 && (
        <>
          <div><span className="action-dot done">✓</span><p><strong>Workspace ready</strong><small>Project context loaded</small></p></div>
          <div><span className="action-dot active">●</span><p><strong>Waiting for a task</strong><small>Agent actions will stream here</small></p></div>
        </>
      )}
      {actions.map((action) => (
        <div key={action.id}>
          <span className={`action-dot ${action.kind === "tool" && action.status === "error" ? "failed" : action.kind === "tool" && action.status === "pending" ? "active" : "done"}`}>
            {action.kind === "tool" && action.status === "pending" ? "●" : action.kind === "tool" && action.status === "error" ? "!" : "✓"}
          </span>
          <p>
            <strong>{action.kind === "tool" ? action.title || action.tool : action.text}</strong>
            <small>{action.kind === "tool" ? action.status : action.action}</small>
          </p>
        </div>
      ))}
    </div>
  );
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
    id: "core.composer", pluginId: "session", title: "Composer",
    description: "Prompt, model, agent, voice, and technical controls.",
    zone: "main", defaultSize: { w: 12, h: 6 }, audience: "simple",
    render: () => <Composer variant="hero" />,
  },
  {
    id: "core.chat", pluginId: "session", title: "Conversation",
    description: "The active conversation timeline and composer.",
    zone: "main", defaultSize: { w: 12, h: 8 }, audience: "power",
    render: () => <ChatWidget />,
  },
  {
    id: "core.quick-actions", pluginId: "commands", title: "Quick actions",
    description: "Open frequently used workspace tools.", zone: "header",
    defaultSize: { w: 6, h: 2 }, audience: "simple", render: () => <QuickActionsWidget />,
  },
  {
    id: "goals.current", pluginId: "goals", title: "Current Task Plan",
    description: "Track the active objective and its progress.", zone: "header",
    defaultSize: { w: 5, h: 4 }, audience: "simple", render: () => <TaskPlanWidget />,
  },
  {
    id: "files.project-map", pluginId: "files", title: "Project Map",
    description: "A visual map of the project’s top-level folders.", zone: "left",
    defaultSize: { w: 5, h: 4 }, audience: "simple", render: () => <ProjectMapWidget />,
  },
  {
    id: "files.explorer", pluginId: "files", title: "Files",
    description: "Browse and edit project files.", zone: "left",
    defaultSize: { w: 6, h: 7 }, audience: "standard", render: () => <EditorView />,
  },
  {
    id: "git.recent", pluginId: "git", title: "Recent Changes",
    description: "Review source-control status, diffs, and commits.", zone: "right",
    defaultSize: { w: 5, h: 4 }, audience: "simple", render: () => <RecentChangesWidget />,
  },
  {
    id: "terminal.shell", pluginId: "terminal", title: "Terminal",
    description: "Run project-scoped shell sessions.", zone: "bottom",
    defaultSize: { w: 12, h: 5 }, audience: "standard", render: () => <TerminalView />,
  },
  {
    id: "knowledge.notes", pluginId: "knowledge", title: "Notes / Memory",
    description: "Keep project notes, plans, and durable knowledge.", zone: "left",
    defaultSize: { w: 6, h: 5 }, audience: "standard", render: () => <KnowledgePanel />,
  },
  {
    id: "session.work-status", pluginId: "session", title: "Agent Actions",
    description: "Live task, delegated-agent, and usage status.", zone: "right",
    defaultSize: { w: 5, h: 4 }, audience: "simple", render: () => <AgentActionsWidget />,
  },
  {
    id: "session.activity", pluginId: "session", title: "Activity Timeline",
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

const BUILTIN_WIDGET_META: Record<string, Partial<WidgetDef>> = {
  "core.composer": {
    pluginName: "Core workspace", category: "conversation", recommended: true,
    supportedZones: ["main", "bottom"], minSize: { w: 6, h: 4 }, maxSize: { w: 12, h: 8 },
    resizable: true, scope: "workspace",
  },
  "core.chat": {
    pluginName: "Core workspace", category: "conversation",
    supportedZones: ["main"], minSize: { w: 8, h: 6 }, maxSize: { w: 12, h: 12 },
    resizable: true, scope: "workspace",
  },
  "core.quick-actions": {
    pluginName: "Core workspace", category: "actions", recommended: true,
    supportedZones: ["header", "left", "main", "right"], minSize: { w: 3, h: 2 },
    maxSize: { w: 12, h: 5 }, resizable: true, scope: "workspace",
  },
  "goals.current": {
    pluginName: "Core workspace", category: "planning",
    supportedZones: ["header", "left", "main", "right"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 8 }, resizable: true, scope: "workspace",
  },
  "files.project-map": {
    pluginName: "Core workspace", category: "files",
    supportedZones: ["left", "main", "right"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 8 }, resizable: true, scope: "workspace",
  },
  "files.explorer": {
    pluginName: "Core workspace", category: "files",
    supportedZones: ["left", "main", "right"], minSize: { w: 5, h: 6 },
    maxSize: { w: 12, h: 12 }, resizable: true, scope: "workspace",
  },
  "git.recent": {
    pluginName: "Git tools", category: "source control", recommended: true,
    supportedZones: ["left", "main", "right"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 8 }, resizable: true, scope: "workspace",
    capabilities: ["diff", "status", "history"],
  },
  "terminal.shell": {
    pluginName: "Core workspace", category: "tools",
    supportedZones: ["main", "bottom", "floating"], minSize: { w: 8, h: 4 },
    maxSize: { w: 12, h: 12 }, resizable: true, floating: true, scope: "workspace",
    capabilities: ["shell", "commands"],
  },
  "knowledge.notes": {
    pluginName: "Knowledge", category: "knowledge", recommended: true,
    supportedZones: ["left", "main", "right", "floating"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 10 }, resizable: true, duplicatable: true, floating: true,
    scope: "workspace", capabilities: ["notes", "memory"],
  },
  "session.work-status": {
    pluginName: "Core workspace", category: "status",
    supportedZones: ["header", "left", "main", "right"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 8 }, resizable: true, scope: "workspace",
  },
  "session.activity": {
    pluginName: "Core workspace", category: "status",
    supportedZones: ["left", "main", "right", "bottom"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 8 }, resizable: true, scope: "workspace",
  },
  "preview.app": {
    pluginName: "Core workspace", category: "preview",
    supportedZones: ["main", "bottom", "floating"], minSize: { w: 8, h: 5 },
    maxSize: { w: 12, h: 12 }, resizable: true, floating: true, scope: "workspace",
  },
  "github.overview": {
    pluginName: "GitHub", category: "source control",
    supportedZones: ["left", "main", "right"], minSize: { w: 5, h: 4 },
    maxSize: { w: 12, h: 10 }, resizable: true, scope: "plugin",
  },
  "schedule.tasks": {
    pluginName: "Tools", category: "planning",
    supportedZones: ["left", "main", "right"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 8 }, resizable: true, scope: "plugin",
  },
  "multirun.runs": {
    pluginName: "Tools", category: "agents",
    supportedZones: ["main", "bottom"], minSize: { w: 8, h: 5 },
    maxSize: { w: 12, h: 12 }, resizable: true, scope: "plugin",
  },
  "fusion.answers": {
    pluginName: "Tools", category: "agents",
    supportedZones: ["main", "bottom"], minSize: { w: 8, h: 5 },
    maxSize: { w: 12, h: 12 }, resizable: true, scope: "plugin",
  },
  "walkthrough.review": {
    pluginName: "Git tools", category: "source control",
    supportedZones: ["main", "bottom"], minSize: { w: 8, h: 5 },
    maxSize: { w: 12, h: 12 }, resizable: true, scope: "plugin",
  },
  "usage.session": {
    pluginName: "Tools", category: "status",
    supportedZones: ["header", "left", "main", "right"], minSize: { w: 3, h: 2 },
    maxSize: { w: 8, h: 6 }, resizable: true, scope: "workspace",
  },
};

for (const widget of BUILTINS) {
  registerWidget({
    ...widget,
    ...BUILTIN_WIDGET_META[widget.id],
    settingsRender: widget.settingsRender ?? (() => (
      <div className="builtin-widget-settings">
        <span>Uses the active workspace context</span>
        <small>Visibility, size, audience, and placement are configured above.</small>
      </div>
    )),
  });
}
