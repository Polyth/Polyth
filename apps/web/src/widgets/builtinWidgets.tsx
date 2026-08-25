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
import { openWorkspacePane, useActiveModel, useStore } from "../store.ts";
import {
  defineWidgetPlugin,
  registerWidgetPlugin,
  type PluginWidgetDef,
  type WidgetDef,
  type WidgetPlugin,
  type WidgetRenderContext,
  type WidgetSettingsContext,
} from "./catalog.ts";
import { widgetSlotFromZone } from "./widgetLayout.ts";
import { api, type FileEntry, type GitFileEntry } from "../api.ts";
import { useGitStatus } from "../gitStatusStore.ts";
import { requestComposerReplace } from "../composerInsert.ts";
import { Icon } from "../icons.tsx";
import { registerSlot } from "../slots.ts";
import { getLocale, tr } from "../i18n/index.ts";

const NO_EVENTS: never[] = [];

function ChatWidget() {
  const session = useStore((state) => state.sessions.find((item) => item.id === state.activeSessionId) ?? null);
  const model = useActiveModel();
  if (!session) {
    return (
      <div className="widget-chat-empty">
        <p>{tr("widgets.builtinwidgets.startASessionInThisProject")}</p>
        <Composer variant="widget" />
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
        ? <div className="archived-guard">{tr("widgets.builtinwidgets.thisSessionIsArchivedAndReadOnly")}</div>
        : <Composer variant="widget" />}
    </div>
  );
}

function QuickActionsWidget() {
  const actions = [
    [tr("widgets.builtinwidgets.codeReview"), tr("widgets.builtinwidgets.reviewTheRecentChangesForCorrectnessSecurity"), "⌘"],
    [tr("widgets.builtinwidgets.refactor"), tr("widgets.builtinwidgets.refactorTheCurrentCodeForClarityWithout"), "◇"],
    [tr("widgets.builtinwidgets.debug"), tr("widgets.builtinwidgets.debugTheCurrentIssueUsingRuntimeEvidence"), "◎"],
  ] as const;
  return (
    <div className="widget-quick-actions">
      {actions.map(([label, prompt, glyph]) => (
        <button key={label} onClick={() => requestComposerReplace(prompt)}>
          <span aria-hidden="true">{glyph}</span>
          <strong>{label}</strong>
          <small>{tr("widgets.builtinwidgets.fillComposer")}</small>
        </button>
      ))}
    </div>
  );
}

