import type {
  WorkflowNodeStatus,
  WorkflowRunDto,
  WorkflowRunNodeDto,
  WorkflowRunStatus,
} from "@polyth/contracts";
import { formatNumber, getLocale, tr } from "../../../apps/web/src/i18n/index.ts";

export function workflowStatusLabel(status: WorkflowNodeStatus | WorkflowRunStatus): string {
  return tr(`workflowstatus.${status}`);
}

export function workflowNodeCount(count: number): string {
  const key = new Intl.PluralRules(getLocale()).select(count) === "one"
    ? "workflowcount.nodeOne"
    : "workflowcount.nodeOther";
  return tr(key, { count: formatNumber(count) });
}

export function workflowNodeFinished(node: WorkflowRunNodeDto): boolean {
  return node.status !== "queued" && node.status !== "running";
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
    run.nodes.findIndex((node) => workflowHumanWait(node) !== null),
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
      const leftNeedsHuman = left.nodes.some((node) => workflowHumanWait(node) !== null);
      const rightNeedsHuman = right.nodes.some((node) => workflowHumanWait(node) !== null);
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

export function workflowHumanWaitLabel(node: WorkflowRunNodeDto): string | null {
  const wait = workflowHumanWait(node);
  return wait === "permission"
    ? tr("workflowtimeline.waitingForYourApproval")
    : wait === "answer"
      ? tr("workflowtimeline.waitingForYourAnswer")
      : null;
}

export function workflowNodeDetail(node: WorkflowRunNodeDto): string {
  return workflowHumanWaitLabel(node)
    ?? node.error
    ?? node.activity
    ?? (node.status === "queued"
      ? tr("workflowtimeline.waitingForDependencies")
      : workflowStatusLabel(node.status));
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
