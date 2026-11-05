// Which person's account settings (small model, Compaction model) apply to a
// session. Pure so the order and the membership check are tested in one place.

export interface SessionAccountInput {
  /** The chat's notification recipient, recorded at creation or on the first
   *  message a person typed. Already checked against the Space. */
  recipient?: string;
  /** The person the session currently acts for (`SessionProjection.actor`). */
  actor?: string;
  /** Every account with a role in the session's Space. */
  members(): readonly string[];
  /** The account exists and still holds a role in the session's Space. */
  isMember(userId: string): boolean;
}

/** The recorded owner, else the person the session acts for, else the Space's
 *  only member. An actor who left the Space never counts, and a Space shared
 *  by several people without either record has no answer: the server
 *  defaults apply rather than one member's private choices. */
export function resolveSessionAccount(input: SessionAccountInput): string | undefined {
  if (input.recipient) return input.recipient;
  if (input.actor && input.isMember(input.actor)) return input.actor;
  const members = input.members().filter((userId) => input.isMember(userId));
  return members.length === 1 ? members[0] : undefined;
}
