import { useEffect, useMemo, useState, type ReactNode } from "react";
import Composer from "../components/Composer.tsx";
import QuestionCards from "../components/QuestionCards.tsx";
import Timeline from "../components/Timeline.tsx";
import { setUiError, useActiveModel, useStore } from "../store.ts";
import { openSession, prefetchSessionTail } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { displaySessionTitle, isPlaceholderTitle } from "../format.ts";
import { resolveSessionStatus } from "../sessionStatus.ts";
import { Button, Tabs } from "../components/ui/index.ts";
import { requestComposerReplace } from "../composerInsert.ts";
import { getLocale, tr } from "../i18n/index.ts";
import { defineWidgetPlugin, registerWidgetPlugin, type WidgetDef, type WidgetPlugin } from "./catalog.ts";

const NO_EVENTS: never[] = [];
/** How many of the project's sessions the conversation widget offers at once,
 *  and how many more each "More" reveals. */
export const CHAT_SESSION_TAB_PAGE = 5;

/** Session switcher for the canvas conversation widget. The canvas has no
 *  sidebar, so the widget carries its own strip of the project's most recent
 *  sessions. Switching activates the canonical session (every session-scoped
 *  widget on the canvas follows) without leaving Canvas for Chat. */
export function ChatSessionTabs({ projectId }: { projectId: string | null }) {
  const sessions = useStore((state) => state.sessions);
  const activeSessionId = useStore((state) => state.activeSessionId);
  const [limit, setLimit] = useState(CHAT_SESSION_TAB_PAGE);
  useEffect(() => { setLimit(CHAT_SESSION_TAB_PAGE); }, [projectId]);

  const ordered = useMemo(() => sessions
    .filter((session) => session.projectId === projectId && session.status !== "archived")
    .sort((a, b) => (b.lastTurnAt ?? b.createdAt) - (a.lastTurnAt ?? a.createdAt)),
    [sessions, projectId]);
  const shown = useMemo(() => {
    const page = ordered.slice(0, limit);
    // The open session stays selectable even when it is older than the page.
    const open = ordered.find((session) => session.id === activeSessionId);
    return open && !page.includes(open) ? [...page, open] : page;
  }, [ordered, limit, activeSessionId]);

  // Titles are derived from the first user message, which a listing may not
  // carry yet. Ask for those tails only — never for every session.
  useEffect(() => {
    for (const session of shown) {
      if (isPlaceholderTitle(session.title, session.id)) prefetchSessionTail(session.id);
    }
  }, [shown]);

  if (ordered.length === 0) return null;
  const tabs = shown.map((session) => {
    const status = resolveSessionStatus(session);
    return {
      id: session.id,
      label: <>
        {status.kind !== "regular" && (
          <span className={`widget-chat-tab-status ${status.kind}`} aria-hidden="true">
            {status.kind === "working"
              ? <span className="ui-spinner ui-spinner--sm" />
              : status.glyph}
          </span>
        )}
        <span className="widget-chat-tab-title">{displaySessionTitle(session.title, session.id)}</span>
      </>,
    };
  });
  return <div className="widget-chat-tabs">
    <Tabs
      className="widget-chat-tablist"
      size="sm"
      label={tr("widgets.builtinwidgets.projectSessions")}
      tabs={tabs}
      value={activeSessionId ?? ""}
      onChange={(id) => {
        if (id === activeSessionId) return;
        void openSession(id, { showChat: false })
          .catch((error) => setUiError(friendlyError(tr("common.error"), error)));
      }}
    />
    {ordered.length > shown.length && (
      <Button
        size="sm"
        variant="ghost"
        className="widget-chat-tabs-more"
        title={tr("widgets.builtinwidgets.showOlderSessions")}
        aria-label={tr("widgets.builtinwidgets.showOlderSessions")}
        onClick={() => setLimit((current) => current + CHAT_SESSION_TAB_PAGE)}
      >{tr("common.more")}</Button>
    )}
  </div>;
}

