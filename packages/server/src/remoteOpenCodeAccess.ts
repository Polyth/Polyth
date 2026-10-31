// SSH connection ownership for the remote OpenCode runtime (Spaces §14.6).
// The same rule `harness-runtime` `resolveRemoteHarnessHost` applies to every
// other remote harness: the session's acting person must be able to use the
// connection; with no person (a probe, a turn nobody started, an actor who
// left the Space) the project's existing binding decides.

type SshPrincipal =
  | { kind: "person"; userId: string; spaceId: string; instanceOwner: boolean }
  | { kind: "binding"; spaceId: string };

export interface RemoteOpenCodeAccessDeps {
  /** SSH package connection ownership; absent on older transports. */
  usable?(connectionId: string, principal: SshPrincipal): boolean;
  /** The person who started the session's current turn, if any. */
  actorOf(sessionId: string): Promise<string | undefined>;
  /** That person's context in the Space, or undefined when they cannot act there. */
  personSpaceContext(userId: string, spaceId: string): { instanceOwner?: boolean } | undefined;
}

export async function remoteOpenCodePrincipal(
  deps: Pick<RemoteOpenCodeAccessDeps, "actorOf" | "personSpaceContext">,
  spaceId: string,
  sessionId?: string,
): Promise<SshPrincipal> {
  const actor = sessionId ? await deps.actorOf(sessionId).catch(() => undefined) : undefined;
  const person = actor ? deps.personSpaceContext(actor, spaceId) : undefined;
  return person && actor
    ? { kind: "person", userId: actor, spaceId, instanceOwner: person.instanceOwner === true }
    : { kind: "binding", spaceId };
}

/** A connection this use may not reach answers `not-found`, as on every SSH route. */
export async function assertRemoteOpenCodeUsable(
  deps: RemoteOpenCodeAccessDeps,
  input: { connectionId: string; spaceId: string; sessionId?: string },
): Promise<void> {
  if (!deps.usable) return;
  const principal = await remoteOpenCodePrincipal(deps, input.spaceId, input.sessionId);
  if (!deps.usable(input.connectionId, principal)) {
    throw Object.assign(new Error("unknown SSH connection"), { code: "not-found" });
  }
}
