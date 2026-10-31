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
  const backgroundRuns =
    (session.backgroundWork?.multirun ?? 0)
    + (session.backgroundWork?.fusion ?? 0)
    + (session.backgroundWork?.workflow ?? 0);
  if (session.status === "working" || backgroundRuns > 0) {
    return {
      kind: "working",
      elapsedMs: Math.max(
        0,
        now - (
          backgroundRuns > 0
            ? session.backgroundWork?.startedAt ?? session.lastTurnAt ?? session.updatedAt
            : session.lastTurnAt ?? session.updatedAt
        ),
      ),
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
  if ((session.attention?.unread ?? 0) > 0) {
    return { kind: "unread", glyph: "●", label: tr("sessionStatus.unreadActivity") };
  }
  return { kind: "regular", glyph: "○", label: tr("sessionStatus.idle") };
}
