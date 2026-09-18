import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { ago, displaySessionTitle, isPlaceholderTitle } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { formatNumber, tr } from "../../i18n/index.ts";
import {
  buildIslandItems,
  eventsHaveCodeChanges,
  notablePeers,
  promptExcerpt,
  recentSessionsForIsland,
  sessionTitleOf,
  tasksForIsland,
  type IslandItem,
  type IslandTask,
} from "../../mobileIsland.ts";
import {
  deriveTaskProgressEvent,
  taskProgressSnapshot,
  taskProgressSnapshotKey,
  type TaskProgressEvent,
} from "../../mobileTaskProgress.ts";
import { resolveSessionStatus, type SessionRowStatus } from "../../sessionStatus.ts";
import {
  openSession,
  pollSessionTail,
  prefetchSessionTail,
  refreshSessions,
} from "../../init.ts";
import { setRailPlugin, setSidebarOpen, startNewSession, useActiveModel, useStore, workspaceProjectId } from "../../store.ts";
import { useResolvedCapabilities } from "../../capabilities.ts";
import {
  hideMobileWorkspaceHome,
  showMobileWorkspaceHome,
  useMobileWorkspaceNavigation,
} from "../../mobileWorkspaceNavigation.ts";
import { firstUserTextCached, lastUserTextCached } from "../../utils.ts";
import { ComposeIcon, GlassIsland, IconButton, LayersIcon, MenuIcon } from "../ui/index.ts";
import Sheet, { SheetRow, SheetSection } from "./Sheet.tsx";
import WorkspacePanel from "./WorkspacePanel.tsx";
import {
  contextGaugeForTelemetry,
  contextTelemetryStatus,
} from "../../reduce.ts";
import { useUiSettings } from "../../uiPrefs.ts";
import ContextIndicator from "../ContextIndicator.tsx";
import "./MobileSessionHeader.css";

const SESSION_TITLE_POLL_MS = 2_000;
const TASK_ACTIVE_TITLE_MS = 1_600;
const TASK_COMPLETED_TITLE_MS = 950;
const TASK_ALL_COMPLETE_TITLE_MS = 1_200;

type TaskTitleTone = TaskProgressEvent["kind"];

interface TaskTitleCue {
  sessionId: string | undefined;
  key: string;
  text: string;
  tone: TaskTitleTone;
}

/**
 * Borrow the compact session title for task transitions that happen while the
 * reader is already in this session. The source is the normalized task
 * snapshot, not provider-specific task events, so TodoWrite-only harnesses get
 * the same behavior. Switching sessions seeds the baseline and never replays
 * an old task cue.
 */
