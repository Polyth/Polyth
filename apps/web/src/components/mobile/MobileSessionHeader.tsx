import { useEffect, useMemo, useState } from "react";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { ago, displaySessionTitle, fmtTokens } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { tr } from "../../i18n/index.ts";
import {
  buildIslandItems,
  eventsHaveCodeChanges,
  notablePeers,
  promptExcerpt,
  recentSessionsForIsland,
  sessionTitleOf,
  type IslandItem,
  type IslandTask,
} from "../../mobileIsland.ts";
import { resolveSessionStatus, type SessionRowStatus } from "../../sessionStatus.ts";
import { openSession, prefetchSessionTail } from "../../init.ts";
import { setRailPlugin, setSidebarOpen, startNewSession, useActiveModel, useStore } from "../../store.ts";
import { firstUserTextCached, lastUserTextCached } from "../../utils.ts";
import { ComposeIcon, GlassIsland, IconButton, LayersIcon, MenuIcon } from "../ui/index.ts";
import Sheet, { SheetRow, SheetSection } from "./Sheet.tsx";
import WorkspacePanel from "./WorkspacePanel.tsx";
import { PROMPT_VISIBILITY_EVENT, promptIsVisible } from "../../promptVisibility.ts";
import {
  contextGaugeForTelemetry,
  contextTelemetryNotice,
  contextTelemetryStatus,
  formatContextPercent,
  type ContextGauge,
} from "../../reduce.ts";
import { useUiSettings } from "../../uiPrefs.ts";
import ContextIndicator from "../ContextIndicator.tsx";

function SessionLiveIcon({ status }: { status: SessionRowStatus }) {
  if (status.kind === "working") {
    return <span className="mobile-island-live working" title={status.label} aria-label={status.label} />;
  }
  if (status.kind === "needs-approval") {
    return <span className="mobile-island-live approval" title={status.label} aria-label={status.label} />;
  }
  if (status.kind === "needs-reply") {
    return <span className="mobile-island-live reply" title={status.label} aria-label={status.label} />;
  }
  if (status.kind === "failed") {
    return <span className="mobile-island-live failed" title={status.label} aria-label={status.label} />;
  }
  if (status.kind === "unread" || status.kind === "reconciling" || status.kind === "epoch-pending") {
    return <span className={`mobile-island-live ${status.kind}`} title={status.label} aria-label={status.label} />;
  }
  return <span className="mobile-island-live idle" title={status.label} aria-label={status.label} />;
}

function CodeChangedMark() {
  return (
    <span className="mobile-island-diff" title={tr("mobile.island.codeChanged")} aria-label={tr("mobile.island.codeChanged")}>
      <i className="add" /><i className="del" />
    </span>
  );
}

function PromptExcerpt({ text }: { text: string }) {
  const excerpt = promptExcerpt(text);
  const expandable = text.trim() !== excerpt;
  const [open, setOpen] = useState(false);
  return (
    <div className="mobile-island-prompt">
      <span className="mobile-island-prompt-label">{tr("mobile.island.prompt")}</span>
      <p className={open ? "full" : undefined}>{open ? text : excerpt}</p>
      {expandable && (
        <button type="button" className="mobile-island-prompt-toggle" onClick={() => setOpen((value) => !value)}>
          {open ? tr("mobile.island.hideFullPrompt") : tr("mobile.island.showFullPrompt")}
        </button>
      )}
    </div>
  );
}

function TaskMark({ status }: { status: IslandTask["status"] }) {
  if (status === "done") return <span className="mobile-task-mark done" aria-hidden="true"><Icon.check /></span>;
  if (status === "failed") return <span className="mobile-task-mark failed" aria-hidden="true">×</span>;
  if (status === "active") return <span className="mobile-task-mark active" aria-hidden="true"><i /></span>;
  return <span className="mobile-task-mark pending" aria-hidden="true" />;
}

