import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type DragEvent, type FormEvent,
} from "react";
import type { AttachmentRef } from "@polyth/contracts";
import { api, type AgentRunAttachmentDto, type ScheduleRunDto, type ScheduleTaskDto } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { MarkdownDoc } from "../../../apps/web/src/markdown.tsx";
import { fmtSessionElapsed } from "../../../apps/web/src/format.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import { executionPathParts, executionPresentation } from "../../../apps/web/src/execution.ts";
import ChatActionButton from "../../../apps/web/src/components/ChatActionButton.tsx";
import ActivityTicker, { useTickerKey } from "../../../apps/web/src/components/ActivityTicker.tsx";
import AttachmentPills from "../../../apps/web/src/components/AttachmentPills.tsx";
import { ExecutionIcon } from "../../../apps/web/src/components/ExecutionIcon.tsx";
import {
  BookmarkIcon, Button, ChevronRightIcon, GlassDock, Icon,
  ExternalLinkIcon, SessionIcon, ShieldAlertIcon, TextInput, ThumbsDownIcon, ThumbsUpIcon,
} from "../../../apps/web/src/components/ui/index.ts";
import { AgentMark } from "./AgentGlyph.tsx";
import { tokenTotal } from "../src/agentPrompt.ts";
import { newestReportAt, shortDuration, type AgentLive } from "./agentLive.ts";
import { agentName } from "./agentActions.ts";
import { useNow } from "./agentClock.ts";
import { optimistic, refreshAgents } from "./agentsStore.ts";
import AgentComposer, { type AgentMessage, type DroppedFiles } from "./AgentComposer.tsx";
import {
  carries, conversationDays, dayItems, queues,
  type ConversationThread, type PendingMessage, type ThreadOpening,
} from "./agentThreads.ts";

export { conversationDays } from "./agentThreads.ts";
export type { ConversationDay, ConversationItem, ConversationThread } from "./agentThreads.ts";

const UNITS = () => ({ s: tr("agents.unitSeconds"), min: tr("agents.unitMinutes"), h: tr("agents.unitHours") });
const timeOf = (at: number): string =>
  new Date(at).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });

/** "Today", "Yesterday", or "Mon, 12 Oct". */
export function dayLabel(at: number, now = Date.now()): string {
  const locale = getLocale();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - at) / (24 * 60 * 60_000));
  if (days === 0 || days === 1) {
    const text = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-days, "day");
    return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
  }
  return new Date(at).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
}

/** "26 Oct, 08:20" (or just the time today). */
function momentOf(at: number, now = Date.now()): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (at >= today.getTime()) return timeOf(at);
  const date = new Date(at).toLocaleDateString(getLocale(), { day: "numeric", month: "short" });
  return `${date}, ${timeOf(at)}`;
}

function triggerLabel(run: ScheduleRunDto): string {
  if (run.trigger === "heartbeat") return tr("agents.triggerHeartbeat");
  if (run.trigger === "event") return tr("agents.eventRun");
  if (run.trigger === "manual") return run.input || run.attachments?.length ? tr("agents.answerToYou") : tr("agents.manualRun");
  return tr("agents.triggerSchedule");
}

type Signal = "alert" | "update" | "failed" | "unknown" | "stopped";
function signalOf(run: ScheduleRunDto): Signal {
  if (run.stopped && run.status !== "ok") return "stopped";
  if (run.status === "failed") return "failed";
  if (run.status === "unknown") return "unknown";
  return run.signal === "alert" ? "alert" : "update";
}

function headlineOf(run: ScheduleRunDto): string {
  if (run.headline) return run.headline;
  if (run.stopped && run.status !== "ok") return tr("agents.stoppedByYou");
  // The error itself reads as a detail under the plain words.
  if (run.status === "failed") return tr("agents.runFailedTitle");
  if (run.status === "unknown") return tr("agents.runUnknown");
  const first = run.summary?.split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "").trim();
  return first || tr("agents.runOk");
}

/** The files of a message as read-only pills. */
const pillsOf = (files: readonly AgentRunAttachmentDto[], key: string): AttachmentRef[] =>
  files.map((file, index) => ({
    id: `${key}-${index}`,
    name: file.name,
    mime: file.mime,
    size: file.size,
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.path ? { path: file.path } : {}),
  }));

// ---- pieces ------------------------------------------------------------------------

