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
import { useSessionModel, useStore } from "../../../apps/web/src/store.ts";
import { executionPathParts, executionPresentation } from "../../../apps/web/src/execution.ts";
import ChatActionButton from "../../../apps/web/src/components/ChatActionButton.tsx";
import ActivityTicker, { useTickerKey } from "../../../apps/web/src/components/ActivityTicker.tsx";
import AttachmentPills from "../../../apps/web/src/components/AttachmentPills.tsx";
import { ExecutionIcon } from "../../../apps/web/src/components/ExecutionIcon.tsx";
import {
  Button, GlassDock, Icon,
  ExternalLinkIcon, SessionIcon, ShieldAlertIcon, TextInput, ThumbsDownIcon, ThumbsUpIcon,
} from "../../../apps/web/src/components/ui/index.ts";
import { AgentMark } from "./AgentGlyph.tsx";
import { tokenTotal } from "../src/agentPrompt.ts";
import { newestReportAt, shortDuration, type AgentLive } from "./agentLive.ts";
import { agentName } from "./agentActions.ts";
import { useNow } from "./agentClock.ts";
import { optimistic } from "./agentsStore.ts";
import AgentComposer, { type AgentMessage, type DroppedFiles } from "./AgentComposer.tsx";
import {
  carries, conversationDays, dayItems, queues,
  type ConversationThread, type PendingMessage, type ThreadOpening,
} from "./agentThreads.ts";

export { conversationDays } from "./agentThreads.ts";
export type { ConversationDay, ConversationItem, ConversationThread } from "./agentThreads.ts";

const UNITS = () => ({ s: tr("agents.unitSeconds"), min: tr("agents.unitMinutes"), h: tr("agents.unitHours") });
const timeOf = (at: number): string =>
  new Date(at).toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" });

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

/** Why the run woke, when that is worth a word: a schedule is how an agent
 *  usually wakes, and an answer sits right under the person's own words. */
function wakeLabel(run: ScheduleRunDto): string | null {
  if (run.trigger === "heartbeat") return tr("agents.triggerHeartbeat");
  if (run.trigger === "event") return tr("agents.eventRun");
  if (run.trigger === "manual" && !run.input && !run.attachments?.length) return tr("agents.manualRun");
  return null;
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

type OnFeedback = (runId: string, verdict: "up" | "down" | null, note?: string) => Promise<void>;

/** A run's feedback: the verdict buttons and the note a "not useful" asks for.
 *  The buttons go where the card has room; the note always under the report. */
function useFeedback(run: ScheduleRunDto, onFeedback: OnFeedback) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(run.feedback?.note ?? "");
  const [busy, setBusy] = useState(false);
  const send = async (next: "up" | "down" | null, text?: string) => {
    setBusy(true);
    try { await onFeedback(run.runId, next, text); } finally { setBusy(false); }
  };
  return { verdict: run.feedback?.verdict, delivered: !!run.feedback?.delivered, noteOpen, setNoteOpen, note, setNote, busy, send };
}
type FeedbackState = ReturnType<typeof useFeedback>;

function FeedbackButtons({ feedback }: { feedback: FeedbackState }) {
  const { verdict, busy, send, setNoteOpen } = feedback;
  return (
    // A given verdict stays in view; the buttons otherwise wait for a hover.
    <span className="agent-report-actions" data-verdict={verdict}>
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
          {feedback.delivered ? tr("agents.feedbackHeard") : tr("agents.feedbackPending")}
        </span>
      )}
    </span>
  );
}

function FeedbackNote({ feedback }: { feedback: FeedbackState }) {
  const { note, setNote, busy, send, setNoteOpen } = feedback;
  return (
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
  );
}

/** "38 min · 273K tokens · $6.26": what a run cost, said briefly. */
function runFacts(run: ScheduleRunDto): string {
  const tokens = tokenTotal(run.tokens);
  const locale = getLocale();
  const count = tokens >= 10_000
    ? new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: tokens >= 1_000_000 ? 1 : 0 }).format(tokens)
    : tokens.toLocaleString(locale);
  return [
    run.finishedAt ? shortDuration(run.finishedAt - run.startedAt, UNITS()) : null,
    tokens > 0 ? tr("agents.tokensValue", { count }) : null,
    run.cost !== undefined && run.cost > 0 ? `$${run.cost.toFixed(run.cost < 0.1 ? 3 : 2)}` : null,
  ].filter(Boolean).join(" · ");
}

