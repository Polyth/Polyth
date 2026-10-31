// Browser-safe selectors behind the session progress bar and the sub-agent
// panel. Pure functions over canonical session events and projections, so they
// are testable without a DOM and work for every harness.
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { normalizeTodoItems, todoProgress, type TodoItem, type TodoProgress } from "./index.ts";

export interface SessionProgress extends TodoProgress {
  items: TodoItem[];
  /** Time of the first snapshot of the current list (a cleared list starts a new one). */
  startedAt?: number;
  /** Time the list settled; absent while work remains. */
  endedAt?: number;
}

/** Progress of the newest `task/snapshot`, with the span the list has run. */
export function sessionProgress(events: readonly SessionEvent[]): SessionProgress {
  let startedAt: number | undefined;
  let lastTime: number | undefined;
  let latest: readonly TodoItem[] = [];
  for (const event of events) {
    if (event.type !== "task/snapshot") continue;
    const items = normalizeTodoItems(event.data.items) ?? [];
    if (items.length === 0) {
      startedAt = undefined;
      lastTime = undefined;
      latest = [];
      continue;
    }
    startedAt ??= event.time;
    lastTime = event.time;
    latest = items;
  }
  const progress = todoProgress(latest);
  const out: SessionProgress = { ...progress, items: [...latest] };
  if (startedAt !== undefined) out.startedAt = startedAt;
  if (progress.total > 0 && progress.settled && lastTime !== undefined) out.endedAt = lastTime;
  return out;
}

/** Elapsed ms for a progress span; ticks to `now` until the list settles. */
export function progressElapsed(progress: Pick<SessionProgress, "startedAt" | "endedAt">, now: number): number | undefined {
  if (progress.startedAt === undefined) return undefined;
  return Math.max(0, (progress.endedAt ?? now) - progress.startedAt);
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

export type SubagentState = "running" | "done" | "failed" | "idle" | "unknown";

export interface SubagentRow {
  sessionId: string;
  label: string;
  state: SubagentState;
  currentTask?: string;
  /** input + output tokens of this session plus all nested sub-agents; absent when unreported. */
  tokens?: number;
  cost?: number;
  depth: number;
}

export interface SubagentSummary {
  rows: SubagentRow[];
  running: number;
  /** Sum over direct children (each already includes its own descendants). */
  tokens: number;
  cost: number;
  /** True when at least one agent had no reported usage, so totals may be partial. */
  partial: boolean;
}

export interface SubagentSource {
  events(sessionId: string): readonly SessionEvent[];
  session(sessionId: string): Pick<SessionProjection, "status" | "title" | "tokenTotals" | "costTotal" | "parentId"> | undefined;
}

const MAX_DEPTH = 4;
const DONE = new Set(["done", "completed", "complete", "succeeded", "finished"]);
const FAILED = new Set(["failed", "error", "cancelled", "canceled", "aborted"]);
const RUNNING = new Set(["running", "working", "active", "in_progress", "in-progress", "inprogress", "waiting", "started"]);

export function subagentState(snapshotStatus: unknown, sessionStatus?: string): SubagentState {
  // The child's own projection is fresher than a parent snapshot.
  if (sessionStatus === "working" || sessionStatus === "waiting" || sessionStatus === "reconciling") return "running";
  if (sessionStatus === "failed") return "failed";
  if (sessionStatus === "finished") return "done";
  const status = typeof snapshotStatus === "string" ? snapshotStatus.trim().toLowerCase() : "";
  if (DONE.has(status)) return "done";
  if (FAILED.has(status)) return "failed";
  if (RUNNING.has(status)) return sessionStatus === "idle" ? "idle" : "running";
  return sessionStatus === "idle" ? "idle" : "unknown";
}

const usageTokens = (usage: { input: number; output: number } | undefined): number | undefined =>
  usage ? (Number(usage.input) || 0) + (Number(usage.output) || 0) : undefined;

function agentsOf(events: readonly SessionEvent[]): Array<Record<string, unknown>> {
  const latest = events.findLast((event) => event.type === "subagent/snapshot");
  const agents: unknown = latest?.data.agents;
  if (!Array.isArray(agents)) return [];
  return agents.filter((a: unknown): a is Record<string, unknown> => !!a && typeof a === "object" && !Array.isArray(a));
}

/** Sub-agents of a session from its newest `subagent/snapshot`, joined with each
 *  child's canonical projection and rolled up through nested children. */
export function summarizeSubagents(sessionId: string, source: SubagentSource): SubagentSummary {
  const rows: SubagentRow[] = [];
  const seen = new Set<string>([sessionId]);
  let partial = false;

  // Returns the roll-up of the subtree below `parentId` (excluding the parent itself).
  const walk = (parentId: string, depth: number): { tokens: number; cost: number } => {
    const total = { tokens: 0, cost: 0 };
    for (const agent of agentsOf(source.events(parentId))) {
      const id = typeof agent.sessionId === "string" ? agent.sessionId : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const session = source.session(id);
      const row: SubagentRow = {
        sessionId: id,
        label: (typeof agent.label === "string" && agent.label.trim()) || session?.title || id.slice(0, 8),
        state: subagentState(agent.status, session?.status),
        depth,
      };
      if (typeof agent.currentTask === "string" && agent.currentTask.trim()) row.currentTask = agent.currentTask.trim();
      rows.push(row);
      const index = rows.length - 1;
      const nested = depth < MAX_DEPTH ? walk(id, depth + 1) : { tokens: 0, cost: 0 };
      const own = usageTokens(session?.tokenTotals);
      // A session reports only its own usage, so a row's roll-up is own + nested.
      if (own === undefined && session?.costTotal === undefined) partial = true;
      const tokens = (own ?? 0) + nested.tokens;
      const cost = (session?.costTotal ?? 0) + nested.cost;
      if (own !== undefined || nested.tokens > 0) rows[index]!.tokens = tokens;
      if (session?.costTotal !== undefined || nested.cost > 0) rows[index]!.cost = cost;
      total.tokens += tokens;
      total.cost += cost;
    }
    return total;
  };

  const total = walk(sessionId, 0);
  return {
    rows,
    running: rows.filter((row) => row.state === "running").length,
    tokens: total.tokens,
    cost: total.cost,
    partial,
  };
}
