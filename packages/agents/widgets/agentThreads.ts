// The agent's conversation as it reads on its page: days, and inside each day
// the conversations (sessions) the runs happened in. A run that went on in a
// session already shown joins it; a run that started a new session opens a
// new conversation, saying why. DOM-free so it is tested directly.
import type { AgentFollowUpDto, AgentRunAttachmentDto, ScheduleRunDto, ScheduleTaskDto } from "@polyth/session/web-api";
import { isUnread } from "./agentLive.ts";

export type ConversationItem =
  /** The person's words that started a run (or wait for one). */
  | {
    kind: "you"; key: string; at: number; text: string;
    attachments?: readonly AgentRunAttachmentDto[];
    /** `sending`: on its way; `queued`: waits for the run in progress. */
    pending?: "sending" | "queued";
    attachmentCount?: number;
  }
  /** What a run said. */
  | { kind: "report"; key: string; run: ScheduleRunDto }
  /** Quiet checks and skipped wakes in a row, as one line. */
  | { kind: "quiet"; key: string; runs: ScheduleRunDto[] }
  /** The run working now, at the end of its conversation. */
  | { kind: "live"; key: string; run: ScheduleRunDto }
  /** Where the reports the person has not read begin. */
  | { kind: "new"; key: string };

/** How a conversation segment begins. */
export type ThreadOpening =
  /** Its session starts here: a new conversation. */
  | { kind: "start"; at: number; run: ScheduleRunDto }
  /** It goes on in a session shown earlier (another conversation came between). */
  | { kind: "resume"; since?: number }
  /** The person's message on its way will start a new conversation. */
  | { kind: "upcoming" };

export interface ConversationThread {
  key: string;
  /** The session it happened in; absent for wakes that never reached one
   *  and for a run of loose wakes. */
  sessionId?: string;
  /** Wakes that each had a session to themselves (a fresh agent's checks and
   *  reports nobody answered): they read as one stream, not as conversations. */
  loose?: true;
  /** Absent when the segment simply continues the one before it (across a day). */
  opening?: ThreadOpening;
  items: ConversationItem[];
}

export interface ConversationDay { key: string; at: number; threads: ConversationThread[] }

const dayKey = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

/** A run that reports nothing: folded with its neighbours. */
export const quietRun = (run: ScheduleRunDto): boolean => !run.input && !run.attachments?.length && (
  run.status === "skipped" || (run.status === "ok" && run.signal === "quiet")
  || (run.status === "ok" && !run.signal && !run.summary?.trim() && !run.headline));

/** A message the person sent that no run carries yet. */
export interface PendingMessage {
  text: string;
  at: number;
  attachments?: readonly AgentRunAttachmentDto[];
  /** The person chose where it goes; absent = the agent judges. */
  continuation?: "continue" | "new";
}

/** Whether `run` carries the words of `message`: all of its words, or one of
 *  the messages a merged queue joined with a blank line — never just a
 *  run whose words happen to contain them. */
export function carries(run: ScheduleRunDto, message: Pick<PendingMessage, "text" | "at">): boolean {
  if (run.startedAt < message.at - 60_000) return false;
  const text = message.text.trim();
  if (!text) return !!run.attachments?.length;
  const input = run.input ?? "";
  return input === text || input.startsWith(`${text}\n\n`) || input.endsWith(`\n\n${text}`) || input.includes(`\n\n${text}\n\n`);
}

/** Whether the server's queue already holds `message` (its words, or its
 *  files when it had no words). The queue lists each message on its own. */
export function queues(queued: { text: string; at: number; attachments?: number }, message: PendingMessage): boolean {
  const text = message.text.trim();
  if (text) return queued.text === text;
  return !queued.text && !!queued.attachments && queued.at >= message.at - 60_000;
}

/** The journal as a conversation: oldest first, grouped by day and by the
 *  session each run happened in. The person's words come before the run they
 *  started; the run in progress closes its conversation; messages still on
 *  their way go where their run will land (the queue's fixed conversation,
 *  else `followUp`). */