/** A report's opening paragraph, shown under its headline, and the rest,
 *  shown on request. A body that opens with a heading, list, table, quote or
 *  code has no lead: all of it is the rest. A bold opening sentence (most
 *  often the headline said again) reads as plain prose in the lead. */
export function reportLead(body: string): { lead: string; rest: string } {
  const text = body.trim();
  const gap = /\n[ \t]*\n/.exec(text);
  const first = gap ? text.slice(0, gap.index) : text;
  const rest = gap ? text.slice(gap.index + gap[0].length).trim() : "";
  const fences = first.match(/^\s*(```|~~~)/gm)?.length ?? 0;
  if (!first || fences % 2 === 1 || /^\s*(#|\||```|~~~|>|[-*+]\s|\d+[.)]\s)/.test(first)) return { lead: "", rest: text };
  return { lead: first.replace(/^\*\*([^*\n]+)\*\*/, "$1").replace(/^__([^_\n]+)__/, "$1"), rest };
}

/** What a run said, as a ledger entry: the headline with its time at the
 *  column's end, then its opening paragraph. A status word comes first only
 *  when one is due. The rest of the report, with the notes it kept as its last
 *  section, opens from one quiet link; feedback and cost show on hover. A
 *  report read before, with newer ones after it, is one line until opened. */
