import type { SessionProjection } from "@polyth/contracts";

export type SessionStatusKind =
  | "needs-approval"
  | "needs-reply"
  | "working"
  | "failed"
  | "epoch-pending"
  | "reconciling"
  | "unknown"
  | "unread"
  | "regular";

export type SessionRowStatus =
  | { kind: "working"; elapsedMs: number; glyph: "◌"; label: "Working" }
  | {
      kind: Exclude<SessionStatusKind, "working">;
      glyph: string;
      label: string;
    };

/** One pure priority resolver for sidebar, hero, mobile navigation, and
 * palette rows. Attention that needs a person always outranks activity. */
export function resolveSessionStatus(
  session: SessionProjection,
  now = Date.now(),
): SessionRowStatus {
  const questions = session.attention?.questions ?? 0;
  const permissions = session.attention?.permissions ?? 0;
  if (permissions > 0) {
    return { kind: "needs-approval", glyph: "✓", label: "Approval required" };
  }
  if (questions > 0) {
    return { kind: "needs-reply", glyph: "?", label: "Reply needed" };
  }
  if (session.status === "waiting") {
    return { kind: "needs-reply", glyph: "?", label: "Waiting for you" };
  }
  const backgroundRuns =
    (session.backgroundWork?.multirun ?? 0)
    + (session.backgroundWork?.fusion ?? 0);
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
      label: "Working",
    };
  }
  if (session.status === "failed") {
    return { kind: "failed", glyph: "!", label: "Failed" };
  }
  if (session.status === "epoch-pending") {
    return { kind: "epoch-pending", glyph: "⚠", label: "Runtime changed" };
  }
  if (session.status === "reconciling") {
    return { kind: "reconciling", glyph: "↻", label: "Reconnecting" };
  }
  if (session.status === "unknown") {
    return { kind: "unknown", glyph: "?", label: "Status unknown" };
  }
  if ((session.attention?.unread ?? 0) > 0) {
    return { kind: "unread", glyph: "●", label: "Unread activity" };
  }
  return { kind: "regular", glyph: "○", label: "Idle" };
}

/** Compatibility name for row call sites while status ownership moves here. */
export const sessionRowStatus = resolveSessionStatus;
