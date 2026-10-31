import type {
  WorkflowNodeStatus,
  WorkflowReviewJudgmentDto,
  WorkflowReviewVerdict,
  WorkflowRunDto,
  WorkflowRunNodeDto,
  WorkflowRunStatus,
} from "@polyth/contracts";
import { formatNumber, getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { reworkTargets } from "../src/review.ts";

export function workflowVerdictLabel(verdict: WorkflowReviewVerdict | "uncertain"): string {
  if (verdict === "approved") return tr("workflowverdict.approved");
  if (verdict === "changes-requested") return tr("workflowverdict.changesRequested");
  if (verdict === "uncertain") return tr("workflowverdict.uncertain");
  return "";
}

export function workflowJudgedLabel(judgment: WorkflowReviewJudgmentDto): string {
  return tr("workflowverdict.judgedPercent", {
    percent: formatNumber(Math.round(judgment.topProbability * 100)),
  });
}

export function workflowRoundLabel(round: number): string {
  return tr("workflowview.roundValue", { number: formatNumber(round) });
}

export function workflowReviewRoundsLabel(rounds: number): string {
  if (rounds === 0) return tr("workflowview.reviewRoundsNone");
  const form = new Intl.PluralRules(getLocale()).select(rounds) === "one" ? "One" : "Other";
  return tr(`workflowview.reviewRound${form}`, { count: formatNumber(rounds) });
}

/** Roles a review sent its findings to, from the run's recorded definition. */
export function workflowSentBackRoles(run: Pick<WorkflowRunDto, "definition" | "nodes">, node: WorkflowRunNodeDto): string[] {
  if (node.verdict !== "changes-requested" || !run.definition) return [];
  const roles = new Map(run.nodes.map((entry) => [entry.id, entry.role]));
  return reworkTargets(run.definition, node.id).map((id) => roles.get(id) ?? id);
}

/** Reviews that still requested changes once the run settled. */
export function workflowUnresolvedReviews(run: Pick<WorkflowRunDto, "status" | "nodes">): WorkflowRunNodeDto[] {
  if (run.status === "running") return [];
  return run.nodes.filter((node) => node.status === "done" && node.verdict === "changes-requested");
}

/** Reviews that produced an uncertain verdict once the run settled. */
export function workflowUncertainReviews(run: Pick<WorkflowRunDto, "status" | "nodes">): WorkflowRunNodeDto[] {
  if (run.status === "running") return [];
  return run.nodes.filter((node) => node.status === "done" && node.judgment?.verdict === "uncertain");
}

function workflowCount(prefix: "agent" | "stage", count: number): string {
  const form = new Intl.PluralRules(getLocale()).select(count) === "one" ? "One" : "Other";
  return tr(`workflowcount.${prefix}${form}`, { count: formatNumber(count) });
}

export const workflowAgentCount = (count: number): string => workflowCount("agent", count);
export const workflowStageCount = (count: number): string => workflowCount("stage", count);

export function workflowStatusLabel(status: WorkflowNodeStatus | WorkflowRunStatus): string {
  return tr(`workflowstatus.${status}`);
}

export function workflowNodeCount(count: number): string {
  const key = new Intl.PluralRules(getLocale()).select(count) === "one"
    ? "workflowcount.nodeOne"
    : "workflowcount.nodeOther";
  return tr(key, { count: formatNumber(count) });
}

/**
 * Streamed node output can carry runs of empty paragraphs (reasoning-only and
 * marker messages). Runs recorded before the runner stopped joining them still
 * carry those gaps, so presentation keeps at most one blank line between
 * blocks. The stored record is never rewritten.
 */
export function workflowDisplayText(text: string | undefined): string {
  const kept: string[] = [];
  let blank = 0;
  // One pass over lines: a regex over runs of spaces can go quadratic on the
  // 64,000-character output limit.
  for (const line of (text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim()) {
      blank = 0;
      kept.push(line.trimEnd());
    } else if (++blank === 1 && kept.length) {
      kept.push("");
    }
  }
  if (kept.at(-1) === "") kept.pop();
  return kept.join("\n");
}

export function workflowNodeFinished(node: WorkflowRunNodeDto): boolean {
  // A unit held for a fix is still to be done.
  return node.status !== "queued" && node.status !== "running" && node.needsFix !== true;
}

export function workflowFinishedCount(run: WorkflowRunDto): number {
  return run.nodes.filter(workflowNodeFinished).length;
}

/**
 * Keep long workflow timelines useful without making the conversation card
 * dominate the page. The collapsed window follows the node that currently
 * needs attention, is running, or is next in line.
 */
export interface WorkflowTimelineWindow {
  nodes: WorkflowRunNodeDto[];
  start: number;
  end: number;
  total: number;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
}

export function workflowTimelineNodes(
  run: WorkflowRunDto,
  expanded: boolean,
  limit = 6,
): WorkflowTimelineWindow {
  const total = run.nodes.length;
  if (expanded || total <= limit) {
    return {
      nodes: run.nodes,
      start: total > 0 ? 1 : 0,
      end: total,
      total,
      truncatedBefore: false,
      truncatedAfter: false,
    };
  }
  const focusIndex = [
    run.nodes.findIndex((node) => workflowHumanWait(node) !== null || workflowNeedsDecision(node)),
    run.nodes.findIndex((node) => node.status === "running" || node.status === "error"),
    run.nodes.findIndex((node) => !workflowNodeFinished(node)),
  ].find((index) => index >= 0) ?? -1;
  const safeIndex = focusIndex < 0 ? run.nodes.length - 1 : focusIndex;
  const start = Math.max(0, Math.min(
    safeIndex - Math.floor(limit / 2),
    run.nodes.length - limit,
  ));
  const nodes = run.nodes.slice(start, start + limit);
  return {
    nodes,
    start: start + 1,
    end: start + nodes.length,
    total,
    truncatedBefore: start > 0,
    truncatedAfter: start + nodes.length < total,
  };
}

/** Put action-required runs first, then the newest run. Global indicators use
 * this ordering so an older blocked run cannot be hidden by newer background
 * work. */
export function prioritizeWorkflowRuns(runs: readonly WorkflowRunDto[]): WorkflowRunDto[] {
  return runs
    .filter((run) => run.status === "running")
    .slice()
    .sort((left, right) => {
      const leftNeedsHuman = left.nodes.some((node) => workflowHumanWait(node) !== null || workflowNeedsFix(node) || workflowNeedsDecision(node));
      const rightNeedsHuman = right.nodes.some((node) => workflowHumanWait(node) !== null || workflowNeedsFix(node) || workflowNeedsDecision(node));
      return Number(rightNeedsHuman) - Number(leftNeedsHuman)
        || right.startedAt - left.startedAt
        || right.id.localeCompare(left.id);
    });
}

export function workflowHumanWait(node: WorkflowRunNodeDto): "permission" | "answer" | null {
  if (node.status !== "running") return null;
  const activity = node.activity ?? "";
  if (/^awaiting permission(?::|$)/i.test(activity)) return "permission";
  if (/^awaiting answer(?::|$)/i.test(activity)) return "answer";
  return null;
}

/** A unit the running run holds until a person picks another route (or
 * retries the same one). Old clients see a retryable failure. */
export function workflowNeedsFix(node: WorkflowRunNodeDto): boolean {
  return node.needsFix === true && node.status === "error";
}

/** A review the run holds because its rounds ran out: the person accepts the
 * work as it is or grants another round, in the run view. */
export function workflowNeedsDecision(node: WorkflowRunNodeDto): boolean {
  return Boolean(node.needsDecision);
}

export function workflowHumanWaitLabel(node: WorkflowRunNodeDto): string | null {
  const wait = workflowHumanWait(node);
  return wait === "permission"
    ? tr("workflowtimeline.waitingForYourApproval")
    : wait === "answer"
      ? tr("workflowtimeline.waitingForYourAnswer")
      : workflowNeedsDecision(node)
        ? tr("workflowtimeline.waitingForYourDecision")
        : null;
}

export function workflowNodeDetail(node: WorkflowRunNodeDto): string {
  const decided = node.verdict ?? (node.judgment?.verdict === "uncertain" ? "uncertain" : undefined);
  const verdictDetail = decided
    ? (node.judgment
      ? `${workflowVerdictLabel(decided)} · ${workflowJudgedLabel(node.judgment)}`
      : workflowVerdictLabel(decided))
    : undefined;
  const detail = workflowHumanWaitLabel(node)
    ?? node.error
    ?? node.activity
    ?? (node.status === "queued"
      ? tr("workflowtimeline.waitingForDependencies")
      : node.status === "done" && verdictDetail
        ? verdictDetail
        : workflowStatusLabel(node.status));
  return (node.round ?? 1) > 1 ? `${workflowRoundLabel(node.round!)} · ${detail}` : detail;
}

/**
 * Event-log state is normally the freshest source for a run. A terminal API
 * response wins over a still-running event projection during the short window
 * before its completion event arrives over WebSocket.
 */
export function fresherWorkflowRun(
  apiRun: WorkflowRunDto | null,
  eventRun: WorkflowRunDto | null,
): WorkflowRunDto | null {
  if (!apiRun) return eventRun;
  if (!eventRun) return apiRun;
  if (apiRun.id !== eventRun.id) {
    return eventRun.startedAt >= apiRun.startedAt ? eventRun : apiRun;
  }
  if (apiRun.status !== "running" && eventRun.status === "running") return apiRun;
  return eventRun;
}