function Report({ task, run, compact, latest, onFeedback }: {
  task: ScheduleTaskDto;
  run: ScheduleRunDto;
  compact?: boolean;
  /** The newest report on the page: on touch, the one that offers feedback. */
  latest?: boolean;
  onFeedback: OnFeedback;
}) {
  const [open, setOpen] = useState(!compact);
  const [full, setFull] = useState(false);
  const feedback = useFeedback(run, onFeedback);
  const signal = signalOf(run);
  const headline = headlineOf(run);
  const body = run.summary?.trim() ?? "";
  // The headline came from the body's first line: never twice.
  const shownBody = !run.headline && body.split("\n")[0]?.replace(/^#+\s*/, "").trim() === headline
    ? body.split("\n").slice(1).join("\n").trim()
    : body;
  const { lead, rest } = reportLead(shownBody);
  const facts = runFacts(run);
  const notes = run.remembered ?? [];
  const wake = wakeLabel(run);
  const at = new Date(run.startedAt).toISOString();
  const markdown = (text: string, part: string) => (
    <div className={`msg assistant agent-report-body agent-report-${part}`}>
      <div className="bubble">
        <MarkdownDoc
          text={text}
          keyBase={`agent-${run.runId}-${part}`}
          resourceContext={{ projectId: task.projectId, sessionId: run.sessionId ?? null }}
        />
      </div>
    </div>
  );

  const time = <time dateTime={at}>{timeOf(run.startedAt)}</time>;
  if (!open) {
    return (
      <li className="agent-turn agent-report" data-signal={signal} data-compact="line">
        <button type="button" className="agent-report-line" aria-expanded={false} onClick={() => setOpen(true)}>
          <span className="agent-report-line-title">{headline}</span>
          {time}
        </button>
      </li>
    );
  }

  // Said only when it is news: what went wrong, or why the run woke.
  const status = [
    signal === "alert" ? <span key="signal" className="agent-report-signal" data-signal="alert">{tr("agents.signalAlert")}</span> : null,
    signal === "failed" && run.headline ? <span key="signal" className="agent-report-signal" data-signal="failed">{tr("agents.runFailed")}</span> : null,
    wake ? <span key="wake" className="agent-report-wake">{wake}</span> : null,
    run.late ? <span key="late" className="agent-report-wake">{tr("agents.lateRun")}</span> : null,
    run.backup ? <span key="backup" className="agent-report-wake">{tr("agents.ranOnBackupValue", { count: run.backup })}</span> : null,
  ].filter(Boolean);
  // One link: the rest of the report (its notes last), or the notes alone.
  const more = rest || notes.length > 0;
  const moreLabel = full ? tr("agents.showLess")
    : rest ? tr("agents.readFullReport")
      : tr(notes.length === 1 ? "agents.notesOneValue" : "agents.notesValue", { count: notes.length });
  const tools = run.status === "ok" || facts;
  return (
    <li
      className="agent-turn agent-report"
      data-signal={signal}
      data-compact={compact ? "open" : undefined}
      data-latest={latest || undefined}
    >
      {status.length > 0 && <p className="agent-report-meta">{status}</p>}
      <div className="agent-report-head">
        <h3 className="agent-report-headline">{headline}</h3>
        {compact ? (
          <button type="button" className="agent-report-fold" aria-expanded aria-label={tr("agents.showLess")} onClick={() => setOpen(false)}>
            {time}
          </button>
        ) : time}
      </div>
      {run.note || run.events?.length ? (
        <ul className="agent-report-events">
          {/* The wake script's words, which may quote event data: what woke
              the agent, never the person speaking. */}
          {run.note && <li className="agent-report-wake-note" title={run.note}>{tr("agents.wakeNoteValue", { note: run.note })}</li>}
          {(run.events ?? []).slice(0, 3).map((line, index) => <li key={index}>{line}</li>)}
          {(run.events?.length ?? 0) > 3 && <li>{tr("agents.moreEventsValue", { count: run.events!.length - 3 })}</li>}
        </ul>
      ) : null}
      {lead && markdown(lead, "lead")}
      {rest && full && markdown(rest, "full")}
      {full && notes.length > 0 && (
        <section className="agent-report-notes" aria-label={tr("agents.remembered")}>
          <h4 className="agent-report-notes-label">{tr("agents.remembered")}</h4>
          <ul>{notes.map((note) => <li key={note}>{note}</li>)}</ul>
        </section>
      )}
      {run.error && signal !== "stopped" && <p className="agent-report-error">{run.error}</p>}
      {(more || tools) && (
        <footer className="agent-report-foot" data-link={more || undefined}>
          {more && (
            <button type="button" className="agent-report-more" aria-expanded={full} onClick={() => setFull(!full)}>
              {moreLabel}
            </button>
          )}
          {tools && (
            <span className="agent-report-tools">
              {run.status === "ok" && <FeedbackButtons feedback={feedback} />}
              {facts && <span className="agent-report-facts">{facts}</span>}
            </span>
          )}
        </footer>
      )}
      {feedback.noteOpen && <FeedbackNote feedback={feedback} />}
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
        <span className="agent-quiet-label">{label}</span>
        <time>{range}</time>
      </button>
      {open && (
        <ol className="agent-quiet-list">
          {runs.map((run) => (
            <li key={run.runId}>
              <span>{run.status === "skipped" ? run.error ?? tr("agents.runSkipped") : run.summary?.split("\n")[0] || tr("agents.signalQuiet")}</span>
              <time dateTime={new Date(run.startedAt).toISOString()}>{timeOf(run.startedAt)}</time>
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

/** Why a conversation begins here, or that an earlier one comes back. */
function openingWords(opening: ThreadOpening): { title: string; detail: string } {
  if (opening.kind === "start") {
    const run = opening.run;
    // The run that opened it says when and why it woke right below; the head
    // only says why a new conversation began when one could have gone on.
    const reason = run.fresh && run.fresh !== "none" ? run.fresh : run.rotated;
    const why = reason ? FRESH_KEYS[reason] : undefined;
    return { title: tr("agents.threadStarted"), detail: why ? tr(why) : "" };
  }
  if (opening.kind === "resume") {
    return {
      title: tr("agents.threadResumed"),
      detail: opening.since ? tr("agents.threadSinceValue", { time: momentOf(opening.since, Date.now()) }) : "",
    };
  }
  return { title: tr("agents.threadStarting"), detail: "" };
}

/** A divider across the conversation: a day, where a conversation begins, or
 *  both on one line when a conversation opens the day. */
function Divider({ day, opening, sessionId, onOpenSession, heading }: {
  day?: string;
  opening?: ThreadOpening;
  sessionId?: string;
  onOpenSession?: (sessionId: string) => void;
  heading?: boolean;
}) {
  const words = opening ? openingWords(opening) : null;
  const locale = getLocale();
  // After the day, the opening reads on as part of one phrase.
  const title = words && day ? words.title.charAt(0).toLocaleLowerCase(locale) + words.title.slice(1) : words?.title;
  const Label = heading ? "h2" : "p";
  return (
    <div className="agent-divider" data-opening={opening?.kind}>
      <Label className="agent-divider-label">
        {/* One phrase, so a narrow column wraps it as words, not as columns. */}
        <span className="agent-divider-text">
          {day && <span className="agent-divider-day">{day}</span>}
          {title && <span className="agent-divider-opening">{day ? " · " : ""}{title}</span>}
          {words?.detail && <span className="agent-divider-detail">{" — "}{words.detail}</span>}
        </span>
      </Label>
      {sessionId && onOpenSession && (
        <span className="agent-divider-open">
          <ChatActionButton
            icon={SessionIcon}
            className="agent-thread-open"
            label={tr("agents.openConversation")}
            onClick={() => onOpenSession(sessionId)}
          />
        </span>
      )}
    </div>
  );
}

type WaitingRequest = NonNullable<ScheduleRunDto["waiting"]>[number];

/** The permission requests of each run; a run's session shows them on one card. */
function permissionRuns(waiting: AgentLive["waiting"]): Array<{ run: ScheduleRunDto; requests: WaitingRequest[] }> {
  const runs = new Map<string, { run: ScheduleRunDto; requests: WaitingRequest[] }>();
  for (const { run, request } of waiting) {
    if (request.kind !== "permission") continue;
    const entry = runs.get(run.runId) ?? { run, requests: [] };
    entry.requests.push(request);
    runs.set(run.runId, entry);
  }
  return [...runs.values()];
}

/** How long a request has waited, and what the agent's policy does about it. */
function waitLine(task: ScheduleTaskDto, request: WaitingRequest, now: number): string {
  const policy = task.approvals && task.approvals.onTimeout !== "wait"
    ? tr(task.approvals.onTimeout === "reject" ? "agents.deniesAtValue" : "agents.stopsAtValue", {
      time: timeOf(request.since + task.approvals.timeoutMinutes * 60_000),
    })
    : "";
  return `${tr("agents.waitingForValue", { duration: shortDuration(now - request.since, UNITS()) })}${policy ? ` · ${policy}` : ""}`;
}

/** A question the run waits on; it is answered in its session. */
function QuestionCard({ task, run, request, onOpenSession }: {
  task: ScheduleTaskDto;
  run: ScheduleRunDto;
  request: WaitingRequest;
  onOpenSession?: (sessionId: string) => void;
}) {
  const now = useNow(true);
  return (
    <GlassDock className="agent-request" role="group" aria-label={tr("agents.requestQuestion")}>
      <div className="agent-request-head">
        <span className="agent-request-icon" aria-hidden="true"><Icon icon={ShieldAlertIcon} size="sm" /></span>
        <span className="agent-request-heading">
          <span className="agent-request-title">{tr("agents.asksYou")}</span>
          <span className="agent-request-when">{waitLine(task, request, now)}</span>
        </span>
        {run.sessionId && onOpenSession && (
          <ChatActionButton
            icon={ExternalLinkIcon}
            className="agent-request-open"
            label={tr("agents.answerInSession")}
            onClick={() => onOpenSession(run.sessionId!)}
          />
        )}
      </div>
      <p className="agent-request-question">{request.title}</p>
      {run.sessionId && onOpenSession && (
        <div className="agent-request-actions">
          <Button size="sm" variant="primary" onClick={() => onOpenSession(run.sessionId!)}>{tr("agents.answerInSession")}</Button>
        </div>
      )}
    </GlassDock>
  );
}

/** The run's permission requests: the card every chat shows, under a line with
 *  what only the agent's page knows. That line and its way into the session stay
 *  when the session's events cannot be read here. */
function PermissionRequests({ host, task, run, requests, onOpenSession }: {
  host?: WebPackageHost;
  task: ScheduleTaskDto;
  run: ScheduleRunDto;
  requests: readonly WaitingRequest[];
  onOpenSession?: (sessionId: string) => void;
}) {
  const now = useNow(true);
  const requestIds = requests.map((request) => request.requestId);
  // The run's record trails the session: a decided request says so here first.
  const model = useSessionModel(run.sessionId!);
  const open = requests.find((request) => model.permissions.find((known) => known.requestId === request.requestId)?.status !== "resolved");
  return (
    <div className="agent-permission" role="group" aria-label={tr("agents.requestPermission")}>
      {open && (
        <div className="agent-permission-wait">
          <span className="agent-request-when">{waitLine(task, open, now)}</span>
          {onOpenSession && (
            <ChatActionButton
              icon={ExternalLinkIcon}
              className="agent-request-open"
              label={tr("agents.openSession")}
              onClick={() => onOpenSession(run.sessionId!)}
            />
          )}
        </div>
      )}
      {host && <host.ui.Slot slot="session.permission.requests" context={{ sessionId: run.sessionId, requestIds }} />}
    </div>
  );
}

function Thread({ agent, thread, headless, latest, onOpenSession, onFeedback }: {
  agent: ScheduleTaskDto;
  thread: ConversationThread;
  /** The key of the newest report on the page. */
  latest?: string;
  /** Its opening is said on the day's divider above it. */
  headless?: boolean;
  onOpenSession?: (sessionId: string) => void;
  onFeedback: OnFeedback;
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
      {thread.opening && !headless && (
        <Divider
          opening={thread.opening}
          {...(thread.sessionId ? { sessionId: thread.sessionId } : {})}
          {...(onOpenSession ? { onOpenSession } : {})}
        />
      )}
      <ol className="agent-thread-items">
        {thread.items.map((item) => {
          if (item.kind === "new") {
            // No rule: the page opens here, and a reader of the page hears it.
            return <li key={item.key} className="agent-turn agent-new" role="separator" aria-label={tr("agents.newBadge")} />;
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
          return (
            <Report
              key={item.key}
              task={agent}
              run={item.run}
              compact={!!item.compact}
              latest={item.key === latest}
              onFeedback={onFeedback}
            />
          );
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
  const latestReport = days.flatMap(dayItems).findLast((item) => item.kind === "report")?.key;

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
          {days.map((day) => {
            // A conversation that opens the day is said on the day's line.
            const first = day.threads[0];
            const joined = first?.opening && first.opening.kind !== "upcoming" ? first : undefined;
            return (
              <section className="agent-day" key={day.key} aria-label={dayLabel(day.at)}>
                <Divider
                  heading
                  day={dayLabel(day.at)}
                  {...(joined?.opening ? { opening: joined.opening } : {})}
                  {...(joined?.sessionId ? { sessionId: joined.sessionId } : {})}
                  {...(joined && openSession ? { onOpenSession: openSession } : {})}
                />
                {day.threads.map((thread) => (
                  <Thread
                    key={thread.key}
                    agent={agent}
                    thread={thread}
                    headless={thread === joined}
                    {...(latestReport ? { latest: latestReport } : {})}
                    {...(openSession ? { onOpenSession: openSession } : {})}
                    onFeedback={feedback}
                  />
                ))}
              </section>
            );
          })}
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
          {waiting.filter(({ request }) => request.kind === "question").map(({ run, request }) => (
            <QuestionCard
              key={request.requestId}
              task={agent}
              run={run}
              request={request}
              {...(openSession ? { onOpenSession: openSession } : {})}
            />
          ))}
          {permissionRuns(waiting).map(({ run, requests }) => (
            <PermissionRequests
              key={run.runId}
              {...(host ? { host } : {})}
              task={agent}
              run={run}
              requests={requests}
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
