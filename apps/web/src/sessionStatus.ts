import type { SessionProjection } from "@polyth/contracts";
import { tr } from "./i18n/index.ts";

export type SessionStatusKind =
  | "needs-approval"
  | "needs-reply"
  | "working"
  | "failed"
  | "rate-limited"
  | "epoch-pending"
  | "resume-ready"
  | "reconciling"
  | "unknown"
  | "awaiting"
  | "unread"
  | "regular";

export type SessionRowStatus =
  | { kind: "working"; elapsedMs: number; glyph: "◌"; label: string }
  | {
      kind: Exclude<SessionStatusKind, "working">;
      glyph: string;
      label: string;
    };

/** Phases a planned handoff owns: the switch is running, not an incident. */
const PLANNED_EPOCH_PHASES: ReadonlySet<string> = new Set(["requested", "released"]);

/**
 * A user-planned epoch handoff explains its own pending status. Mirrors the
 * harness transition row's suppression (packages/harness-runtime's
 * `transitionStatusMode`): a switch that is still running must not flash
 * "Runtime changed" in the session row, the island or the status bar. A
 * borrowed runtime keeps its warning — replacing that identity needs explicit
 * human confirmation, so it is not a planned handoff.
 */
export function plannedHarnessEpoch(
  session: Pick<SessionProjection, "harnessTransition" | "runtimeControl">,
): boolean {
  const transition = session.harnessTransition;
  if (!transition || !PLANNED_EPOCH_PHASES.has(transition.phase)) return false;
  return session.runtimeControl !== "borrowed";
}

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["working", "waiting", "reconciling", "unknown", "epoch-pending"]);

/** Rows this client shows as working, waiting or unread, most urgent and then
 *  most recent first. A reconnect re-reads them (`refreshSessionIds`): a turn
 *  that ended or a question answered while the link was down would otherwise
 *  keep its old mark on the rail and in the phone's Live Activity. */
export function sessionIdsToRefresh(sessions: readonly SessionProjection[], limit = 100): string[] {
  const tier = (session: SessionProjection): number => {
    if (session.status === "archived") return -1;
    const background = (session.backgroundWork?.multirun ?? 0)
      + (session.backgroundWork?.fusion ?? 0)
      + (session.backgroundWork?.workflow ?? 0);
    if (ACTIVE_STATUSES.has(session.status) || background > 0 || session.resume
      || (session.attention?.questions ?? 0) > 0 || (session.attention?.permissions ?? 0) > 0) return 0;
    return (session.attention?.unread ?? 0) > 0 ? 1 : -1;
  };
  return sessions
    .map((session) => ({ id: session.id, tier: tier(session), at: session.updatedAt ?? 0 }))
    .filter((row) => row.tier >= 0)
    .sort((a, b) => a.tier - b.tier || b.at - a.at)
    .slice(0, limit)
    .map((row) => row.id);
}

const backgroundRunCount = (session: SessionProjection): number =>
  (session.backgroundWork?.multirun ?? 0)
  + (session.backgroundWork?.fusion ?? 0)
  + (session.backgroundWork?.workflow ?? 0);

/** When a working row's running clock started. A row that shows the clock
 *  can tick it by itself from this, so the list around it need not re-render
 *  every second only to move one label. */
export function sessionWorkingSince(session: SessionProjection): number {
  return backgroundRunCount(session) > 0
    ? session.backgroundWork?.startedAt ?? session.lastTurnAt ?? session.updatedAt
    : session.lastTurnAt ?? session.updatedAt;
}

/** One pure priority resolver for sidebar, hero, mobile navigation, and
 * palette rows. Attention that needs a person always outranks activity. */
export function resolveSessionStatus(
  session: SessionProjection,
  now = Date.now(),
): SessionRowStatus {
  const questions = session.attention?.questions ?? 0;
  const permissions = session.attention?.permissions ?? 0;
  if (permissions > 0) {
    return { kind: "needs-approval", glyph: "✓", label: tr("sessionStatus.approvalRequired") };
  }
  if (questions > 0) {
    return { kind: "needs-reply", glyph: "?", label: tr("sessionStatus.replyNeeded") };
  }
  if (session.status === "waiting") {
    return { kind: "needs-reply", glyph: "?", label: tr("sessionStatus.waitingForYou") };
  }
  if (session.status === "working" || backgroundRunCount(session) > 0) {
    return {
      kind: "working",
      elapsedMs: Math.max(0, now - sessionWorkingSince(session)),
      glyph: "◌",
      label: tr("sessionStatus.working"),
    };
  }
  // A provider limit/quota stop with a server-owned resume timer is a pause,
  // not a failure: the last message is re-sent by itself at resumeAt. A refused
  // request is the same pause; its copy names the retry instead of a limit.
  if (session.resume && session.status !== "archived") {
    return session.resume.scope === "request"
      ? { kind: "rate-limited", glyph: "↻", label: tr("sessionStatus.autoRetry") }
      : { kind: "rate-limited", glyph: "⏱", label: tr("sessionStatus.resumesAfterLimit") };
  }
  if (session.status === "failed") {
    return { kind: "failed", glyph: "!", label: tr("sessionStatus.failed") };
  }
  // A changed Polyth-owned runtime is recovered from canonical history when
  // this session is opened or sent to. It needs no user action and should not
  // turn every dormant session into an attention item after a restart.
  if (session.status === "epoch-pending" && session.runtimeControl === "owned"
    && !session.harnessTransition) {
    return { kind: "resume-ready", glyph: "↻", label: tr("sessionStatus.reconnectOnUse") };
  }
  if (session.status === "epoch-pending" && !plannedHarnessEpoch(session)) {
    return { kind: "epoch-pending", glyph: "⚠", label: tr("sessionStatus.runtimeChanged") };
  }
  if (session.status === "reconciling") {
    return { kind: "reconciling", glyph: "↻", label: tr("sessionStatus.reconnecting") };
  }
  if (session.status === "unknown") {
    return { kind: "unknown", glyph: "?", label: tr("sessionStatus.statusUnknown") };
  }
  // Something is armed to wake it (a watched chat, a polyth_wait): it is not
  // done, it continues by itself. Outranks an unread reply, which the rail
  // still counts (projectRailStatus).
  if (session.waits?.length && session.status !== "archived") {
    return { kind: "awaiting", glyph: "⧗", label: tr("sessionStatus.awaiting") };
  }
  if ((session.attention?.unread ?? 0) > 0) {
    return { kind: "unread", glyph: "●", label: tr("sessionStatus.unreadActivity") };
  }
  return { kind: "regular", glyph: "○", label: tr("sessionStatus.idle") };
}

