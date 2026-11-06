// People talking in a session: typed calls for the per-chat people routes.
// A person message is a durable `person/message` event; it never starts,
// queues or steers an agent turn. The server is the authority on mentions,
// carry-to-agent access and mute scope, so these calls only shape requests.
import type {
  PersonAccessDecisionInput,
  PersonAccessDecisionResult,
  PersonMessageInput,
  PersonMessageResult,
  NewChatPeopleDto,
  SessionMentionCandidateDto,
  SessionMentionOutsidersDto,
} from "@polyth/contracts";
import { useEffect, useMemo, useState } from "react";
import { sessionFetch } from "@polyth/session/web-api";
import { activeBrowserAccountId } from "./accountStorage.ts";
import { assignPersonTones, preferredPersonTone } from "./personIdentity.ts";

const personMessagesPath = (sessionId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/person-messages`;
const mentionCandidatesPath = (sessionId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/mention-candidates`;
const mutePath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/mute`;
const outsidersPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/sharing/outsiders`;
const personAccessPath = (sessionId: string, messageSeq: number) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/person-messages/${messageSeq}/access`;

interface CandidateList { items?: unknown }

const isCandidate = (value: unknown): value is SessionMentionCandidateDto => {
  if (!value || typeof value !== "object") return false;
  const row = value as { userId?: unknown; name?: unknown; access?: unknown };
  return typeof row.userId === "string"
    && row.userId.length > 0
    && (row.name === undefined || typeof row.name === "string")
    && (row.access === "view" || row.access === "collaborate" || row.access === "manage");
};

/** Per-session candidate cache. The picker renders from it immediately on
 *  open and refreshes in the background; a failed refresh keeps the last
 *  known list rather than emptying the People group. */
const candidateCache = new Map<string, SessionMentionCandidateDto[]>();
/** Who hears when a chat's people change: its list here and in the composer. */
const candidateListeners = new Map<string, Set<(items: SessionMentionCandidateDto[]) => void>>();

function subscribeCandidates(sessionId: string, listener: (items: SessionMentionCandidateDto[]) => void): () => void {
  const listeners = candidateListeners.get(sessionId) ?? new Set();
  candidateListeners.set(sessionId, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) candidateListeners.delete(sessionId);
  };
}

export function cachedMentionCandidates(sessionId: string): SessionMentionCandidateDto[] {
  return candidateCache.get(sessionId) ?? [];
}

export function forgetMentionCandidates(sessionId: string): void {
  candidateCache.delete(sessionId);
  outsidersCache.delete(sessionId);
}

export async function loadMentionCandidates(
  sessionId: string,
  options: { refresh?: boolean } = {},
): Promise<SessionMentionCandidateDto[]> {
  if (!options.refresh && candidateCache.has(sessionId)) return candidateCache.get(sessionId)!;
  const result = await sessionFetch<CandidateList>(mentionCandidatesPath(sessionId));
  const items = Array.isArray(result?.items) ? result.items.filter(isCandidate) : [];
  candidateCache.set(sessionId, items);
  for (const listener of candidateListeners.get(sessionId) ?? []) listener(items);
  return items;
}

/** Who cannot open a chat and what the reader can do about it, per session.
 *  Read only once someone starts a mention: most chats never need it. */
const outsidersCache = new Map<string, SessionMentionOutsidersDto>();

export function cachedMentionOutsiders(sessionId: string): SessionMentionOutsidersDto | null {
  return outsidersCache.get(sessionId) ?? null;
}

export async function loadMentionOutsiders(sessionId: string): Promise<SessionMentionOutsidersDto> {
  const result = await sessionFetch<SessionMentionOutsidersDto>(outsidersPath(sessionId));
  outsidersCache.set(sessionId, result);
  return result;
}

/** The same before a chat exists. Not cached: there is no session to key it by,
 *  and the composer reads it only when a mention starts. */
export const loadNewChatPeople = (projectId: string): Promise<NewChatPeopleDto> =>
  sessionFetch<NewChatPeopleDto>(`/api/sharing/new-chat?projectId=${encodeURIComponent(projectId)}`);

/** Answers a message's request to open the chat to someone. */
export async function decidePersonAccess(
  sessionId: string,
  messageSeq: number,
  input: PersonAccessDecisionInput,
): Promise<PersonAccessDecisionResult> {
  const result = await sessionFetch<PersonAccessDecisionResult>(personAccessPath(sessionId, messageSeq), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  // They are in the chat now, so everything naming its people should say so.
  if (result.outcome === "shared") {
    outsidersCache.delete(sessionId);
    void loadMentionCandidates(sessionId, { refresh: true }).catch(() => { /* keep the last known people */ });
  }
  return result;
}

/** "Max", "Max and Olena": first names in the reader's language. The names
 *  stay in the nominative, so a sentence never has to decline one. */
export function firstNamesList(names: readonly string[], locale?: string): string {
  const firsts = names.map((name) => name.trim().split(/\s+/)[0] || name);
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(firsts);
  } catch {
    return firsts.join(", ");
  }
}

export const postPersonMessage = (
  sessionId: string,
  input: PersonMessageInput,
): Promise<PersonMessageResult> => sessionFetch<PersonMessageResult>(personMessagesPath(sessionId), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
});

export const setSessionMuted = (sessionId: string, muted: boolean): Promise<{ ok: true }> =>
  sessionFetch<{ ok: true }>(mutePath(sessionId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ muted }),
  });

/** Whether the reader has at least one unseen mention: drives the @ badge. */
export function hasMentionAttention(session: { attention?: { mentions?: number } } | null | undefined): boolean {
  return (session?.attention?.mentions ?? 0) > 0;
}

/** A conversation's unread messages from other people (the reader's own
 *  count, from the server); 0 for any other chat. */
export function conversationUnread(
  session: { purpose?: string; attention?: { unread?: number } } | null | undefined,
): number {
  return session?.purpose === "conversation" ? Math.max(0, session.attention?.unread ?? 0) : 0;
}

/** The unread count as a badge shows it. */
export const unreadBadgeText = (count: number): string => count > 99 ? "99+" : String(count);

/** A person's colour in `sessionId`, from the people known for that chat
 *  (the same assignment the chat itself makes once its people are loaded). */
export function personToneInSession(sessionId: string, userId: string): number {
  const tones = assignPersonTones([
    activeBrowserAccountId(),
    ...cachedMentionCandidates(sessionId).map((candidate) => candidate.userId),
    userId,
  ]);
  return tones.get(userId) ?? preferredPersonTone(userId);
}

/** Insertable mention token. Whitespace cannot live inside the composer's
 *  token grammar, so a display name is joined with underscores. */
export function personMentionToken(name: string): string {
  const collapsed = name.trim().replace(/\s+/g, "_") || "someone";
  return `@${collapsed}`;
}

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? "";

/** The token a person picks: the first name when nobody else here shares it
 *  ("@Olena"), else the whole name ("@Olena_Kovalenko"). */
export function mentionTokenFor(name: string, everyone: readonly string[]): string {
  const first = firstName(name);
  if (!first) return personMentionToken(name);
  const key = first.toLocaleLowerCase();
  const clash = everyone.some((other) => other !== name && firstName(other).toLocaleLowerCase() === key);
  return clash ? personMentionToken(name) : personMentionToken(first);
}

/** Every token that may name this person in a message's text. */
export function mentionTokensOf(name: string): string[] {
  const full = personMentionToken(name);
  const first = personMentionToken(firstName(name) || name);
  return first === full ? [full] : [full, first];
}

/** Up to two initials for a person's identity mark. */
export function personInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1
    ? `${[...words[0]!][0] ?? ""}${[...words[words.length - 1]!][0] ?? ""}`
    : [...(words[0] ?? "?")].slice(0, 1).join("");
  return letters.toLocaleUpperCase() || "?";
}

/** Operation ids survive a failed request so a retry is idempotent on the
 *  server instead of recording the same message twice. The key is the
 *  complete request intent, so editing the draft earns a fresh id. */
const operationIds = new Map<string, string>();

export function personMessageOperationId(key: string): string {
  const existing = operationIds.get(key);
  if (existing) return existing;
  const uuid = globalThis.crypto?.randomUUID?.();
  const id = uuid ?? `person-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  operationIds.set(key, id);
  return id;
}

