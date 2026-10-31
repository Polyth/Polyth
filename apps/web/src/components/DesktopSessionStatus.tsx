import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { SessionMentionCandidateDto } from "@polyth/contracts";
import { draftTitleSource } from "../sessionDraft.ts";
import { resolveModelContextLimit } from "@polyth/contracts/model-context";
import { resolveModelPresentation } from "@polyth/contracts/model-presentation";
import { displayWideSessionTitle } from "../format.ts";
import { openSession, prefetchSessionTail } from "../init.ts";
import { tr } from "../i18n/index.ts";
import {
  recentSessionsForIsland,
  sessionTitleOf,
  tasksForIsland,
  type IslandTask,
} from "../mobileIsland.ts";
import {
  deriveTaskProgressEvent,
  taskProgressSnapshot,
  taskProgressSnapshotKey,
  type TaskProgressEvent,
} from "../mobileTaskProgress.ts";
import { resolveSessionStatus } from "../sessionStatus.ts";
import { sessionOverviewMode } from "../sessionOverviewMode.ts";
import { useActiveModel, usePendingSends, overlaySessionProjection, useStore } from "../store.ts";
import { firstUserTextCached, lastUserTextCached } from "../utils.ts";
import { Icon } from "../icons.tsx";
import SessionActivityDetails from "./SessionActivityDetails.tsx";
import { SessionSharingLine } from "./ShareSessionDialog.tsx";
import { candidateName, useSessionPeople } from "../sessionPeople.ts";
import { assignPersonTones } from "../personIdentity.ts";
import { activeBrowserAccountId } from "../accountStorage.ts";
import { Popover } from "./ui/index.ts";
import {
  contextGaugeForTelemetry,
  contextTelemetryNotice,
  contextTelemetryStatus,
  formatContextPercent,
} from "../reduce.ts";
import { useShellMode } from "../responsiveShell.ts";
import { SessionQuickAccessSheet } from "./mobile/MobileSessionHeader.tsx";
import { MobileStatusIcon } from "./mobile/MobileStatusIcon.tsx";
import {
  closeSessionStatusPopover,
  toggleSessionStatusPopover,
  useSessionStatusPopover,
} from "../sessionStatusPopover.ts";
import "./ConversationProgress.css";

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

/** Width of the chat column in the window the overview opens from: the
 *  conversation holding the opener (the composer's status dock), else the
 *  chat under the header title. The column is the timeline's content box. */
function useOpenerColumnWidth(open: boolean, anchor: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const conversation = anchor?.closest(".focus-conversation") ?? document.querySelector(".main .focus-conversation");
    const timeline = conversation?.querySelector<HTMLElement>(".timeline");
    if (!timeline) {
      setWidth(null);
      return;
    }
    const measure = () => {
      const style = getComputedStyle(timeline);
      const column = timeline.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      setWidth(column > 0 ? Math.round(column) : null);
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(timeline);
    return () => observer.disconnect();
  }, [open, anchor]);
  return width;
}

/** The centered desktop session overview. Task transitions temporarily borrow
 * the title so progress never has to jump around inside the conversation.
 * The popover can also open from the above-composer agent status dock. */
