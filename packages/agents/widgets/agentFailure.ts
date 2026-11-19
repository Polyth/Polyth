// Why a run did not finish, in the reader's words, and what waits for the
// person on an agent's page. DOM-free so it is tested directly.
import type { ScheduleRunDto, ScheduleTaskDto } from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { openNeeds, type OpenNeed } from "../src/agentReport.ts";
import { agentState } from "./agentModel.ts";

export type RunCause = NonNullable<ScheduleRunDto["cause"]> | "unsaid";

const SIGN_IN = /\b(401|403|unauthori[sz]ed|authentication|api key|sign[- ]?in|log ?in again|expired)\b/i;

/** Why `run` ended without finishing. Records kept before causes were kept
 *  say only what their error does: a refused sign-in reads as the route's,
 *  the old catch-all stop as unsaid (a person, a restart or a tool that ran
 *  too long all left the same words). */
export function runCause(run: Pick<ScheduleRunDto, "status" | "cause" | "stopped" | "error" | "sessionId">): RunCause | undefined {
  if (run.status !== "failed") return undefined;
  if (run.stopped) return "person";
  if (run.cause) return run.cause;
  const error = run.error ?? "";
  if (error === "Stopped before it finished.") return "unsaid";
  if (SIGN_IN.test(error)) return "route";
  return run.sessionId ? "error" : "start";
}

/** A failed run's headline: what happened, not "failed". */
export function failureTitle(run: ScheduleRunDto): string {
  switch (runCause(run)) {
    case "person": return tr("agents.stoppedByYou");
    case "cut": return run.resumed
      ? tr("agents.fail.cutResumedValue", { count: run.resumed })
      : tr("agents.fail.cut");
    case "route": return tr("agents.fail.route");
    case "start": return tr("agents.fail.start");
    case "approval": return tr("agents.fail.approval");
    case "unsaid": return tr("agents.fail.unsaid");
    default: return tr("agents.runFailedTitle");
  }
}

/** A provider's error as a sentence: the message inside its JSON, then where
 *  it came from. "commandcode API error (401): {"message":"Your API key has
 *  expired."}" reads "Your API key has expired. (commandcode API error 401)". */
export function plainError(error: string | undefined): string {
  const text = (error ?? "").trim();
  const open = text.indexOf("{");
  if (open < 0) return text;
  let message: unknown;
  try {
    const parsed = JSON.parse(text.slice(open, text.lastIndexOf("}") + 1)) as { message?: unknown; error?: unknown };
    message = parsed.message ?? (typeof parsed.error === "string" ? parsed.error : (parsed.error as { message?: unknown } | undefined)?.message);
  } catch {
    return text;
  }
  if (typeof message !== "string" || !message.trim()) return text;
  const source = text.slice(0, open).replace(/[:\s]+$/, "").replace(/[()]/g, "").trim();
  return source ? `${message.trim()} (${source})` : message.trim();
}

/** The sentence under a failed run's headline: what the error says, or for a
 *  cut what a cut is. Empty when the headline said it all. */
export function failureDetail(run: ScheduleRunDto): string {
  const cause = runCause(run);
  if (cause === "person" || cause === "unsaid") return "";
  if (cause === "cut") return tr("agents.fail.cutDetail");
  if (cause === "approval") return tr("agents.fail.approvalDetail");
  return plainError(run.error);
}

export type AttentionItem =
  /** The agent stopped waking: its failure streak, or its daily limit. */
  | { kind: "stopped"; key: string; reason: "failures" | "budget"; count: number; last?: ScheduleRunDto; detail?: string }
  /** The newest run could not use its model: a sign-in, a quota, the model. */
  | { kind: "route"; key: string; run: ScheduleRunDto; detail: string }
  /** The newest run stopped on a request nobody answered. */
  | { kind: "approval"; key: string; run: ScheduleRunDto }
  /** What a report said only the person can do. */
  | { kind: "need"; key: string; need: OpenNeed };

/** Everything on an agent's page that waits for the person, most urgent
 *  first: why it no longer wakes, what stopped its newest run that only they
 *  can clear, then what its reports asked of them. Requests that wait inside
 *  a run in progress (approvals, questions) are answered at the composer and
 *  are not listed here. */
export function agentAttention(task: ScheduleTaskDto, now = Date.now()): AttentionItem[] {
  const items: AttentionItem[] = [];
  const history = task.history ?? [];
  const finished = history.filter((run) => run.status !== "running" && run.status !== "skipped");
  const last = finished[0];
  if (agentState(task) === "tripped" && task.tripped) {
    const lastFailed = finished.find((run) => run.status === "failed" && !run.stopped);
    items.push({
      kind: "stopped",
      key: `stopped-${task.tripped.at}`,
      reason: task.tripped.reason,
      count: task.pauseAfterFailures ?? 0,
      ...(task.tripped.reason === "failures" && lastFailed ? { last: lastFailed } : {}),
      ...(task.tripped.reason === "budget" ? { detail: task.tripped.message } : {}),
    });
  }
  // Only the newest run speaks for the agent's state: a later one that
  // finished has cleared whatever stopped the earlier.
  const running = history.some((run) => run.status === "running");
  if (last && !running) {
    const cause = runCause(last);
    if (cause === "route") items.push({ kind: "route", key: `route-${last.runId}`, run: last, detail: plainError(last.error) });
    else if (cause === "approval") items.push({ kind: "approval", key: `approval-${last.runId}`, run: last });
  }
  for (const need of openNeeds(history, now)) items.push({ kind: "need", key: `need-${need.runId}-${need.index}`, need });
  return items;
}