/** Chats behind each status a project's rail tile and tree row show. */
export interface ProjectRailStatus {
  /** Waiting for a person to approve a tool call. */
  permissions: number;
  /** Waiting for a person's reply. */
  questions: number;
  /** Ended in a failure a person should look at. */
  failed: number;
  /** Their runtime changed outside a planned handoff and needs confirming. */
  runtime: number;
  /** Finished with a reply nobody has read yet. */
  results: number;
  working: number;
  reconciling: number;
  /** Will continue by themselves: a provider-limit pause or auto-retry. */
  limited: number;
  /** Will continue by themselves: armed to wake on another chat or a wait. */
  awaiting: number;
}

export const EMPTY_PROJECT_RAIL_STATUS: Readonly<ProjectRailStatus> = Object.freeze({
  permissions: 0, questions: 0, failed: 0, runtime: 0, results: 0,
  working: 0, reconciling: 0, limited: 0, awaiting: 0,
});

/** Counts chats, not requests, through the same resolver as their rows, so an
 * icon and the list it opens agree. A subagent's request blocks work and counts;
 * its finished run is its parent's business (a fork's is its own), and a muted chat does not call. */
export function projectRailStatus(
  sessions: readonly SessionProjection[],
  now = Date.now(),
): ProjectRailStatus {
  const status: ProjectRailStatus = { ...EMPTY_PROJECT_RAIL_STATUS };
  for (const session of sessions) {
    if (session.status === "archived") continue;
    const { kind } = resolveSessionStatus(session, now);
    const ownResult = (!session.parentId || !!session.forkOf) && !session.muted;
    if (kind === "needs-approval") status.permissions += 1;
    else if (kind === "needs-reply") status.questions += 1;
    else if (kind === "working") status.working += 1;
    else if (kind === "reconciling") status.reconciling += 1;
    // A subagent's failure or stale runtime is its parent's to report, like
    // its result; a muted chat does not call.
    else if (kind === "failed") { if (ownResult) status.failed += 1; }
    else if (kind === "epoch-pending") { if (ownResult) status.runtime += 1; }
    else if (kind === "rate-limited") status.limited += 1;
    else if (kind === "awaiting") {
      status.awaiting += 1;
      // A waiting chat's row shows the waiting clock, but its unread reply is
      // still a result to read.
      if ((session.attention?.unread ?? 0) > 0 && ownResult) status.results += 1;
    } else if (kind === "unread" && ownResult) status.results += 1;
  }
  return status;
}

/** What needs a person, most urgent first: the seal takes this kind's colour. */
export type ProjectSealKind = "permission" | "question" | "failed" | "runtime";

export interface ProjectStatusSignal {
  /** One seal for everything that waits on a person: the most urgent kind,
   *  and how many chats wait in all. */
  seal: { kind: ProjectSealKind; count: number } | null;
  /** The project's own motion: something runs, reconnects, or holds still
   *  until it continues by itself. */
  activity: "working" | "reconciling" | "paused" | null;
  /** Chats running or reconnecting, for the tree row's counter. */
  running: number;
  /** Chats with a reply nobody has read. */
  unread: number;
}

/** One reading of a project's chats for every place that summarises them
 *  (rail tile, tree row), so they never disagree. */
export function projectStatusSignal(status: ProjectRailStatus): ProjectStatusSignal {
  const waiting = status.permissions + status.questions + status.failed + status.runtime;
  const kind: ProjectSealKind | null = status.permissions > 0 ? "permission"
    : status.questions > 0 ? "question"
      : status.failed > 0 ? "failed"
        : status.runtime > 0 ? "runtime"
          : null;
  const activity = status.working > 0 ? "working"
    : status.reconciling > 0 ? "reconciling"
      : status.limited + status.awaiting > 0 ? "paused"
        : null;
  return {
    seal: kind ? { kind, count: waiting } : null,
    activity,
    running: status.working + status.reconciling,
    unread: status.results,
  };
}
