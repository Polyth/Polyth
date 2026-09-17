import { useEffect, useMemo, useRef, useState } from "react";
import { displayWideSessionTitle, fmtTokens } from "../format.ts";
import { openSession } from "../init.ts";
import { recentSessionsForIsland, sessionTitleOf, tasksForIsland, type IslandTask } from "../mobileIsland.ts";
import {
  deriveTaskProgressEvent,
  taskProgressSnapshot,
  taskProgressSnapshotKey,
  type TaskProgressEvent,
} from "../mobileTaskProgress.ts";
import { resolveSessionStatus } from "../sessionStatus.ts";
import { useActiveModel, usePendingSends, overlaySessionProjection, useStore } from "../store.ts";
import { firstUserTextCached, lastUserTextCached } from "../utils.ts";
import { Icon } from "../icons.tsx";
import { Popover } from "./ui/index.ts";
import {
  contextGaugeForTelemetry,
  contextTelemetryNotice,
  contextTelemetryStatus,
  formatContextPercent,
} from "../reduce.ts";
import { useUiSettings } from "../uiPrefs.ts";
import ContextIndicator from "./ContextIndicator.tsx";
import {
  closeSessionStatusPopover,
  toggleSessionStatusPopover,
  useSessionStatusPopover,
} from "../sessionStatusPopover.ts";
import "./ConversationProgress.css";

const TASK_MARK = { done: "✓", active: "●", failed: "×", pending: "○" } as const;
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
      ? `✓ ${event.completed}/${event.total} complete`
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

/** The centered desktop session overview. Task transitions temporarily borrow
 * the title so progress never has to jump around inside the conversation.
 * The popover can also open from the above-composer agent status dock. */
