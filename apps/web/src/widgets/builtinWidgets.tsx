import { type ReactNode } from "react";
import Composer from "../components/Composer.tsx";
import QuestionCards from "../components/QuestionCards.tsx";
import Timeline from "../components/Timeline.tsx";
import SlotHost from "../components/slots/SlotHost.ts";
import { useActiveModel, useStore } from "../store.ts";
import { requestComposerReplace } from "../composerInsert.ts";
import { getLocale, tr } from "../i18n/index.ts";
import { defineWidgetPlugin, registerWidgetPlugin, type WidgetDef, type WidgetPlugin } from "./catalog.ts";

const NO_EVENTS: never[] = [];

function ChatWidget() {
  const session = useStore((state) => state.sessions.find((item) => item.id === state.activeSessionId) ?? null);
  const model = useActiveModel();
  if (!session) return <div className="widget-chat-empty"><p>{tr("widgets.builtinwidgets.startASessionInThisProject")}</p><Composer variant="widget" /></div>;
  const questions = model.questions.filter((item) => item.status === "pending");
  const permissions = model.permissions.filter((item) => item.status === "pending");
  const secrets = model.secrets.filter((item) => item.status === "pending");
  return <div className="widget-chat">
    <Timeline model={model} />
    {questions.length > 0 && <QuestionCards questions={questions} />}
    <SlotHost slot="session.timeline.after" context={{ permissions, secrets, sessionId: session.id, projectId: session.projectId }} />
    {session.status === "archived" ? <div className="archived-guard">{tr("widgets.builtinwidgets.thisSessionIsArchivedAndReadOnly")}</div> : <Composer variant="widget" />}
  </div>;
}

function QuickActionsWidget() {
  const actions = [
    [tr("widgets.builtinwidgets.codeReview"), tr("widgets.builtinwidgets.reviewTheRecentChangesForCorrectnessSecurity"), "⌘"],
    [tr("widgets.builtinwidgets.refactor"), tr("widgets.builtinwidgets.refactorTheCurrentCodeForClarityWithout"), "◇"],
    [tr("widgets.builtinwidgets.debug"), tr("widgets.builtinwidgets.debugTheCurrentIssueUsingRuntimeEvidence"), "◎"],
  ] as const;
  return <div className="widget-quick-actions">{actions.map(([label, prompt, glyph]) => <button key={label} onClick={() => requestComposerReplace(prompt)}><span aria-hidden="true">{glyph}</span><strong>{label}</strong><small>{tr("widgets.builtinwidgets.fillComposer")}</small></button>)}</div>;
}

function AgentActionsWidget() {
  const model = useActiveModel();
  const actions = model.messages.filter((message) => message.kind === "tool" || message.kind === "task").slice(-8).reverse();
  return <div className="widget-agent-actions">
    {actions.length === 0 && <><div><span className="action-dot done">✓</span><p><strong>{tr("widgets.builtinwidgets.workspaceReady")}</strong><small>{tr("widgets.builtinwidgets.projectContextLoaded")}</small></p></div><div><span className="action-dot active">●</span><p><strong>{tr("widgets.builtinwidgets.waitingForATask")}</strong><small>{tr("widgets.builtinwidgets.agentActionsWillStreamHere")}</small></p></div></>}
    {actions.map((action) => <div key={action.id}><span className={`action-dot ${action.kind === "tool" && action.status === "error" ? "failed" : action.kind === "tool" && action.status === "pending" ? "active" : "done"}`}>{action.kind === "tool" && action.status === "pending" ? "●" : action.kind === "tool" && action.status === "error" ? "!" : "✓"}</span><p><strong>{action.kind === "tool" ? action.title || action.tool : action.text}</strong><small>{action.kind === "tool" ? action.status : action.action}</small></p></div>)}
  </div>;
}

function ActivityWidget() {
  const events = useStore((state) => (state.activeSessionId ? state.events[state.activeSessionId] : undefined) ?? NO_EVENTS);
  if (events.length === 0) return <div className="widget-empty">{tr("widgets.builtinwidgets.sessionActivityAppearsHere")}</div>;
  return <div className="widget-activity">{[...events].slice(-24).reverse().map((event) => <div className="widget-activity-row" key={event.id}><span className="mono">#{event.seq}</span><span>{event.type}</span><time>{new Date(event.time).toLocaleTimeString(getLocale())}</time></div>)}</div>;
}

const BUILTINS: WidgetDef[] = [
  { id: "core.chat", pluginId: "session", title: tr("widgets.builtinwidgets.conversation"), description: tr("widgets.builtinwidgets.theActiveConversationTimelineAndComposer"), zone: "main", defaultSize: { w: 12, h: 8 }, minSize: { w: 4, h: 3 }, maxSize: { w: 12, h: 50 }, audience: "simple", scope: "workspace", resizable: true, render: () => <ChatWidget /> },
  { id: "core.quick-actions", pluginId: "session", title: tr("widgets.builtinwidgets.quickActions"), description: tr("widgets.builtinwidgets.openFrequentlyUsedWorkspaceTools"), zone: "header", defaultSize: { w: 6, h: 2 }, minSize: { w: 3, h: 2 }, maxSize: { w: 12, h: 50 }, audience: "simple", scope: "workspace", resizable: true, render: () => <QuickActionsWidget /> },
  { id: "session.work-status", pluginId: "session", title: tr("widgets.builtinwidgets.agentActions"), description: tr("widgets.builtinwidgets.liveTaskDelegatedAgentAndUsageStatus"), zone: "right", defaultSize: { w: 5, h: 4 }, minSize: { w: 4, h: 3 }, maxSize: { w: 12, h: 50 }, audience: "simple", scope: "workspace", resizable: true, render: () => <AgentActionsWidget /> },
  { id: "session.activity", pluginId: "session", title: tr("widgets.builtinwidgets.activityTimeline"), description: tr("widgets.builtinwidgets.recentDurableEventsFromTheActiveSession"), zone: "right", defaultSize: { w: 6, h: 4 }, minSize: { w: 4, h: 3 }, maxSize: { w: 12, h: 50 }, audience: "power", scope: "workspace", resizable: true, render: () => <ActivityWidget /> },
];

export const BUILTIN_WIDGET_PLUGINS: readonly WidgetPlugin[] = [defineWidgetPlugin({ id: "session", name: "Core workspace", widgets: BUILTINS.map(({ pluginId: _pluginId, pluginName: _pluginName, ...widget }) => widget) })];
let installed = false;
export function installBuiltinWidgetPlugins(): void { if (installed) return; installed = true; for (const plugin of BUILTIN_WIDGET_PLUGINS) registerWidgetPlugin(plugin); }
installBuiltinWidgetPlugins();