function Feedback({ run, onFeedback }: {
  run: ScheduleRunDto;
  onFeedback: (runId: string, verdict: "up" | "down" | null, note?: string) => Promise<void>;
}) {
  const verdict = run.feedback?.verdict;
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(run.feedback?.note ?? "");
  const [busy, setBusy] = useState(false);
  const send = async (next: "up" | "down" | null, text?: string) => {
    setBusy(true);
    try { await onFeedback(run.runId, next, text); } finally { setBusy(false); }
  };
  return (
    <>
      <ChatActionButton
        icon={ThumbsUpIcon}
        label={tr("agents.useful")}
        pressed={verdict === "up"}
        disabled={busy}
        onClick={() => void send(verdict === "up" ? null : "up")}
      />
      <ChatActionButton
        icon={ThumbsDownIcon}
        label={tr("agents.notUseful")}
        pressed={verdict === "down"}
        disabled={busy}
        onClick={() => {
          if (verdict === "down") {
            setNoteOpen(false);
            void send(null);
          } else {
            setNoteOpen(true);
            void send("down");
          }
        }}
      />
      {verdict && (
        <span className="agent-report-heard">
          {run.feedback?.delivered ? tr("agents.feedbackHeard") : tr("agents.feedbackPending")}
        </span>
      )}
      {noteOpen && (
        <form
          className="agent-report-note"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void send("down", note.trim() || undefined).then(() => setNoteOpen(false));
          }}
        >
          <TextInput
            uiSize="sm"
            value={note}
            maxLength={500}
            aria-label={tr("agents.feedbackPlaceholder")}
            placeholder={tr("agents.feedbackPlaceholder")}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button size="sm" type="submit" disabled={busy}>{tr("agents.feedbackSave")}</Button>
        </form>
      )}
    </>
  );
}

/** A long report stays folded to a few lines until asked. */
const LONG_BODY = 900;

