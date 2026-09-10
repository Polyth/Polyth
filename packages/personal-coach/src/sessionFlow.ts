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

export function latestCoachSession(
  sessions: readonly SessionProjection[], projectId: string, spaceId: string,
): SessionProjection | undefined {
  return sessions.filter((session) => session.projectId === projectId
    && session.spaceId === spaceId && session.status !== "archived")
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
      // A reset sets the profile to `new`: old chats must not resurrect setup.
      const existing = input.resume && profile.onboardingState !== "new"
        ? latestCoachSession(await sessions.list(projectId), projectId, space.spaceId)
        : undefined;
      if (existing) {
        await deps.context(existing.id, store);
        return { sessionId: existing.id, resumed: true };
      }
      const onboarding = profile.onboardingState !== "complete";
      const session = await sessions.create({
        projectId,
        title: input.title ?? (input.resume && onboarding ? "Coach · Setup" : "Coach · Today"),
      });
      // Legacy callers which only create a chat retain their response/behavior.
      const interactive = input.resume !== undefined || input.text !== undefined;
      if (interactive && onboarding) store.updateProfile({
        onboardingState: "started",
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      });
      await deps.context(session.id, store);
      if (interactive) {
        const text = input.text ?? (onboarding
          ? "Help me set up Coach. Ask what I would like to make progress on, then help me choose one realistic first step."
          : "Help me choose one useful focus for today. Read my current Coach state before making suggestions.");
        try {
          // Canonical admission persists the user message before runtime delivery.
          await sessions.send(session.id, { text });
        } catch {
          // Admission can be uncertain. Return the real session for recovery;
          // never create a replacement or replay this text on the next click.
          return {
            sessionId: session.id,
            startError: "Coach opened, but the first message was not confirmed. Check the conversation before sending it again.",
          };
        }
      }
      return { sessionId: session.id };
    })();
    pending.set(space.spaceId, work);
    try { return await work; }
    finally { if (pending.get(space.spaceId) === work) pending.delete(space.spaceId); }
  };
}
