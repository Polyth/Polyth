import type { SpaceContext, SessionProjection, SessionService } from "@polyth/contracts";
import type { CoachStore } from "./index.ts";

export interface CoachSessionInput {
  title?: string;
  resume?: boolean;
  text?: string;
  timeZone?: string;
}

export interface CoachSessionResult {
  sessionId: string;
  resumed?: boolean;
  startError?: string;
}

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid-input" });

export function parseCoachSessionInput(value: Record<string, unknown>): CoachSessionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Expected an object");
  const result: CoachSessionInput = {};
  for (const [key, limit] of [["title", 120], ["text", 4000], ["timeZone", 120]] as const) {
    const raw = value[key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string" || !raw.trim() || raw.trim().length > limit) {
      throw invalid(`${key} must be text between 1 and ${limit} characters`);
    }
    result[key] = raw.trim();
  }
  if (value.resume !== undefined) {
    if (typeof value.resume !== "boolean") throw invalid("resume must be a boolean");
    result.resume = value.resume;
  }
  if (result.timeZone) {
    try { new Intl.DateTimeFormat("en", { timeZone: result.timeZone }).format(0); }
    catch { throw invalid("timeZone must be a valid IANA time zone"); }
  }
  return result;
}

export const COACH_SESSION_TITLE = "Coach";

/**
 * Resolve the one session "Ask Coach" resumes.
 *
 * The recorded canonical id wins whenever that session is still live. An
 * install that predates the pointer adopts its most recent Coach session once,
 * so an upgrade does not orphan an ongoing conversation. Scheduled check-ins
 * and reviews create their own sessions and are deliberately NOT adopted —
 * otherwise last night's cron run would silently become "the" Coach chat.
 */
export function resolveCanonicalCoachSession(
  sessions: readonly SessionProjection[],
  input: { projectId: string; spaceId: string; recordedId?: string; adopt: boolean },
): SessionProjection | undefined {
  const owned = sessions.filter((session) => session.projectId === input.projectId
    && session.spaceId === input.spaceId
    && session.status !== "archived");
  const recorded = input.recordedId
    ? owned.find((session) => session.id === input.recordedId)
    : undefined;
  if (recorded || !input.adopt) return recorded;
  return owned
    .filter((session) => session.title === COACH_SESSION_TITLE || session.title.startsWith("Coach · "))
    .filter((session) => !session.title.startsWith("Coach · Daily") && !session.title.startsWith("Coach · Weekly"))
    .sort((a, b) => (b.lastTurnAt ?? b.createdAt) - (a.lastTurnAt ?? a.createdAt))[0];
}

/** One launch at a time per Space. Canonical sessions remain the durable resume
 * authority; no second session registry, guessed project, or automatic replay. */
export function createCoachSessionFlow(deps: {
  workspace(space: SpaceContext): Promise<{ projectId: string }>;
  store(space: SpaceContext): CoachStore;
  sessions(space: SpaceContext): Pick<SessionService, "list" | "create" | "send">;
  prepare(space: SpaceContext, projectId: string, store: CoachStore): void | Promise<void>;
  context(sessionId: string, store: CoachStore): Promise<void>;
}) {
  const pending = new Map<string, Promise<CoachSessionResult>>();
  // Last text admitted per Space. A second tab or a double click repeats the
  // exact same message, and replaying it into a resumed conversation is never
  // what the user meant. Deliberately in-memory: after a restart one duplicate
  // is possible, which is strictly better than a durable replay ledger.
  const lastDelivered = new Map<string, string>();
  return async (space: SpaceContext, raw: Record<string, unknown>): Promise<CoachSessionResult> => {
    // Validate before creating a workspace, touching a profile, or spawning.
    const input = parseCoachSessionInput(raw);
    const previous = pending.get(space.spaceId);
    const work = (async () => {
      if (previous) await previous.catch(() => undefined);
      const { projectId } = await deps.workspace(space);
      const store = deps.store(space);
      const sessions = deps.sessions(space);
      const profile = store.profile();
      await deps.prepare(space, projectId, store);
      const onboarding = profile.onboardingState !== "complete";
      // A reset sets the profile to `new`: old chats must not resurrect setup.
      const existing = input.resume && profile.onboardingState !== "new"
        ? resolveCanonicalCoachSession(await sessions.list(projectId), {
            projectId,
            spaceId: space.spaceId,
            ...(store.canonicalSessionId() ? { recordedId: store.canonicalSessionId()! } : {}),
            adopt: store.canonicalSessionId() === undefined,
          })
        : undefined;
      const interactive = input.resume !== undefined || input.text !== undefined;
      const deliver = async (sessionId: string, text: string): Promise<CoachSessionResult | undefined> => {
        // Recorded BEFORE the send: an uncertain admission may already have
        // persisted the message, so the retry path must not replay it either.
        lastDelivered.set(space.spaceId, text);
        try {
          // Canonical admission persists the user message before runtime delivery.
          await sessions.send(sessionId, { text });
          return undefined;
        } catch {
          // Admission can be uncertain. Return the real session for recovery;
          // never create a replacement or replay this text on the next click.
          return {
            sessionId,
            startError: "Coach opened, but the message was not confirmed. Check the conversation before sending it again.",
          };
        }
      };

      if (existing) {
        // Resuming re-publishes current durable state, so a day-old chat never
        // reasons from a stale snapshot of goals or today.
        store.setCanonicalSessionId(existing.id);
        await deps.context(existing.id, store);
        // A contextual ask ("about this goal") continues the one Coach
        // conversation rather than spawning a competing titled session — unless
        // it is the message that was just admitted, which is a double click.
        if (input.text && lastDelivered.get(space.spaceId) !== input.text) {
          const failed = await deliver(existing.id, input.text);
          if (failed) return { ...failed, resumed: true };
        }
        return { sessionId: existing.id, resumed: true };
      }

      const session = await sessions.create({
        projectId,
        title: input.title ?? COACH_SESSION_TITLE,
      });
      // Only the generic, resumable conversation becomes the canonical target.
      // An explicitly titled special-purpose session never takes it over.
      if (!input.title) store.setCanonicalSessionId(session.id);
      if (interactive && onboarding) store.updateProfile({
        onboardingState: "started",
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      });
      await deps.context(session.id, store);
      if (interactive) {
        const text = input.text ?? (onboarding
          ? "Help me set up Coach. Ask what I would like to make progress on, then help me choose one realistic first step."
          : "Help me choose one useful focus for today. Read my current Coach state before making suggestions.");
        const failed = await deliver(session.id, text);
        if (failed) return failed;
      }
      return { sessionId: session.id };
    })();
    pending.set(space.spaceId, work);
    try { return await work; }
    finally { if (pending.get(space.spaceId) === work) pending.delete(space.spaceId); }
  };
}
