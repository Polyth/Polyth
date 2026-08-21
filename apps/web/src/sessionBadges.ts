// Session status badges (UX-SHELL-CONSOLIDATION-02 finding 3): one pure
// derivation over the EXISTING SessionProjection fields — no event-log shape
// change and no new durable state.
//
// Lite scope, documented: the log carries no durable "read" or "merged"
// facts. "Read + nothing pending" therefore means idle with zero open
// attention counts (→ no badge at all), and "merged" derives from the
// worktree-session cleanup signal (branch recorded + worktree removed) —
// a session merged without removing its worktree will not show it.
import type { SessionProjection } from "@polyth/contracts";

export type SessionStatusBadge =
  | { kind: "running"; elapsedMs: number }
  | { kind: "waiting" }
  | { kind: "completed" }
  | { kind: "merged" };

export function sessionStatusBadge(s: SessionProjection, now: number): SessionStatusBadge | null {
  if (s.status === "working") {
    return { kind: "running", elapsedMs: Math.max(0, now - (s.lastTurnAt ?? s.updatedAt)) };
  }
  const questions = s.attention?.questions ?? 0;
  const permissions = s.attention?.permissions ?? 0;
  // A waiting session with open requests already shows the ?N / !N attention
  // badges (the icon the finding asks for); don't duplicate them here.
  if (questions > 0 || permissions > 0) return null;
  if (s.status === "waiting") return { kind: "waiting" };
  if (s.status === "archived") return null;
  if (s.branch !== undefined && s.worktreeState === "missing") return { kind: "merged" };
  if (s.status === "finished") return { kind: "completed" };
  // idle/failed with nothing pending: no badge (failed keeps its status dot).
  return null;
}
