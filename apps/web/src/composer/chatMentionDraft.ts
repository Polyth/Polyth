// Chat mentions in the composer: the person sees `@Title`, the message carries
// the `[@Title](polyth://session/<id>)` token. The draft keeps a small list of
// `{ label, sessionId }` next to its text (drafts.ts), so a reload keeps the
// link; a label edited away simply sends as plain text.
import { sessionMentionToken } from "@polyth/contracts";

export interface ChatMentionRef {
  label: string;
  sessionId: string;
}

export const MAX_DRAFT_CHAT_MENTIONS = 32;

const TOKEN = /\[@([^\]\n]{0,80})\]\(polyth:\/\/session\/([^)\s]{1,128})\)/g;
const LABEL_IN_TOKEN = /^\[@([^\]\n]*)\]\(/;

/** The label a token will carry for this title (the token's own sanitizing). */
export function chatMentionLabel(sessionId: string, title: string): string {
  return LABEL_IN_TOKEN.exec(sessionMentionToken(sessionId, title))?.[1] ?? "chat";
}

/** What the composer inserts for a picked chat, and the ref to remember. */
export function chatMentionInsert(sessionId: string, title: string): { text: string; ref: ChatMentionRef } {
  const label = chatMentionLabel(sessionId, title);
  return { text: `@${label} `, ref: { label, sessionId } };
}

const wordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}_]/u.test(char);

/** Start indexes of `@label` that stand alone: not inside a token (`[@…]`),
 *  not glued to a word on either side. */
function occurrences(text: string, label: string): number[] {
  const needle = `@${label}`;
  const found: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const before = text[at - 1];
    const after = text[at + needle.length];
    if (before === "[" || wordChar(before) || after === "]" || wordChar(after)) continue;
    found.push(at);
  }
  return found;
}

/** Rewrites the first not-yet-used `@label` of each ref into its token, in
 *  ref order. A ref whose label is gone is dropped: plain text, no link. */
export function expandChatMentions(text: string, refs: readonly ChatMentionRef[]): string {
  if (refs.length === 0) return text;
  const used: Array<{ start: number; end: number; token: string }> = [];
  for (const ref of refs) {
    const length = ref.label.length + 1;
    const start = occurrences(text, ref.label).find((at) => !used.some((u) => at < u.end && at + length > u.start));
    if (start === undefined) continue;
    used.push({ start, end: start + length, token: sessionMentionToken(ref.sessionId, ref.label) });
  }
  used.sort((a, b) => b.start - a.start);
  let out = text;
  for (const u of used) out = out.slice(0, u.start) + u.token + out.slice(u.end);
  return out;
}

/** The other way, for recalled prompts and old drafts: tokens become `@label`
 *  and come back as refs, so a resend produces the same tokens. */
export function collapseChatMentions(text: string): { text: string; refs: ChatMentionRef[] } {
  const refs: ChatMentionRef[] = [];
  const shown = text.replace(TOKEN, (_match, label: string, sessionId: string) => {
    refs.push({ label, sessionId });
    return `@${label}`;
  });
  return { text: shown, refs };
}

/** Refs still backed by an `@label` in the text (one occurrence each). */
export function liveChatMentions(text: string, refs: readonly ChatMentionRef[]): ChatMentionRef[] {
  const counts = new Map<string, number>();
  return refs.filter((ref) => {
    const seen = counts.get(ref.label) ?? 0;
    const keep = occurrences(text, ref.label).length > seen;
    if (keep) counts.set(ref.label, seen + 1);
    return keep;
  });
}

/** Adds refs, keeping the newest `MAX_DRAFT_CHAT_MENTIONS`. */
export function mergeChatMentions(current: readonly ChatMentionRef[], added: readonly ChatMentionRef[]): ChatMentionRef[] {
  return [...current, ...added].slice(-MAX_DRAFT_CHAT_MENTIONS);
}

export function isChatMentionRef(value: unknown): value is ChatMentionRef {
  const ref = value as Partial<ChatMentionRef> | null;
  return !!ref && typeof ref.label === "string" && ref.label.length <= 120
    && typeof ref.sessionId === "string" && ref.sessionId.length > 0 && ref.sessionId.length <= 128
    && !/[\s)]/.test(ref.sessionId);
}