export function conversationDays(
  task: ScheduleTaskDto,
  seenAt: number | undefined,
  pending: readonly PendingMessage[] = [],
): ConversationDay[] {
  const days: ConversationDay[] = [];
  const shown = new Map<string, number>();
  let marked = false;

  const dayOf = (at: number): ConversationDay => {
    const key = dayKey(at);
    let day = days.at(-1);
    if (!day || day.key !== key) {
      const midnight = new Date(at);
      midnight.setHours(0, 0, 0, 0);
      day = { key, at: midnight.getTime(), threads: [] };
      days.push(day);
    }
    return day;
  };
  const runs = [...(task.history ?? [])].sort((a, b) => a.startedAt - b.startedAt);
  const runsIn = new Map<string, number>();
  for (const run of runs) if (run.sessionId) runsIn.set(run.sessionId, (runsIn.get(run.sessionId) ?? 0) + 1);
  const rolling = task.target?.mode === "dedicated-session";

  // Messages still waiting: the server's queue, then what this page sent that
  // the queue does not hold yet. They start one run together. The server
  // fixed where when the first queued; a later explicit choice moves it (as
  // the server joins them); else they go where the agent would go on now.
  const queuedNow = task.queued ?? [];
  const unqueued = pending.filter((message) => !queuedNow.some((queued) => queues(queued, message)));
  const choice = unqueued.map((message) => message.continuation).filter(Boolean).at(-1);
  const waitingTarget = !queuedNow.length && !unqueued.length ? undefined
    : choice === "new" ? undefined
      : choice === "continue" ? task.followUp?.sessionId
        : queuedNow.length ? queuedNow.at(-1)!.sessionId
          : continuesInto(task.followUp);

  /** A conversation is a session that went on (more than one run), one the
   *  person spoke in or is answering now, or the rolling agent's ongoing one.
   *  A fresh agent's lone wake is not: it joins the loose stream. */
  const conversational = (run: ScheduleRunDto): boolean => !!run.sessionId && (
    rolling || !!run.input || !!run.attachments?.length || !!run.continued
    || (runsIn.get(run.sessionId) ?? 0) > 1 || run.sessionId === waitingTarget);

  /** The segment `run` belongs in, opening one when the session changes. */
  const threadFor = (run: ScheduleRunDto): ConversationThread => {
    const day = dayOf(run.startedAt);
    const last = day.threads.at(-1);
    if (!conversational(run)) {
      if (last?.loose) return last;
      const loose: ConversationThread = { key: `loose-${run.runId}`, loose: true, items: [] };
      day.threads.push(loose);
      return loose;
    }
    const sessionId = run.sessionId!;
    if (last && last.sessionId === sessionId) return last;
    // The previous segment (maybe on an earlier day) was this session: the
    // conversation simply goes on past the day label.
    const previous = days.flatMap((candidate) => candidate.threads).at(-1);
    let opening: ThreadOpening | undefined;
    if (previous?.sessionId === sessionId) opening = undefined;
    else if (shown.has(sessionId)) opening = { kind: "resume", since: shown.get(sessionId)! };
    // The session's first run in the bounded journal may still continue an
    // older conversation the journal no longer holds.
    else if (run.continued) opening = { kind: "resume" };
    else opening = { kind: "start", at: run.startedAt, run };
    if (!shown.has(sessionId)) shown.set(sessionId, run.startedAt);
    const thread: ConversationThread = {
      key: `${sessionId}-${run.runId}`,
      sessionId,
      ...(opening ? { opening } : {}),
      items: [],
    };
    day.threads.push(thread);
    return thread;
  };

  for (const run of runs) {
    const thread = threadFor(run);
    if (run.input || run.attachments?.length) {
      thread.items.push({
        kind: "you", key: `you-${run.runId}`, at: run.startedAt, text: run.input ?? "",
        ...(run.attachments?.length ? { attachments: run.attachments } : {}),
      });
    }
    if (run.status === "running") {
      thread.items.push({ kind: "live", key: `live-${run.runId}`, run });
      continue;
    }
    if (quietRun(run)) {
      const last = thread.items.at(-1);
      if (last?.kind === "quiet") last.runs.push(run);
      else thread.items.push({ kind: "quiet", key: `quiet-${run.runId}`, runs: [run] });
      continue;
    }
    if (!marked && isUnread({ ...task, seenAt }, run)) {
      marked = true;
      thread.items.push({ kind: "new", key: "new" });
    }
    thread.items.push({ kind: "report", key: run.runId, run });
  }

  // Waiting messages: the server's queue first, then what this page sent.
  const waiting: ConversationItem[] = [
    ...queuedNow.map((message): ConversationItem => ({
      kind: "you", key: `queued-${message.at}`, at: message.at, text: message.text, pending: "queued",
      ...(message.attachments ? { attachmentCount: message.attachments } : {}),
    })),
    ...unqueued.map((message): ConversationItem => ({
      kind: "you", key: `pending-${message.at}`, at: message.at, text: message.text, pending: "sending",
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    })),
  ];
  if (waiting.length) {
    const first = waiting[0]!;
    const day = dayOf(first.kind === "you" ? first.at : Date.now());
    const target = waitingTarget;
    const lastToday = day.threads.at(-1);
    const previous = days.flatMap((candidate) => candidate.threads).at(-1);
    if (target && lastToday?.sessionId === target) {
      lastToday.items.push(...waiting);
    } else {
      const opening: ThreadOpening | undefined = !target ? { kind: "upcoming" }
        : previous?.sessionId === target ? undefined
          : { kind: "resume", ...(shown.has(target) ? { since: shown.get(target)! } : {}) };
      day.threads.push({
        key: `upcoming-${first.key}`,
        ...(target ? { sessionId: target } : {}),
        ...(opening ? { opening } : {}),
        items: waiting,
      });
    }
  }
  return days;
}

