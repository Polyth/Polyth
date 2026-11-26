// Holding event wakes while the agent waits for its person.
//
// A monitor that reports a state ("disk at 92%") every few minutes wakes the
// agent with the same news again and again. When the agent has already looked
// at that news and asked the person for a decision ("Needs you: …"), another
// run can only repeat itself. Such a wake is held: counted in the event log,
// never run. The agent wakes again when anything moves:
//
// - the person answers (their message is a newer run) or settles the request;
// - an event the last run did not see arrives (another source, title, kind,
//   host or severity), or its figure moves by HOLD_FIGURE_STEP points or more;
// - HOLD_RECHECK_MS passed since the last run, for one recheck.
//
// Server-only logic on plain data; events stay data, never instructions.

import type { AgentEvent } from "./agentEvents.ts";
import { openNeeds, sameNeed } from "./agentReport.ts";
import type { AgentNeed } from "./agentReport.ts";

/** What a run remembers about one event that woke it. */
export interface AgentEventMark {
  /** Source, title, kind, host and severity: the same news carries the same key. */
  key: string;
  /** The largest percentage the event states (a disk at 92%), when it states one. */
  figure?: number;
}

/** Same news after this long still wakes the agent once, to look again. */
export const HOLD_RECHECK_MS = 3 * 60 * 60_000;
/** A figure that moved this many points is news. */
export const HOLD_FIGURE_STEP = 2;
/** At most this many marks are kept per run. */
export const EVENT_MARKS_KEPT = 20;

const FIELD_LIMIT = 120;
const PERCENT = /(\d{1,3}(?:[.,]\d+)?)\s*%/g;

const words = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\d+(?:[.,:]\d+)*/g, "#").replace(/\s+/g, " ").trim().toLocaleLowerCase().slice(0, FIELD_LIMIT) : "";