export default function DesktopSessionStatus({ showTrigger = true }: { showTrigger?: boolean } = {}) {
  const headerRef = useRef<HTMLButtonElement>(null);
  const overlayAnchorRef = useRef<HTMLElement | null>(null);
  const overlay = useSessionStatusPopover();
  overlayAnchorRef.current = overlay.anchor ?? headerRef.current;
  const fromDock = Boolean(overlay.anchor && overlay.anchor !== headerRef.current);
  const ui = useUiSettings();
  const sessions = useStore((state) => state.sessions);
  const events = useStore((state) => state.events);
  const models = useStore((state) => state.models);
  const activeSessionId = useStore((state) => state.activeSessionId);
  const runtimeFeatures = useStore((state) => activeSessionId ? state.runtimeFeatures[activeSessionId] : undefined);
  const sessionRecord = sessions.find((item) => item.id === activeSessionId) ?? null;
  const pendingSends = usePendingSends(activeSessionId);
  const session = overlaySessionProjection(sessionRecord, pendingSends) ?? null;
  const model = useActiveModel();
  const recent = useMemo(() => recentSessionsForIsland(sessions, activeSessionId ?? undefined, 5), [sessions, activeSessionId]);
  const status = session ? resolveSessionStatus(session) : null;
  const title = session ? displayWideSessionTitle(
    session.title,
    session.titleSource,
    session.id,
    firstUserTextCached(events[session.id]),
  ) : "";
  const tasks = tasksForIsland(model.tasks, model.messages);
  const taskProgressTitle = useTaskProgressTitle(session?.id, tasks);
  const displayedTitle = taskProgressTitle?.text ?? title;
  const completedTasks = tasks.filter((task) => task.status === "done").length;
  const failedTasks = tasks.filter((task) => task.status === "failed").length;
  const prompt = lastUserTextCached(session ? events[session.id] : undefined);
  const pendingModel = pendingSends[pendingSends.length - 1]?.model;
  const activeModel = pendingModel ?? model.contextUsage?.model ?? model.turn?.model ?? session?.model;
  const descriptor = activeModel ? models.find((item) => item.providerID === activeModel.providerID && item.modelID === activeModel.modelID) : undefined;
  const telemetryStatus = contextTelemetryStatus(runtimeFeatures?.telemetry);
  const gauge = contextGaugeForTelemetry(model, descriptor?.context, session?.contextWindow ?? null, telemetryStatus);
  const contextPercent = formatContextPercent(gauge);
  const contextNotice = contextTelemetryNotice(telemetryStatus, gauge);
  const sessionIdRef = useRef(activeSessionId);

  useEffect(() => {
    if (sessionIdRef.current === activeSessionId) return;
    sessionIdRef.current = activeSessionId;
    closeSessionStatusPopover();
  }, [activeSessionId]);

  if (!session || !status) return null;

  const popover = (
    <Popover
      open={overlay.open}
      onClose={closeSessionStatusPopover}
      anchorRef={overlayAnchorRef}
      align="center"
      side={fromDock ? "up" : "down"}
      ariaLabel="Session overview"
    >
      <div className="desktop-session-status-popover">
        <header>
          <span className={`desktop-session-status-dot ${status.kind}`} aria-hidden="true" />
          <div><strong>{title}</strong><small>{status.label}</small></div>
        </header>
        <section className="session-context-details">
          <h3>Context{contextPercent ? ` · ${contextPercent}` : ""}</h3>
          <p>{contextNotice ?? (gauge.known
            ? `${fmtTokens(gauge.inputTokens)} / ${fmtTokens(gauge.contextTokens)} tokens`
            : "Model context metadata is unavailable.")}</p>
        </section>
        <section>
          <h3>Tasks{tasks.length > 0 ? ` · ${completedTasks}/${tasks.length} complete${failedTasks > 0 ? ` · ${failedTasks} failed` : ""}` : ""}</h3>
          {tasks.length > 0 ? (
            <ul className="desktop-session-task-list">
              {tasks.map((task) => (
                <li key={task.id} className={task.status}>
                  <span className="desktop-session-task-mark" aria-hidden="true">{TASK_MARK[task.status]}</span>
                  <span>{task.text}</span>
                </li>
              ))}
            </ul>
          ) : <p>No active task plan.</p>}
        </section>
        {prompt && <section><h3>Current intent</h3><p>{prompt}</p></section>}
        <section>
          <h3>Recent sessions</h3>
          {recent.length > 0 ? <ul>{recent.map((item) => {
            const itemStatus = resolveSessionStatus(item);
            return <li key={item.id}><button type="button" onClick={() => { void openSession(item.id); closeSessionStatusPopover(); }}><span className={`desktop-session-status-dot ${itemStatus.kind}`} aria-hidden="true" /><span>{sessionTitleOf(item, events)}</span><small>{itemStatus.label}</small></button></li>;
          })}</ul> : <p>No recent sessions.</p>}
        </section>
      </div>
    </Popover>
  );

  if (!showTrigger) return popover;

  return <div className="desktop-session-status">
    <button
      ref={headerRef}
      type="button"
      className="desktop-session-status-trigger header-control"
      aria-label={`Session: ${title}. Status: ${status.label}`}
      aria-expanded={overlay.open}
      aria-haspopup="dialog"
      title={status.label}
      onClick={() => toggleSessionStatusPopover(headerRef.current)}
    >
      <ContextIndicator gauge={gauge} mode={ui.contextIndicatorMode} providerID={activeModel?.providerID} providerName={descriptor?.providerName} harnessId={descriptor?.harnessId ?? session.resolvedHarnessId} active={status.kind === "working"} telemetryStatus={telemetryStatus} />
      <span className="desktop-session-status-mask">
        <span
          key={taskProgressTitle?.key ?? `title:${session.id}`}
          className={`desktop-session-status-copy${taskProgressTitle ? ` task-progress ${taskProgressTitle.tone}` : ""}`}
        ><span>{displayedTitle}</span></span>
      </span>
      <Icon.chevronDown />
    </button>
    {taskProgressTitle && <span className="sr-only" role="status" aria-live="polite">{displayedTitle}</span>}
    {popover}
  </div>;
}
