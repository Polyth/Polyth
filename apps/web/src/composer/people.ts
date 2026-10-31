// DOM-free people-mode decisions for the composer: which mention tokens the
// draft still carries, whether the next submit belongs to people or the
// agent, and the send button's exact label. The component only projects this.
import type { SessionProjection } from "@polyth/contracts";
import { parsePromptTokens } from "./language.ts";
import { personMentionToken } from "../sessionPeople.ts";
import { canCollaborateSession } from "../sessionSharing.ts";
import { tr } from "../i18n/index.ts";

export interface ComposerPersonMention {
  userId: string;
  name: string;
  /** The token inserted for this person; defaults to the full-name token. */
  token?: string;
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
