// DOM-free people-mode decisions for the composer: which mention tokens the
// draft still carries, whether the next submit belongs to people or the
// agent, and the send button's exact label. The component only projects this.
import type { PersonMessageInput, SessionAccessLevel, SessionMentionOutsidersDto, SessionProjection } from "@polyth/contracts";
import { parsePromptTokens } from "./language.ts";
import { personMentionToken } from "../sessionPeople.ts";
import { canCollaborateSession } from "../sessionSharing.ts";
import { tr } from "../i18n/index.ts";

export interface ComposerPersonMention {
  userId: string;
  name: string;
  /** The token inserted for this person; defaults to the full-name token. */
  token?: string;
  /** They could not open the chat when they were picked. */
  outside?: boolean;
  /** What the sender said about that. Unset means they have not been asked
   *  for an answer yet. `granted` shares or asks with the message; `skipped`
   *  leaves the words as plain text and tells nobody. */
  accessAnswer?: "granted" | "skipped";
}

type OutsideAction = SessionMentionOutsidersDto["action"];

/** Mentioned people the sender has not answered about yet. With nobody able
 *  to share there is nothing to answer, so nobody waits. */
export function awaitingAccessAnswer(
  mentions: readonly ComposerPersonMention[],
  action: OutsideAction | undefined,
): ComposerPersonMention[] {
  if (action === undefined || action === "none") return [];
  return mentions.filter((mention) => mention.outside && !mention.accessAnswer);
}

/** An answer is about one way in, so it does not outlive a change of what the
 *  sender can do: "ask them" must never become "open it" by itself. */
export function withoutGrantedAnswers(mentions: readonly ComposerPersonMention[]): ComposerPersonMention[] {
  return mentions.map(({ accessAnswer, ...mention }) => (
    accessAnswer === "skipped" ? { ...mention, accessAnswer } : mention
  ));
}

/** Whom the message reaches, now or once the chat opens to them. */
export function addressedMentions(
  mentions: readonly ComposerPersonMention[],
  action: OutsideAction | undefined,
): ComposerPersonMention[] {
  return mentions.filter((mention) => {
    if (!mention.outside) return true;
    if (mention.accessAnswer === "skipped") return false;
    return action === "share" || action === "request";
  });
}

/** The request fields a send carries: who can read it, and how the others get
 *  there. A person still outside is never named as a plain mention. */
export function personMessageRecipients(
  mentions: readonly ComposerPersonMention[],
  action: OutsideAction | undefined,
  level: SessionAccessLevel,
): Pick<PersonMessageInput, "mentions" | "shareWith" | "requestAccessFor"> {
  const inside = mentions.filter((mention) => !mention.outside).map((mention) => mention.userId);
  const granted = mentions.filter((mention) => mention.outside && mention.accessAnswer === "granted").map((mention) => mention.userId);
  const shareWith = action === "share" ? granted : [];
  const requestAccessFor = action === "request" ? granted : [];
  const named = [...inside, ...shareWith, ...requestAccessFor];
  return {
    ...(named.length > 0 ? { mentions: named } : {}),
    ...(shareWith.length > 0 ? { shareWith: shareWith.map((userId) => ({ userId, access: level })) } : {}),
    ...(requestAccessFor.length > 0 ? { requestAccessFor } : {}),
  };
}

/** A new person gets the least that lets them read and answer, as in the share
 *  dialog. Everyone in a people-only conversation joins as an equal. */
export function defaultMentionLevel(levels: readonly SessionAccessLevel[], conversation: boolean): SessionAccessLevel {
  if (conversation && levels.includes("collaborate")) return "collaborate";
  return levels[0] ?? "view";
}

/** What the line above the composer says, or nothing when it has no business
 *  being there: it speaks only while the message is going to people. */
export type MentionAccessLine =
  | { state: "ask"; action: "share" | "request"; people: ComposerPersonMention[] }
  | { state: "blocked"; people: ComposerPersonMention[] }
  | { state: "granted"; action: "share" | "request"; people: ComposerPersonMention[] };

export function mentionAccessLine(
  mentions: readonly ComposerPersonMention[],
  action: OutsideAction | undefined,
  peopleMode: boolean,
): MentionAccessLine | null {
  if (!peopleMode || action === undefined) return null;
  const outside = mentions.filter((mention) => mention.outside);
  if (action === "none") {
    const blocked = outside.filter((mention) => mention.accessAnswer !== "skipped");
    return blocked.length > 0 ? { state: "blocked", people: blocked } : null;
  }
  // An unanswered person comes first: the question is what needs doing.
  const waiting = awaitingAccessAnswer(mentions, action);
  if (waiting.length > 0) return { state: "ask", action, people: waiting };
  const granted = outside.filter((mention) => mention.accessAnswer === "granted");
  return granted.length > 0 ? { state: "granted", action, people: granted } : null;
}

const hasToken = (text: string, token: string): boolean =>
  parsePromptTokens(text).some((candidate) => candidate.kind === "file" && candidate.path === token.slice(1));

/** Drop mentions whose token the person deleted from the draft. */
export function livePersonMentions(
  text: string,
  mentions: readonly ComposerPersonMention[],
): ComposerPersonMention[] {
  return mentions.filter((mention) => hasToken(text, mention.token ?? personMentionToken(mention.name)));
}

/** People mode is the default while people are mentioned; picking Agent
 *  overrides it for this draft. A view-only reader has no agent mode at all. */
export function peopleModeActive(input: {
  mentionCount: number;
  agentOverride: boolean;
  viewOnly: boolean;
}): boolean {
  if (input.viewOnly) return true;
  return input.mentionCount > 0 && !input.agentOverride;
}

/** A people send is available with an existing session even with no mention. */
export function peopleSendLabel(mentions: readonly ComposerPersonMention[]): string {
  if (mentions.length === 1) {
    // The button has room for a first name; the full name is in the token.
    const name = mentions[0]!.name.trim();
    return tr("composer.people.sendToOne", { name: name.split(/\s+/)[0] || name });
  }
  if (mentions.length === 0) return tr("conversation.send");
  return tr("composer.people.sendToMany", { count: mentions.length });
}

/** A people-first conversation has no agent turn to name, so its send action
 *  either addresses the room or counts the mentioned people. */
export function conversationSendLabel(mentions: readonly ComposerPersonMention[]): string {
  if (mentions.length === 0) return tr("conversation.send");
  return tr("composer.people.sendToMany", { count: mentions.length });
}

/** "Add to next prompt" needs collaborate access; a view-only reader cannot
 *  make their message reference data for a later agent turn. */
export function showCarryToAgent(session: Pick<SessionProjection, "sharing"> | null, viewOnly: boolean): boolean {
  return !viewOnly && !!session && canCollaborateSession(session);
}