export function forgetPersonMessageOperation(key: string): void {
  operationIds.delete(key);
}

/** A person's display name: their name, else their account id. */
export const candidateName = (item: SessionMentionCandidateDto): string => item.name?.trim() || item.userId;

const EMPTY_PEOPLE: SessionMentionCandidateDto[] = [];

/** The other people who can open `sessionId` (cached, refreshed on mount);
 *  empty for null. */
export function useSessionPeople(sessionId: string | null): SessionMentionCandidateDto[] {
  const [people, setPeople] = useState<SessionMentionCandidateDto[]>(() => sessionId ? cachedMentionCandidates(sessionId) : EMPTY_PEOPLE);
  useEffect(() => {
    if (!sessionId) { setPeople(EMPTY_PEOPLE); return; }
    setPeople(cachedMentionCandidates(sessionId));
    let live = true;
    const unsubscribe = subscribeCandidates(sessionId, setPeople);
    void loadMentionCandidates(sessionId, { refresh: true })
      .then((items) => { if (live) setPeople(items); })
      .catch(() => { /* keep the last known people */ });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [sessionId]);
  return people;
}

/** Names of the other people who can open `sessionId`; empty for null. */
export function useSessionPeopleNames(sessionId: string | null): string[] {
  const people = useSessionPeople(sessionId);
  return useMemo(() => people.map(candidateName), [people]);
}
