// People-first conversations: typed calls for the two conversation routes.
// A conversation is a session with purpose "conversation": people write to
// each other and no agent turn exists. The routes are idempotent through a
// clientOperationId, so a retry after a lost response must reuse the same one.
import type {
  CreateConversationInput,
  StartSessionFromConversationInput,
  StartSessionFromConversationResult,
} from "@polyth/contracts";
import type { AccountChoice } from "./accounts.ts";
import type { SpaceMemberDto } from "@polyth/contracts";
import { sessionFetch } from "@polyth/session/web-api";

const createPath = "/api/conversations";
const startPath = (sessionId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/conversation/start`;

export interface SpacePersonChoice {
  userId: string;
  name: string;
}

/** Space members other than the reader, named when the account list still
 *  exposes them and falling back to the id (never to a blank row). */
export function conversationPeople(
  members: readonly SpaceMemberDto[],
  accounts: readonly AccountChoice[],
  selfId: string,
): SpacePersonChoice[] {
  const names = new Map(accounts.map((account) => [account.id, account.name.trim()]));
  return members
    .filter((member) => member.userId !== selfId)
    .map((member) => ({
      userId: member.userId,
      name: member.name?.trim() || names.get(member.userId) || member.userId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const createConversation = (input: CreateConversationInput): Promise<{ id: string }> =>
  sessionFetch<{ id: string }>(createPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const startSessionFromConversation = (
  sessionId: string,
  input: StartSessionFromConversationInput,
): Promise<StartSessionFromConversationResult> =>
  sessionFetch<StartSessionFromConversationResult>(startPath(sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

/** Operation ids survive a failed request so a retry is idempotent on the
 *  server. The key is the complete request intent. */
const operationIds = new Map<string, string>();

export function conversationOperationId(key: string): string {
  const existing = operationIds.get(key);
  if (existing) return existing;
  const uuid = globalThis.crypto?.randomUUID?.();
  const id = uuid ?? `conversation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  operationIds.set(key, id);
  return id;
}

export function forgetConversationOperation(key: string): void {
  operationIds.delete(key);
}
