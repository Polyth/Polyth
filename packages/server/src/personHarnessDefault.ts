// A person's own default harness (Spaces §13): a chat they start without
// naming a harness is pinned to it, before account limits pick their first
// entry and before project/Space defaults apply. The choice lives with the
// person in harness-runtime's person storage; harness-runtime resolves it and
// answers only while it is still usable by that person in that Space, so the
// facades below (limits, restricted accounts) re-check it like any pin.
import type { HarnessSelection, SessionService, SpaceContext } from "@polyth/contracts";

/** The acting person's usable default harness id in their Space, if any. */
export type PersonHarnessDefault = (ctx: SpaceContext) => Promise<string | undefined>;

export function personDefaultSessionService(
  base: SessionService,
  ctx: SpaceContext,
  resolve: PersonHarnessDefault,
): SessionService {
  return {
    ...base,
    create: async (input) => {
      // Only a chat that names nothing: an explicit harness (Auto included),
      // a model, an agent profile, a subagent of a parent or an adopted
      // native session keeps its own routing.
      if (input.harness || input.model || input.parentId || input.backendSessionId
        || (input as { agentProfileId?: unknown }).agentProfileId) return base.create(input);
      // A broken or missing preference never blocks starting a chat.
      const harnessId = await resolve(ctx).catch(() => undefined);
      const harness: HarnessSelection | undefined = harnessId ? { mode: "pinned", harnessId } : undefined;
      return base.create(harness ? { ...input, harness } : input);
    },
  };
}

/** Wrap only when a resolver exists. */
export function personDefaultSessionsForActor(
  ctx: SpaceContext,
  base: SessionService,
  resolve: PersonHarnessDefault | undefined,
): SessionService {
  return resolve ? personDefaultSessionService(base, ctx, resolve) : base;
}