export default function DesktopSessionStatus({
  showTrigger = true,
  trailing,
  caption,
}: {
  showTrigger?: boolean;
  trailing?: ReactNode;
  /** Small context line above the title (the project on tablet widths). */
  caption?: string | undefined;
} = {}) {
  const headerRef = useRef<HTMLButtonElement>(null);
  const overlayAnchorRef = useRef<HTMLElement | null>(null);
  const overlay = useSessionStatusPopover();
  overlayAnchorRef.current = overlay.anchor ?? headerRef.current;
  const fromDock = overlay.source === "dock";
  const shellMode = useShellMode();
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
    firstUserTextCached(events[session.id]) ?? draftTitleSource(session),
  ) : "";
  const tasks = tasksForIsland(model.tasks, model.messages);
  const taskProgressTitle = useTaskProgressTitle(session?.id, tasks);
  const displayedTitle = taskProgressTitle?.text ?? title;
  const prompt = lastUserTextCached(session ? events[session.id] : undefined);
  const pendingModel = pendingSends[pendingSends.length - 1]?.model;
  const activeModel = pendingModel ?? model.contextUsage?.model ?? model.turn?.model ?? session?.model;
  const descriptor = resolveModelPresentation(activeModel, models, session?.resolvedHarnessId).descriptor;
  const contextTokens = resolveModelContextLimit(
    activeModel,
    models,
    session?.resolvedHarnessId,
  );
  const telemetryStatus = contextTelemetryStatus(runtimeFeatures?.telemetry);
  const occupancy = session?.contextWindow;
  const gauge = contextGaugeForTelemetry(model, contextTokens,
    occupancy && pendingModel ? { ...occupancy, model: model.turn?.model ?? sessionRecord?.model } : occupancy ?? null, telemetryStatus,
    { model: activeModel, harnessId: session?.resolvedHarnessId });
  const contextPercent = formatContextPercent(gauge);
  const contextNotice = contextTelemetryNotice(telemetryStatus, gauge);
  const modelName = descriptor?.name ?? activeModel?.modelID ?? null;
  const sessionIdRef = useRef(activeSessionId);
  const columnWidth = useOpenerColumnWidth(overlay.open && shellMode === "wide", overlay.anchor);

  useEffect(() => {
    if (sessionIdRef.current === activeSessionId) return;
    sessionIdRef.current = activeSessionId;
    closeSessionStatusPopover();
  }, [activeSessionId]);

  useEffect(() => {
    if (shellMode === "wide" || !overlay.open) return;
    for (const item of recent) prefetchSessionTail(item.id);
  }, [shellMode, overlay.open, recent]);

  const conversationPeople = useSessionPeople(session?.purpose === "conversation" ? session.id : null);
  const peopleTones = useMemo(
    () => assignPersonTones([activeBrowserAccountId(), ...conversationPeople.map((person) => person.userId)]),
    [conversationPeople],
  );

  if (!session || !status) return null;

  // A conversation has no agent and no runtime, so its header keeps the title
  // and nothing else: no status trigger, model/context overview or recent-run
  // list that would only describe work this session cannot do.
  if (session.purpose === "conversation") {
    if (!showTrigger) return null;
    return <div className="desktop-session-status desktop-session-status--conversation">
      <div className="desktop-session-status-row">
        <div className="desktop-session-status-trigger">
          <span className="desktop-session-status-mask">
            {conversationPeople.length > 0
              ? <span className="desktop-session-status-caption"><PeopleCaption people={conversationPeople} tones={peopleTones} /></span>
              : caption && <span className="desktop-session-status-caption">{caption}</span>}
            <span className="desktop-session-status-copy"><span>{title}</span></span>
          </span>
        </div>
      </div>
    </div>;
  }

  const overview = (shellMode === "compact" || shellMode === "phone")
    ? (overlay.open ? (
      <SessionQuickAccessSheet
        fullScreen={sessionOverviewMode(false, overlay) === "full"}
        activeSession={session}
        gauge={gauge}
        contextPercent={contextPercent}
        contextNotice={contextNotice}
        modelName={modelName}
        model={model}
        sessionTitle={title}
        prompt={prompt}
        tasks={tasks}
        requests={[]}
        recent={recent}
        events={events}
        onClose={closeSessionStatusPopover}
      />
    ) : null)
    : (
    <Popover
      open={overlay.open}
      onClose={closeSessionStatusPopover}
      anchorRef={overlayAnchorRef}
      className="desktop-session-status-surface"
      style={columnWidth ? { "--session-status-column": `${columnWidth}px` } as CSSProperties : undefined}
      align="center"
      side={fromDock ? "up" : "down"}
      ariaLabel={tr("mobile.island.overview")}
    >
      <div className="desktop-session-status-popover">
        <header>
          <button
            type="button"
            className="desktop-session-status-active-btn"
            aria-label={`${title}, ${status.label}`}
            onClick={() => {
              if (session) void openSession(session.id);
              closeSessionStatusPopover();
            }}
          >
            <span className={`desktop-session-status-icon ${status.kind}`} aria-hidden="true">
              <MobileStatusIcon kind={status.kind} />
            </span>
            <div className="desktop-session-status-active-copy">
              <strong>{title}</strong>
              <small>{status.label}</small>
            </div>
          </button>
          <SessionSharingLine session={session} onOpen={closeSessionStatusPopover} />
        </header>
        <SessionActivityDetails
          sessionTitle={title}
          showIdentity={false}
          prompt={prompt}
          modelName={modelName}
          tasks={tasks}
          session={session}
          model={model}
          usageEvents={events[session.id]}
          gauge={gauge}
          contextNotice={contextNotice}
        />
        <section>
          <h3>{tr("sessionStatus.recentSessions")}</h3>
          {recent.length > 0 ? <ul>{recent.map((item) => {
            const itemStatus = resolveSessionStatus(item);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    void openSession(item.id);
                    closeSessionStatusPopover();
                  }}
                >
                  <span className={`desktop-session-status-icon ${itemStatus.kind}`} aria-hidden="true">
                    <MobileStatusIcon kind={itemStatus.kind} />
                  </span>
                  <span>{sessionTitleOf(item, events)}</span>
                  <small>{itemStatus.label}</small>
                </button>
              </li>
            );
          })}</ul> : <p>{tr("sessionStatus.noRecentSessions")}</p>}
        </section>
      </div>
    </Popover>
  );

  if (!showTrigger) return overview;

  return <div className="desktop-session-status">
    <div className="desktop-session-status-row">
      <button
        ref={headerRef}
        type="button"
        className="desktop-session-status-trigger header-control"
        aria-label={tr("sessionStatus.sessionStatusValue", { title, status: status.label })}
        aria-expanded={overlay.open}
        aria-haspopup="dialog"
        title={status.label}
        onClick={() => toggleSessionStatusPopover(headerRef.current, "header")}
      >
        <span className="desktop-session-status-mask">
          {caption && <span className="desktop-session-status-caption">{caption}</span>}
          <span
            key={taskProgressTitle?.key ?? `title:${session.id}`}
            className={`desktop-session-status-copy${taskProgressTitle ? ` task-progress ${taskProgressTitle.tone}` : ""}`}
          ><span>{displayedTitle}</span></span>
        </span>
        <span className="desktop-session-status-end">
          {trailing}
          <Icon.chevronDown />
        </span>
      </button>
    </div>
    {taskProgressTitle && <span className="sr-only" role="status" aria-live="polite">{displayedTitle}</span>}
    {overview}
  </div>;
}

/** "With Ann, Max": each name in its person's colour, the same colour their
 *  name and monogram wear in the chat, so the header doubles as its legend. */
function PeopleCaption({ people, tones }: { people: readonly SessionMentionCandidateDto[]; tones: ReadonlyMap<string, number> }) {
  const marker = "\u0000";
  const [before = "", after = ""] = tr("conversation.withPeople", { names: marker }).split(marker);
  return <>
    {before}
    {people.map((person, index) => (
      <Fragment key={person.userId}>
        {index > 0 && ", "}
        <bdi className="person-name" data-person-tone={tones.get(person.userId)}>{candidateName(person)}</bdi>
      </Fragment>
    ))}
    {after}
  </>;
}