/** The session the person's next message goes on in, if any. */
export function continuesInto(followUp: AgentFollowUpDto | undefined, now = Date.now()): string | undefined {
  if (!followUp?.sessionId) return undefined;
  if (typeof followUp.until === "number" && now > followUp.until) return undefined;
  return followUp.sessionId;
}

/** Every item of a day, for counting and placement. */
export const dayItems = (day: ConversationDay): ConversationItem[] => day.threads.flatMap((thread) => thread.items);

/** One of the agent's conversations (sessions), for its "Conversations" menu. */
export interface AgentConversationRef {
  sessionId: string;
  startedAt: number;
  lastAt: number;
  runs: number;
  live: boolean;
  /** What it began with: the person's first words or the first headline. */
  topic?: string;
}

/** The first line of what a run began with, for naming its conversation. */
const openingWords = (run: ScheduleRunDto): string | undefined =>
  (run.input ?? run.headline)?.split("\n").find((line) => line.trim())?.trim().slice(0, 120) || undefined;

/** The agent's conversations, newest first, from its bounded journal. */
export function agentConversations(task: Pick<ScheduleTaskDto, "history">, limit = 12): AgentConversationRef[] {
  const bySession = new Map<string, AgentConversationRef>();
  const runs = [...(task.history ?? [])].sort((a, b) => a.startedAt - b.startedAt);
  for (const run of runs) {
    if (!run.sessionId) continue;
    const at = run.finishedAt ?? run.startedAt;
    const known = bySession.get(run.sessionId);
    if (known) {
      known.lastAt = Math.max(known.lastAt, at);
      known.runs += 1;
      known.live ||= run.status === "running";
      if (!known.topic) {
        const topic = openingWords(run);
        if (topic) known.topic = topic;
      }
    } else {
      const topic = openingWords(run);
      bySession.set(run.sessionId, {
        sessionId: run.sessionId, startedAt: run.startedAt, lastAt: at, runs: 1, live: run.status === "running",
        ...(topic ? { topic } : {}),
      });
    }
  }
  return [...bySession.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, limit);
}
