// DOM-free decisions for people-first conversations: the two request payloads,
// message-selection ordering, and the one-time participant copy from a
// conversation's current sharing grants. The components only project this.
import type {
  SessionAccessLevel,
  SessionShareGrantDto,
  StartSessionFromConversationInput,
} from "@polyth/contracts";

export interface ConversationParticipantDraft {
  userId: string;
  name?: string;
  access: SessionAccessLevel;
}

/** A title from the first selected person message: first line, trimmed and
 *  bounded so a long message does not become a paragraph-long title. */
export function conversationTitleFromMessage(text: string, limit = 80): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length <= limit) return firstLine;
  return `${firstLine.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** Selection keeps click order: the server carries the messages in that
 *  order, and the card lists them the same way. */
export function toggleSelectedSeq(selected: readonly number[], seq: number): number[] {
  return selected.includes(seq) ? selected.filter((value) => value !== seq) : [...selected, seq];
}

export function createConversationPayload(input: {
  projectId: string;
  title: string;
  participants: readonly string[];
  text: string;
  operationId: string;
}): {
  projectId: string;
  title?: string;
  participants: string[];
  text: string;
  clientOperationId: string;
} {
  const title = input.title.trim();
  return {
    projectId: input.projectId,
    ...(title ? { title } : {}),
    participants: [...input.participants],
    text: input.text.trim(),
    clientOperationId: input.operationId,
  };
}

/** One-time copy of the conversation's current named grants. The caller
 *  becomes the owner, so the reader is not copied into the list. */
export function participantsFromGrants(
  grants: readonly SessionShareGrantDto[],
  selfId: string,
): ConversationParticipantDraft[] {
  return grants
    .filter((grant) => grant.userId !== selfId)
    .map((grant) => ({
      userId: grant.userId,
      ...(grant.name?.trim() ? { name: grant.name.trim() } : {}),
      access: grant.access,
    }));
}

export function startSessionPayload(input: {
  sourceSeqs: readonly number[];
  title: string;
  prompt: string;
  participants: readonly ConversationParticipantDraft[];
  operationId: string;
}): StartSessionFromConversationInput {
  const title = input.title.trim();
  const prompt = input.prompt.trim();
  return {
    sourceSeqs: [...input.sourceSeqs],
    ...(title ? { title } : {}),
    ...(prompt ? { prompt } : {}),
    participants: input.participants.map((participant) => ({
      userId: participant.userId,
      access: participant.access,
    })),
    clientOperationId: input.operationId,
  };
}

export function conversationOperationKey(input: {
  kind: "create" | "start";
  sessionId?: string;
  projectId?: string;
  participants: readonly (string | { userId: string; access: SessionAccessLevel })[];
  title: string;
  text: string;
  sourceSeqs?: readonly number[];
}): string {
  const people = input.participants.map((participant) =>
    typeof participant === "string" ? participant : `${participant.userId}:${participant.access}`).join(",");
  return [
    input.kind,
    input.sessionId ?? "",
    input.projectId ?? "",
    people,
    input.title.trim(),
    input.text.trim(),
    (input.sourceSeqs ?? []).join(","),
  ].join("\u0000");
}