function IslandOverview({
  title,
  prompt,
  tasks,
  requests,
  recent,
  events,
  gauge,
  contextNotice,
  onClose,
}: {
  title: string;
  prompt: string | undefined;
  tasks: IslandTask[];
  requests: IslandItem[];
  recent: SessionProjection[];
  events: Record<string, readonly SessionEvent[] | undefined>;
  gauge: ContextGauge;
  contextNotice?: string;
  onClose: () => void;
}) {
  const contextPercent = formatContextPercent(gauge);
  return (
    <Sheet
      title={tr("mobile.island.overview")}
      origin="top"
      className="mobile-island-sheet"
      onClose={onClose}
    >
      <div className="mobile-island-now">
        <strong className="mobile-island-session">{title}</strong>
        <div className="mobile-island-context">
          <strong>Context{contextPercent ? ` · ${contextPercent}` : ""}</strong>
          <span>{contextNotice ?? (gauge.known
            ? `${fmtTokens(gauge.inputTokens)} / ${fmtTokens(gauge.contextTokens)} tokens`
            : "Model context metadata is unavailable.")}</span>
        </div>
        {prompt
          ? <PromptExcerpt text={prompt} />
          : <p className="mobile-island-empty">{tr("mobile.island.noPrompt")}</p>}
      </div>
      {requests.length > 0 && (
        <SheetSection title={tr("mobile.island.requests")}>
          <ul className="mobile-task-list">
            {requests.map((request) => (
              <li key={request.id} className="request">
                <span className={`mobile-island-dot ${request.tone ?? request.kind}`} aria-hidden="true" />
                <span className="mobile-task-text">{request.text}</span>
              </li>
            ))}
          </ul>
        </SheetSection>
      )}
      <SheetSection title={tr("mobile.island.tasks")}>
        {tasks.length > 0 ? (
          <ul className="mobile-task-list">
            {tasks.map((task) => (
              <li key={task.id} className={task.status}>
                <TaskMark status={task.status} />
                <span className="mobile-task-text">{task.text}</span>
                {task.status === "active" && <small>{tr("mobile.island.inProgress")}</small>}
              </li>
            ))}
          </ul>
        ) : <p className="sheet-empty">{tr("mobile.island.noTasks")}</p>}
      </SheetSection>
      <SheetSection title={tr("mobile.island.recent")}>
        {recent.map((item) => {
          const status = resolveSessionStatus(item);
          const itemTitle = sessionTitleOf(item, events);
          return (
            <SheetRow
              key={item.id}
              title={itemTitle}
              meta={status.kind === "regular" ? ago(item.lastTurnAt ?? item.createdAt) : status.label}
              icon={<SessionLiveIcon status={status} />}
              trailing={eventsHaveCodeChanges(events[item.id]) ? <CodeChangedMark /> : undefined}
              onClick={() => {
                void openSession(item.id);
                onClose();
              }}
            />
          );
        })}
        {recent.length === 0 && <p className="sheet-empty">{tr("mobile.island.noRecent")}</p>}
      </SheetSection>
    </Sheet>
  );
}

export function Tools({ onClose }: { onClose: () => void }) {
  return <WorkspacePanel onClose={onClose} />;
}

