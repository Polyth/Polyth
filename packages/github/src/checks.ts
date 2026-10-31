import type { CheckStatus, PrCheck } from "@polyth/contracts";
import { anyCheckPending, summarizeChecks } from "@polyth/code-hosting/checks";
export { anyCheckPending, summarizeChecks };

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
