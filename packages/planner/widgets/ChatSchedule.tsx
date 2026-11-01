// A chat's own schedule, shown in that chat. While anything is planned to
// arrive here, one quiet line above the composer says when the next run comes
// and what it is; it opens upward into the chat's planned tasks with their
// actions, the line itself staying under the pointer. Each run that arrived
// is a timeline fact just before its prompt. Times and words are the
// Planner's own; the Planner pane stays the place to edit a task.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { SessionEvent } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";
import {
  ChevronUpIcon,
  DeleteIcon,
  ExternalLinkIcon,
  Icon,
  IconButton,
  Menu,
  MoreIcon,
  PauseIcon,
  PlayIcon,
  ScheduleIcon,
  WarningIcon,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import type { PlannerTask } from "../src/model.ts";
import { PLANNER_PACKAGE_ID } from "../src/packageId.ts";
import { chatSchedule, plannerTaskRunning } from "../src/chatSchedule.ts";
import { taskDisplayTitle } from "../src/plannerList.ts";
import { cadenceOfTask } from "../src/plannerTask.ts";
import { deleteTask, runTask, setTaskPaused } from "./plannerActions.ts";
import { cadenceSummary, formatClockAt, formatRunDay, formatRunWhen } from "./plannerFormat.ts";
import { openPlannerTask } from "./plannerOpen.ts";
import { acceptPlannerTask, ensurePlannerTasks, requestPlannerRefresh, usePlannerTasks } from "./plannerTasks.ts";
import { t, usePlannerLocale } from "./plannerText.ts";

/** The clock the line reads: every 15 s while the next run is within the
 *  hour (it says "in 12 minutes"), every minute otherwise. */
function useNow(nextRunAt: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const soon = nextRunAt !== null && nextRunAt !== undefined && nextRunAt - now < 3_600_000;
  useEffect(() => {
    if (nextRunAt === null || nextRunAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), soon ? 15_000 : 60_000);
    return () => clearInterval(timer);
  }, [nextRunAt, soon]);
  return now;
}

function TaskRow({ host, task, now, locale }: { host: WebPackageHost; task: PlannerTask; now: number; locale: string }) {
  const [busy, setBusy] = useState(false);
  const title = taskDisplayTitle(task);
  const running = plannerTaskRunning(task);
  const upcoming = task.enabled && task.nextRunAt !== null;
  const act = async (work: () => Promise<PlannerTask | undefined>) => {
    setBusy(true);
    const updated = await work();
    setBusy(false);
    if (updated) acceptPlannerTask(updated);
    requestPlannerRefresh();
  };
  const entries: MenuEntry[] = [
    { id: "run", label: t("action.runNow"), icon: PlayIcon, onSelect: () => void act(() => runTask(task)) },
    {
      id: "toggle",
      label: task.enabled ? t("action.pause") : t("action.resume"),
      icon: task.enabled ? PauseIcon : PlayIcon,
      onSelect: () => void act(() => setTaskPaused(task, task.enabled)),
    },
    { id: "open", label: t("chat.openTask"), icon: ExternalLinkIcon, onSelect: () => openPlannerTask(host, task.id) },
    "separator",
    {
      id: "delete",
      label: t("action.delete"),
      icon: DeleteIcon,
      danger: true,
      onSelect: () => void deleteTask(task).then((ok) => {
        if (ok) acceptPlannerTask(task, true);
        requestPlannerRefresh();
      }),
    },
  ];
  return (
    <li className="planner-chat-task" data-state={running ? "running" : upcoming ? "upcoming" : "idle"} aria-busy={busy || undefined}>
      <span className="planner-chat-task-when">
        {upcoming
          ? <><span className="planner-chat-task-day">{formatRunDay(task.nextRunAt!, now, locale)}</span><strong>{formatClockAt(task.nextRunAt!, locale)}</strong></>
          : <span className="planner-chat-task-day">{task.enabled ? t("list.noNextRun") : t("list.paused")}</span>}
      </span>
      <button type="button" className="planner-chat-task-main" title={task.prompt} onClick={() => openPlannerTask(host, task.id)}>
        <bdi className="planner-chat-task-title">{title}</bdi>
        <span className="planner-chat-task-meta">
          {running && <span className="planner-chat-live"><i aria-hidden="true" />{t("list.running")}</span>}
          {/* The time stands in its own column: the cadence names only the rhythm. */}
          <span>{cadenceSummary(cadenceOfTask(task), locale, true)}</span>
          {task.lastError && !running && (
            <span className="planner-chat-task-error" title={task.lastError}>
              <Icon icon={WarningIcon} size="sm" />{t("list.lastFailed")}
            </span>
          )}
        </span>
      </button>
      <span className="planner-chat-task-tools">
        {upcoming && (
          <IconButton className="planner-chat-task-run" icon={PlayIcon} size="sm" label={t("action.runNow")} busy={busy} onClick={() => void act(() => runTask(task))} />
        )}
        <Menu label={t("list.taskActions")} align="end" entries={entries}>
          {(trigger) => <IconButton icon={MoreIcon} size="sm" label={t("list.taskActions")} {...trigger} />}
        </Menu>
      </span>
    </li>
  );
}