/** Phone navigation is intentionally a small overlay, not a second application header. */
export default function MobileSessionHeader() {
  const projectId = useStore((state) => state.activeProjectId);
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const events = useStore((state) => state.events);
  const sessions = useStore((state) => state.sessions);
  const session = useStore((state) => state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const model = useActiveModel();
  const models = useStore((state) => state.models);
  const ui = useUiSettings();
  const [surface, setSurface] = useState<"island" | "tools" | null>(null);
  const [promptVisible, setPromptVisible] = useState(promptIsVisible);
  const title = session
    ? displaySessionTitle(session.title, session.id, firstUserTextCached(events[session.id]))
    : tr("mobile.island.newChat");
  const prompt = lastUserTextCached(session ? events[session.id] : undefined);
  useEffect(() => {
    const update = (event: Event) => setPromptVisible((event as CustomEvent<boolean>).detail);
    window.addEventListener(PROMPT_VISIBILITY_EVENT, update);
    return () => window.removeEventListener(PROMPT_VISIBILITY_EVENT, update);
  }, []);
  const recent = useMemo(
    () => recentSessionsForIsland(sessions, session?.id),
    [sessions, session?.id],
  );
  const peers = useMemo(
    () => notablePeers(sessions, session?.id, events),
    [sessions, session?.id, events],
  );
  useEffect(() => {
    for (const peer of peers) prefetchSessionTail(peer.id);
    for (const item of recent) prefetchSessionTail(item.id);
  }, [peers, recent]);
  const labels = useMemo(() => ({
    task: tr("mobile.island.kindTask"),
    request: tr("mobile.island.kindRequest"),
    session: tr("mobile.island.kindSession"),
    peer: tr("mobile.island.kindPeer"),
    working: tr("mobile.island.working"),
    newChat: tr("mobile.island.newChat"),
  }), []);
  // The pill title stays put; the derived items only feed the status glyph and
  // the overview's request list, so nothing rotates under the reader.
  const items = useMemo(() => buildIslandItems({
    sessionTitle: title,
    hasSession: session !== null,
    tasks: model.tasks?.items,
    permissions: model.permissions,
    questions: model.questions,
    secrets: model.secrets,
    peers,
    labels,
  }), [title, session, model.tasks, model.permissions, model.questions, model.secrets, peers, labels]);
  const requests = useMemo(() => items.filter((item) => item.kind === "request"), [items]);
  const sessionStatus = session ? resolveSessionStatus(session) : null;
  const runtimeFeatures = useStore((s) => session?.id ? s.runtimeFeatures[session.id] : undefined);
  const activeModel = model.contextUsage?.model ?? model.turn?.model ?? session?.model;
  const descriptor = activeModel ? models.find((item) => item.providerID === activeModel.providerID && item.modelID === activeModel.modelID) : undefined;
  const telemetryStatus = contextTelemetryStatus(runtimeFeatures?.telemetry);
  const gauge = contextGaugeForTelemetry(model, descriptor?.context, session?.contextWindow ?? null, telemetryStatus);
  const contextNotice = contextTelemetryNotice(telemetryStatus, gauge);

  return <>
    <div className="mobile-session-floats" aria-label="Workspace navigation">
      <GlassIsland className="mobile-float-navigation">
        <IconButton icon={MenuIcon} label="Open navigation" size="lg" variant="quiet" aria-expanded={sidebarOpen} onClick={() => {
          setRailPlugin(null);
          setSidebarOpen(true);
        }} />
      </GlassIsland>
      <GlassIsland className="mobile-session-title-island">
        <button
          className="mobile-session-selector"
          aria-label={tr("mobile.island.openOverview", { label: title })}
          aria-haspopup="dialog"
          aria-expanded={surface === "island"}
          onClick={() => setSurface("island")}
        >
          {session && <ContextIndicator gauge={gauge} mode={ui.contextIndicatorMode} providerID={activeModel?.providerID} providerName={descriptor?.providerName} harnessId={descriptor?.harnessId ?? session.resolvedHarnessId} active={sessionStatus?.kind === "working"} telemetryStatus={telemetryStatus} />}
          <span className="mobile-island-text">{title}</span>
          <Icon.chevronDown />
        </button>
      </GlassIsland>
      <GlassIsland className="mobile-float-actions">
        <IconButton icon={ComposeIcon} label="New session" size="lg" variant="ghost" disabled={!projectId} onClick={() => projectId && startNewSession(projectId)} />
        <IconButton icon={LayersIcon} label="Open tools" size="lg" variant="ghost" aria-expanded={surface === "tools"} onClick={() => setSurface("tools")} />
      </GlassIsland>
    </div>
    {surface === "island" && (
      <IslandOverview
        title={title}
        prompt={promptVisible ? undefined : prompt}
        tasks={model.tasks?.items ?? []}
        requests={requests}
        recent={recent}
        events={events}
        gauge={gauge}
        contextNotice={contextNotice}
        onClose={() => setSurface(null)}
      />
    )}
    {surface === "tools" && <Tools onClose={() => setSurface(null)} />}
  </>;
}
