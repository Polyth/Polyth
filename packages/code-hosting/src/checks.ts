import type { CheckStatus, PrCheck } from "@polyth/contracts";

export interface RollupEntry {
  __typename?: string; name?: string; context?: string; status?: string; conclusion?: string;
  state?: string; startedAt?: string; completedAt?: string; detailsUrl?: string;
  targetUrl?: string; workflowName?: string;
}
const CONCLUSION_MAP: Record<string, CheckStatus> = { SUCCESS: "success", FAILURE: "failure", CANCELLED: "cancelled", SKIPPED: "skipped", NEUTRAL: "neutral", TIMED_OUT: "timed_out", ACTION_REQUIRED: "action_required", STALE: "cancelled" };
const STATE_MAP: Record<string, CheckStatus> = { SUCCESS: "success", FAILURE: "failure", ERROR: "failure", PENDING: "queued", EXPECTED: "queued" };
export function normalizeCheck(entry: RollupEntry, index: number): PrCheck {
  const name = entry.name || entry.context || `check-${index + 1}`;
  let status: CheckStatus;
  if (entry.state !== undefined) status = STATE_MAP[entry.state.toUpperCase()] ?? "neutral";
  else if ((entry.status ?? "").toUpperCase() === "COMPLETED") status = CONCLUSION_MAP[(entry.conclusion ?? "").toUpperCase()] ?? "neutral";
  else if ((entry.status ?? "").toUpperCase() === "IN_PROGRESS") status = "in_progress";
  else status = "queued";
  const url = entry.detailsUrl || entry.targetUrl;
  return { id: `${name}#${index}`, name, status, ...(entry.workflowName ? { workflow: entry.workflowName } : {}), ...(entry.startedAt ? { startedAt: entry.startedAt } : {}), ...(entry.completedAt ? { completedAt: entry.completedAt } : {}), ...(url ? { url } : {}) };
}
export interface ChecksGroup { id: "failed" | "running" | "succeeded" | "skipped" | "cancelled"; label: string; checks: PrCheck[] }
export interface ChecksSummary { total: number; headline: string; state: "failure" | "pending" | "success" | "none"; counts: Partial<Record<CheckStatus, number>>; groups: ChecksGroup[] }
export function summarizeChecks(checks: PrCheck[]): ChecksSummary {
  const counts: Partial<Record<CheckStatus, number>> = {};
  for (const c of checks) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const pick = (statuses: CheckStatus[]) => checks.filter((c) => statuses.includes(c.status));
  const failed = pick(["failure", "action_required", "timed_out"]), running = pick(["queued", "in_progress"]), succeeded = pick(["success"]), skipped = pick(["skipped", "neutral"]), cancelled = pick(["cancelled"]);
  const groups: ChecksGroup[] = [];
  if (failed.length) groups.push({ id: "failed", label: "Failure / action required", checks: failed });
  if (running.length) groups.push({ id: "running", label: "Running / queued", checks: running });
  if (succeeded.length) groups.push({ id: "succeeded", label: "Success", checks: succeeded });
  if (skipped.length) groups.push({ id: "skipped", label: "Skipped / neutral", checks: skipped });
  if (cancelled.length) groups.push({ id: "cancelled", label: "Cancelled", checks: cancelled });
  let headline: string; let state: ChecksSummary["state"];
  if (!checks.length) { headline = "No checks reported"; state = "none"; }
  else if (failed.length) { headline = `${failed.length} failing`; state = "failure"; }
  else if (cancelled.length && !running.length && !succeeded.length && !skipped.length) { headline = `${cancelled.length} cancelled`; state = "failure"; }
  else if (running.length) { headline = `${running.length} running`; state = "pending"; }
  else if (!succeeded.length) { headline = `All ${checks.length} checks skipped`; state = "none"; }
  else if (succeeded.length === checks.length) { headline = `All ${checks.length} checks passed`; state = "success"; }
  else { headline = `${succeeded.length} of ${checks.length} passed`; state = "success"; }
  return { total: checks.length, headline, state, counts, groups };
}
export const anyCheckPending = (checks: PrCheck[]): boolean => checks.some((c) => ["queued", "in_progress"].includes(c.status));