function useTaskProgressTitle(sessionId: string | undefined, tasks: readonly IslandTask[]): TaskTitleCue | null {
  const snapshot = taskProgressSnapshot(tasks);
  const snapshotKey = taskProgressSnapshotKey(snapshot);
  const sessionRef = useRef(sessionId);
  const previousRef = useRef(snapshot);
  const [visible, setVisible] = useState<TaskTitleCue | null>(null);

  useEffect(() => {
    if (sessionRef.current !== sessionId) {
      sessionRef.current = sessionId;
      previousRef.current = snapshot;
      setVisible(null);
      return;
    }

    const previous = previousRef.current;
    previousRef.current = snapshot;
    const event = deriveTaskProgressEvent(previous, snapshot);
    if (!event) {
      setVisible(null);
      return;
    }

    const text = event.kind === "all-complete"
      ? `✓ ${tr("timeline.valueCompleteOfValue", { completed: event.completed, total: event.total })}`
      : event.kind === "completed"
        ? `✓ ${event.text}`
        : event.kind === "failed"
          ? `× ${event.text}`
          : `● ${event.text}`;
    const cue: TaskTitleCue = {
      sessionId,
      key: `${sessionId ?? "new"}:${event.key}:${snapshotKey}`,
      text,
      tone: event.kind,
    };
    setVisible(cue);

    if (event.kind === "failed") return;
    const duration = event.kind === "active"
      ? TASK_ACTIVE_TITLE_MS
      : event.kind === "all-complete"
        ? TASK_ALL_COMPLETE_TITLE_MS
        : TASK_COMPLETED_TITLE_MS;
    const timer = window.setTimeout(() => {
      setVisible((current) => current?.key === cue.key ? null : current);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [sessionId, snapshotKey]);

  return visible?.sessionId === sessionId ? visible : null;
}

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

function PromptExcerpt({ text }: { text: string }) {
  return (
    <div className="mobile-island-prompt">
      <span className="mobile-island-prompt-label">{tr("mobile.island.prompt")}</span>
      <p>{promptExcerpt(text, 140)}</p>
    </div>
  );
}

function TaskMark({ status }: { status: IslandTask["status"] }) {
  if (status === "done") return <span className="mobile-task-mark done" aria-hidden="true"><Icon.check /></span>;
  if (status === "failed") return <span className="mobile-task-mark failed" aria-hidden="true">×</span>;
  if (status === "active") return <span className="mobile-task-mark active" aria-hidden="true"><i /></span>;
  return <span className="mobile-task-mark pending" aria-hidden="true" />;
}

function progressStep(tasks: IslandTask[]): number {
  const active = tasks.findIndex((task) => task.status === "active");
  if (active >= 0) return active + 1;
  const pending = tasks.findIndex((task) => task.status === "pending");
  if (pending >= 0) return pending + 1;
  return tasks.length;
}

function IslandOverview({
  sessionTitle,
  prompt,
  tasks,
  requests,
  recent,
  events,
  onClose,
}: {
  sessionTitle: string;
  prompt: string | undefined;
  tasks: IslandTask[];
  requests: IslandItem[];
  recent: SessionProjection[];
  events: Record<string, readonly SessionEvent[] | undefined>;
  onClose: () => void;
}) {
  const actionNeededCopy = tr("mobile.island.requests");
  const actionNeededLabel = actionNeededCopy === "Requests" ? "Action needed" : actionNeededCopy;
  const progressCopy = tr("mobile.island.tasks");
  const progressLabel = progressCopy === "Tasks" ? "Progress" : progressCopy;
  const currentStep = progressStep(tasks);

  return (
    <Sheet
      title={tr("mobile.island.overview")}
      origin="top"
      className="mobile-island-sheet"
      onClose={onClose}
    >
      {(sessionTitle || prompt) && (
        <div className="mobile-island-now">
          {sessionTitle && <div className="mobile-island-session">{sessionTitle}</div>}
          {prompt && <PromptExcerpt text={prompt} />}
        </div>
      )}

      {requests.length > 0 && (
        <SheetSection title={`${actionNeededLabel} · ${formatNumber(requests.length)}`}>
          <ul className="mobile-task-list mobile-action-needed-list">
            {requests.map((request) => (
              <li key={request.id} className="request">
                <span className={`mobile-island-dot ${request.tone ?? request.kind}`} aria-hidden="true" />
                <span className="mobile-task-text">{request.text}</span>
              </li>
            ))}
          </ul>
        </SheetSection>
      )}

      {tasks.length > 0 && (
        <SheetSection title={`${progressLabel} · ${formatNumber(currentStep)}/${formatNumber(tasks.length)}`}>
          <ul className="mobile-task-list mobile-progress-list">
            {tasks.map((task) => (
              <li key={task.id} className={task.status}>
                <TaskMark status={task.status} />
                <span className="mobile-task-text">{task.text}</span>
              </li>
            ))}
          </ul>
        </SheetSection>
      )}

      {recent.length > 0 && (
        <SheetSection title={tr("mobile.island.recent")}>
          {recent.map((item) => {
            const itemStatus = resolveSessionStatus(item);
            const itemTitle = sessionTitleOf(item, events);
            const rowLabel = [
              itemTitle,
              itemStatus.label,
              eventsHaveCodeChanges(events[item.id]) ? tr("mobile.island.codeChanged") : "",
            ].filter(Boolean).join(", ");
            return (
              <SheetRow
                key={item.id}
                title={itemTitle}
                icon={<SessionLiveIcon status={itemStatus} />}
                ariaLabel={rowLabel}
                onClick={() => {
                  void openSession(item.id);
                  onClose();
                }}
              />
            );
          })}
        </SheetSection>
      )}
    </Sheet>
  );
}

export function Tools({ onClose }: { onClose: () => void }) {
  return <WorkspacePanel onClose={onClose} />;
}

/** Phone navigation is intentionally a small overlay, not a second application header. */
export default function MobileSessionHeader() {
  const projectId = useStore(workspaceProjectId);
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const events = useStore((state) => state.events);
  const sessions = useStore((state) => state.sessions);
  const session = useStore((state) => state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const model = useActiveModel();
  const models = useStore((state) => state.models);
  const ui = useUiSettings();
  const capabilities = useResolvedCapabilities();
  const workspaceNav = useMobileWorkspaceNavigation();
  const [surface, setSurface] = useState<"island" | null>(null);
  const title = session
    ? displaySessionTitle(session.title, session.id, firstUserTextCached(events[session.id]))
    : tr("mobile.island.newChat");
  const prompt = lastUserTextCached(session ? events[session.id] : undefined);

  const recent = useMemo(
    () => recentSessionsForIsland(sessions, session?.id),
    [sessions, session?.id],
  );
  const unresolvedTitleIds = useMemo(
    () => recent
      .filter((item) => isPlaceholderTitle(item.title, item.id)
        && (item.lastTurnAt !== undefined || item.status !== "idle"))
      .map((item) => item.id),
    [recent],
  );
  const unresolvedTitleIdsRef = useRef<readonly string[]>(unresolvedTitleIds);
  const peers = useMemo(
    () => notablePeers(sessions, session?.id, events),
    [sessions, session?.id, events],
  );

  useEffect(() => {
    for (const peer of peers) prefetchSessionTail(peer.id);
    for (const item of recent) prefetchSessionTail(item.id);
  }, [peers, recent]);

  useEffect(() => {
    unresolvedTitleIdsRef.current = unresolvedTitleIds;
  }, [unresolvedTitleIds]);

  useEffect(() => {
    if (surface !== "island" || !projectId) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      // Projections carry native/generated titles; passive tails cover the
      // short interval where a new background session has a durable prompt
      // but its semantic title is still pending. Recursive scheduling avoids
      // overlapping reads on slow mobile links.
      await Promise.allSettled([
        refreshSessions(projectId),
        ...unresolvedTitleIdsRef.current.map((id) => pollSessionTail(id)),
      ]);
      if (!disposed) timer = window.setTimeout(() => void poll(), SESSION_TITLE_POLL_MS);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [surface, projectId]);

  const labels = useMemo(() => ({
    task: tr("mobile.island.kindTask"),
    request: tr("mobile.island.kindRequest"),
    session: tr("mobile.island.kindSession"),
    peer: tr("mobile.island.kindPeer"),
    working: tr("mobile.island.working"),
    newChat: tr("mobile.island.newChat"),
  }), []);

  const overviewTasks = tasksForIsland(model.tasks, model.messages);
  const taskProgressTitle = useTaskProgressTitle(session?.id, overviewTasks);
  const displayedTitle = taskProgressTitle?.text ?? title;
  const items = buildIslandItems({
    sessionTitle: title,
    hasSession: session !== null,
    tasks: overviewTasks,
    permissions: model.permissions,
    questions: model.questions,
    secrets: model.secrets,
    peers,
    labels,
  });
  const requests = items.filter((item) => item.kind === "request");
  const sessionStatus = session ? resolveSessionStatus(session) : null;
  const runtimeFeatures = useStore((state) => session?.id ? state.runtimeFeatures[session.id] : undefined);
  const activeModel = model.contextUsage?.model ?? model.turn?.model ?? session?.model;
  const descriptor = activeModel
    ? models.find((item) => item.providerID === activeModel.providerID && item.modelID === activeModel.modelID)
    : undefined;
  const telemetryStatus = contextTelemetryStatus(runtimeFeatures?.telemetry);
  const gauge = contextGaugeForTelemetry(model, descriptor?.context, session?.contextWindow ?? null, telemetryStatus);

  const openWorkspaceNavigation = () => {
    setSurface(null);
    const remembered = workspaceNav.lastPackageId;
    const capability = remembered
      ? capabilities.find(({ descriptor: capabilityDescriptor }) => capabilityDescriptor.id === remembered && capabilityDescriptor.available())
      : undefined;
    if (capability) {
      hideMobileWorkspaceHome();
      capability.descriptor.open();
      return;
    }
    showMobileWorkspaceHome();
  };

  return <>
    <div className="mobile-session-floats" aria-label="Workspace navigation">
      <GlassIsland className="mobile-float-navigation">
        <IconButton icon={MenuIcon} label="Open navigation" size="lg" variant="ghost" aria-expanded={sidebarOpen} onClick={() => {
          hideMobileWorkspaceHome();
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
          <span
            key={taskProgressTitle?.key ?? `title:${session?.id ?? "new"}`}
            className={`mobile-island-text${taskProgressTitle ? ` task-progress ${taskProgressTitle.tone}` : ""}`}
          >{displayedTitle}</span>
          <Icon.chevronDown />
        </button>
        {taskProgressTitle && <span className="sr-only" role="status" aria-live="polite">{displayedTitle}</span>}
      </GlassIsland>
      <GlassIsland className="mobile-float-actions">
        <IconButton icon={ComposeIcon} label="New session" size="lg" variant="ghost" disabled={!projectId} onClick={() => {
          hideMobileWorkspaceHome();
          if (projectId) startNewSession(projectId);
        }} />
        <IconButton icon={LayersIcon} label="Open tools" size="lg" variant="ghost" aria-expanded={workspaceNav.homeOpen} onClick={openWorkspaceNavigation} />
      </GlassIsland>
    </div>
    {surface === "island" && (
      <IslandOverview
        sessionTitle={title}
        prompt={prompt}
        tasks={overviewTasks}
        requests={requests}
        recent={recent}
        events={events}
        onClose={() => setSurface(null)}
      />
    )}
    {workspaceNav.homeOpen && <Tools onClose={hideMobileWorkspaceHome} />}
  </>;
}
