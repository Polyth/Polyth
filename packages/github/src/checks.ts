// Check-run normalization and grouping (WP11). Pure functions: the gh CLI's
// statusCheckRollup mixes CheckRun (status+conclusion) and StatusContext
// (state) shapes; everything is folded into the shared PrCheck contract, then
// grouped failure-first for the UI.
import type { CheckStatus, PrCheck } from "@polyth/contracts";

/** Raw entry from `gh pr view --json statusCheckRollup`. */
export interface RollupEntry {
  __typename?: string;
  name?: string;
  context?: string;            // StatusContext name
  status?: string;             // CheckRun: QUEUED | IN_PROGRESS | COMPLETED
  conclusion?: string;         // CheckRun: SUCCESS | FAILURE | SKIPPED | ...
  state?: string;              // StatusContext: SUCCESS | FAILURE | ERROR | PENDING | EXPECTED
  startedAt?: string;
  completedAt?: string;
  detailsUrl?: string;
  targetUrl?: string;
  workflowName?: string;
}

const CONCLUSION_MAP: Record<string, CheckStatus> = {
  SUCCESS: "success",
  FAILURE: "failure",
  CANCELLED: "cancelled",
  SKIPPED: "skipped",
  NEUTRAL: "neutral",
  TIMED_OUT: "timed_out",
  ACTION_REQUIRED: "action_required",
  STALE: "cancelled",
};

const STATE_MAP: Record<string, CheckStatus> = {
  SUCCESS: "success",
  FAILURE: "failure",
  ERROR: "failure",
  PENDING: "queued",
  EXPECTED: "queued",
};

export function normalizeCheck(entry: RollupEntry, index: number): PrCheck {
  const name = entry.name || entry.context || `check-${index + 1}`;
  let status: CheckStatus;
  if (entry.state !== undefined) {
    status = STATE_MAP[entry.state.toUpperCase()] ?? "neutral";
  } else if ((entry.status ?? "").toUpperCase() === "COMPLETED") {
    status = CONCLUSION_MAP[(entry.conclusion ?? "").toUpperCase()] ?? "neutral";
  } else if ((entry.status ?? "").toUpperCase() === "IN_PROGRESS") {
    status = "in_progress";
  } else {
    status = "queued";
  }
  const url = entry.detailsUrl || entry.targetUrl;
  return {
    // rerun with the same name gets a distinct id via the index suffix
    id: `${name}#${index}`,
    name,
    status,
    ...(entry.workflowName ? { workflow: entry.workflowName } : {}),
    ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
    ...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
    ...(url ? { url } : {}),
  };
}

export interface ChecksGroup {
  id: "failed" | "running" | "succeeded" | "skipped" | "cancelled";
  label: string;
  checks: PrCheck[];
}

export interface ChecksSummary {
  total: number;
  /** failure-first headline: "2 failing", "3 running", "All 7 checks passed" */
  headline: string;
  state: "failure" | "pending" | "success" | "none";
  counts: Partial<Record<CheckStatus, number>>;
  groups: ChecksGroup[];
}

const FAILING: CheckStatus[] = ["failure", "action_required", "timed_out"];
const RUNNING: CheckStatus[] = ["queued", "in_progress"];
const SKIPPED: CheckStatus[] = ["skipped", "neutral"];

export function summarizeChecks(checks: PrCheck[]): ChecksSummary {
  const counts: Partial<Record<CheckStatus, number>> = {};
  for (const c of checks) counts[c.status] = (counts[c.status] ?? 0) + 1;

  const pick = (statuses: CheckStatus[]) => checks.filter((c) => statuses.includes(c.status));
  const failed = pick(FAILING);
  const running = pick(RUNNING);
  const succeeded = pick(["success"]);
  const skipped = pick(SKIPPED);
  const cancelled = pick(["cancelled"]);

  const groups: ChecksGroup[] = [];
  if (failed.length) groups.push({ id: "failed", label: "Failure / action required", checks: failed });
  if (running.length) groups.push({ id: "running", label: "Running / queued", checks: running });
  if (succeeded.length) groups.push({ id: "succeeded", label: "Success", checks: succeeded });
  if (skipped.length) groups.push({ id: "skipped", label: "Skipped / neutral", checks: skipped });
  if (cancelled.length) groups.push({ id: "cancelled", label: "Cancelled", checks: cancelled });

  let headline: string;
  let state: ChecksSummary["state"];
  if (checks.length === 0) {
    headline = "No checks reported";
    state = "none";
  } else if (failed.length) {
    headline = `${failed.length} failing`;
    state = "failure";
  } else if (cancelled.length && !running.length && !succeeded.length && !skipped.length) {
    headline = `${cancelled.length} cancelled`;
    state = "failure";
  } else if (running.length) {
    headline = `${running.length} running`;
    state = "pending";
  } else if (succeeded.length === 0) {
    headline = `All ${checks.length} checks skipped`;
    state = "none";
  } else if (succeeded.length === checks.length) {
    headline = `All ${checks.length} checks passed`;
    state = "success";
  } else {
    headline = `${succeeded.length} of ${checks.length} passed`;
    state = "success";
  }

  return { total: checks.length, headline, state, counts, groups };
}

/** True while any check is nonterminal — the UI polls only in this state. */
export const anyCheckPending = (checks: PrCheck[]): boolean =>
  checks.some((c) => RUNNING.includes(c.status));
