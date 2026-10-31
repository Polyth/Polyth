// How a new message or mention from a person reaches someone who is not
// reading that chat. Pure decision, node:test friendly; notify.ts performs it.
//
// - Reading that very chat on screen: no alert, the inbox row is marked seen.
// - Polyth on screen, another chat: an in-app banner (always — muting a
//   conversation is the per-chat off switch, and the server already skips
//   muted people), plus the OS alert/sound the person chose for the kind.
// - Polyth hidden: the OS alert the person chose (Web Push, when active,
//   covers a hidden page from the service worker instead).
import type { NotificationKind, NotificationRecord } from "@polyth/contracts";

export type PeopleKind = Extract<NotificationKind, "mention" | "message">;

export const isPeopleKind = (kind: string): kind is PeopleKind => kind === "mention" || kind === "message";

/** One OS notification per chat: the page and the service worker share it. */
export const peopleNotificationTag = (sessionId: string): string => `polyth-people-${sessionId}`;

export interface PeopleAlertContext {
  activeSessionId: string | null;
  /** The page is on screen. */
  visible: boolean;
  /** Kinds the person routes to OS alerts and sound. */
  kinds: ReadonlySet<string>;
  /** OS alerts are on (Settings → Notifications → Desktop notification). */
  osAlerts: boolean;
  /** OS alerts only while Polyth is in the background. */
  onlyWhenHidden: boolean;
  sound: boolean;
}

export type PeopleAlertPlan =
  | { seen: true }
  | { seen: false; banner: boolean; os: boolean; sound: boolean };

export function planPeopleAlert(
  record: { kind: string; sessionId: string },
  context: PeopleAlertContext,
): PeopleAlertPlan | null {
  if (!isPeopleKind(record.kind)) return null;
  if (context.visible && record.sessionId === context.activeSessionId) return { seen: true };
  const chosen = context.kinds.has(record.kind);
  return {
    seen: false,
    banner: context.visible,
    os: context.osAlerts && chosen && (!context.visible || !context.onlyWhenHidden),
    sound: context.sound && chosen && context.visible,
  };
}

/** The newest lines a conversation card shows. */
export const THREAD_LINES = 3;

export interface PeopleThreadLine {
  id: string;
  author: { userId: string; name: string } | null;
  text: string;
  mention: boolean;
  ts: number;
}

/** What one chat's card stands for while it is on screen. */
export interface PeopleThread {
  /** The newest few, oldest first. */
  lines: PeopleThreadLine[];
  count: number;
  /** Once a burst mentions the reader the card says so until it leaves. */
  mention: boolean;
}

type PeopleRecord = Pick<NotificationRecord, "id" | "kind" | "title" | "body" | "ts"> & {
  author?: unknown;
  chat?: unknown;
};

/** The record's author, when the server named one well formed. */
export function recordAuthor(record: PeopleRecord): { userId: string; name: string } | null {
  const author = record.author as { userId?: unknown; name?: unknown } | null | undefined;
  if (!author || typeof author.userId !== "string" || !author.userId) return null;
  const name = typeof author.name === "string" && author.name.trim() ? author.name.trim() : author.userId;
  return { userId: author.userId, name };
}

/** The chat's title: the record's own, else the end of "Ann · Chat". */
export function recordChat(record: PeopleRecord): string {
  if (typeof record.chat === "string" && record.chat.trim()) return record.chat.trim();
  const at = record.title.lastIndexOf(" · ");
  return at >= 0 ? record.title.slice(at + 3).trim() : record.title.trim();
}

/** `thread` with `record` added (a replayed record changes nothing). */
export function addToThread(thread: PeopleThread | undefined, record: PeopleRecord): PeopleThread {
  const current = thread ?? { lines: [], count: 0, mention: false };
  if (current.lines.some((line) => line.id === record.id)) return current;
  const line: PeopleThreadLine = {
    id: record.id,
    author: recordAuthor(record),
    text: record.body,
    mention: record.kind === "mention",
    ts: record.ts,
  };
  return {
    lines: [...current.lines, line].slice(-THREAD_LINES),
    count: current.count + 1,
    mention: current.mention || line.mention,
  };
}