function TaskPlanWidget() {
  const model = useActiveModel();
  const tasks = model.tasks?.items ?? [];
  const display = tasks.length > 0 ? tasks : [
    { id: "discover", text: tr("widgets.builtinwidgets.understandTask"), status: "done" as const },
    { id: "implement", text: tr("widgets.builtinwidgets.implementChanges"), status: "active" as const },
    { id: "verify", text: tr("widgets.builtinwidgets.runChecks"), status: "pending" as const },
    { id: "deliver", text: tr("widgets.builtinwidgets.summarizeWork"), status: "pending" as const },
  ];
  const done = display.filter((task) => task.status === "done").length;
  const progress = Math.round((done / display.length) * 100);
  return (
    <div className="widget-task-plan">
      <div className="widget-plan-progress">
        <span>{done} {tr("widgets.builtinwidgets.of")}{" "}{display.length} {tr("widgets.builtinwidgets.complete")}</span><strong>{progress}%</strong>
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
        <Icon.files /><span>{tr("widgets.builtinwidgets.project")}</span>
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
        <span>{status?.branch || tr("widgets.builtinwidgets.workingTree")}</span>
        <button onClick={() => openWorkspacePane("git")}>{tr("widgets.builtinwidgets.viewAll")}</button>
      </div>
      {(changes.length > 0 ? changes.slice(0, 7) : [
        { path: tr("widgets.builtinwidgets.noUncommittedChanges"), status: "clean", staged: false },
      ]).map((entry) => (
        <button key={`${entry.path}:${entry.staged}`} onClick={() => openWorkspacePane("git")}>
          <span className={`change-status ${entry.status === "clean" ? "clean" : ""}`}>{entry.status === "clean" ? "✓" : entry.status.slice(0, 1) || "M"}</span>
          <span>{entry.path}</span>
          <small>{entry.status === "clean" ? tr("widgets.builtinwidgets.clean") : entry.staged ? tr("widgets.builtinwidgets.staged") : "+1 −1"}</small>
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
          <div><span className="action-dot done">✓</span><p><strong>{tr("widgets.builtinwidgets.workspaceReady")}</strong><small>{tr("widgets.builtinwidgets.projectContextLoaded")}</small></p></div>
          <div><span className="action-dot active">●</span><p><strong>{tr("widgets.builtinwidgets.waitingForATask")}</strong><small>{tr("widgets.builtinwidgets.agentActionsWillStreamHere")}</small></p></div>
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
  if (events.length === 0) return <div className="widget-empty">{tr("widgets.builtinwidgets.sessionActivityAppearsHere")}</div>;
  return (
    <div className="widget-activity">
      {[...events].slice(-24).reverse().map((event) => (
        <div className="widget-activity-row" key={event.id}>
          <span className="mono">#{event.seq}</span>
          <span>{event.type}</span>
          <time>{new Date(event.time).toLocaleTimeString(getLocale())}</time>
        </div>
      ))}
    </div>
  );
}

const BUILTINS: WidgetDef[] = [
  {
    id: "core.chat", pluginId: "session", title: tr("widgets.builtinwidgets.conversation"),
    description: tr("widgets.builtinwidgets.theActiveConversationTimelineAndComposer"),
    zone: "main", defaultSize: { w: 12, h: 8 }, audience: "simple",
    render: () => <ChatWidget />,
  },
  {
    id: "core.quick-actions", pluginId: "commands", title: tr("widgets.builtinwidgets.quickActions"),
    description: tr("widgets.builtinwidgets.openFrequentlyUsedWorkspaceTools"), zone: "header",
    defaultSize: { w: 6, h: 2 }, audience: "simple", render: () => <QuickActionsWidget />,
  },
  {
    id: "goals.current", pluginId: "goals", title: tr("widgets.builtinwidgets.currentTaskPlan"),
    description: tr("widgets.builtinwidgets.trackTheActiveObjectiveAndItsProgress"), zone: "header",
    defaultSize: { w: 5, h: 4 }, audience: "simple", render: () => <TaskPlanWidget />,
  },
  {
    id: "files.project-map", pluginId: "files", title: tr("widgets.builtinwidgets.projectMap"),
    description: tr("widgets.builtinwidgets.aVisualMapOfTheProjectS"), zone: "left",
    defaultSize: { w: 5, h: 4 }, audience: "simple", render: () => <ProjectMapWidget />,
  },
  {
    id: "files.explorer", pluginId: "files", title: tr("widgets.builtinwidgets.files"),
    description: tr("widgets.builtinwidgets.browseAndEditProjectFiles"), zone: "left",
    defaultSize: { w: 6, h: 7 }, audience: "standard", render: () => <EditorView />,
  },
  {
    id: "git.recent", pluginId: "git", title: tr("widgets.builtinwidgets.recentChanges"),
    description: tr("widgets.builtinwidgets.reviewSourceControlStatusDiffsAndCommits"), zone: "right",
    defaultSize: { w: 5, h: 4 }, audience: "simple", render: () => <RecentChangesWidget />,
  },
  {
    id: "terminal.shell", pluginId: "terminal", title: tr("widgets.builtinwidgets.terminal"),
    description: tr("widgets.builtinwidgets.runProjectScopedShellSessions"), zone: "bottom",
    defaultSize: { w: 12, h: 5 }, audience: "standard", render: () => <TerminalView />,
  },
  {
    id: "knowledge.notes", pluginId: "knowledge", title: tr("widgets.builtinwidgets.notesMemory"),
    description: tr("widgets.builtinwidgets.keepProjectNotesPlansAndDurableKnowledge"), zone: "left",
    defaultSize: { w: 6, h: 5 }, audience: "standard", render: () => <KnowledgePanel />,
  },
  {
    id: "session.work-status", pluginId: "session", title: tr("widgets.builtinwidgets.agentActions"),
    description: tr("widgets.builtinwidgets.liveTaskDelegatedAgentAndUsageStatus"), zone: "right",
    defaultSize: { w: 5, h: 4 }, audience: "simple", render: () => <AgentActionsWidget />,
  },
  {
    id: "session.activity", pluginId: "session", title: tr("widgets.builtinwidgets.activityTimeline"),
    description: tr("widgets.builtinwidgets.recentDurableEventsFromTheActiveSession"), zone: "right",
    defaultSize: { w: 6, h: 4 }, audience: "power", render: () => <ActivityWidget />,
  },
  {
    id: "browser.app", pluginId: "browser", title: tr("widgets.builtinwidgets.browser"),
    description: tr("widgets.builtinwidgets.browsePagesWithAgentsAnd"), zone: "bottom",
    defaultSize: { w: 12, h: 6 }, audience: "standard", render: () => <PreviewView />,
  },
  {
    id: "github.overview", pluginId: "github", title: tr("widgets.builtinwidgets.github"),
    description: tr("widgets.builtinwidgets.repositoryIssuesPullRequestsAndChecks"), zone: "right",
    defaultSize: { w: 6, h: 6 }, audience: "standard", render: () => <GithubView />,
  },
  {
    id: "schedule.tasks", pluginId: "schedule", title: tr("widgets.builtinwidgets.schedule"),
    description: tr("widgets.builtinwidgets.scheduledPromptsAndRecurringAutomation"), zone: "right",
    defaultSize: { w: 6, h: 5 }, audience: "standard", render: () => <ScheduleView />,
  },
  {
    id: "multirun.runs", pluginId: "multirun", title: tr("widgets.builtinwidgets.multiRun"),
    description: tr("widgets.builtinwidgets.compareParallelModelRuns"), zone: "main",
    defaultSize: { w: 12, h: 6 }, audience: "power", render: () => <MultiRunView />,
  },
  {
    id: "fusion.answers", pluginId: "fusion", title: tr("widgets.builtinwidgets.fusion"),
    description: tr("widgets.builtinwidgets.combineAndWeighMultipleModelAnswers"), zone: "main",
    defaultSize: { w: 12, h: 6 }, audience: "power", render: () => <FusionView />,
  },
  {
    id: "walkthrough.review", pluginId: "walkthrough", title: tr("widgets.builtinwidgets.walkthrough"),
    description: tr("widgets.builtinwidgets.reviewChangedFilesInGuidedStages"), zone: "main",
    defaultSize: { w: 12, h: 6 }, audience: "standard", render: () => <WalkthroughView />,
  },
];

// Feature-owned widget pluginIds match their packages/<pluginId> boundary.
// These web adapters keep React in apps/web while contributing package-owned
// Git and Terminal widgets through the same slot third parties use.
const SLOT_BACKED_BUILTINS = new Set(["git.recent", "terminal.shell"]);

const BUILTIN_WIDGET_META: Record<string, Partial<WidgetDef>> = {
  "core.chat": {
    pluginName: tr("widgets.widgetlibrary.coreWorkspace"), category: "conversation", recommended: true,
    supportedZones: ["main", "bottom"], minSize: { w: 4, h: 3 }, maxSize: { w: 12, h: 50 },
    resizable: true, scope: "workspace",
  },
  "core.quick-actions": {
    pluginName: tr("widgets.widgetlibrary.coreWorkspace"), category: "actions", recommended: true,
    supportedZones: ["header", "left", "main", "right"], minSize: { w: 3, h: 2 },
    maxSize: { w: 12, h: 50 }, resizable: true, scope: "workspace",
  },
  "goals.current": {
    pluginName: tr("widgets.widgetlibrary.coreWorkspace"), category: "planning",
    supportedZones: ["header", "left", "main", "right"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 50 }, resizable: true, scope: "workspace",
  },
  "files.project-map": {
    pluginName: tr("widgets.widgetlibrary.coreWorkspace"), category: "files",
    supportedZones: ["left", "main", "right"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 50 }, resizable: true, scope: "workspace",
  },
  "files.explorer": {
    pluginName: tr("widgets.widgetlibrary.coreWorkspace"), category: "files",
    supportedZones: ["left", "main", "right"], minSize: { w: 5, h: 6 },
    maxSize: { w: 12, h: 50 }, resizable: true, scope: "workspace",
  },
  "git.recent": {
    pluginName: tr("widgets.widgetlibrary.gitTools"), category: "source control", recommended: true,
    supportedZones: ["left", "main", "right"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 50 }, resizable: true, scope: "workspace",
    capabilities: ["diff", "status", "history"],
  },
  "terminal.shell": {
    pluginName: tr("widgets.widgetlibrary.coreWorkspace"), category: "tools",
    supportedZones: ["main", "bottom", "floating"], minSize: { w: 8, h: 4 },
    maxSize: { w: 12, h: 50 }, resizable: true, floating: true, scope: "workspace",
    capabilities: ["shell", "commands"],
  },
  "knowledge.notes": {
    pluginName: tr("capabilities.knowledge"), category: "knowledge", recommended: true,
    supportedZones: ["left", "main", "right", "floating"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 50 }, resizable: true, duplicatable: true, floating: true,
    scope: "workspace", capabilities: ["notes", "memory"],
  },
  "session.work-status": {
    pluginName: tr("widgets.widgetlibrary.coreWorkspace"), category: "status",
    supportedZones: ["header", "left", "main", "right"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 50 }, resizable: true, scope: "workspace",
  },
  "session.activity": {
    pluginName: tr("widgets.widgetlibrary.coreWorkspace"), category: "status",
    supportedZones: ["left", "main", "right", "bottom"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 50 }, resizable: true, scope: "workspace",
  },
  "browser.app": {
    pluginName: tr("widgets.widgetlibrary.coreWorkspace"), category: "browser",
    supportedZones: ["main", "bottom", "floating"], minSize: { w: 8, h: 5 },
    maxSize: { w: 12, h: 50 }, resizable: true, floating: true, scope: "workspace",
  },
  "github.overview": {
    pluginName: "GitHub", category: "source control",
    supportedZones: ["left", "main", "right"], minSize: { w: 5, h: 4 },
    maxSize: { w: 12, h: 50 }, resizable: true, scope: "plugin",
  },
  "schedule.tasks": {
    pluginName: tr("composeraddmenu.tools"), category: "planning",
    supportedZones: ["left", "main", "right"], minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 50 }, resizable: true, scope: "plugin",
  },
  "multirun.runs": {
    pluginName: tr("composeraddmenu.tools"), category: "agents",
    supportedZones: ["main", "bottom"], minSize: { w: 8, h: 5 },
    maxSize: { w: 12, h: 50 }, resizable: true, scope: "plugin",
  },
  "fusion.answers": {
    pluginName: tr("composeraddmenu.tools"), category: "agents",
    supportedZones: ["main", "bottom"], minSize: { w: 8, h: 5 },
    maxSize: { w: 12, h: 50 }, resizable: true, scope: "plugin",
  },
  "walkthrough.review": {
    pluginName: tr("widgets.widgetlibrary.gitTools"), category: "source control",
    supportedZones: ["main", "bottom"], minSize: { w: 8, h: 5 },
    maxSize: { w: 12, h: 50 }, resizable: true, scope: "plugin",
  },
};

function widgetSlotMeta(widget: WidgetDef): Record<string, unknown> {
  return {
    pluginId: widget.pluginId,
    pluginName: widget.pluginName,
    title: widget.title,
    description: widget.description,
    kind: widget.kind,
    defaultSlot: widget.defaultSlot,
    supportedSlots: widget.supportedSlots,
    defaultVisible: widget.defaultVisible,
    order: widget.order,
    zone: widget.zone,
    supportedZones: widget.supportedZones,
    recommendedSize: widget.recommendedSize,
    defaultSize: widget.defaultSize,
    minSize: widget.minSize,
    maxSize: widget.maxSize,
    audience: widget.audience,
    showIn: widget.showIn,
    scope: widget.scope,
    resizable: widget.resizable,
    duplicatable: widget.duplicatable,
    floating: widget.floating,
    recommended: widget.recommended,
    category: widget.category,
    capabilities: widget.capabilities,
    settingsSchema: widget.settingsSchema,
  };
}

const pluginDefinitions = new Map<string, { name: string; widgets: PluginWidgetDef[] }>();
for (const base of BUILTINS) {
  const widget: WidgetDef = {
    ...base,
    ...BUILTIN_WIDGET_META[base.id],
    recommendedSize: BUILTIN_WIDGET_META[base.id]?.recommendedSize
      ?? base.recommendedSize
      ?? base.defaultSize
      ?? BUILTIN_WIDGET_META[base.id]?.minSize,
    settingsRender: base.settingsRender ?? (() => (
      <div className="builtin-widget-settings">
        <span>{tr("widgets.builtinwidgets.usesTheActiveWorkspaceContext")}</span>
        <small>{tr("widgets.builtinwidgets.visibilitySizeAudienceAndPlacementAreConfigured")}</small>
      </div>
    )),
  };
  if (SLOT_BACKED_BUILTINS.has(widget.id)) {
    registerSlot(
      "widget.catalog",
      widget.id,
      (context) => widget.render(context as WidgetRenderContext),
      0,
      widgetSlotMeta(widget),
    );
    registerSlot(
      "widget.settings",
      widget.id,
      (context) => widget.settingsRender?.(context as WidgetSettingsContext) ?? null,
      0,
      { widgetId: widget.id },
    );
    continue;
  }
  const { pluginId, pluginName, ...definition } = widget;
  const owner = pluginDefinitions.get(pluginId) ?? {
    name: pluginName ?? pluginId,
    widgets: [],
  };
  const defaultSlot = definition.defaultSlot ?? widgetSlotFromZone(definition.zone ?? "main");
  owner.widgets.push({
    ...definition,
    kind: definition.kind ?? "widget",
    defaultSlot,
    supportedSlots: definition.supportedSlots
      ?? definition.supportedZones?.map(widgetSlotFromZone)
      ?? [defaultSlot],
  });
  pluginDefinitions.set(pluginId, owner);
}

/** Built-ins use the exact same 0..N declaration API as third-party plugins.
 * Notably `session` and `files` each own multiple independent widgets. */
export const BUILTIN_WIDGET_PLUGINS: readonly WidgetPlugin[] = [...pluginDefinitions].map(
  ([id, owner]) => defineWidgetPlugin({ id, name: owner.name, widgets: owner.widgets }),
);

let installed = false;

export function installBuiltinWidgetPlugins(): void {
  if (installed) return;
  installed = true;
  for (const plugin of BUILTIN_WIDGET_PLUGINS) registerWidgetPlugin(plugin);
}

installBuiltinWidgetPlugins();
