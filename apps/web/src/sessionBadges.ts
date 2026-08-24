// One pure derivation owns the sidebar row's right-zone state. Keeping this
// priority in one place guarantees that a row never renders competing status
// icons and that status changes cannot alter the title column geometry.
import type { SessionProjection } from "@polyth/contracts";

export type SessionRowStatus =
  | { kind: "needs-approval" }
  | { kind: "needs-reply" }
  | { kind: "working"; elapsedMs: number }
  | { kind: "unread" }
  | { kind: "regular" };

export function sessionRowStatus(s: SessionProjection, now: number): SessionRowStatus {
  const questions = s.attention?.questions ?? 0;
  const permissions = s.attention?.permissions ?? 0;
  if (permissions > 0) return { kind: "needs-approval" };
  if (questions > 0 || s.status === "waiting") return { kind: "needs-reply" };
  if (s.status === "working") {
    return { kind: "working", elapsedMs: Math.max(0, now - (s.lastTurnAt ?? s.updatedAt)) };
  }
  if ((s.attention?.unread ?? 0) > 0) return { kind: "unread" };
  return { kind: "regular" };
}