function ChatWidget({ projectId }: { projectId: string | null }) {
  const session = useStore((state) => state.sessions.find((item) => item.id === state.activeSessionId) ?? null);
  const model = useActiveModel();
  if (!session) return <div className="widget-chat">
    <ChatSessionTabs projectId={projectId} />
    <div className="widget-chat-empty"><p>{tr("widgets.builtinwidgets.startASessionInThisProject")}</p><Composer variant="widget" /></div>
  </div>;
  const questions = model.questions.filter((item) => item.status === "pending");
  return <div className="widget-chat">
    <ChatSessionTabs projectId={projectId} />
    <Timeline model={model} />
    {questions.length > 0 && <QuestionCards questions={questions} />}
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
    {actions.map((action) => {
      const active = action.kind === "tool" && (action.status === "pending" || action.status === "running");
      return <div key={action.id}><span className={`action-dot ${action.kind === "tool" && action.status === "error" ? "failed" : active ? "active" : "done"}`}>{action.kind === "tool" && action.status === "pending" ? "○" : action.kind === "tool" && action.status === "running" ? "◌" : action.kind === "tool" && action.status === "error" ? "!" : "✓"}</span><p><strong>{action.kind === "tool" ? action.title || action.tool : action.text}</strong><small>{action.kind === "tool" ? action.status : action.action}</small></p></div>;
    })}
  </div>;
}

function ActivityWidget() {
  const events = useStore((state) => (state.activeSessionId ? state.events[state.activeSessionId] : undefined) ?? NO_EVENTS);
  if (events.length === 0) return <div className="widget-empty">{tr("widgets.builtinwidgets.sessionActivityAppearsHere")}</div>;
  return <div className="widget-activity">{[...events].slice(-24).reverse().map((event) => <div className="widget-activity-row" key={event.id}><span className="mono">#{event.seq}</span><span>{event.type}</span><time>{new Date(event.time).toLocaleTimeString(getLocale())}</time></div>)}</div>;
}

const BUILTINS: WidgetDef[] = [
  { id: "core.chat", pluginId: "session", title: tr("widgets.builtinwidgets.conversation"), description: tr("widgets.builtinwidgets.theActiveConversationTimelineAndComposer"), zone: "main", defaultSize: { w: 12, h: 8 }, minSize: { w: 4, h: 3 }, maxSize: { w: 12, h: 50 }, audience: "simple", scope: "workspace", resizable: true, render: (context) => <ChatWidget projectId={context.projectId} /> },
  { id: "core.quick-actions", pluginId: "session", title: tr("widgets.builtinwidgets.quickActions"), description: tr("widgets.builtinwidgets.openFrequentlyUsedWorkspaceTools"), zone: "header", defaultSize: { w: 6, h: 2 }, minSize: { w: 3, h: 2 }, maxSize: { w: 12, h: 50 }, audience: "simple", scope: "workspace", resizable: true, render: () => <QuickActionsWidget /> },
  { id: "session.work-status", pluginId: "session", title: tr("widgets.builtinwidgets.agentActions"), description: tr("widgets.builtinwidgets.liveTaskDelegatedAgentAndUsageStatus"), zone: "right", defaultSize: { w: 5, h: 4 }, minSize: { w: 4, h: 3 }, maxSize: { w: 12, h: 50 }, audience: "simple", scope: "workspace", resizable: true, render: () => <AgentActionsWidget /> },
  { id: "session.activity", pluginId: "session", title: tr("widgets.builtinwidgets.activityTimeline"), description: tr("widgets.builtinwidgets.recentDurableEventsFromTheActiveSession"), zone: "right", defaultSize: { w: 6, h: 4 }, minSize: { w: 4, h: 3 }, maxSize: { w: 12, h: 50 }, audience: "power", scope: "workspace", resizable: true, render: () => <ActivityWidget /> },
];

export const BUILTIN_WIDGET_PLUGINS: readonly WidgetPlugin[] = [defineWidgetPlugin({ id: "session", name: "Core workspace", widgets: BUILTINS.map(({ pluginId: _pluginId, pluginName: _pluginName, ...widget }) => widget) })];
let installed = false;
export function installBuiltinWidgetPlugins(): void { if (installed) return; installed = true; for (const plugin of BUILTIN_WIDGET_PLUGINS) registerWidgetPlugin(plugin); }
installBuiltinWidgetPlugins();