/** A JSON object body's own facts (webhook senders often post JSON). */
function jsonFacts(text: string | undefined): Record<string, unknown> {
  const trimmed = text?.trim();
  if (!trimmed?.startsWith("{")) return {};
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** The largest percentage in `text` (0–100), if any. */
function largestPercent(text: string): number | undefined {
  let best: number | undefined;
  for (const match of text.matchAll(PERCENT)) {
    const value = Number(match[1]!.replace(",", "."));
    if (Number.isFinite(value) && value <= 100 && (best === undefined || value > best)) best = value;
  }
  return best;
}

export function eventMark(event: AgentEvent): AgentEventMark {
  const facts = jsonFacts(event.fields.text);
  const key = [
    event.kind,
    event.source ?? event.target?.triggerId ?? event.sourceAgentId ?? "",
    event.outcome,
    words(event.fields.title || event.fields.agent),
    words(event.fields.event ?? facts.event),
    words(facts.title),
    words(event.fields.host ?? facts.host),
    words(event.fields.severity ?? facts.severity ?? facts.level),
  ].join("|");
  const figure = largestPercent([event.fields.text, event.fields.summary, event.fields.error].filter(Boolean).join(" "));
  return { key, ...(figure !== undefined ? { figure } : {}) };
}

export function eventMarks(events: readonly AgentEvent[]): AgentEventMark[] {
  const marks: AgentEventMark[] = [];
  for (const event of events) {
    const mark = eventMark(event);
    const known = marks.find((item) => item.key === mark.key);
    // One mark per news item; the batch's largest figure stands for it.
    if (known) {
      if (mark.figure !== undefined && (known.figure === undefined || mark.figure > known.figure)) known.figure = mark.figure;
    } else if (marks.length < EVENT_MARKS_KEPT) marks.push(mark);
  }
  return marks;
}

interface HoldRun {
  runId: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  trigger?: string;
  needs?: AgentNeed[];
  marks?: AgentEventMark[];
}

export type HoldDecision =
  | { hold: false }
  | { hold: true; since: number; need: string };

/** Whether `events` only repeat what the last run saw while a request to the
 *  person is still open. `history` is newest first, as tasks keep it. */
export function holdDecision(history: readonly HoldRun[] | undefined, events: readonly AgentEvent[], now: number): HoldDecision {
  const last = (history ?? []).find((run) => run.status !== "running" && run.status !== "skipped");
  if (!last || last.status !== "ok" || last.trigger !== "event" || !last.marks?.length) return { hold: false };
  if (now - last.startedAt >= HOLD_RECHECK_MS) return { hold: false };
  const waiting = openNeeds(history, now, 1)[0];
  if (!waiting) return { hold: false };
  const seen = last.marks;
  for (const mark of eventMarks(events)) {
    const before = seen.find((item) => item.key === mark.key);
    if (!before) return { hold: false };
    if ((before.figure === undefined) !== (mark.figure === undefined)) return { hold: false };
    if (before.figure !== undefined && Math.abs(mark.figure! - before.figure) >= HOLD_FIGURE_STEP) return { hold: false };
  }
  return { hold: true, since: last.startedAt, need: waiting.text };
}

/** The line a wake after held events carries, so the agent knows it missed nothing new. */
export function heldNote(count: number): string {
  return `${count} more event${count === 1 ? "" : "s"} with the same news arrived since your last run and ${count === 1 ? "was" : "were"} held while your request to the user stays open. Look again only if something changed; do not repeat your report.`;
}

const SIGNAL_RANK = { quiet: 0, update: 1, alert: 2 } as const;
const figures = (text: string | undefined): string =>
  (text?.match(/\d+(?:[.,]\d+)?/g) ?? []).map((value) => value.replace(",", ".")).sort().join(" ");

interface ReportRun {
  runId: string;
  status: string;
  signal?: "quiet" | "update" | "alert";
  headline?: string;
  needs?: AgentNeed[];
  repeat?: { of: string; signal: "update" | "alert" };
  startedAt: number;
  finishedAt?: number;
}

/** Whether `rec` (just settled) only asks again for what already waits: each
 *  of its requests is still open from an earlier report, the newest report
 *  that asked them gave the same figures in its headline, and this one is no
 *  stronger. `earlier` is the history without `rec`, newest first. */
export function repeatedReport(
  rec: ReportRun,
  earlier: readonly ReportRun[],
  now: number,
): { of: string; signal: "update" | "alert" } | undefined {
  if (rec.signal !== "update" && rec.signal !== "alert") return undefined;
  if (!rec.needs?.length) return undefined;
  const open = openNeeds(earlier, now, Number.MAX_SAFE_INTEGER);
  if (!rec.needs.every((need) => open.some((item) => sameNeed(item.text, need.text)))) return undefined;
  const before = earlier.find((run) => run.status === "ok"
    && (run.signal === "update" || run.signal === "alert" || run.repeat)
    && rec.needs!.every((need) => run.needs?.some((item) => !item.done && sameNeed(item.text, need.text))));
  if (!before) return undefined;
  // The bar is the strongest of the newest ask and the original one it repeats.
  const original = before.repeat ? earlier.find((run) => run.runId === before.repeat!.of) : before;
  const asked = [before.repeat?.signal ?? before.signal, original?.signal]
    .map((signal) => signal ? SIGNAL_RANK[signal] : 0);
  if (SIGNAL_RANK[rec.signal] > Math.max(...asked)) return undefined;
  if (figures(rec.headline) !== figures(before.headline)) return undefined;
  return { of: before.repeat?.of ?? before.runId, signal: rec.signal };
}

/** The newest finished report, as a wake script sees it. */
export function lastReportOf(history: readonly ReportRun[] | undefined): { signal: string; headline: string; at: number } | null {
  const run = (history ?? []).find((item) => item.status === "ok" && item.signal);
  return run ? { signal: run.signal!, headline: run.headline ?? "", at: run.finishedAt ?? run.startedAt } : null;
}