/** What a run said: the agent speaking, on the conversation's spine. */
function Report({ task, run, onFeedback }: {
  task: ScheduleTaskDto;
  run: ScheduleRunDto;
  onFeedback: (runId: string, verdict: "up" | "down" | null, note?: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const signal = signalOf(run);
  const headline = headlineOf(run);
  const body = run.summary?.trim() ?? "";
  // The headline came from the body's first line: never twice.
  const shownBody = !run.headline && body.split("\n")[0]?.replace(/^#+\s*/, "").trim() === headline
    ? body.split("\n").slice(1).join("\n").trim()
    : body;
  const long = shownBody.length > LONG_BODY || shownBody.split("\n").length > 14;
  const tokens = tokenTotal(run.tokens);
  const took = run.finishedAt ? shortDuration(run.finishedAt - run.startedAt, UNITS()) : null;
  const facts = [
    took,
    tokens > 0 ? tr("agents.tokensValue", { count: tokens.toLocaleString(getLocale()) }) : null,
    run.cost !== undefined && run.cost > 0 ? `$${run.cost.toFixed(run.cost < 0.1 ? 3 : 2)}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="agent-turn agent-report" data-signal={signal}>
      <span className="agent-spine-node" aria-hidden="true" />
      <header className="agent-report-meta">
        <time dateTime={new Date(run.startedAt).toISOString()}>{timeOf(run.startedAt)}</time>
        <span>{triggerLabel(run)}</span>
        {signal === "alert" && <span className="agent-report-signal" data-signal="alert">{tr("agents.signalAlert")}</span>}
        {signal === "failed" && run.headline && <span className="agent-report-signal" data-signal="failed">{tr("agents.runFailed")}</span>}
        {run.late && <span>{tr("agents.lateRun")}</span>}
        {run.backup ? <span>{tr("agents.ranOnBackupValue", { count: run.backup })}</span> : null}
        {facts && <span className="agent-report-facts">{facts}</span>}
      </header>
      <h3 className="agent-report-headline">{headline}</h3>
      {run.note || run.events?.length ? (
        <ul className="agent-report-events">
          {/* The wake script's words, which may quote event data: what woke
              the agent, never the person speaking. */}
          {run.note && <li className="agent-report-wake-note" title={run.note}>{tr("agents.wakeNoteValue", { note: run.note })}</li>}
          {(run.events ?? []).slice(0, 3).map((line, index) => <li key={index}>{line}</li>)}
          {(run.events?.length ?? 0) > 3 && <li>{tr("agents.moreEventsValue", { count: run.events!.length - 3 })}</li>}
        </ul>
      ) : null}
      {shownBody && (
        <div className="msg assistant agent-report-body" data-folded={long && !expanded ? "" : undefined}>
          <div className="bubble">
            <MarkdownDoc
              text={shownBody}
              keyBase={`agent-${run.runId}`}
              resourceContext={{ projectId: task.projectId, sessionId: run.sessionId ?? null }}
            />
          </div>
        </div>
      )}
      {long && (
        <button type="button" className="agent-report-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? tr("agents.showLess") : tr("agents.showMore")}
        </button>
      )}
      {run.error && signal !== "stopped" && <p className="agent-report-error">{run.error}</p>}
      {run.remembered?.length ? (
        <ul className="agent-report-notes" aria-label={tr("agents.remembered")}>
          {run.remembered.map((note) => (
            <li key={note}>
              <Icon icon={BookmarkIcon} size="sm" />
              <span>{tr("agents.rememberedValue", { note })}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {run.status === "ok" && (
        <footer className="agent-report-foot">
          <Feedback run={run} onFeedback={onFeedback} />
        </footer>
      )}
    </li>
  );
}

function YouBubble({ id, text, at, pending, attachments, attachmentCount }: {
  id: string;
  text: string;
  at: number;
  pending?: "sending" | "queued";
  attachments?: readonly AgentRunAttachmentDto[];
  attachmentCount?: number;
}) {
  const meta = pending === "sending" ? tr("agents.sending")
    : pending === "queued" ? tr("agents.queuedAfterRun")
      : timeOf(at);
  return (
    <li className="agent-turn msg user agent-you" data-pending={pending}>
      {text && <div className="bubble">{text}</div>}
      {attachments?.length ? (
        <div className="agent-you-files"><AttachmentPills attachments={pillsOf(attachments, id)} /></div>
      ) : attachmentCount ? (
        <span className="agent-you-meta">{tr("agents.filesCountValue", { count: attachmentCount })}</span>
      ) : null}
      <span className="agent-you-meta">{meta}</span>
    </li>
  );
}

function QuietFold({ runs }: { runs: ScheduleRunDto[] }) {
  const [open, setOpen] = useState(false);
  const first = runs[0]!;
  const last = runs.at(-1)!;
  const skipped = runs.filter((run) => run.status === "skipped").length;
  const checks = runs.length - skipped;
  const range = runs.length > 1 ? `${timeOf(first.startedAt)}–${timeOf(last.startedAt)}` : timeOf(first.startedAt);
  const label = [
    checks ? tr("agents.quietChecksValue", { count: checks }) : "",
    skipped ? tr("agents.skippedCountValue", { count: skipped }) : "",
  ].filter(Boolean).join(" · ");
  return (
    <li className="agent-turn agent-quiet" data-open={open || undefined}>
      <button type="button" className="agent-quiet-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon icon={ChevronRightIcon} size="sm" className="agent-quiet-chevron" />
        <span>{label}</span>
        <time>{range}</time>
      </button>
      {open && (
        <ol className="agent-quiet-list">
          {runs.map((run) => (
            <li key={run.runId}>
              <time dateTime={new Date(run.startedAt).toISOString()}>{timeOf(run.startedAt)}</time>
              <span>{run.status === "skipped" ? run.error ?? tr("agents.runSkipped") : run.summary?.split("\n")[0] || tr("agents.signalQuiet")}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

/** One step's words, as the chat's live line says them. */
function StepWords({ run, projectRoot }: { run: ScheduleRunDto; projectRoot: string | null }) {
  const activity = run.activity;
  if (!activity) {
    return <span className="agent-live-step"><strong>{run.sessionId ? tr("agents.liveStarting") : tr("agents.liveWaitingTurn")}</strong></span>;
  }
  if (activity.kind === "tool" && activity.tool) {
    const presentation = executionPresentation({ tool: activity.tool, input: activity.input ?? {} });
    const parts = presentation.path ? executionPathParts(presentation.path, projectRoot) : undefined;
    const title = parts?.filename ?? presentation.label;
    const preview = parts ? [presentation.label, parts.directory].filter(Boolean).join(" · ") : presentation.preview;
    return (
      <span className="agent-live-step">
        <span className="agent-live-glyph" aria-hidden="true"><ExecutionIcon kind={presentation.kind} {...(presentation.mcp?.icon ? { mcp: presentation.mcp.icon } : {})} /></span>
        <strong>{title}</strong>
        {preview && <span className="agent-live-preview">{preview}</span>}
      </span>
    );
  }
  return (
    <span className="agent-live-step">
      <strong>{activity.kind === "thinking" ? tr("agents.liveThinking") : tr("agents.liveWriting")}</strong>
      {activity.text && <span className="agent-live-preview">{activity.text}</span>}
    </span>
  );
}

/** The run working now, at the end of its conversation: what it is doing,
 *  step by step, and for how long. */
function LiveTurn({ agent, run, onOpenSession }: {
  agent: ScheduleTaskDto;
  run: ScheduleRunDto;
  onOpenSession?: (sessionId: string) => void;
}) {
  const now = useNow(true);
  const projectRoot = useStore((state) => state.projectRegistry.projects.find((project) => project.id === agent.projectId)?.path ?? null);
  // One step keeps its line while its words grow; only a new step rises in.
  const stepKey = run.activity ? `${run.activity.kind}:${run.activity.id ?? run.activity.at}` : "start";
  // Words of the last few lines, so a line that is leaving keeps its own.
  const lines = useRef(new Map<string, ScheduleRunDto>());
  lines.current.set(stepKey, run);
  if (lines.current.size > 4) lines.current.delete(lines.current.keys().next().value!);
  const ticker = useTickerKey(stepKey);
  const elapsed = Math.max(0, (now || Date.now()) - run.startedAt);
  return (
    <li className="agent-turn agent-live" aria-label={tr("agents.workingForValue", { duration: shortDuration(elapsed, UNITS()) })}>
      <span className="agent-live-mark"><AgentMark icon={agent.icon} color={agent.color} working /></span>
      <div className="agent-live-body">
        <div className="agent-live-line">
          <ActivityTicker
            ticker={ticker}
            render={(key) => <StepWords run={lines.current.get(key) ?? run} projectRoot={projectRoot} />}
          />
        </div>
        <div className="agent-live-meta">
          <span className="agent-live-state">{tr("agents.workingNow")}</span>
          <span className="agent-live-time">{fmtSessionElapsed(elapsed)}</span>
          {run.steps ? <span className="agent-live-steps">{tr("agents.stepsValue", { count: run.steps })}</span> : null}
          {run.sessionId && onOpenSession && (
            <button type="button" className="agent-live-open" onClick={() => onOpenSession(run.sessionId!)}>
              {tr("agents.watchInSession")}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

const FRESH_KEYS: Partial<Record<string, Parameters<typeof tr>[0]>> = {
  asked: "agents.freshAsked",
  idle: "agents.freshIdle",
  "instructions-changed": "agents.freshInstructions",
  "context-full": "agents.freshContextFull",
  compacted: "agents.freshCompacted",
  unavailable: "agents.freshUnavailable",
};

/** Where a conversation begins, or where an earlier one comes back. */
function ThreadHead({ opening, sessionId, onOpenSession }: {
  opening: ThreadOpening;
  sessionId?: string;
  onOpenSession?: (sessionId: string) => void;
}) {
  const now = Date.now();
  let title = "";
  let detail = "";
  if (opening.kind === "start") {
    const run = opening.run;
    title = tr("agents.threadStarted");
    // The run that opened it says when and why it woke right below; the head
    // only says why a new conversation began when one could have gone on.
    const reason = run.fresh && run.fresh !== "none" ? run.fresh : run.rotated;
    const why = reason ? FRESH_KEYS[reason] : undefined;
    detail = why ? tr(why) : "";
  } else if (opening.kind === "resume") {
    title = tr("agents.threadResumed");
    detail = opening.since ? tr("agents.threadSinceValue", { time: momentOf(opening.since, now) }) : "";
  } else {
    title = tr("agents.threadStarting");
  }
  return (
    <div className="agent-thread-head" data-opening={opening.kind}>
      <span className="agent-spine-cap" aria-hidden="true" />
      <span className="agent-thread-title">{title}</span>
      {detail && <span className="agent-thread-detail">{detail}</span>}
      {sessionId && onOpenSession && (
        <ChatActionButton
          icon={SessionIcon}
          className="agent-thread-open"
          label={tr("agents.openConversation")}
          onClick={() => onOpenSession(sessionId)}
        />
      )}
    </div>
  );
}

/** What waits for the person in the run that is working now. */
function RequestCard({ task, run, request, onOpenSession }: {
  task: ScheduleTaskDto;
  run: ScheduleRunDto;
  request: NonNullable<ScheduleRunDto["waiting"]>[number];
  onOpenSession?: (sessionId: string) => void;
}) {
  const [busy, setBusy] = useState<"once" | "reject" | null>(null);
  const now = useNow(true);
  const reply = async (answer: "once" | "reject") => {
    setBusy(answer);
    try {
      await api.replyPermission(run.sessionId!, request.requestId, answer);
      void refreshAgents();
    } finally {
      setBusy(null);
    }
  };
  const policy = task.approvals && task.approvals.onTimeout !== "wait"
    ? tr(task.approvals.onTimeout === "reject" ? "agents.deniesAtValue" : "agents.stopsAtValue", {
      time: timeOf(request.since + task.approvals.timeoutMinutes * 60_000),
    })
    : "";
  const question = request.kind === "question";
  return (
    <GlassDock className="agent-request" role="group" aria-label={question ? tr("agents.requestQuestion") : tr("agents.requestPermission")}>
      <div className="agent-request-head">
        <span className="agent-request-icon" aria-hidden="true"><Icon icon={ShieldAlertIcon} size="sm" /></span>
        <span className="agent-request-heading">
          <span className="agent-request-title">{question ? tr("agents.asksYou") : tr("agents.asksPermission")}</span>
          <span className="agent-request-when">
            {tr("agents.waitingForValue", { duration: shortDuration(now - request.since, UNITS()) })}
            {policy ? ` · ${policy}` : ""}
          </span>
        </span>
        {run.sessionId && onOpenSession && (
          <ChatActionButton
            icon={ExternalLinkIcon}
            className="agent-request-open"
            label={question ? tr("agents.answerInSession") : tr("agents.openSession")}
            onClick={() => onOpenSession(run.sessionId!)}
          />
        )}
      </div>
      {question
        ? <p className="agent-request-question">{request.title}</p>
        : <p className="agent-request-command" dir="ltr"><span aria-hidden="true">$</span><code>{request.title}</code></p>}
      {question ? (
        run.sessionId && onOpenSession && (
          <div className="agent-request-actions">
            <Button size="sm" variant="primary" onClick={() => onOpenSession(run.sessionId!)}>{tr("agents.answerInSession")}</Button>
          </div>
        )
      ) : (
        <div className="agent-request-actions">
          <Button size="sm" variant="danger" busy={busy === "reject"} disabled={busy !== null} onClick={() => void reply("reject")}>
            {tr("agents.deny")}
          </Button>
          <Button size="sm" variant="primary" busy={busy === "once"} disabled={busy !== null} onClick={() => void reply("once")}>
            {tr("agents.allowOnce")}
          </Button>
        </div>
      )}
    </GlassDock>
  );
}

function Thread({ agent, thread, onOpenSession, onFeedback }: {
  agent: ScheduleTaskDto;
  thread: ConversationThread;
  onOpenSession?: (sessionId: string) => void;
  onFeedback: (runId: string, verdict: "up" | "down" | null, note?: string) => Promise<void>;
}) {
  const live = thread.items.some((item) => item.kind === "live");
  return (
    <section
      className="agent-thread"
      data-session={thread.sessionId ? "" : undefined}
      data-loose={thread.loose || undefined}
      data-live={live || undefined}
      data-opening={thread.loose ? undefined : thread.opening?.kind ?? "continued"}
    >
      {thread.opening && (
        <ThreadHead
          opening={thread.opening}
          {...(thread.sessionId ? { sessionId: thread.sessionId } : {})}
          {...(onOpenSession ? { onOpenSession } : {})}
        />
      )}
      <ol className="agent-thread-items">
        {thread.items.map((item) => {
          if (item.kind === "new") {
            return <li key={item.key} className="agent-turn agent-new" role="separator"><span>{tr("agents.newBadge")}</span></li>;
          }
          if (item.kind === "you") {
            return (
              <YouBubble
                key={item.key}
                id={item.key}
                text={item.text}
                at={item.at}
                {...(item.pending ? { pending: item.pending } : {})}
                {...(item.attachments ? { attachments: item.attachments } : {})}
                {...(item.attachmentCount ? { attachmentCount: item.attachmentCount } : {})}
              />
            );
          }
          if (item.kind === "quiet") return <QuietFold key={item.key} runs={item.runs} />;
          if (item.kind === "live") {
            return <LiveTurn key={item.key} agent={agent} run={item.run} {...(onOpenSession ? { onOpenSession } : {})} />;
          }
          return <Report key={item.key} task={agent} run={item.run} onFeedback={onFeedback} />;
        })}
      </ol>
    </section>
  );
}

// ---- the conversation ----------------------------------------------------------------

export default function AgentConversation({ host, agent, live, onReview, onRun, onStop }: {
  host?: WebPackageHost;
  agent: ScheduleTaskDto;
  live: AgentLive;
  onReview: (action: "trust-current" | "run-once" | "reject") => void;
  onRun: (message: AgentMessage) => Promise<boolean>;
  onStop: () => Promise<void>;
}) {
  const name = agentName(agent);
  const phone = useShellMode() === "phone";
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const placed = useRef<string | null>(null);
  // "New" stays where it was when the page opened, while the reports are read.
  const [openedSeenAt, setOpenedSeenAt] = useState(agent.seenAt);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [dragging, setDragging] = useState(false);
  const [dropped, setDropped] = useState<DroppedFiles | null>(null);
  const dragDepth = useRef(0);
  // A drag that ends anywhere (dropped elsewhere, cancelled, the window left)
  // takes the drop sheet with it.
  useEffect(() => {
    if (!dragging) return;
    const end = () => {
      dragDepth.current = 0;
      setDragging(false);
    };
    window.addEventListener("dragend", end, true);
    window.addEventListener("drop", end, true);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("dragend", end, true);
      window.removeEventListener("drop", end, true);
      window.removeEventListener("blur", end);
    };
  }, [dragging]);
  useEffect(() => {
    setOpenedSeenAt(agent.seenAt);
    setPending([]);
    placed.current = null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);
  // A sent message is shown until a run (or the server's queue) carries it.
  useEffect(() => {
    if (!pending.length) return;
    const delivered = (message: PendingMessage) =>
      (agent.history ?? []).some((run) => carries(run, message))
      || (agent.queued ?? []).some((queued) => queues(queued, message));
    if (pending.some(delivered)) setPending((current) => current.filter((message) => !delivered(message)));
  }, [agent.history, agent.queued, pending]);

  const days = useMemo(() => conversationDays(agent, openedSeenAt, pending), [agent, openedSeenAt, pending]);
  const empty = days.length === 0;

  // Read a moment after the reports are on screen.
  const newest = newestReportAt(agent);
  useEffect(() => {
    if (newest === undefined || (agent.seenAt ?? 0) >= newest) return;
    const timer = setTimeout(() => {
      void optimistic(agent.id, { seenAt: newest }, () => api.scheduleSeen(agent.id, newest)).catch(() => {});
    }, 1_200);
    return () => clearTimeout(timer);
  }, [agent.id, agent.seenAt, newest]);

  // Open at the first new report, else at the newest; then follow the end
  // while the person is there.
  const itemCount = days.reduce((sum, day) => sum + dayItems(day).length, 0);
  const liveStep = live.running?.activity?.at;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (placed.current !== agent.id) {
      placed.current = agent.id;
      const marker = element.querySelector<HTMLElement>(".agent-new");
      if (marker) {
        element.scrollTop = Math.max(0, marker.offsetTop - element.clientHeight * 0.3);
      } else {
        element.scrollTop = element.scrollHeight;
      }
      return;
    }
    if (atBottom.current) element.scrollTop = element.scrollHeight;
  }, [agent.id, itemCount, live.running?.runId, live.waiting.length, liveStep]);

  const openSession = host ? (sessionId: string) => void host.conversation.openSession(sessionId) : undefined;
  const feedback = async (runId: string, verdict: "up" | "down" | null, note?: string) => {
    const history = (agent.history ?? []).map((run) => run.runId !== runId ? run : verdict === null
      ? { ...run, feedback: undefined }
      : { ...run, feedback: { verdict, ...(note ? { note } : {}), at: Date.now() } });
    await optimistic(agent.id, { history }, () => api.scheduleFeedback(agent.id, runId, verdict, note)).catch(() => {});
  };
  const send = async (message: AgentMessage): Promise<boolean> => {
    const at = Date.now();
    const files: AgentRunAttachmentDto[] = message.attachments.map((file) => ({
      name: file.name, mime: file.mime, size: file.size,
      ...(file.kind === "image" || file.kind === "file" ? { kind: file.kind } : {}),
      ...(file.path ? { path: file.path } : {}),
    }));
    setPending((current) => [...current, {
      text: message.text,
      at,
      ...(files.length ? { attachments: files } : {}),
      ...(message.continuation !== "auto" ? { continuation: message.continuation } : {}),
    }]);
    atBottom.current = true;
    const ok = await onRun(message);
    if (!ok) setPending((current) => current.filter((item) => item.at !== at));
    return ok;
  };

  const blocked = live.phase === "review";
  const running = live.running;
  const waiting = live.waiting;
  const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes("Files");

  return (
    <div
      className="agent-conversation"
      role="tabpanel"
      data-color={agent.color ?? "neutral"}
      data-dragging={dragging || undefined}
      onDragEnter={(event) => {
        if (!hasFiles(event) || blocked) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        // Files dropped here never reach the browser (it would open them),
        // even while the agent cannot take them.
        event.preventDefault();
        event.dataTransfer.dropEffect = blocked ? "none" : "copy";
      }}
      onDragLeave={(event) => {
        if (!hasFiles(event)) return;
        const into = event.relatedTarget as Node | null;
        // Leaving for somewhere outside the conversation ends it at once,
        // whatever enter/leave pairs went missing on the way.
        dragDepth.current = into && !event.currentTarget.contains(into) ? 0 : Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (blocked) return;
        const files = [...event.dataTransfer.files];
        if (files.length) setDropped((current) => ({ batch: (current?.batch ?? 0) + 1, agentId: agent.id, files }));
      }}
    >
      <div
        ref={scroller}
        className="agent-feed"
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
        }}
      >
        <div className="agent-feed-column">
          {agent.parseError && <p className="agent-feed-error" role="alert">{agent.parseError}</p>}
          {empty && (
            <div className="agent-feed-empty">
              <AgentMark icon={agent.icon} color={agent.color} working={false} />
              <p className="agent-feed-empty-title">{tr("agents.feedEmptyTitleValue", { name })}</p>
              <p>{tr("agents.feedEmptyBody")}</p>
            </div>
          )}
          {days.map((day) => (
            <section className="agent-day" key={day.key} aria-label={dayLabel(day.at)}>
              <h2 className="agent-day-label"><span>{dayLabel(day.at)}</span></h2>
              {day.threads.map((thread) => (
                <Thread
                  key={thread.key}
                  agent={agent}
                  thread={thread}
                  {...(openSession ? { onOpenSession: openSession } : {})}
                  onFeedback={feedback}
                />
              ))}
            </section>
          ))}
        </div>
      </div>

      <div className="agent-dock">
        <div className="agent-dock-column">
          {blocked && (
            <GlassDock className="agent-request" role="group" aria-label={tr("agents.reviewNeeded")}>
              <div className="agent-request-head">
                <span className="agent-request-icon" aria-hidden="true"><Icon icon={ShieldAlertIcon} size="sm" /></span>
                <span className="agent-request-title">{tr("agents.reviewNeeded")}</span>
              </div>
              <p className="agent-request-question">{tr("agents.reviewNote")}</p>
              <div className="agent-request-actions">
                <Button size="sm" variant="ghost" onClick={() => onReview("reject")}>{tr("agents.keepBlocked")}</Button>
                <Button size="sm" onClick={() => onReview("run-once")}>{tr("agents.runVersionOnce")}</Button>
                <Button size="sm" variant="primary" onClick={() => onReview("trust-current")}>{tr("agents.trustVersion")}</Button>
              </div>
            </GlassDock>
          )}
          {waiting.map(({ run, request }) => (
            <RequestCard
              key={request.requestId}
              task={agent}
              run={run}
              request={request}
              {...(openSession ? { onOpenSession: openSession } : {})}
            />
          ))}
          <AgentComposer
            key={agent.id}
            agent={agent}
            name={name}
            placeholder={phone
              ? tr("agents.talkShortPlaceholder")
              : running ? tr("agents.talkQueuedPlaceholderValue", { name }) : tr("agents.talkPlaceholderValue", { name })}
            disabled={blocked}
            running={!!running}
            onSend={send}
            onStop={onStop}
            files={dropped}
          />
        </div>
      </div>
      {dragging && (
        <div className="agent-drop" aria-hidden="true">
          <span>{tr("agents.dropFiles")}</span>
        </div>
      )}
    </div>
  );
}
