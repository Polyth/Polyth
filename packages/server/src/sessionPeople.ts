// People in shared sessions: who wrote a message, on whose behalf a session
// acts, and each person's own draft, read cursor and pin.
//
// The person always comes from the authenticated Space context, never from a
// request body. A system context (agents over the control socket, background
// package work) is nobody: it writes no author and never borrows a member.
import type { SessionPerson, SessionPersonState, SessionProjection, SpaceContext } from "@polyth/contracts";
import { normalizeSessionPerson, sessionDraftPreview } from "@polyth/contracts";
import { canonicalSecurity } from "./runtimeSecurity.ts";

/** Session-store surface for per-person views. Optional so lightweight test
 *  doubles stay valid; without it projections pass through unchanged. */
export interface SessionPersonSource {
  personStates?(sessionIds: readonly string[], personId: string): Record<string, SessionPersonState>;
  unreadFor?(sessionIds: readonly string[], personId: string): Record<string, number>;
}

/** Who people are, from the tenancy registry of the running auth mode. */
export interface PeopleDirectory {
  /** Display name of an active account. */
  name(userId: string): string | undefined;
  /** Whether the account is an active member of the Space right now. */
  activeMember(userId: string, spaceId: string): boolean;
}

export interface SessionPeople {
  directory?: PeopleDirectory;
  /** Each row as this person sees it: their own draft, pin and unread count. */
  personalize(rows: readonly SessionProjection[], personId: string): SessionProjection[];
}

/** Names and live membership from the running auth mode's registry. */
export function peopleDirectory(store: {
  user(id: string): { name: string } | undefined;
  roleOf(userId: string, spaceId: string): string | undefined;
}): PeopleDirectory {
  return {
    name: (userId) => store.user(userId)?.name,
    activeMember: (userId, spaceId) => store.roleOf(userId, spaceId) !== undefined,
  };
}

/** A context minted for server work rather than for a signed-in person. */
export function isSystemContext(ctx: Pick<SpaceContext, "userId">): boolean {
  return (ctx as { authority?: { kind?: unknown } }).authority?.kind === "system"
    || ctx.userId.startsWith("system:");
}

/** The signed-in person behind a context; undefined for system work. */
export function contextPerson(ctx: SpaceContext, directory?: PeopleDirectory): SessionPerson | undefined {
  if (!ctx.userId || isSystemContext(ctx)) return undefined;
  const name = directory?.name(ctx.userId);
  return { userId: ctx.userId, ...(name ? { name } : {}) };
}

/**
 * The author a send is admitted as. A person always speaks for themselves,
 * whatever the caller asked for. Trusted server code on a system context may
 * act for someone else (a schedule for its owner), but only for an active
 * member of this Space; a person who left cannot keep sending as themselves.
 */
export function admittedAuthor(
  ctx: SpaceContext,
  requested: SessionPerson | undefined,
  directory?: PeopleDirectory,
): SessionPerson | undefined {
  const own = contextPerson(ctx, directory);
  if (own) {
    // Trusted server code acting through the person's own context (a
    // schedule run as its owner) may say how; it never changes who.
    const via = normalizeSessionPerson(requested)?.via;
    return via && requested?.userId === own.userId ? { ...own, via } : own;
  }
  const person = normalizeSessionPerson(requested);
  if (!person) return undefined;
  if (!directory?.activeMember(person.userId, ctx.spaceId)) {
    throw Object.assign(new Error("That person is no longer a member of this Space"), {
      code: "forbidden",
      mutationOutcome: "not-started",
    });
  }
  const name = directory.name(person.userId);
  return { ...person, ...(name ? { name } : {}) };
}

/** Pre-v21 drafts were shared; they now belong only to the session's owner.
 *  Without canonical identity there is a single person, who owns them all. */
export function ownsLegacySessionState(sessionId: string, personId: string): boolean {
  const security = canonicalSecurity();
  if (!security) return true;
  return security.resources.resource(sessionId)?.ownerPrincipalId === personId;
}

function personalizeRow(
  row: SessionProjection,
  state: SessionPersonState | undefined,
  unread: number | undefined,
  personId: string,
  ownsLegacy: (sessionId: string, personId: string) => boolean,
): SessionProjection {
  let next = row;
  const edit = (): SessionProjection => (next === row ? (next = { ...row }) : next);
  // A navigator summary carries only the bounded preview of the person's own
  // draft; a full projection carries the text and its CAS witness.
  if (state?.draftUpdatedAt !== undefined) {
    const own = edit();
    if (row.summary) {
      const preview = sessionDraftPreview(state.draft);
      if (preview) own.draftPreview = preview;
      else delete own.draftPreview;
    } else {
      if (state.draft) own.draft = state.draft;
      else delete own.draft;
      own.draftUpdatedAt = state.draftUpdatedAt;
    }
  } else if ((row.draft !== undefined || row.draftUpdatedAt !== undefined || row.draftPreview !== undefined)
    && !ownsLegacy(row.id, personId)) {
    const own = edit();
    delete own.draft;
    delete own.draftUpdatedAt;
    delete own.draftPreview;
  }
  // No choice yet keeps the pre-v21 shared pin as everyone's default.
  if (state?.pinned !== undefined) {
    const own = edit();
    if (state.pinned) own.pinned = state.pinned;
    else delete own.pinned;
  }
  if (unread !== undefined && row.attention && row.attention.unread !== unread) {
    edit().attention = { ...row.attention, unread };
  }
  // A muted conversation notifies this person only of mentions.
  if (state?.muted === true) edit().muted = true;
  // Mention attention is one above the reader's own cursor. The store keeps
  // only the newest mentioning seq per person (`lastMentionSeq`), so the exact
  // number of unread mentions is not available synchronously here; a reader
  // with any mention past their read cursor gets a count of 1. Exact counting
  // would need an indexed per-session event query, which this per-row
  // projection path deliberately avoids. markRead clears it.
  if (state?.lastMentionSeq !== undefined && state.lastMentionSeq > (state.readSeq ?? 0)) {
    const current = next.attention ?? row.attention;
    edit().attention = { ...(current ?? { questions: 0, permissions: 0, unread: 0 }), mentions: 1 };
  }
  return next;
}

export function createSessionPeople(
  source: SessionPersonSource,
  directory?: PeopleDirectory,
  ownsLegacy: (sessionId: string, personId: string) => boolean = ownsLegacySessionState,
): SessionPeople {
  return {
    ...(directory ? { directory } : {}),
    personalize(rows, personId) {
      if (rows.length === 0 || !personId || !source.personStates) return [...rows];
      const ids = rows.map((row) => row.id);
      const states = source.personStates(ids, personId);
      const unread = source.unreadFor && rows.some((row) => row.attention)
        ? source.unreadFor(ids, personId)
        : undefined;
      return rows.map((row) => personalizeRow(
        row, states[row.id], unread ? unread[row.id] ?? 0 : undefined, personId, ownsLegacy,
      ));
    },
  };
}