/** One line above the composer while the chat has planned runs. */
export function ChatScheduleLine({ host, sessionId }: { host: WebPackageHost; sessionId: string | null }) {
  const locale = usePlannerLocale();
  const { tasks } = usePlannerTasks();
  const schedule = chatSchedule(tasks, sessionId);
  const now = useNow(schedule.next?.nextRunAt);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (sessionId) ensurePlannerTasks(); }, [sessionId]);
  // Nothing left in this chat: the open list goes with the line.
  useEffect(() => { if (schedule.tasks.length === 0) setOpen(false); }, [schedule.tasks.length]);
  // An open list keeps the line while its last upcoming task is paused, so
  // the action does not pull the list out from under the pointer.
  const showing = Boolean(sessionId) && (schedule.upcoming > 0 || (open && schedule.tasks.length > 0));
  const NoticeRow = host.ui.components.ComposerNoticeRow;
  const fold = (isOpen: boolean, children: ReactNode) => NoticeRow ? <NoticeRow open={isOpen}>{children}</NoticeRow> : isOpen ? children : null;

  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !open || event.defaultPrevented) return;
    event.preventDefault();
    close();
  };

  const next = schedule.next;
  const running = schedule.tasks.some(plannerTaskRunning);
  const more = schedule.tasks.length - (next ? 1 : 0);
  const panel = (
    <section id={panelId} className="planner-chat-panel" aria-label={t("chat.title")}>
      <ul className="planner-chat-tasks">
        {schedule.tasks.map((task) => <TaskRow key={task.id} host={host} task={task} now={now} locale={locale} />)}
      </ul>
      <p className="planner-chat-foot">
        <span>{t("chat.explain")}</span>
        <button type="button" className="planner-chat-foot-open" onClick={() => host.navigation.openWorkspacePane(PLANNER_PACKAGE_ID)}>
          {t("chat.openPlanner")}
        </button>
      </p>
    </section>
  );
  const line = (
    <div className="planner-chat" data-open={open || undefined} onKeyDown={onKeyDown}>
      {fold(open && showing, panel)}
      <div className="planner-chat-line" data-running={running || undefined}>
        <button
          ref={toggleRef}
          type="button"
          className="planner-chat-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="planner-chat-mark" aria-hidden="true"><Icon icon={ScheduleIcon} size="md" />{running && <i />}</span>
          {next ? (
            <>
              <span className="sr-only">{t("chat.next")} </span>
              <strong className="planner-chat-when">{formatRunWhen(next.nextRunAt!, now, locale)}</strong>
              <bdi className="planner-chat-title">{taskDisplayTitle(next)}</bdi>
              <span className="planner-chat-cadence">{cadenceSummary(cadenceOfTask(next), locale, true)}</span>
            </>
          ) : (
            <>
              <strong className="planner-chat-when">{t("chat.nothingUpcoming")}</strong>
              <span className="planner-chat-cadence">{t("chat.pausedCount", { count: schedule.idle })}</span>
            </>
          )}
          {next && more > 0 && (
            <span className="planner-chat-more" aria-label={t("chat.moreLabel", { count: more })}>{t("chat.more", { count: more })}</span>
          )}
          <span className="planner-chat-chevron" aria-hidden="true"><Icon icon={ChevronUpIcon} size="sm" /></span>
        </button>
      </div>
    </div>
  );
  return fold(showing, line);
}

interface RunEventData {
  taskId?: unknown;
  taskTitle?: unknown;
  manual?: unknown;
  late?: unknown;
}

/** Where a planned run arrived: a centred line between hairlines, just
 *  before the prompt it sent. The title opens the task while it exists. */
export function PlannedRunFact({ host, event }: { host: WebPackageHost; event: SessionEvent }) {
  const locale = usePlannerLocale();
  const { tasks } = usePlannerTasks();
  const data = (event.data ?? {}) as RunEventData;
  const taskId = typeof data.taskId === "string" ? data.taskId : "";
  if (!taskId) return null;
  const task = tasks?.find((item) => item.id === taskId);
  const title = (typeof data.taskTitle === "string" && data.taskTitle.trim()) || (task ? taskDisplayTitle(task) : "");
  const kind = data.manual === true ? "manual" : data.late === true ? "late" : "planned";
  const label = kind === "manual" ? t("chat.runManual") : kind === "late" ? t("chat.runLate") : t("chat.runPlanned");
  return (
    <div className="planner-run-fact" data-kind={kind} data-msg-id={event.id}>
      <p className="planner-run-fact-line">
        <span className="planner-run-fact-copy" {...(kind === "late" ? { title: t("chat.runLateHint") } : {})}>
          <span className="planner-run-fact-head">
            <span className="planner-run-fact-mark" aria-hidden="true"><Icon icon={ScheduleIcon} size="sm" /></span>
            <strong>{label}</strong>
          </span>
          {/* On a narrow column what ran takes its own line, without a
              separator to start it. */}
          <span className="planner-run-fact-what">
            {title && (task
              ? <button type="button" className="planner-run-fact-title" title={t("chat.openTask")} onClick={() => openPlannerTask(host, task.id)}><bdi>{title}</bdi></button>
              : <bdi className="planner-run-fact-title">{title}</bdi>)}
            <time dateTime={new Date(event.time).toISOString()}>{formatClockAt(event.time, locale)}</time>
          </span>
        </span>
      </p>
    </div>
  );
}
