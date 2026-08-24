// Pure surface-selection rules for the session main pane (UX-FIXTURE-VISUAL).
// Pending question/permission/secret surfaces must take precedence over the
// empty-session hero, and archived sessions must never present a live
// composer. Derived only from replayed events + the session projection, so
// reload/replay can never resolve or duplicate a request.
import type { SessionProjection } from "@polyth/contracts";
import type { RenderModel } from "./reduce.ts";

export type SurfaceModel = Pick<
  RenderModel,
  "messages" | "permissions" | "questions" | "secrets" | "workflowRun"
>;

export interface PendingCounts {
  questions: number;
  permissions: number;
  secrets: number;
}

export function pendingCounts(model: SurfaceModel): PendingCounts {
  return {
    questions: model.questions.filter((q) => q.status === "pending").length,
    permissions: model.permissions.filter((p) => p.status === "pending").length,
    secrets: model.secrets.filter((secret) => secret.status === "pending").length,
  };
}

/** True only when there is genuinely nothing to act on: no messages, workflow
 *  run, unresolved question/permission/secret, and the session is not archived. */
export function showSessionHero(
  sessionId: string | null,
  model: SurfaceModel,
  session: Pick<SessionProjection, "status"> | null,
): boolean {
  if (!sessionId) return true;
  if (session?.status === "archived") return false;
  if (model.workflowRun) return false;
  const pending = pendingCounts(model);
  return model.messages.length === 0
    && pending.questions === 0
    && pending.permissions === 0
    && pending.secrets === 0;
}

export type SessionSurfaceKind = "loading" | "hero" | "session";

/** Chooses among the loading row, the fresh-session hero, and the session
 *  timeline. While a canonical event load is in flight (openingSessionId is
 *  claimed), an otherwise-fresh surface presents as loading — never as the
 *  fresh-session hero — so a delayed replay cannot flash a false empty state
 *  over a populated session (UX-TIMELINE-LAYOUT-01 §8, initial replay). A
 *  visible session with content stays visible during a switch, as before. */
export function sessionSurfaceKind(
  sessionId: string | null,
  openingSessionId: string | null,
  model: SurfaceModel,
  session: Pick<SessionProjection, "status"> | null,
): SessionSurfaceKind {
  if (!showSessionHero(sessionId, model, session)) return "session";
  return openingSessionId !== null ? "loading" : "hero";
}

/** Archived sessions block composition behind an explicit restore action. */
export function composerBlockedByArchive(
  session: Pick<SessionProjection, "status"> | null,
): boolean {
  return session?.status === "archived";
}
